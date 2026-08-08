import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { cuid, isoDate, minorAmount, positiveMinorAmount } from '@hishab/shared';
import { z } from 'zod';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { zodPipe } from '../common/zod.pipe';
import { LoansService } from './loans.service';

/* Mirrors of the Prisma enums, kept local until loans earn a place in
 * @hishab/shared — the same holding pattern savings uses, so there is one
 * obvious file to move them out of. */
const LOAN_DIRECTIONS = ['LENT', 'BORROWED'] as const;
const LOAN_INTEREST_TYPES = ['NONE', 'FIXED', 'PERCENT'] as const;
const LOAN_STATUSES = ['ACTIVE', 'COMPLETED', 'OVERDUE', 'CANCELLED'] as const;
const PAYMENT_METHODS = ['CASH', 'BANK', 'MOBILE_WALLET', 'CHEQUE', 'CARD', 'OTHER'] as const;
const STATEMENT_PRESETS = [
  'today',
  'yesterday',
  'last7',
  'thisMonth',
  'lastMonth',
  'thisYear',
] as const;

/**
 * A cleared filter arrives as `?direction=` — an empty string, not an absent
 * key. Treating that as "no filter" is the difference between a working
 * "সব" chip and a 400 the user cannot explain.
 */
const optionalQuery = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (value === '' || value === null ? undefined : value), schema.optional());

const attachmentIds = z.array(z.string().min(1).max(200)).max(20);

const listLoansQuerySchema = z.object({
  direction: optionalQuery(z.enum(LOAN_DIRECTIONS)),
  status: optionalQuery(z.enum(LOAN_STATUSES)),
  personId: optionalQuery(cuid),
  /** Smart search: loan number, person name or phone, note, payment reference,
   * and — when it parses as a number — the principal in taka. */
  q: optionalQuery(z.string().max(120)),
  from: optionalQuery(isoDate),
  to: optionalQuery(isoDate),
});
export type ListLoansQuery = z.infer<typeof listLoansQuerySchema>;

const loanFields = z.object({
  /** Either an existing person… */
  personId: cuid.optional(),
  /** …or a name to create one from, so recording a loan is a single screen. */
  personName: z.string().min(1).max(120).optional(),
  personPhone: z.string().max(30).optional(),
  direction: z.enum(LOAN_DIRECTIONS),
  principalMinor: positiveMinorAmount,
  interestType: z.enum(LOAN_INTEREST_TYPES).default('NONE'),
  /** A single agreed sum when interestType is FIXED, poisha. */
  interestMinor: minorAmount.nonnegative().default(0),
  /** Annual rate in basis points when interestType is PERCENT: 8.25% is 825. */
  interestRateBps: z.number().int().min(0).max(100_000).default(0),
  loanDate: isoDate,
  dueDate: isoDate.optional(),
  /** The cash or bank account the principal moves through. */
  accountId: cuid,
  note: z.string().max(2000).optional(),
  attachmentIds: attachmentIds.default([]),
});

const createLoanSchema = loanFields
  .refine((v) => Boolean(v.personId) || Boolean(v.personName?.trim()), {
    message: 'ব্যক্তি নির্বাচন করুন অথবা নাম লিখুন',
    path: ['personId'],
  })
  .refine((v) => !v.dueDate || v.dueDate >= v.loanDate, {
    message: 'ফেরতের তারিখ ঋণের তারিখের আগে হতে পারে না',
    path: ['dueDate'],
  });
export type CreateLoanInput = z.infer<typeof createLoanSchema>;

/**
 * Terms, dates, note and attachments only. The counterparty, the direction and
 * the cash account are fixed once the ledger has booked the disbursement:
 * changing them would rewrite what the books say already happened, and the
 * honest way to do that is to delete the loan and record it again.
 */
const updateLoanSchema = z.object({
  principalMinor: positiveMinorAmount.optional(),
  interestType: z.enum(LOAN_INTEREST_TYPES).optional(),
  interestMinor: minorAmount.nonnegative().optional(),
  interestRateBps: z.number().int().min(0).max(100_000).optional(),
  loanDate: isoDate.optional(),
  /** Explicit null clears the due date. */
  dueDate: isoDate.nullable().optional(),
  note: z.string().max(2000).nullable().optional(),
  attachmentIds: attachmentIds.optional(),
});
export type UpdateLoanInput = z.infer<typeof updateLoanSchema>;

const addPaymentSchema = z.object({
  date: isoDate,
  amountMinor: positiveMinorAmount,
  method: z.enum(PAYMENT_METHODS).default('CASH'),
  /** The cash or bank account the instalment moves through. */
  accountId: cuid,
  referenceNumber: z.string().max(120).optional(),
  note: z.string().max(2000).optional(),
  attachmentIds: attachmentIds.default([]),
});
export type AddLoanPaymentInput = z.infer<typeof addPaymentSchema>;

/** Explicit `from`/`to` win over `preset`; both absent means the whole life. */
const statementQuerySchema = z.object({
  preset: optionalQuery(z.enum(STATEMENT_PRESETS)),
  from: optionalQuery(isoDate),
  to: optionalQuery(isoDate),
});
export type StatementQuery = z.infer<typeof statementQuerySchema>;

@Controller('loans')
@UseGuards(JwtAuthGuard)
export class LoansController {
  constructor(private readonly loans: LoansService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query(zodPipe(listLoansQuerySchema)) query: ListLoansQuery) {
    return this.loans.list(user, query);
  }

  /* Declared before `:id` on purpose. Nest matches routes in declaration
   * order, so a literal segment placed after a parameter would never be
   * reached — `/loans/dashboard` would arrive as a loan id. */
  @Get('dashboard')
  dashboard(@CurrentUser() user: AuthUser) {
    return this.loans.dashboard(user);
  }

  @Get('people/:personId/ledger')
  personLedger(
    @CurrentUser() user: AuthUser,
    @Param('personId') personId: string,
    @Query(zodPipe(statementQuerySchema)) query: StatementQuery,
  ) {
    return this.loans.personLedger(user, personId, query);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body(zodPipe(createLoanSchema)) body: CreateLoanInput) {
    return this.loans.create(user, body);
  }

  @Get(':id')
  findOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.loans.findOne(user, id);
  }

  @Get(':id/statement')
  statement(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query(zodPipe(statementQuerySchema)) query: StatementQuery,
  ) {
    return this.loans.statement(user, id, query);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(zodPipe(updateLoanSchema)) body: UpdateLoanInput,
  ) {
    return this.loans.update(user, id, body);
  }

  @Post(':id/payments')
  addPayment(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(zodPipe(addPaymentSchema)) body: AddLoanPaymentInput,
  ) {
    return this.loans.addPayment(user, id, body);
  }

  @Delete(':id/payments/:paymentId')
  removePayment(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('paymentId') paymentId: string,
  ) {
    return this.loans.removePayment(user, id, paymentId);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.loans.cancel(user, id);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.loans.remove(user, id);
  }
}
