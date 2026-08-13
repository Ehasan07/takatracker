import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  assertBalanced,
  buildStatement,
  deriveLoanStatus,
  loanInterestMinor,
  nextLoanNumber,
  presetRange,
  searchDocs,
  searchField,
  settlementDate,
  summariseLoan,
  type EntryDraft,
  type LoanPaymentInput,
  type LoanProgress,
  type LoanTerms,
  type SearchBucket,
  type SearchDoc,
} from '@hishab/core';
import {
  formatMinor,
  fromLocalDateString,
  toLocalDateString,
  type EntryDirection,
} from '@hishab/shared';
import { Prisma } from '@prisma/client';
import type {
  Loan,
  LoanDirection,
  LoanInterestType,
  LoanStatus,
  PaymentMethod,
  Person,
  TransactionType,
} from '@prisma/client';
import { AccountsService } from '../accounts/accounts.service';
import { AuditService } from '../audit/audit.service';
import { minorToNumber } from '../common/bigint-json';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../transactions/transactions.service';
import type {
  AddLoanPaymentInput,
  CreateLoanInput,
  ListLoansQuery,
  SearchPeopleQuery,
  StatementQuery,
  UpdateLoanInput,
} from './loans.controller';

/*
 * Audit actions emitted below, all six already present in AUDIT_ACTIONS
 * (../audit/audit.service.ts) and so type-checked rather than cast:
 *   'loan.created', 'loan.updated', 'loan.deleted',
 *   'loan.cancelled', 'loan.payment_added', 'loan.payment_deleted'
 */

/**
 * Loans given and taken.
 *
 * The money never lives here. The workspace has two control accounts — ঋণ পাওনা
 * (RECEIVABLE) and ঋণ দেনা (PAYABLE), made on first use by
 * `AccountsService.loanControlAccount` — and every disbursement and every
 * repayment is an ordinary transfer between the matching one and a cash or bank
 * account. `packages/core/src/reports.ts` classifies by `ACCOUNT_CLASS`, so the
 * principal lands on the balance sheet and in the cash flow statement and is
 * **never** counted as income or expense (spec §12).
 *
 * **Two accounts, not one per loan.** A chart of accounts has a single
 * *Accounts receivable*; করিম and রহিম are rows in its subsidiary ledger, not
 * accounts of their own. Ours is derived rather than stored — `findOne` walks
 * one loan's payments and `personLedger` walks one person's — so a per-loan
 * balance cannot drift from the control account it rolls up into, and the
 * wallet screen never has to show ten accounts because somebody made ten loans.
 *
 * **Principal and interest part company on the way back.** §12 draws its line
 * around the loan, not around the interest, and every serious ledger —
 * QuickBooks, Zoho, Xero — puts the two on opposite sides of it: principal is a
 * balance-sheet movement, interest is a profit-and-loss one. Interest collected
 * on money we lent is income; interest we hand over on money we borrowed is an
 * expense. So a repayment is up to three legs, allocated **interest first, then
 * principal**, and the interest leg carries a category exactly like any other
 * income or expense line. See `repaymentEntries`.
 *
 * The loan row and its ledger side are written in one `$transaction`, so a loan
 * can never exist without the entries that explain where the money went.
 *
 * One shape worth knowing before you read the views: `LoanDetail.statement` is
 * a bare array of rows, not the `{ openingMinor, rows, closingMinor }` envelope
 * — the whole-life opening balance is always zero, so the envelope belongs to
 * `GET /loans/:id/statement`, where a date window makes it mean something.
 */

// --- views -------------------------------------------------------------------

export interface PersonView {
  id: string;
  name: string;
  phone: string | null;
  relation: string | null;
  note: string | null;
}

/** One row of the counterparty picker. */
export interface PersonSearchHit extends PersonView {
  /**
   * Loans with this person that still mean something. Soft-deleted and
   * cancelled ones are left out, so the number agrees with the party ledger the
   * picker is about to open rather than promising rows that are not there.
   */
  loanCount: number;
  /**
   * `suggestion` is a did-you-mean, not a match: the query missed every field
   * and only the fuzzy rungs reached this person. It is on the row because the
   * UI has to be able to say so instead of presenting a guess as an answer.
   */
  bucket: SearchBucket;
}

export interface PersonSearchResponse {
  /**
   * False when `q` was absent or too short to be a filter — `people` is then
   * the plain workspace list, oldest first, not a search result.
   */
  filtered: boolean;
  people: PersonSearchHit[];
}

export interface LoanPaymentView {
  id: string;
  date: string;
  amountMinor: number;
  method: PaymentMethod;
  accountId: string;
  accountName: string;
  referenceNumber: string | null;
  note: string | null;
  attachmentIds: string[];
  transactionId: string | null;
  createdAt: string;
}

export interface LoanView {
  id: string;
  loanNumber: string;
  direction: LoanDirection;
  personId: string;
  personName: string;
  personPhone: string | null;
  principalMinor: number;
  interestType: LoanInterestType;
  /** The *agreed* lump sum when interestType is FIXED — what the form holds. */
  interestMinor: number;
  interestRateBps: number;
  /** What the terms have actually produced as of today. */
  accruedInterestMinor: number;
  loanDate: string;
  dueDate: string | null;
  /** The cash or bank account the principal moved through. */
  accountId: string;
  accountName: string;
  /** The workspace's shared ঋণ পাওনা / ঋণ দেনা control account. */
  loanAccountId: string;
  loanAccountName: string;
  /** The disbursement transaction. */
  transactionId: string | null;
  note: string | null;
  attachmentIds: string[];
  /** Recomputed on every read, so a loan goes OVERDUE without a cron. */
  status: LoanStatus;
  progress: LoanProgress;
  createdAt: string;
}

export interface StatementRowView {
  date: string;
  description: string;
  debitMinor: number;
  creditMinor: number;
  balanceMinor: number;
  method: PaymentMethod | null;
  referenceNumber: string | null;
}

export interface PartyLedgerRowView extends StatementRowView {
  /** Null on a row that came from shared spending rather than from a loan. */
  loanId: string | null;
  loanNumber: string | null;
  direction: LoanDirection | null;
  /** Set on a row that came from a split group, so the screen can name it. */
  groupId?: string | null;
  groupName?: string | null;
}

export interface LoanDetail {
  loan: LoanView;
  person: PersonView;
  progress: LoanProgress;
  payments: LoanPaymentView[];
  /** Whole life of the loan, oldest first. */
  statement: StatementRowView[];
}

export interface LoanStatementResponse {
  openingMinor: number;
  rows: StatementRowView[];
  closingMinor: number;
  loan: LoanView;
  person: PersonView;
  /** The resolved window, so the UI can label what it is showing. */
  from: string | null;
  to: string | null;
}

export interface LoanBucket {
  totalMinor: number;
  repaidMinor: number;
  outstandingMinor: number;
  overdueMinor: number;
  upcomingMinor: number;
  count: number;
}

export interface LoanDashboard {
  borrowed: LoanBucket;
  lent: LoanBucket;
}

export interface PartyLedgerLoanSubtotal {
  loanId: string;
  loanNumber: string;
  direction: LoanDirection;
  status: LoanStatus;
  loanDate: string;
  dueDate: string | null;
  principalMinor: number;
  totalPayableMinor: number;
  paidMinor: number;
  outstandingMinor: number;
  /** Outstanding signed the party way: + they owe us, − we owe them. */
  signedOutstandingMinor: number;
}

export interface PartyLedgerResponse {
  person: PersonView;
  from: string | null;
  to: string | null;
  openingMinor: number;
  rows: PartyLedgerRowView[];
  closingMinor: number;
  loans: PartyLedgerLoanSubtotal[];
  /** + the person owes the user, − the user owes the person. Includes interest. */
  netPositionMinor: number;
  receivableMinor: number;
  payableMinor: number;
}

// --- local helpers -----------------------------------------------------------

const CURRENCY = 'BDT';

/** How far ahead a due date still counts as "coming up" on the dashboard. */
const UPCOMING_WINDOW_DAYS = 30;

/** A picker shows a handful of rows. The controller's `limit` raises this. */
const DEFAULT_PEOPLE_RESULTS = 20;

const pad = (value: number, width: number): string => String(value).padStart(width, '0');

