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
import { cuid, isoDate, minorAmount } from '@hishab/shared';
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

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.savings.remove(user.workspaceId, user.id, id);
  }
}
