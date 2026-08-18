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
  /**
   * The `SAVINGS` ledger account this instrument's money actually sits in.
   *
   * Optional, and it stays optional. A plan without one behaves exactly as
   * savings plans always have — a schedule, a projection, a status somebody
   * ticks — and only a plan *with* one can offer to book an instalment as a
   * transfer. The note field is still where the account number and the branch
   * go; this is a different thing, and it is only worth setting for somebody
   * who wants the deposits on their balance sheet.
   *
   * `nullish` rather than `optional`, because an edit has to be able to say
   * "unlink it" as well as "leave it alone": omitted keeps the link, `null`
   * removes it. Same three-way rule `Transaction.personId` follows.
   */
  linkedAccountId: cuid.nullish(),
  /**
   * The account each instalment comes *out* of.
   *
   * The other half of the same sentence, and the half a saver actually repeats:
   * a DPS is a standing instruction against one wallet or one salary account,
   * and remembering it is the difference between confirming a deposit and
   * re-picking the source sixty times over five years. Any account will do —
   * this is what the deposit dialog defaults to, not a rule about where money
   * may come from — so unlike `linkedAccountId` it is not type-checked.
   *
   * Same three-way `nullish` rule: omitted keeps it, `null` forgets it.
   */
  sourceAccountId: cuid.nullish(),
  note: z.string().max(2000).optional(),
});

const createSavingsPlanSchema = savingsPlanFields;
export type CreateSavingsPlanInput = z.infer<typeof createSavingsPlanSchema>;

const updateSavingsPlanSchema = savingsPlanFields.partial().extend({
  status: z.enum(SAVINGS_STATUSES).optional(),
});
export type UpdateSavingsPlanInput = z.infer<typeof updateSavingsPlanSchema>;

/**
 * "জমা দিলাম" — the instalment is paid.
 *
 * ## Why `fromAccountId` is what decides whether money moves
 *
 * Marking an instalment paid has never touched the ledger, and it still does
 * not unless the caller names an account for the money to leave. That is the
 * whole switch: no `fromAccountId`, no transaction, exactly the behaviour this
 * endpoint shipped with. Send one and the deposit is booked as a **transfer**
 * out of that account and into the plan's linked savings account.
 *
 * A transfer, never an expense. Putting ৳2,000 into a DPS is one asset becoming
 * another (Conceptual Framework 4.3 — nothing is consumed, nothing is owed);
 * filed as an expense it would understate net worth by every poisha ever saved
 * and overstate the month's spending by the instalment. The owner of these
 * books has ten plans and ৳31,000 across four savings accounts, which is what
 * that error looks like from outside.
 *
 * The plan must have a linked account for this to mean anything, and the
 * service refuses rather than guessing at one.
 */
const payInstallmentSchema = z.object({
  /** Defaults to today in the workspace timezone. Also dates the transfer. */
  paidDate: isoDate.optional(),
  /** A ledger transaction recorded separately, for a caller that has one. */
  transactionId: cuid.optional(),
  /**
   * Where the money left from — the current account, the wallet, cash.
   *
   * Absent means "just mark it": the status flips and the books are untouched.
   */
  fromAccountId: cuid.optional(),
  /**
   * What actually left, when it was not the scheduled amount.
   *
   * Defaults to the instalment's `expectedMinor`. A box rather than a fixed
   * figure because a late instalment collects a penalty and a bank sometimes
   * takes the excise duty out of the same debit — and what gets booked has to
   * be what the statement says, not what the schedule hoped for.
   */
  amountMinor: positiveMinorAmount.optional(),
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

  /** The whole `user`: booking the deposit wants a `TenantContext`. */
  @Post(':id/installments/:installmentId/pay')
  @HttpCode(200)
  pay(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('installmentId') installmentId: string,
    @Body(zodPipe(payInstallmentSchema)) body: PayInstallmentInput,
  ) {
    return this.savings.payInstallment(user, id, installmentId, body);
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