/** YYYY-MM-DD from a Date's *local* calendar components. */
function localCalendarDate(date: Date): string {
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)}`;
}

/**
 * A Date whose *local* components are that calendar day at midnight.
 *
 * `@hishab/core`'s loan maths reads dates by their local calendar day — that is
 * what makes "one day old" mean one day. Handing it the raw UTC instant out of
 * Postgres would read the day in whatever timezone the server happens to run
 * in, so every date crosses this boundary as the workspace's own calendar day
 * first and becomes an instant again only on the way back to the database.
 */
function calendarDay(isoDate: string): Date {
  const year = Number(isoDate.slice(0, 4));
  const month = Number(isoDate.slice(5, 7));
  const day = Number(isoDate.slice(8, 10));
  return new Date(year, month - 1, day, 0, 0, 0, 0);
}

function addCalendarDays(isoDate: string, days: number): string {
  const moved = calendarDay(isoDate);
  moved.setDate(moved.getDate() + days);
  return localCalendarDate(moved);
}

function taka(minor: number): string {
  return formatMinor(minor, { bengaliNumerals: true });
}

/** Income when they pay us interest, expense when we are the ones paying it. */
const INTEREST_CATEGORY = {
  LENT: { kind: 'INCOME', name: 'ঋণের সুদ' },
  BORROWED: { kind: 'EXPENSE', name: 'সুদ ব্যয়' },
} as const;

/** Interest categories sort below the ones the user set up for themselves. */
const INTEREST_CATEGORY_SORT_ORDER = 950;

interface LedgerPair {
  type: TransactionType;
  debitAccountId: string;
  creditAccountId: string;
}

const draft = (
  accountId: string,
  direction: EntryDirection,
  amountMinor: number,
  categoryId?: string | null,
): EntryDraft => ({
  accountId,
  direction,
  amountMinor,
  currency: CURRENCY,
  fxRate: 1,
  categoryId,
});

/**
 * Lent: the receivable grows and the cash leaves. Borrowed: the cash arrives
 * and the payable grows. Both are plain transfers — no nominal account is
 * touched, which is precisely why loans never show up as income or expense.
 */
function disbursementPair(
  direction: LoanDirection,
  cashAccountId: string,
  controlAccountId: string,
): LedgerPair {
  return direction === 'LENT'
    ? { type: 'LOAN_GIVEN', debitAccountId: controlAccountId, creditAccountId: cashAccountId }
    : { type: 'BORROWED', debitAccountId: cashAccountId, creditAccountId: controlAccountId };
}

function entriesFor(pair: LedgerPair, amountMinor: number): EntryDraft[] {
  const entries: EntryDraft[] = [
    draft(pair.debitAccountId, 'DEBIT', amountMinor),
    draft(pair.creditAccountId, 'CREDIT', amountMinor),
  ];
  // Belt and braces: the pair says it balances, the DB trigger will say so too.
  assertBalanced(entries);
  return entries;
}

/** How one repayment divides. Interest first, then whatever is left. */
interface RepaymentSplit {
  interestMinor: number;
  principalMinor: number;
}

interface RepaymentAccounts {
  cashAccountId: string;
  controlAccountId: string;
  /** SYSTEM_INCOME when they repay us, SYSTEM_EXPENSE when we repay them. */
  nominalAccountId: string;
  interestCategoryId: string | null;
}

/**
 * A repayment, in up to three legs.
 *
 * They repay us: DR cash for the whole amount, CR the receivable for the
 * principal part, CR income for the interest part. We repay them: the mirror —
 * CR cash for the whole amount, DR the payable, DR expense.
 *
 * Cash always moves by the full amount, which is the leg the user typed. Only
 * the split behind it decides how much of that was the debt coming back and how
 * much was the cost of the loan. A leg worth nothing is left out entirely: an
 * interest-free loan is two legs, exactly as it was before interest existed
 * here, and a payment that is pure interest has no principal leg at all.
 */
function repaymentEntries(
  direction: LoanDirection,
  accounts: RepaymentAccounts,
  split: RepaymentSplit,
): { type: TransactionType; entries: EntryDraft[] } {
  const totalMinor = split.principalMinor + split.interestMinor;
  const cashSide: EntryDirection = direction === 'LENT' ? 'DEBIT' : 'CREDIT';
  const otherSide: EntryDirection = direction === 'LENT' ? 'CREDIT' : 'DEBIT';

  const entries: EntryDraft[] = [draft(accounts.cashAccountId, cashSide, totalMinor)];
  if (split.principalMinor > 0) {
    entries.push(draft(accounts.controlAccountId, otherSide, split.principalMinor));
  }
  if (split.interestMinor > 0) {
    entries.push(
      draft(accounts.nominalAccountId, otherSide, split.interestMinor, accounts.interestCategoryId),
    );
  }

  assertBalanced(entries);
  return {
    type: direction === 'LENT' ? 'LOAN_REPAID' : 'BORROW_REPAID',
    entries,
  };
}

/**
 * Only the interest leg ever carries a category: the principal moving between
 * a control account and a bank account is not a category of anything.
 */
function entryData(
  entry: EntryDraft,
  workspaceId: string,
): Prisma.LedgerEntryCreateWithoutTransactionInput {
  return {
    workspace: { connect: { id: workspaceId } },
    account: { connect: { id: entry.accountId } },
    category: entry.categoryId ? { connect: { id: entry.categoryId } } : undefined,
    amountMinor: BigInt(entry.amountMinor),
    direction: entry.direction,
    currency: entry.currency,
    fxRate: entry.fxRate,
  };
}

function disbursementDescription(
  direction: LoanDirection,
  personName: string,
  loanNumber: string,
): string {
  const verb = direction === 'LENT' ? 'ধার দেওয়া' : 'ধার নেওয়া';
  return `${verb} — ${personName} (#${loanNumber})`;
}

function repaymentDescription(
  direction: LoanDirection,
  personName: string,
  loanNumber: string,
): string {
  const verb = direction === 'LENT' ? 'ধার ফেরত পাওয়া' : 'ধার পরিশোধ';
  return `${verb} — ${personName} (#${loanNumber})`;
}

const loanInclude = {
  person: true,
  account: { select: { id: true, name: true } },
  loanAccount: { select: { id: true, name: true, type: true } },
  payments: {
    orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
    include: { account: { select: { id: true, name: true } } },
  },
} satisfies Prisma.LoanInclude;

type LoanRow = Prisma.LoanGetPayload<{ include: typeof loanInclude }>;
type PaymentRow = LoanRow['payments'][number];

/** One dated movement of the debt, before it becomes a statement row. */
interface Movement {
  isoDate: string;
  description: string;
  /** Positive increases what is owed, negative reduces it. */
  deltaMinor: number;
  method: PaymentMethod | null;
  referenceNumber: string | null;
  /** Null when the movement came from shared spending rather than a loan. */
  loanId: string | null;
  loanNumber: string | null;
  direction: LoanDirection | null;
  groupId?: string | null;
  groupName?: string | null;
}

