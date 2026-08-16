import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { cuid, isoDate, minorAmount, positiveMinorAmount } from '@hishab/shared';
import { z } from 'zod';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { zodPipe } from '../common/zod.pipe';
import { SavingsService } from './savings.service';

/* Mirrors of the Prisma enums. Kept local until savings earns a place in
 * @hishab/shared, so the client contract has one obvious home to move to. */
const SAVINGS_PLAN_TYPES = [
  'DPS',
  'FDR',
  'SANCHAYPATRA',
  'RECURRING_DEPOSIT',
  'GOAL_SAVINGS',
] as const;
const PROFIT_CALCS = [
  'SIMPLE',
  'COMPOUND_MONTHLY',
  'COMPOUND_QUARTERLY',
  'COMPOUND_YEARLY',
] as const;
const PLAN_FREQUENCIES = ['MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'YEARLY'] as const;
const SAVINGS_STATUSES = ['ACTIVE', 'MATURED', 'CLOSED'] as const;

const savingsPlanFields = z.object({
  planName: z.string().min(1).max(120),
  institution: z.string().max(120).optional(),
  planType: z.enum(SAVINGS_PLAN_TYPES).default('DPS'),
  /** One instalment. Zero for a lump-sum FDR — the service rejects both zero. */
  installmentMinor: minorAmount.nonnegative().default(0),
  principalMinor: minorAmount.nonnegative().default(0),
  frequency: z.enum(PLAN_FREQUENCIES).default('MONTHLY'),
  /* 600 months is fifty years: past any Sanchayapatra or DPS a bank sells, and
   * short enough that a fat-fingered term cannot generate a million rows. */
  termMonths: z.number().int().min(1).max(600),
  startDate: isoDate,
  /** Defaults to startDate + termMonths; accepted so a passbook date wins. */
  maturityDate: isoDate.optional(),
  /** Basis points: 8.25% is 825, capped at a 100% annual rate. */
  profitRateBps: z.number().int().min(0).max(10_000).default(0),
  profitCalc: z.enum(PROFIT_CALCS).default('COMPOUND_YEARLY'),
  linkedAccountId: cuid.optional(),
  note: z.string().max(2000).optional(),
});

const createSavingsPlanSchema = savingsPlanFields;
export type CreateSavingsPlanInput = z.infer<typeof createSavingsPlanSchema>;

const updateSavingsPlanSchema = savingsPlanFields.partial().extend({
  status: z.enum(SAVINGS_STATUSES).optional(),
});
export type UpdateSavingsPlanInput = z.infer<typeof updateSavingsPlanSchema>;

const payInstallmentSchema = z.object({
  /** Defaults to today in the workspace timezone. */
  paidDate: isoDate.optional(),
  /** The ledger transaction that moved the money, once one exists. */
  transactionId: cuid.optional(),
});
export type PayInstallmentInput = z.infer<typeof payInstallmentSchema>;

/**
 * Profit arrived — the monthly or quarterly payout on a Sanchayapatra, or the
 * excess a DPS pays at maturity.
 *
 * Only what the bank actually credited. The projection on the plan is what it
 * *should* yield; source tax and excise duty come off before the money lands,
 * so booking the projection would file a figure that never existed. Same rule
 * as the renewal fee.
 */
const recordProfitSchema = z.object({
  amountMinor: positiveMinorAmount,
  /** Where the profit landed — the bank account, the savings account, cash. */
  accountId: cuid,
  /** Required: income filed under nothing is invisible on every report. */
  categoryId: cuid,
  /** Defaults to today. Backdating is how a year of quarterly payouts is caught up. */
  date: isoDate.optional(),
});
export type RecordProfitInput = z.infer<typeof recordProfitSchema>;

/**
 * Maturity: the money leaves the savings account and comes home.
 *
 * A transfer, deliberately — see `SavingsService.mature`. The profit is booked
 * separately and before this, through `POST :id/profit`.
 */
const matureSchema = z.object({
  /** The account the savings money has been sitting in. */
  fromAccountId: cuid,
  /** Where it goes — the current account, the wallet, cash. */
  toAccountId: cuid,
  /** The whole balance, when the intent is to empty it. Always confirmed. */
  amountMinor: positiveMinorAmount,
  date: isoDate.optional(),
});
export type MatureInput = z.infer<typeof matureSchema>;

@Controller('savings')
@UseGuards(JwtAuthGuard)
export class SavingsController {
  constructor(private readonly savings: SavingsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.savings.list(user.workspaceId, user.timezone);
  }

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body(zodPipe(createSavingsPlanSchema)) body: CreateSavingsPlanInput,
  ) {
    return this.savings.create(user.workspaceId, user.id, body, user.timezone);
  }

  @Get(':id')
  findOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.savings.findOne(user.workspaceId, id, user.timezone);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(zodPipe(updateSavingsPlanSchema)) body: UpdateSavingsPlanInput,
  ) {
    return this.savings.update(user.workspaceId, user.id, id, body, user.timezone);
  }

  @Post(':id/installments/:installmentId/pay')
  @HttpCode(200)
  pay(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('installmentId') installmentId: string,
    @Body(zodPipe(payInstallmentSchema)) body: PayInstallmentInput,
  ) {
    return this.savings.payInstallment(
      user.workspaceId,
      user.id,
      id,
      installmentId,
      body,
      user.timezone,
    );
  }

  /** The whole `user`: `TransactionsService.create` wants a `TenantContext`. */
  @Post(':id/profit')
  @HttpCode(201)
  recordProfit(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(zodPipe(recordProfitSchema)) body: RecordProfitInput,
  ) {
    return this.savings.recordProfit(user, id, body);
  }

  @Post(':id/mature')
  @HttpCode(200)
  mature(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(zodPipe(matureSchema)) body: MatureInput,
  ) {
    return this.savings.mature(user, id, body);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.savings.remove(user.workspaceId, user.id, id);
  }
}