@Injectable()
export class LoansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountsService,
    private readonly audit: AuditService,
  ) {}

  // --- reads -----------------------------------------------------------------

  async list(ctx: TenantContext, query: ListLoansQuery): Promise<LoanView[]> {
    const where: Prisma.LoanWhereInput = {
      workspaceId: ctx.workspaceId,
      deletedAt: null,
      ...(query.direction ? { direction: query.direction } : {}),
      ...(query.personId ? { personId: query.personId } : {}),
      ...(query.from || query.to
        ? {
            loanDate: {
              ...(query.from ? { gte: fromLocalDateString(query.from, ctx.timezone) } : {}),
              ...(query.to
                ? {
                    lt: new Date(
                      fromLocalDateString(query.to, ctx.timezone).getTime() + 86_400_000,
                    ),
                  }
                : {}),
            },
          }
        : {}),
    };

    const rows = await this.prisma.loan.findMany({
      where,
      include: loanInclude,
      orderBy: [{ loanDate: 'desc' }, { createdAt: 'desc' }],
    });

    /* `q` is applied here rather than in the WHERE clause, and that move is the
     * whole change. Postgres `contains` can only find the bytes that were
     * typed: it will never take `karim` to করিম, and `korim` matches neither
     * spelling. Getting there means transliterating and folding both sides,
     * which no index can do — so the rows come back and are matched in memory.
     *
     * Direction, person and the date window still narrow in SQL first, and a
     * workspace's loans are human-sized: this is a list somebody scrolls, not a
     * table somebody mines. The cost of loading them is the cost of the
     * unfiltered list this endpoint already serves. */
    const matched = LoansService.searchLoans(rows, query.q);
    const views = await this.presentMany(ctx, matched);
    /* Status is derived, so it cannot be a SQL filter without trusting a column
     * that may be a day stale. Filtering the derived value is the only way a
     * "OVERDUE" chip can be honest the morning a due date passes. */
    return query.status ? views.filter((view) => view.status === query.status) : views;
  }

  async dashboard(ctx: TenantContext): Promise<LoanDashboard> {
    /* Cancelled loans are excluded outright: the two people called the thing
     * off, and counting it would inflate every figure on the card. Settled
     * loans stay in, so "মোট" and "ফেরত" read as lifetime totals and
     * "বাকি" falls to zero on its own. `count` covers exactly the same
     * population, so the four numbers always describe one set of loans. */
    const rows = await this.prisma.loan.findMany({
      where: { workspaceId: ctx.workspaceId, deletedAt: null, status: { not: 'CANCELLED' } },
      include: loanInclude,
    });

    const today = LoansService.today(ctx.timezone);
    const todayIso = localCalendarDate(today);
    const horizonIso = addCalendarDays(todayIso, UPCOMING_WINDOW_DAYS);

    const empty = (): LoanBucket => ({
      totalMinor: 0,
      repaidMinor: 0,
      outstandingMinor: 0,
      overdueMinor: 0,
      upcomingMinor: 0,
      count: 0,
    });
    const buckets: LoanDashboard = { borrowed: empty(), lent: empty() };

    for (const row of rows) {
      const terms = LoansService.terms(row, ctx.timezone);
      const progress = summariseLoan(terms, LoansService.paymentInputs(row, ctx.timezone), today);
      const bucket = row.direction === 'LENT' ? buckets.lent : buckets.borrowed;

      bucket.totalMinor += progress.totalPayableMinor;
      bucket.repaidMinor += progress.paidMinor;
      bucket.outstandingMinor += progress.outstandingMinor;
      bucket.count += 1;

      if (deriveLoanStatus(progress) === 'OVERDUE') {
        bucket.overdueMinor += progress.outstandingMinor;
        continue;
      }
      // Coming up: due inside the window, still owed, and not already late.
      const dueIso = row.dueDate ? toLocalDateString(row.dueDate, ctx.timezone) : null;
      if (dueIso && dueIso <= horizonIso && progress.outstandingMinor > 0) {
        bucket.upcomingMinor += progress.outstandingMinor;
      }
    }

    return buckets;
  }

  async findOne(ctx: TenantContext, id: string): Promise<LoanDetail> {
    const row = await this.requireLoan(ctx.workspaceId, id);
    const [loan] = await this.presentMany(ctx, [row]);

    const todayIso = localCalendarDate(LoansService.today(ctx.timezone));
    const movements = LoansService.movementsFor(row, ctx.timezone, todayIso, false);
    const statement = LoansService.statementRows(0, movements);

    return {
      loan,
      person: LoansService.presentPerson(row.person),
      progress: loan.progress,
      payments: row.payments.map((p) => LoansService.presentPayment(p, ctx.timezone)),
      statement: statement.rows,
    };
  }

  async statement(
    ctx: TenantContext,
    id: string,
    query: StatementQuery,
  ): Promise<LoanStatementResponse> {
    const row = await this.requireLoan(ctx.workspaceId, id);
    const [loan] = await this.presentMany(ctx, [row]);
    const range = LoansService.resolveRange(query, ctx.timezone);

    const todayIso = localCalendarDate(LoansService.today(ctx.timezone));
    const movements = LoansService.movementsFor(row, ctx.timezone, todayIso, false);
    const { opening, inRange } = LoansService.splitByRange(movements, range);
    const built = LoansService.statementRows(opening, inRange);

    return {
      openingMinor: built.openingMinor,
      rows: built.rows,
      closingMinor: built.closingMinor,
      loan,
      person: LoansService.presentPerson(row.person),
      from: range.from,
      to: range.to,
    };
  }

  /**
   * The counterparty picker: the workspace's people, ranked by the same matcher
   * as the loan list.
   *
   * Read-only, and until now there was no way to find a person at all without
   * already knowing a loan they were on — `GET /loans/people/:personId/ledger`
   * needs an id the client had nowhere to get.
   *
   * The matching matters more here than in the list. This endpoint is what lets
   * a client send `personId` instead of `personName`, and every time it does,
   * `resolvePerson` never has to guess. A picker that cannot find করিম when the
   * user types `karim` is exactly how a workspace ends up with two করিমs — and
   * a party ledger split in two is wrong on both halves while looking right on
   * each. Suggestions stay on for that reason: a near-miss offered as a
   * near-miss is far better than a silent second person.
   *
   * Workspace-scoped in the only two queries it runs. Nothing here takes an id
   * from the caller, so there is no second path in and no way to reach another
   * workspace's contacts by guessing one.
   */
  async searchPeople(ctx: TenantContext, query: SearchPeopleQuery): Promise<PersonSearchResponse> {
    const [people, loanCounts] = await Promise.all([
      this.prisma.person.findMany({
        where: { workspaceId: ctx.workspaceId, deletedAt: null },
        orderBy: { createdAt: 'asc' },
      }),
      /* Cancelled loans are left out for the reason the party ledger leaves
       * them out: the two people called the thing off, and it owes nothing. */
      this.prisma.loan.groupBy({
        by: ['personId'],
        where: {
          workspaceId: ctx.workspaceId,
          deletedAt: null,
          status: { not: 'CANCELLED' },
        },
        _count: { _all: true },
      }),
    ]);

    const counts = new Map(loanCounts.map((group) => [group.personId, group._count._all]));

    const docs: SearchDoc<Person>[] = people.map((person, index) => ({
      id: person.id,
      row: person,
      /* createdAt ascending — the same "oldest wins" order `resolvePerson` uses
       * to decide identity, so two people a query cannot separate come back in
       * the order the one that owns the history comes first. */
      order: index,
      fields: [
        searchField('name', 'PRIMARY', person.name),
        searchField('phone', 'SECONDARY', person.phone),
        /* Relation and note are how someone finds the cousin whose name they
         * cannot spell. Below the name, never instead of it. */
        searchField('relation', 'SECONDARY', person.relation),
        searchField('note', 'FREE', person.note),
      ],
    }));

    const result = searchDocs(docs, query.q ?? '');
    /* Suggestions come after every real match, never mixed in, and `bucket`
     * survives onto the row so the client cannot lose the distinction. `hits`
     * is already the whole list when the query was not a filter. */
    const ranked = [...result.hits, ...result.suggestions].slice(
      0,
      query.limit ?? DEFAULT_PEOPLE_RESULTS,
    );

    return {
      filtered: result.filtered,
      people: ranked.map((hit) => ({
        ...LoansService.presentPerson(hit.row),
        loanCount: counts.get(hit.row.id) ?? 0,
        bucket: hit.bucket,
      })),
    };
  }

  /**
   * Everything owed either way with one person, on one running balance.
   *
   * Signed the way a party ledger reads: a loan we gave pushes the balance up
   * (they owe us), one we took pushes it down. So the closing figure answers
   * "where do the two of us stand" in a single number, which is the question
   * someone actually has before they pick up the phone.
   */
  async personLedger(
    ctx: TenantContext,
    personId: string,
    query: StatementQuery,
  ): Promise<PartyLedgerResponse> {
    const person = await this.prisma.person.findFirst({
      where: { id: personId, workspaceId: ctx.workspaceId, deletedAt: null },
    });
    if (!person) throw new NotFoundException('ব্যক্তি পাওয়া যায়নি');

    const rows = await this.prisma.loan.findMany({
      where: { workspaceId: ctx.workspaceId, personId: person.id, deletedAt: null },
      include: loanInclude,
      orderBy: [{ loanDate: 'asc' }, { createdAt: 'asc' }],
    });

    const today = LoansService.today(ctx.timezone);
    const todayIso = localCalendarDate(today);
    const range = LoansService.resolveRange(query, ctx.timezone);

    const movements: Movement[] = [];
    const subtotals: PartyLedgerLoanSubtotal[] = [];
    let receivableMinor = 0;
    let payableMinor = 0;

    for (const row of rows) {
      // Cancelled loans were reversed out of the ledger; they owe nothing.
      if (row.status === 'CANCELLED') continue;
      movements.push(...LoansService.movementsFor(row, ctx.timezone, todayIso, true));

      const terms = LoansService.terms(row, ctx.timezone);
      const progress = summariseLoan(terms, LoansService.paymentInputs(row, ctx.timezone), today);
      const sign = row.direction === 'LENT' ? 1 : -1;

      if (row.direction === 'LENT') receivableMinor += progress.outstandingMinor;
      else payableMinor += progress.outstandingMinor;

      subtotals.push({
        loanId: row.id,
        loanNumber: row.loanNumber,
        direction: row.direction,
        status: deriveLoanStatus(progress),
        loanDate: toLocalDateString(row.loanDate, ctx.timezone),
        dueDate: row.dueDate ? toLocalDateString(row.dueDate, ctx.timezone) : null,
        principalMinor: minorToNumber(row.principalMinor),
        totalPayableMinor: progress.totalPayableMinor,
        paidMinor: progress.paidMinor,
        outstandingMinor: progress.outstandingMinor,
        signedOutstandingMinor: sign * progress.outstandingMinor,
      });
    }

    /* Shared spending sits in the same control accounts as lending, so it
     * belongs in the same ledger. A person who owes you ৳2,000 from a trip and
     * ৳5,000 from a loan owes you ৳7,000, and being shown two screens that each
     * tell half of that is how somebody asks for the wrong amount back. */
    const shared = await this.sharedMovements(ctx, person.id);
    movements.push(...shared.movements);
    receivableMinor += shared.receivableMinor;
    payableMinor += shared.payableMinor;
    movements.sort((a, b) => a.isoDate.localeCompare(b.isoDate));

    const { opening, inRange } = LoansService.splitByRange(movements, range);
    const built = LoansService.statementRows(opening, inRange);

    return {
      person: LoansService.presentPerson(person),
      from: range.from,
      to: range.to,
      openingMinor: built.openingMinor,
      rows: built.rows.map((row, index) => {
        const source = inRange[index] as Movement;
        return {
          ...row,
          loanId: source.loanId,
          loanNumber: source.loanNumber,
          direction: source.direction,
          groupId: source.groupId ?? null,
          groupName: source.groupName ?? null,
        };
      }),
      closingMinor: built.closingMinor,
      loans: subtotals,
      /* Over the whole life of every loan this equals `closingMinor` above:
       * both are principal plus interest less what has come back, one summed
       * per loan and one walked down the rows. They part company only when a
       * date window clips the rows, which is the window doing its job. */
      netPositionMinor: receivableMinor - payableMinor,
      receivableMinor,
      payableMinor,
    };
  }

  /**
   * What one person owes, or is owed, from shared bills rather than from loans.
   *
   * The party ledger is a subsidiary ledger of the receivable and payable
   * control accounts. Splitting posts to exactly those accounts — deliberately,
   * because a share of a restaurant bill is money owed in precisely the way a
   * loan is — so its rows belong here beside the loans, on one running balance.
   *
   * Signs follow the rest of this file: positive means the person owes the
   * workspace owner.
   *
   *  - the owner paid, and this person had a share → they owe it
   *  - this person paid, and the owner had a share → the owner owes it
   *  - a settlement moves the balance towards zero from whichever side paid
   *
   * Bills between two *other* members never appear: they are a fact about a
   * group, not about the owner's books, and they post no entry anywhere.
   */
  private async sharedMovements(
    ctx: TenantContext,
    personId: string,
  ): Promise<{ movements: Movement[]; receivableMinor: number; payableMinor: number }> {
    const memberships = await this.prisma.splitGroupMember.findMany({
      where: { workspaceId: ctx.workspaceId, personId },
      select: { id: true, groupId: true, group: { select: { id: true, name: true } } },
    });
    if (memberships.length === 0) {
      return { movements: [], receivableMinor: 0, payableMinor: 0 };
    }

    const memberIds = memberships.map((m) => m.id);
    const groupIds = [...new Set(memberships.map((m) => m.groupId))];
    const groupName = new Map(memberships.map((m) => [m.groupId, m.group.name]));

    const [expenses, settlements, selves] = await Promise.all([
      this.prisma.sharedExpense.findMany({
        where: { workspaceId: ctx.workspaceId, groupId: { in: groupIds }, deletedAt: null },
        select: {
          id: true,
          groupId: true,
          date: true,
          description: true,
          payerMemberId: true,
          shares: { select: { memberId: true, amountMinor: true } },
        },
      }),
      this.prisma.splitSettlement.findMany({
        where: { workspaceId: ctx.workspaceId, groupId: { in: groupIds }, deletedAt: null },
        select: {
          id: true,
          groupId: true,
          date: true,
          amountMinor: true,
          fromMemberId: true,
          toMemberId: true,
        },
      }),
      this.prisma.splitGroupMember.findMany({
        where: { workspaceId: ctx.workspaceId, groupId: { in: groupIds }, isSelf: true },
        select: { id: true, groupId: true },
      }),
    ]);

    const selfByGroup = new Map(selves.map((s) => [s.groupId, s.id]));
    const theirs = new Set(memberIds);
    const movements: Movement[] = [];
    let receivableMinor = 0;
    let payableMinor = 0;

    for (const expense of expenses) {
      const selfId = selfByGroup.get(expense.groupId);
      const name = groupName.get(expense.groupId) ?? '';
      const theirShare = expense.shares.find((s) => theirs.has(s.memberId));
      const myShare = expense.shares.find((s) => s.memberId === selfId);

      if (expense.payerMemberId === selfId && theirShare) {
        const amount = minorToNumber(theirShare.amountMinor);
        receivableMinor += amount;
        movements.push({
          isoDate: toLocalDateString(expense.date, ctx.timezone),
          description: `${expense.description} — ${name}`,
          deltaMinor: amount,
          method: null,
          referenceNumber: null,
          loanId: null,
          loanNumber: null,
          direction: null,
          groupId: expense.groupId,
          groupName: name,
        });
      } else if (theirs.has(expense.payerMemberId) && myShare) {
        const amount = minorToNumber(myShare.amountMinor);
        payableMinor += amount;
        movements.push({
          isoDate: toLocalDateString(expense.date, ctx.timezone),
          description: `${expense.description} — ${name}`,
          deltaMinor: -amount,
          method: null,
          referenceNumber: null,
          loanId: null,
          loanNumber: null,
          direction: null,
          groupId: expense.groupId,
          groupName: name,
        });
      }
    }

    for (const settlement of settlements) {
      const selfId = selfByGroup.get(settlement.groupId);
      const name = groupName.get(settlement.groupId) ?? '';
      const amount = minorToNumber(settlement.amountMinor);

      if (theirs.has(settlement.fromMemberId) && settlement.toMemberId === selfId) {
        receivableMinor -= amount;
        movements.push({
          isoDate: toLocalDateString(settlement.date, ctx.timezone),
          description: `পরিশোধ — ${name}`,
          deltaMinor: -amount,
          method: null,
          referenceNumber: null,
          loanId: null,
          loanNumber: null,
          direction: null,
          groupId: settlement.groupId,
          groupName: name,
        });
      } else if (settlement.fromMemberId === selfId && theirs.has(settlement.toMemberId)) {
        payableMinor -= amount;
        movements.push({
          isoDate: toLocalDateString(settlement.date, ctx.timezone),
          description: `পরিশোধ — ${name}`,
          deltaMinor: amount,
          method: null,
          referenceNumber: null,
          loanId: null,
          loanNumber: null,
          direction: null,
          groupId: settlement.groupId,
          groupName: name,
        });
      }
    }

    return { movements, receivableMinor, payableMinor };
  }

  // --- writes ----------------------------------------------------------------

  async create(ctx: TenantContext, input: CreateLoanInput): Promise<LoanDetail> {
    const cashAccount = await this.requireCashAccount(ctx.workspaceId, input.accountId);
    const existingPerson = input.personId
      ? await this.requirePerson(ctx.workspaceId, input.personId)
      : null;

    /* The schema already refuses a body with neither, but the service must not
     * depend on a caller's validation to know whose loan this is. */
    const personName = existingPerson?.name ?? input.personName?.trim();
    if (!personName) throw new BadRequestException('ব্যক্তি নির্বাচন করুন অথবা নাম লিখুন');

    const loanNumber = await this.nextLoanNumber(ctx.workspaceId);
    const loanDate = fromLocalDateString(input.loanDate, ctx.timezone);
    const principalMinor = input.principalMinor;

    /* The workspace's one receivable or one payable, made on first use. Resolved
     * before the write rather than inside it: it belongs to the workspace, not
     * to this loan, so a loan that fails to save must not undo it. */
    const controlAccountId = await this.accounts.loanControlAccount(
      ctx.workspaceId,
      input.direction,
    );

    const created = await this.runWithLoanNumberGuard(() =>
      this.prisma.$transaction(async (tx) => {
        /* Resolving the person inside the same write is what lets someone
         * record a loan without first visiting a contacts screen — and means a
         * failed loan leaves no orphan behind. An explicit `personId` is taken
         * at its word; only a typed name goes looking. */
        const person =
          existingPerson ??
          (await LoansService.resolvePerson(tx, ctx.workspaceId, personName, input.personPhone));

        const pair = disbursementPair(input.direction, cashAccount.id, controlAccountId);
        const entries = entriesFor(pair, principalMinor);

        const transaction = await tx.transaction.create({
          data: {
            workspaceId: ctx.workspaceId,
            createdByUserId: ctx.id,
            date: loanDate,
            type: pair.type,
            description: disbursementDescription(input.direction, person.name, loanNumber),
            notes: input.note,
            personId: person.id,
            attachmentIds: input.attachmentIds,
            source: 'MANUAL',
            entries: { create: entries.map((e) => entryData(e, ctx.workspaceId)) },
          },
        });

        return tx.loan.create({
          data: {
            workspaceId: ctx.workspaceId,
            loanNumber,
            personId: person.id,
            direction: input.direction,
            principalMinor: BigInt(principalMinor),
            interestType: input.interestType,
            interestMinor: BigInt(input.interestMinor),
            interestRateBps: input.interestRateBps,
            loanDate,
            dueDate: input.dueDate ? fromLocalDateString(input.dueDate, ctx.timezone) : null,
            accountId: cashAccount.id,
            loanAccountId: controlAccountId,
            transactionId: transaction.id,
            note: input.note,
            attachmentIds: input.attachmentIds,
          },
        });
      }),
    );

    this.audit.emit({
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.id,
      action: 'loan.created',
      entity: 'Loan',
      entityId: created.id,
      after: {
        loanNumber,
        direction: created.direction,
        principalMinor,
        personId: created.personId,
        accountId: created.accountId,
        loanAccountId: created.loanAccountId,
        transactionId: created.transactionId,
      },
    });

    return this.findOne(ctx, created.id);
  }

  async update(ctx: TenantContext, id: string, input: UpdateLoanInput): Promise<LoanDetail> {
    const existing = await this.requireLoan(ctx.workspaceId, id);

    const principalMinor = input.principalMinor ?? minorToNumber(existing.principalMinor);
    const loanDateIso = input.loanDate ?? toLocalDateString(existing.loanDate, ctx.timezone);
    const dueDateIso =
      input.dueDate === undefined
        ? existing.dueDate
          ? toLocalDateString(existing.dueDate, ctx.timezone)
          : null
        : input.dueDate;

    if (dueDateIso && dueDateIso < loanDateIso) {
      throw new BadRequestException('ফেরতের তারিখ ঋণের তারিখের আগে হতে পারে না');
    }

    const principalChanged = principalMinor !== minorToNumber(existing.principalMinor);
    const loanDateChanged = loanDateIso !== toLocalDateString(existing.loanDate, ctx.timezone);

    /* Checked on every edit, not only when the principal moves: dropping the
     * rate, shortening the term or pulling the due date back all shrink what is
     * payable just as surely. Letting any of them fall below what has already
     * come back would credit the control account past zero — a receivable owing
     * money the wrong way — and would break the invariant the whole statement
     * rests on, that a statement's closing balance is what is still owed. */
    const nextTerms: LoanTerms = {
      principalMinor,
      interestType: input.interestType ?? existing.interestType,
      interestMinor: input.interestMinor ?? minorToNumber(existing.interestMinor),
      interestRateBps: input.interestRateBps ?? existing.interestRateBps,
      loanDate: calendarDay(loanDateIso),
      dueDate: dueDateIso ? calendarDay(dueDateIso) : null,
    };
    const today = LoansService.today(ctx.timezone);
    /* Compared against what `summariseLoan` will actually report, not against
     * the payable figure as of today. On a settled loan those differ: core
     * freezes the interest clock on the settlement day, and softening the terms
     * can move that day *earlier*, turning a later instalment into an
     * overpayment. Only the frozen figure catches that. */
    const nextProgress = summariseLoan(
      nextTerms,
      LoansService.paymentInputs(existing, ctx.timezone),
      today,
    );

    if (nextProgress.paidMinor > nextProgress.totalPayableMinor) {
      throw new BadRequestException(
        `এই ঋণে ইতিমধ্যে ${taka(nextProgress.paidMinor)} জমা পড়েছে — মোট পাওনা তার চেয়ে কম করা যাবে না`,
      );
    }

    const loanDate = fromLocalDateString(loanDateIso, ctx.timezone);

    await this.prisma.$transaction(async (tx) => {
      if (principalChanged || loanDateChanged) {
        /* Rewriting terms without rewriting the entries would leave the loan
         * and the books telling different stories, so both move together or
         * neither does. */
        if (!existing.transactionId) {
          throw new BadRequestException(
            'এই ঋণের মূল লেনদেনটি খুঁজে পাওয়া যায়নি, তাই আসল টাকা বা তারিখ বদলানো যাচ্ছে না — ঋণটি মুছে নতুন করে যোগ করুন',
          );
        }
        const disbursement = await tx.transaction.findFirst({
          where: {
            id: existing.transactionId,
            workspaceId: ctx.workspaceId,
            deletedAt: null,
          },
          select: { id: true },
        });
        if (!disbursement) {
          throw new BadRequestException(
            'এই ঋণের মূল লেনদেনটি খুঁজে পাওয়া যায়নি, তাই আসল টাকা বা তারিখ বদলানো যাচ্ছে না — ঋণটি মুছে নতুন করে যোগ করুন',
          );
        }

        const pair = disbursementPair(
          existing.direction,
          existing.accountId,
          existing.loanAccountId,
        );
        const entries = entriesFor(pair, principalMinor);

        await tx.ledgerEntry.deleteMany({ where: { transactionId: disbursement.id } });
        await tx.transaction.update({
          where: { id: disbursement.id },
          data: {
            date: loanDate,
            notes: input.note === undefined ? undefined : input.note,
            attachmentIds: input.attachmentIds,
            entries: { create: entries.map((e) => entryData(e, ctx.workspaceId)) },
          },
        });
      } else if (input.note !== undefined || input.attachmentIds !== undefined) {
        await tx.transaction.updateMany({
          where: {
            id: existing.transactionId ?? '',
            workspaceId: ctx.workspaceId,
            deletedAt: null,
          },
          data: {
            notes: input.note === undefined ? undefined : input.note,
            attachmentIds: input.attachmentIds,
          },
        });
      }

      await tx.loan.update({
        where: { id: existing.id },
        data: {
          principalMinor: BigInt(principalMinor),
          interestType: input.interestType,
          interestMinor:
            input.interestMinor === undefined ? undefined : BigInt(input.interestMinor),
          interestRateBps: input.interestRateBps,
          loanDate,
          dueDate: dueDateIso ? fromLocalDateString(dueDateIso, ctx.timezone) : null,
          note: input.note === undefined ? undefined : input.note,
          attachmentIds: input.attachmentIds,
        },
      });
    });

    this.audit.emit({
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.id,
      action: 'loan.updated',
      entity: 'Loan',
      entityId: existing.id,
      before: {
        principalMinor: minorToNumber(existing.principalMinor),
        interestType: existing.interestType,
        interestMinor: minorToNumber(existing.interestMinor),
        interestRateBps: existing.interestRateBps,
        loanDate: toLocalDateString(existing.loanDate, ctx.timezone),
        dueDate: existing.dueDate ? toLocalDateString(existing.dueDate, ctx.timezone) : null,
      },
      after: {
        principalMinor,
        interestType: input.interestType ?? existing.interestType,
        interestMinor: input.interestMinor ?? minorToNumber(existing.interestMinor),
        interestRateBps: input.interestRateBps ?? existing.interestRateBps,
        loanDate: loanDateIso,
        dueDate: dueDateIso,
      },
    });

    return this.findOne(ctx, existing.id);
  }

  async addPayment(
    ctx: TenantContext,
    id: string,
    input: AddLoanPaymentInput,
  ): Promise<LoanDetail> {
    const loan = await this.requireLoan(ctx.workspaceId, id);
    if (loan.status === 'CANCELLED') {
      throw new BadRequestException('বাতিল করা ঋণে কিস্তি যোগ করা যায় না');
    }
    if (input.amountMinor <= 0) {
      throw new BadRequestException('কিস্তির পরিমাণ শূন্যের বেশি হতে হবে');
    }

    const cashAccount = await this.requireCashAccount(ctx.workspaceId, input.accountId);

    /* Judged on the day the money actually changed hands, not today.
     *
     * That is the honest cap — a borrower clearing the debt last Tuesday owed
     * last Tuesday's interest, not another week of it — and it is also the only
     * one that holds together: core freezes the interest clock on the payment's
     * own date, so capping against today's larger figure would let a back-dated
     * final payment exceed the frozen total and drive the statement's closing
     * balance below zero while the progress read a clean nil. (A settled loan
     * reports the same outstanding whatever date it is asked about, so the
     * already-repaid check below is unaffected by the choice.) */
    const paidOn = calendarDay(input.date);
    const progress = summariseLoan(
      LoansService.terms(loan, ctx.timezone),
      LoansService.paymentInputs(loan, ctx.timezone),
      paidOn,
    );
    if (progress.outstandingMinor <= 0) {
      throw new BadRequestException('এই ঋণের পুরো টাকা ইতিমধ্যে পরিশোধ হয়ে গেছে');
    }
    if (input.amountMinor > progress.outstandingMinor) {
      throw new BadRequestException(
        `এই ঋণে বাকি আছে ${taka(progress.outstandingMinor)} — তার চেয়ে বেশি টাকা জমা করা যাবে না`,
      );
    }

    /* Interest first, then principal — the ordinary allocation, and the one
     * that decides how much of this payment is a debt coming back (balance
     * sheet) and how much is the cost of the loan (profit and loss). */
    const accruedInterestMinor = progress.totalPayableMinor - minorToNumber(loan.principalMinor);
    const interestOwedMinor = Math.max(0, accruedInterestMinor - progress.paidMinor);
    const interestMinor = Math.min(input.amountMinor, interestOwedMinor);
    const split: RepaymentSplit = {
      interestMinor,
      principalMinor: input.amountMinor - interestMinor,
    };

    const system = await this.accounts.systemAccounts(ctx.workspaceId);
    const nominalAccountId =
      loan.direction === 'LENT' ? system.incomeAccountId : system.expenseAccountId;

    const date = fromLocalDateString(input.date, ctx.timezone);

    const payment = await this.prisma.$transaction(async (tx) => {
      /* Created on the first interest posting and reused ever after, so a
       * workspace that never charges interest never grows the category. */
      const interestCategoryId =
        split.interestMinor > 0
          ? await LoansService.resolveInterestCategory(tx, ctx.workspaceId, loan.direction)
          : null;

      const { type, entries } = repaymentEntries(
        loan.direction,
        {
          cashAccountId: cashAccount.id,
          controlAccountId: loan.loanAccountId,
          nominalAccountId,
          interestCategoryId,
        },
        split,
      );

      const transaction = await tx.transaction.create({
        data: {
          workspaceId: ctx.workspaceId,
          createdByUserId: ctx.id,
          date,
          type,
          description: repaymentDescription(loan.direction, loan.person.name, loan.loanNumber),
          notes: input.note,
          personId: loan.personId,
          externalRef: input.referenceNumber,
          attachmentIds: input.attachmentIds,
          source: 'MANUAL',
          entries: { create: entries.map((e) => entryData(e, ctx.workspaceId)) },
        },
      });

      return tx.loanPayment.create({
        data: {
          workspaceId: ctx.workspaceId,
          loanId: loan.id,
          date,
          amountMinor: BigInt(input.amountMinor),
          method: input.method,
          referenceNumber: input.referenceNumber,
          note: input.note,
          attachmentIds: input.attachmentIds,
          accountId: cashAccount.id,
          transactionId: transaction.id,
        },
      });
    });

    this.audit.emit({
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.id,
      action: 'loan.payment_added',
      entity: 'LoanPayment',
      entityId: payment.id,
      after: {
        loanId: loan.id,
        loanNumber: loan.loanNumber,
        amountMinor: input.amountMinor,
        // How it was allocated, so the P&L side is reconstructable from the log.
        interestMinor: split.interestMinor,
        principalMinor: split.principalMinor,
        date: input.date,
        method: input.method,
        accountId: cashAccount.id,
        referenceNumber: input.referenceNumber ?? null,
        transactionId: payment.transactionId,
      },
    });

    // findOne recomputes the status through deriveLoanStatus and persists it.
    return this.findOne(ctx, loan.id);
  }

  async removePayment(ctx: TenantContext, id: string, paymentId: string): Promise<LoanDetail> {
    const loan = await this.requireLoan(ctx.workspaceId, id);
    /* Scoped by workspace *and* loan: a payment id borrowed from another loan
     * has to be as invisible as one borrowed from another workspace. */
    const payment = await this.prisma.loanPayment.findFirst({
      where: { id: paymentId, loanId: loan.id, workspaceId: ctx.workspaceId },
    });
    if (!payment) throw new NotFoundException('কিস্তি পাওয়া যায়নি');

    await this.prisma.$transaction(async (tx) => {
      if (payment.transactionId) {
        /* Soft delete, like every other reversal in the ledger: the row stays
         * for sync and for anyone reading the history, and the balance query
         * filters it out. */
        await tx.transaction.updateMany({
          where: { id: payment.transactionId, workspaceId: ctx.workspaceId },
          data: { deletedAt: new Date() },
        });
      }
      // LoanPayment has no deletedAt column; the audit event below is the record.
      await tx.loanPayment.delete({ where: { id: payment.id } });
    });

    this.audit.emit({
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.id,
      action: 'loan.payment_deleted',
      entity: 'LoanPayment',
      entityId: payment.id,
      before: {
        loanId: loan.id,
        loanNumber: loan.loanNumber,
        amountMinor: minorToNumber(payment.amountMinor),
        date: toLocalDateString(payment.date, ctx.timezone),
        method: payment.method,
        accountId: payment.accountId,
        referenceNumber: payment.referenceNumber,
        note: payment.note,
        attachmentIds: payment.attachmentIds,
        transactionId: payment.transactionId,
      },
    });

    return this.findOne(ctx, loan.id);
  }

  /**
   * Call the loan off.
   *
   * Cancelling is only ever offered while no money has come back, so
   * "cancelled" can only mean this loan never really happened — which makes
   * leaving its disbursement on the books indefensible. A receivable nobody
   * will ever collect, or a payable nobody will ever be paid, would sit on the
   * balance sheet for good and quietly overstate net worth. So the
   * disbursement is reversed, exactly as a delete would do — and that alone is
   * enough now that the control account is shared: soft-deleting the
   * disbursement takes this loan's principal back out of ঋণ পাওনা, while every
   * other loan's principal stays in it. (Archiving the account, which is what
   * the old per-loan shape did here, would now hide every live debt in the
   * workspace.) The difference from a delete is that the `Loan` row stays
   * visible with status CANCELLED: the list still shows it, the number is not
   * reissued, and anyone wondering what happened to L-0004 can see.
   */
  async cancel(ctx: TenantContext, id: string): Promise<LoanDetail> {
    const loan = await this.requireLoan(ctx.workspaceId, id);
    if (loan.payments.length > 0) {
      throw new BadRequestException(
        'এই ঋণে কিস্তি জমা হয়েছে, তাই এটি বাতিল করা যাবে না — প্রয়োজনে আগে কিস্তিগুলো মুছুন',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      if (loan.transactionId) {
        await tx.transaction.updateMany({
          where: { id: loan.transactionId, workspaceId: ctx.workspaceId },
          data: { deletedAt: new Date() },
        });
      }
      await tx.loan.update({ where: { id: loan.id }, data: { status: 'CANCELLED' } });
    });

    this.audit.emit({
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.id,
      action: 'loan.cancelled',
      entity: 'Loan',
      entityId: loan.id,
      before: { status: loan.status },
      after: {
        status: 'CANCELLED',
        loanNumber: loan.loanNumber,
        disbursementReversed: loan.transactionId,
      },
    });

    return this.findOne(ctx, loan.id);
  }

  /**
   * Soft delete. The disbursement is reversed in the same write, so nothing is
   * left claiming a receivable that no loan explains — reversing it is what
   * removes this loan's principal from the shared control account, and the
   * account itself is left alone because every other loan still posts to it.
   * Refused once any money has come back — that history is real.
   */
  async remove(ctx: TenantContext, id: string): Promise<{ id: string }> {
    const loan = await this.requireLoan(ctx.workspaceId, id);
    if (loan.payments.length > 0) {
      throw new BadRequestException(
        'এই ঋণে কিস্তি জমা হয়েছে, তাই এটি মুছে ফেলা যাবে না — প্রয়োজনে আগে কিস্তিগুলো মুছুন',
      );
    }

    const deletedAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      if (loan.transactionId) {
        await tx.transaction.updateMany({
          where: { id: loan.transactionId, workspaceId: ctx.workspaceId },
          data: { deletedAt },
        });
      }
      await tx.loan.update({ where: { id: loan.id }, data: { deletedAt } });
    });

    this.audit.emit({
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.id,
      action: 'loan.deleted',
      entity: 'Loan',
      entityId: loan.id,
      before: {
        loanNumber: loan.loanNumber,
        direction: loan.direction,
        principalMinor: minorToNumber(loan.principalMinor),
        status: loan.status,
      },
      after: { deleted: true, transactionId: loan.transactionId },
    });

    return { id: loan.id };
  }

  // --- guards ----------------------------------------------------------------

  private async requireLoan(workspaceId: string, id: string): Promise<LoanRow> {
    const loan = await this.prisma.loan.findFirst({
      where: { id, workspaceId, deletedAt: null },
      include: loanInclude,
    });
    if (!loan) throw new NotFoundException('ঋণ পাওয়া যায়নি');
    return loan;
  }

  /**
   * The category the interest leg is filed under, found or created on first
   * use. Matched on the exact name so a workspace that already has one — from
   * the seed, from an import, from the user typing it — gets that one rather
   * than a near-duplicate sitting next to it in every picker.
   */
  private static async resolveInterestCategory(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    direction: LoanDirection,
  ): Promise<string> {
    const { kind, name } = INTEREST_CATEGORY[direction];

    const existing = await tx.category.findFirst({
      where: { workspaceId, kind, deletedAt: null, OR: [{ name }, { nameBn: name }] },
      select: { id: true },
    });
    if (existing) return existing.id;

    const created = await tx.category.create({
      data: { workspaceId, name, nameBn: name, kind, sortOrder: INTEREST_CATEGORY_SORT_ORDER },
    });
    return created.id;
  }

  private async requirePerson(workspaceId: string, personId: string): Promise<Person> {
    const person = await this.prisma.person.findFirst({
      where: { id: personId, workspaceId, deletedAt: null },
    });
    if (!person) throw new NotFoundException('ব্যক্তি পাওয়া যায়নি');
    return person;
  }

  /**
   * Find the counterparty by what was typed, or create them.
   *
   * This reads like a convenience and it is not. A `Person` is the axis the
   * party ledger turns on: `GET /loans/people/:personId/ledger` exists to
   * answer "everything between me and this person, on one running balance".
   * Typing করিম on Monday and করিম again on Friday must reach the same row, or
   * that ledger quietly splits in two and *neither half is the answer* — each
   * shows part of the debt, the net position is wrong on both, and nothing on
   * screen suggests anything is missing. A duplicate person is not a tidiness
   * problem; it is a wrong number presented as a right one.
   *
   * The phone wins over the name when both are on offer. Two cousins really can
   * both be করিম and a name cannot separate them, but a number belongs to one
   * person — so a phone match is an identification and a name match is only a
   * strong guess. Oldest match wins, deterministically: that is the row the
   * history already hangs off.
   */
  private static async resolvePerson(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    name: string,
    phone: string | undefined,
  ): Promise<Person> {
    const trimmedPhone = phone?.trim() || undefined;

    const byPhone = trimmedPhone
      ? await tx.person.findFirst({
          where: { workspaceId, deletedAt: null, phone: trimmedPhone },
          orderBy: { createdAt: 'asc' },
        })
      : null;

    /* Case-insensitive because "Karim" and "karim" are one person; trimmed by
     * the caller because a trailing space is a typo, not a different name. */
    const match =
      byPhone ??
      (await tx.person.findFirst({
        where: { workspaceId, deletedAt: null, name: { equals: name, mode: 'insensitive' } },
        orderBy: { createdAt: 'asc' },
      }));

    if (!match) {
      return tx.person.create({ data: { workspaceId, name, phone: trimmedPhone } });
    }

    /* A number we did not have before is new information, so record it. A
     * number we did have is not up for revision here — someone recording a loan
     * is not editing their contacts, and silently overwriting a stored phone
     * from a half-remembered one typed into a loan form would lose the good
     * value to the worse one. The contacts screen is where that gets corrected. */
    if (trimmedPhone && !match.phone) {
      return tx.person.update({ where: { id: match.id }, data: { phone: trimmedPhone } });
    }

    return match;
  }

  /**
   * The account the money actually moves through.
   *
   * `systemKey: null` already puts ঋণ পাওনা and ঋণ দেনা out of reach, so the
   * type check below is about the user's *own* receivable and payable
   * accounts: booking a loan against one of those would balance arithmetically
   * and mean nothing, because no cash moved.
   */
  private async requireCashAccount(
    workspaceId: string,
    accountId: string,
  ): Promise<{ id: string; name: string }> {
    const account = await this.prisma.account.findFirst({
      where: { id: accountId, workspaceId, deletedAt: null, systemKey: null },
      select: { id: true, name: true, type: true, isArchived: true },
    });
    if (!account) throw new NotFoundException('অ্যাকাউন্ট পাওয়া যায়নি');
    if (account.isArchived) {
      throw new BadRequestException('আর্কাইভ করা অ্যাকাউন্টে লেনদেন করা যায় না');
    }
    if (account.type === 'RECEIVABLE' || account.type === 'PAYABLE') {
      throw new BadRequestException(
        'পাওনা বা দেনা অ্যাকাউন্টে টাকা রাখা হয় না — নগদ, ব্যাংক বা মোবাইল ওয়ালেট অ্যাকাউন্ট নির্বাচন করুন',
      );
    }
    return { id: account.id, name: account.name };
  }

  /**
   * Numbered from the highest that has ever existed in the workspace, deleted
   * rows included: the unique index still holds against a soft-deleted loan, so
   * reusing L-0004 would fail the insert rather than renumber anything.
   */
  private async nextLoanNumber(workspaceId: string): Promise<string> {
    const rows = await this.prisma.loan.findMany({
      where: { workspaceId },
      select: { loanNumber: true },
    });
    return nextLoanNumber(rows.map((row) => row.loanNumber));
  }

  private async runWithLoanNumberGuard<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      /* Two loans saved at the same instant can pick the same number. Say so
       * rather than quietly issuing a different one: a loan number the user
       * has already read off the screen must not change under them. */
      if (LoansService.isLoanNumberClash(err)) {
        throw new ConflictException('এই ঋণ নম্বরটি এইমাত্র ব্যবহার হয়ে গেছে — আবার চেষ্টা করুন');
      }
      throw err;
    }
  }

  private static isLoanNumberClash(err: unknown): boolean {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return false;
    if (err.code !== 'P2002') return false;
    const target = err.meta?.target;
    return Array.isArray(target) ? target.includes('loanNumber') : true;
  }

  // --- presentation ----------------------------------------------------------

  /** Today as the workspace's own calendar day, in local components. */
  private static today(timezone: string): Date {
    return calendarDay(toLocalDateString(new Date(), timezone));
  }

  private static terms(loan: Loan, timezone: string): LoanTerms {
    return {
      principalMinor: minorToNumber(loan.principalMinor),
      interestType: loan.interestType,
      interestMinor: minorToNumber(loan.interestMinor),
      interestRateBps: loan.interestRateBps,
      loanDate: calendarDay(toLocalDateString(loan.loanDate, timezone)),
      dueDate: loan.dueDate ? calendarDay(toLocalDateString(loan.dueDate, timezone)) : null,
    };
  }

  /**
   * The repayments as core wants them — **always dated**.
   *
   * The date is what lets `summariseLoan` stop the interest clock on the day
   * the debt was cleared instead of letting it run to today. Drop it and a
   * PERCENT loan repaid in full quietly reopens tomorrow for a day's interest
   * nobody owes. Every `LoanPayment` row has a date, so there is never a reason
   * to leave it out.
   */
  private static paymentInputs(loan: LoanRow, timezone: string): LoanPaymentInput[] {
    return loan.payments.map((p) => ({
      amountMinor: minorToNumber(p.amountMinor),
      date: calendarDay(toLocalDateString(p.date, timezone)),
    }));
  }

  private async presentMany(ctx: TenantContext, rows: LoanRow[]): Promise<LoanView[]> {
    const today = LoansService.today(ctx.timezone);
    const views = rows.map((row) => LoansService.present(row, ctx.timezone, today));
    await this.persistStatusDrift(ctx.workspaceId, rows, views);
    return views;
  }

  /**
   * Write the derived status back when it has moved on.
   *
   * A read that quietly corrects the column is what lets the OVERDUE filter and
   * the dashboard agree with the card the user is looking at, without a nightly
   * job. No audit event: nobody did this, the calendar did.
   */
  private async persistStatusDrift(
    workspaceId: string,
    rows: LoanRow[],
    views: LoanView[],
  ): Promise<void> {
    const byStatus = new Map<LoanStatus, string[]>();
    rows.forEach((row, index) => {
      const next = views[index]?.status;
      if (!next || next === row.status) return;
      const ids = byStatus.get(next) ?? [];
      ids.push(row.id);
      byStatus.set(next, ids);
    });
    if (byStatus.size === 0) return;

    await Promise.all(
      [...byStatus].map(([status, ids]) =>
        this.prisma.loan.updateMany({
          where: { id: { in: ids }, workspaceId, deletedAt: null },
          data: { status },
        }),
      ),
    );
  }

  private static present(row: LoanRow, timezone: string, today: Date): LoanView {
    const terms = LoansService.terms(row, timezone);
    const progress = summariseLoan(terms, LoansService.paymentInputs(row, timezone), today);
    /* CANCELLED is a decision, not arithmetic, so it is never derived away.
     * Everything else is recomputed from the payments and the calendar. */
    const status: LoanStatus =
      row.status === 'CANCELLED' ? 'CANCELLED' : deriveLoanStatus(progress);

    return {
      id: row.id,
      loanNumber: row.loanNumber,
      direction: row.direction,
      personId: row.personId,
      personName: row.person.name,
      personPhone: row.person.phone,
      principalMinor: minorToNumber(row.principalMinor),
      interestType: row.interestType,
      interestMinor: minorToNumber(row.interestMinor),
      interestRateBps: row.interestRateBps,
      accruedInterestMinor: progress.totalPayableMinor - minorToNumber(row.principalMinor),
      loanDate: toLocalDateString(row.loanDate, timezone),
      dueDate: row.dueDate ? toLocalDateString(row.dueDate, timezone) : null,
      accountId: row.accountId,
      accountName: row.account.name,
      loanAccountId: row.loanAccountId,
      loanAccountName: row.loanAccount.name,
      transactionId: row.transactionId,
      note: row.note,
      attachmentIds: row.attachmentIds,
      status,
      progress,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private static presentPerson(person: Person): PersonView {
    return {
      id: person.id,
      name: person.name,
      phone: person.phone,
      relation: person.relation,
      note: person.note,
    };
  }

  private static presentPayment(payment: PaymentRow, timezone: string): LoanPaymentView {
    return {
      id: payment.id,
      date: toLocalDateString(payment.date, timezone),
      amountMinor: minorToNumber(payment.amountMinor),
      method: payment.method,
      accountId: payment.accountId,
      accountName: payment.account.name,
      referenceNumber: payment.referenceNumber,
      note: payment.note,
      attachmentIds: payment.attachmentIds,
      transactionId: payment.transactionId,
      createdAt: payment.createdAt.toISOString(),
    };
  }

  // --- search ------------------------------------------------------------------

  /**
   * The `q` filter, ranked, strongest first.
   *
   * Everything the old five-`contains`-plus-amount predicate found this still
   * finds — the matcher's A tier *is* case-insensitive substring matching — and
   * above it the transliteration and fold rungs reach করিম from `karim` and
   * from `korim`, which no `contains` ever could.
   *
   * **Suggestions are off, and re-checked.** They are the C, D and B1-substr
   * rungs — deliberate near-misses — and this endpoint hands back a bare
   * `LoanView[]` with nowhere to mark a row as a guess. A filtered list of
   * debts where some rows do not match the filter shows a wrong debt as a right
   * one; the picker above can afford them because its shape can label them. It
   * also spares every row the edit-distance work.
   *
   * The setting was worth re-checking, because it used to be doing a second job
   * badly. `afroza`, `nasrin`, `tasnim`, `krim`, `islam` — names written the
   * ordinary way, with the inherent vowel left out — could only be reached by
   * the C rung, so with suggestions off they returned **nothing at all**. That
   * was a hole in the candidate set, not a case for turning guessing on: core's
   * `buildUnit` now reserves the vowel-less spelling a slot and all of them
   * arrive in the main bucket, at T-exact. Switching suggestions on would have
   * papered over the hole and put a wrong loan on screen to do it.
   *
   * A query too short to be a filter comes back as the untouched list. That is
   * `filtered: false`, and it is deliberate: `5` used to return every loan with
   * a five anywhere in its phone number, which is no more a filter than typing
   * nothing but is a great deal more surprising.
   */
  private static searchLoans(rows: LoanRow[], q: string | undefined): LoanRow[] {
    const raw = q?.trim() ?? '';
    if (raw === '') return rows;

    const result = searchDocs(rows.map(LoansService.loanSearchDoc), raw, {
      allowSuggestions: false,
    });
    return result.hits.map((hit) => hit.row);
  }

  /**
   * One loan as the matcher sees it.
   *
   * The same five text fields and the same principal the SQL predicate
   * searched, and deliberately nothing new: `relation`, the payment notes and
   * the interest are all searchable data this endpoint has always ignored, and
   * widening what `q` covers is a different decision from changing how it
   * matches. Weights only say which field wins a tie — a name beats a note at
   * the same tier, and no weight ever lifts a weaker match past a stronger one.
   *
   * `order` is the row's place in the SQL ordering (`loanDate desc, createdAt
   * desc`), which the matcher applies only after score, so equally-good loans
   * still come back newest first and the unfiltered list is unchanged.
   */
  private static loanSearchDoc(row: LoanRow, index: number): SearchDoc<LoanRow> {
    return {
      id: row.id,
      row,
      order: index,
      fields: [
        searchField('personName', 'PRIMARY', row.person.name),
        searchField('loanNumber', 'PRIMARY', row.loanNumber),
        searchField('personPhone', 'SECONDARY', row.person.phone),
        /* One field per payment, keyed by the payment's own id so the
         * shorter-field tie-break resolves to the reference that actually
         * matched. A payment with no reference builds an empty key and can
         * never match anything. */
        ...row.payments.map((payment) =>
          searchField(`reference:${payment.id}`, 'SECONDARY', payment.referenceNumber),
        ),
        // Prose. It matches, but it must never outrank a name.
        searchField('note', 'FREE', row.note),
      ],
      /* "৫০০০" and "5,000" both mean the same loan: typing an amount is how
       * people find a loan they remember by size rather than by name. Exact
       * poisha, so ৳5,000.50 is a different loan — the one clause of the old
       * predicate that was never a substring search, kept as one. */
      amounts: [{ name: 'principal', weight: 'PRIMARY', minor: minorToNumber(row.principalMinor) }],
    };
  }

  // --- statements ------------------------------------------------------------

  /**
   * Explicit `from`/`to` win over a preset, and both absent means the whole
   * life of the loan. The preset is resolved against the workspace's calendar
   * day, not the server's.
   */
  private static resolveRange(
    query: StatementQuery,
    timezone: string,
  ): { from: string | null; to: string | null } {
    if (query.from || query.to) return { from: query.from ?? null, to: query.to ?? null };
    if (query.preset) {
      const range = presetRange(query.preset, LoansService.today(timezone));
      return { from: localCalendarDate(range.from), to: localCalendarDate(range.to) };
    }
    return { from: null, to: null };
  }

  /**
   * The day the statement charges the interest.
   *
   * FIXED interest is owed in full from day one, so it sits beside the
   * disbursement. PERCENT interest accrues, so it is charged at the point
   * accrual actually reached — `accrualIso`, already frozen at the settlement
   * day if the debt was cleared — pulled back to the due date once that has
   * passed, which is exactly where `loanInterestMinor` stops its own clock.
   */
  private static interestChargeDateIso(loan: Loan, timezone: string, accrualIso: string): string {
    const loanDateIso = toLocalDateString(loan.loanDate, timezone);
    if (loan.interestType !== 'PERCENT') return loanDateIso;

    const dueIso = loan.dueDate ? toLocalDateString(loan.dueDate, timezone) : null;
    const chargeIso = dueIso && dueIso < accrualIso ? dueIso : accrualIso;
    // Never before the money changed hands, however the clock is set.
    return chargeIso < loanDateIso ? loanDateIso : chargeIso;
  }

  /**
   * Every movement of the debt, oldest first.
   *
   * Three kinds: the principal going out, the interest being charged, and each
   * repayment coming back. Charging the interest as its own row is what makes
   * the closing balance the *whole* of what is owed, so it equals
   * `progress.outstandingMinor` rather than trailing it by the interest — and
   * it shows the borrower where that extra figure came from instead of folding
   * it silently into the principal.
   *
   * Both the amount and the date of that row come off the **frozen** accrual
   * point, the settlement day once the debt is cleared and today until then.
   * `loanInterestMinor` on its own does not freeze — only `summariseLoan` does
   * — so charging it as of today would leave the statement quietly disagreeing
   * with the progress figure printed beside it the day after a loan was repaid.
   *
   * `signed` flips a borrowed loan so a party ledger can put both directions on
   * one running balance; a single loan's own statement always reads "what is
   * owed on this loan", whichever way it points.
   */
  private static movementsFor(
    loan: LoanRow,
    timezone: string,
    todayIso: string,
    signed: boolean,
  ): Movement[] {
    const sign = signed && loan.direction === 'BORROWED' ? -1 : 1;
    const common = {
      loanId: loan.id,
      loanNumber: loan.loanNumber,
      direction: loan.direction,
    };

    const movements: Movement[] = [
      {
        ...common,
        isoDate: toLocalDateString(loan.loanDate, timezone),
        description: disbursementDescription(loan.direction, loan.person.name, loan.loanNumber),
        deltaMinor: sign * minorToNumber(loan.principalMinor),
        method: null,
        referenceNumber: null,
      },
    ];

    const terms = LoansService.terms(loan, timezone);
    /* The very date core froze `summariseLoan`'s interest clock on, taken from
     * core rather than worked out again here — two copies of that rule would
     * drift, and the first thing to give would be this charge row disagreeing
     * with the progress figure printed above it. */
    const settledOn = settlementDate(terms, LoansService.paymentInputs(loan, timezone));
    const accrualIso = settledOn ? localCalendarDate(settledOn) : todayIso;

    const interestMinor = loanInterestMinor(terms, calendarDay(accrualIso));
    if (interestMinor > 0) {
      movements.push({
        ...common,
        isoDate: LoansService.interestChargeDateIso(loan, timezone, accrualIso),
        description: `সুদ — ${loan.person.name} (#${loan.loanNumber})`,
        deltaMinor: sign * interestMinor,
        method: null,
        referenceNumber: null,
      });
    }

    for (const payment of loan.payments) {
      movements.push({
        ...common,
        isoDate: toLocalDateString(payment.date, timezone),
        description: repaymentDescription(loan.direction, loan.person.name, loan.loanNumber),
        deltaMinor: -sign * minorToNumber(payment.amountMinor),
        method: payment.method,
        referenceNumber: payment.referenceNumber,
      });
    }

    return LoansService.sortMovements(movements);
  }

  /** Stable, oldest first — the same order `buildStatement` will settle on. */
  private static sortMovements(movements: Movement[]): Movement[] {
    return movements.slice().sort((a, b) => {
      if (a.isoDate === b.isoDate) return 0;
      return a.isoDate < b.isoDate ? -1 : 1;
    });
  }

  private static splitByRange(
    movements: Movement[],
    range: { from: string | null; to: string | null },
  ): { opening: number; inRange: Movement[] } {
    const ordered = LoansService.sortMovements(movements);
    let opening = 0;
    const inRange: Movement[] = [];

    for (const movement of ordered) {
      if (range.from && movement.isoDate < range.from) {
        // Everything before the window is folded into the opening balance.
        opening += movement.deltaMinor;
        continue;
      }
      if (range.to && movement.isoDate > range.to) continue;
      inRange.push(movement);
    }

    return { opening, inRange };
  }

  /**
   * `buildStatement` owns the running balance and the debit/credit split; the
   * method and reference ride along beside it. The movements go in already
   * sorted and the sort inside is stable, so row *i* is movement *i*.
   */
  private static statementRows(
    openingMinor: number,
    movements: Movement[],
  ): { openingMinor: number; rows: StatementRowView[]; closingMinor: number } {
    const built = buildStatement(
      openingMinor,
      movements.map((m) => ({
        date: calendarDay(m.isoDate),
        description: m.description,
        deltaMinor: m.deltaMinor,
      })),
    );

    return {
      openingMinor: built.openingMinor,
      closingMinor: built.closingMinor,
      rows: built.rows.map((row, index) => {
        const source = movements[index] as Movement;
        return {
          date: localCalendarDate(row.date),
          description: row.description,
          debitMinor: row.debitMinor,
          creditMinor: row.creditMinor,
          balanceMinor: row.balanceMinor,
          method: source.method,
          referenceNumber: source.referenceNumber,
        };
      }),
    };
  }
}
