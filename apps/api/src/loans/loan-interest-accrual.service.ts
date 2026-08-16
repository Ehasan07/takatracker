import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  assertBalanced,
  interestAccrualSchedule,
  summariseLoan,
  type EntryDraft,
  type LoanTerms,
} from '@hishab/core';
import { fromLocalDateString, toLocalDateString, type EntryDirection } from '@hishab/shared';
import { Prisma } from '@prisma/client';
import type { LoanDirection } from '@prisma/client';
import { AccountsService } from '../accounts/accounts.service';
import { minorToNumber } from '../common/bigint-json';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Loan interest, put into the books as it is earned.
 *
 * ## The defect this closes
 *
 * Interest was derived for display and only ever *posted* inside a repayment
 * (`LoansService.addPayment`). Until somebody paid, the receivable or payable
 * control account understated what was owed, and the loan statement's interest
 * row was a display line with no entry behind it. For an interest-free family
 * loan the two figures are identical and the old design was right; for the
 * bank and DPS-backed loans that carry a real rate it was not.
 *
 * ## What it posts, and where
 *
 * One transaction per loan per period, dated the day the period runs to:
 *
 * - **LENT** — DR the ঋণ পাওনা control account, CR the income nominal, filed
 *   under ঋণের সুদ. The receivable grows as the interest is earned.
 * - **BORROWED** — DR the expense nominal under সুদ ব্যয়, CR the ঋণ দেনা
 *   control account. The payable grows the same way.
 *
 * Neither leg touches a liquid account, so none of this reaches the cash flow
 * statement — which is right: no cash has moved. IFRS 9's effective-interest
 * method is the formal name for recognising it this way; the arithmetic stays
 * the simple interest `loanInterestMinor` already computes, because that is the
 * number the two people agreed and the one the loan card shows.
 *
 * ## Running it twice must not post twice
 *
 * Three independent guards, weakest first:
 *
 *  1. **The amount is a difference.** Every period posts `loanInterestMinor` at
 *     the period end *less what the books already hold*. Run the sweep again
 *     and the second run computes zero before any constraint is consulted.
 *  2. **A local-date watermark.** `LoanInterestAccrual.throughDate` is a
 *     `YYYY-MM-DD` day in the workspace's own timezone — the same guard shape
 *     the card and renewal reminders use — and `interestAccrualSchedule` never
 *     offers a day at or before the latest one already recorded.
 *  3. **A unique index** on `(loanId, throughDate)`. Two sweeps racing past (1)
 *     and (2) still cannot both insert, and the loser is skipped rather than
 *     failed: its work was done by the winner.
 *
 * "What the books already hold" is read from the ledger, not from a running
 * total on the loan, and it deliberately includes interest that **older
 * repayments** posted to the nominal before this service existed. A loan that
 * was half repaid under the old design therefore accrues only the difference,
 * and its income is not counted twice.
 *
 * ## Its own timer, not the reminder sweep
 *
 * `ReminderScheduler` answers "is anything due today" for cards and renewals and
 * sends Telegram messages at 09:00 local. This writes to the ledger, is not a
 * notification, and must not be gated on an hour of the day or coupled to a
 * messaging failure. A separate interval is also the strongest possible version
 * of "a failure in one sweep must not silence the others": they share nothing.
 */
@Injectable()
export class LoanInterestAccrualService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LoanInterestAccrualService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  private static readonly HOUR_MS = 60 * 60 * 1000;

  /** Income when they owe us the interest, expense when we owe it. */
  private static readonly CATEGORY = {
    LENT: { kind: 'INCOME', name: 'ঋণের সুদ' },
    BORROWED: { kind: 'EXPENSE', name: 'সুদ ব্যয়' },
  } as const;

  /** Interest categories sort below the ones the user set up for themselves. */
  private static readonly CATEGORY_SORT_ORDER = 950;

  private static readonly CURRENCY = 'BDT';

  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountsService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test' || process.env.DISABLE_LOAN_ACCRUAL_SWEEP === 'true') {
      return;
    }
    /* Hourly rather than daily, and with no send-hour gate: the sweep is a
       no-op on all but the first run after a month ends, and running it often
       means a restarted or newly deployed instance catches up within the hour
       instead of waiting for a nightly slot. */
    this.timer = setInterval(() => void this.tick(), LoanInterestAccrualService.HOUR_MS);
    setTimeout(() => void this.tick(), 45_000).unref();
    this.logger.log('Loan interest accrual scheduled hourly');
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return; // a slow sweep must not overlap itself
    this.running = true;
    try {
      const result = await this.runSweep();
      if (result.postedMinor !== 0) {
        this.logger.log(
          `Loan interest: ${result.postedMinor} poisha over ${result.periods} period(s) ` +
            `on ${result.accrued} of ${result.checked} loan(s)`,
        );
      }
    } catch (err) {
      this.logger.error(`Loan interest sweep failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  // --- the sweep ---------------------------------------------------------------

  /**
   * Bring every interest-bearing loan up to the end of the last complete month.
   *
   * The last *complete* month, never month-to-date: a part-month accrual posted
   * on the 12th would have to be topped up on the 31st, and two postings for one
   * month is exactly the shape the through-date key exists to forbid. A
   * repayment is the one thing that accrues mid-month — see `catchUp` — and it
   * carries its own distinct through-date.
   *
   * Nothing is skipped quietly: a loan that throws is logged and the sweep moves
   * on, so one bad row cannot stop the rest of the workspace being accrued.
   */
  async runSweep(now = new Date()): Promise<{
    checked: number;
    accrued: number;
    periods: number;
    postedMinor: number;
  }> {
    const loans = await this.prisma.loan.findMany({
      where: {
        deletedAt: null,
        /* The narrow part of a narrow change: an interest-free loan is not
           considered at all, so the common case costs one WHERE clause. */
        interestType: { not: 'NONE' },
        // Called off by the two people; its disbursement was reversed out.
        status: { not: 'CANCELLED' },
        workspace: { deletedAt: null, status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] } },
      },
      select: {
        id: true,
        workspaceId: true,
        workspace: { select: { timezone: true } },
      },
    });

    let accrued = 0;
    let periods = 0;
    let postedMinor = 0;

    for (const loan of loans) {
      try {
        const timezone = loan.workspace.timezone;
        const result = await this.catchUp(
          loan.workspaceId,
          loan.id,
          timezone,
          LoanInterestAccrualService.lastCompleteMonthEnd(now, timezone),
          null,
        );
        if (result.periods > 0) accrued += 1;
        periods += result.periods;
        postedMinor += result.postedMinor;
      } catch (err) {
        this.logger.warn(`Loan interest accrual ${loan.id} failed: ${(err as Error).message}`);
      }
    }

    return { checked: loans.length, accrued, periods, postedMinor };
  }

  /**
   * Post whatever interest this loan has earned up to `upToIso` and not yet had
   * recognised.
   *
   * Called by the sweep with a month end, and by `LoansService.addPayment` with
   * the payment's own date — so that by the time a repayment is written, every
   * poisha of interest it could be settling is already sitting in the control
   * account and the repayment has nothing left to recognise. That is the whole
   * of how the two are kept from posting the same interest twice.
   *
   * Deliberately *not* run inside the caller's transaction. An accrual is true
   * on its own account: the interest was earned whether or not the repayment
   * somebody is typing goes on to save, exactly as
   * `AccountsService.loanControlAccount` is correct whether or not the loan that
   * asked for it lands. Keeping it out also means a lost race on the unique
   * index is a skipped period rather than a failed payment.
   *
   * Each period is its own transaction, so an interrupted catch-up leaves the
   * books consistent at whatever month it reached.
   */
  async catchUp(
    workspaceId: string,
    loanId: string,
    timezone: string,
    upToIso: string,
    actorUserId: string | null,
  ): Promise<{ periods: number; postedMinor: number }> {
    const loan = await this.prisma.loan.findFirst({
      where: { id: loanId, workspaceId, deletedAt: null },
      include: {
        person: { select: { name: true } },
        payments: { select: { amountMinor: true, date: true, transactionId: true } },
        accruals: { select: { throughDate: true, amountMinor: true } },
      },
    });
    if (!loan) return { periods: 0, postedMinor: 0 };
    if (loan.interestType === 'NONE' || loan.status === 'CANCELLED') {
      return { periods: 0, postedMinor: 0 };
    }

    const terms: LoanTerms = {
      principalMinor: minorToNumber(loan.principalMinor),
      interestType: loan.interestType,
      interestMinor: minorToNumber(loan.interestMinor),
      interestRateBps: loan.interestRateBps,
      loanDate: calendarDay(toLocalDateString(loan.loanDate, timezone)),
      dueDate: loan.dueDate ? calendarDay(toLocalDateString(loan.dueDate, timezone)) : null,
    };
    const payments = loan.payments.map((p) => ({
      amountMinor: minorToNumber(p.amountMinor),
      date: calendarDay(toLocalDateString(p.date, timezone)),
    }));

    /* A settled loan accrues nothing, ever. `summariseLoan` freezes the interest
     * clock on the day the debt was cleared, and the payment that cleared it
     * accrued through its own date on the way in — so the books already hold the
     * whole of the frozen figure and there is nothing left to earn. Without this
     * a loan repaid on Sunday would grow a fresh month of interest and quietly
     * reopen. Written off is the same answer by a different route: a CANCELLED
     * loan is refused above. */
    if (summariseLoan(terms, payments, calendarDay(upToIso)).isSettled) {
      return { periods: 0, postedMinor: 0 };
    }

    const system = await this.accounts.systemAccounts(workspaceId);
    const nominalAccountId =
      loan.direction === 'LENT' ? system.incomeAccountId : system.expenseAccountId;

    const postedMinor = await this.alreadyRecognisedMinor(
      workspaceId,
      nominalAccountId,
      loan.accruals,
      loan.payments,
    );

    const accruedThrough = loan.accruals.reduce<string | null>(
      (latest, row) => (latest === null || row.throughDate > latest ? row.throughDate : latest),
      null,
    );

    const schedule = interestAccrualSchedule(terms, {
      postedMinor,
      accruedThrough: accruedThrough ? calendarDay(accruedThrough) : null,
      upTo: calendarDay(upToIso),
    });
    if (schedule.length === 0) return { periods: 0, postedMinor: 0 };

    const loanDateIso = toLocalDateString(loan.loanDate, timezone);
    let periods = 0;
    let posted = 0;

    for (const period of schedule) {
      const throughIso = localCalendarDate(period.throughDate);
      const written = await this.postPeriod({
        workspaceId,
        actorUserId,
        loan: {
          id: loan.id,
          loanNumber: loan.loanNumber,
          direction: loan.direction,
          interestType: loan.interestType,
          personId: loan.personId,
          personName: loan.person.name,
          controlAccountId: loan.loanAccountId,
          loanDateIso,
        },
        nominalAccountId,
        timezone,
        throughIso,
        amountMinor: period.amountMinor,
      });
      if (!written) continue; // another sweep got there first — its row stands
      periods += 1;
      posted += period.amountMinor;
    }

    return { periods, postedMinor: posted };
  }

  // --- the posting ---------------------------------------------------------------

  /**
   * What the ledger already holds as interest on this loan, poisha.
   *
   * Two sources, added because a loan can genuinely have both:
   *
   *  - the accruals this service has posted; and
   *  - **interest booked by repayments before this service existed.** Under the
   *    old design a repayment credited the income nominal directly. A loan that
   *    was half repaid then would otherwise accrue its whole interest again, and
   *    the owner's income statement would show it twice. Reading it back off the
   *    ledger rather than from a stored counter means the figure cannot drift,
   *    and a soft-deleted repayment stops counting on its own.
   */
  private async alreadyRecognisedMinor(
    workspaceId: string,
    nominalAccountId: string,
    accruals: readonly { amountMinor: bigint }[],
    payments: readonly { transactionId: string | null }[],
  ): Promise<number> {
    const fromAccruals = accruals.reduce((sum, row) => sum + minorToNumber(row.amountMinor), 0);

    const paymentTransactionIds = payments
      .map((p) => p.transactionId)
      .filter((id): id is string => Boolean(id));
    if (paymentTransactionIds.length === 0) return fromAccruals;

    const legacy = await this.prisma.ledgerEntry.aggregate({
      where: {
        workspaceId,
        accountId: nominalAccountId,
        transactionId: { in: paymentTransactionIds },
        transaction: { deletedAt: null },
      },
      _sum: { amountMinor: true },
    });

    return fromAccruals + minorToNumber(legacy._sum.amountMinor ?? 0n);
  }

  /**
   * One period, in one transaction. Returns false when the period was already
   * recorded by somebody else.
   *
   * A period worth nothing still gets its row and no ledger entry: the row is
   * what advances the watermark, and a ৳0.00 transaction on a statement is
   * noise a reader has to work out the meaning of.
   */
  private async postPeriod(input: {
    workspaceId: string;
    actorUserId: string | null;
    loan: {
      id: string;
      loanNumber: string;
      direction: LoanDirection;
      interestType: string;
      personId: string;
      personName: string;
      controlAccountId: string;
      loanDateIso: string;
    };
    nominalAccountId: string;
    timezone: string;
    throughIso: string;
    amountMinor: number;
  }): Promise<boolean> {
    const { workspaceId, loan, throughIso, amountMinor } = input;

    /* A flat "৳২,০০০ extra" is owed in full from day one and does not accrue, so
     * it is dated beside the disbursement rather than at a month end — the same
     * rule the loan statement's interest row follows. A rate accrues, so it is
     * dated the day the period actually ran to. */
    const postingIso = loan.interestType === 'FIXED' ? loan.loanDateIso : throughIso;

    try {
      await this.prisma.$transaction(async (tx) => {
        let transactionId: string | null = null;

        if (amountMinor > 0) {
          const categoryId = await this.resolveCategory(tx, workspaceId, loan.direction);
          const entries = LoanInterestAccrualService.entries(
            loan.direction,
            loan.controlAccountId,
            input.nominalAccountId,
            categoryId,
            amountMinor,
          );

          const transaction = await tx.transaction.create({
            data: {
              workspaceId,
              createdByUserId: input.actorUserId,
              date: fromLocalDateString(postingIso, input.timezone),
              // It is income or expense, and the reports read the nominal
              // account rather than this field — but a reader of the
              // transaction list should see it named for what it is.
              type: loan.direction === 'LENT' ? 'INCOME' : 'EXPENSE',
              description: `সুদ — ${loan.personName} (#${loan.loanNumber})`,
              notes: `${throughIso} পর্যন্ত হিসাব করা সুদ`,
              personId: loan.personId,
              // Machine-made and repeating, not something anybody typed.
              source: 'RECURRING',
              entries: {
                create: entries.map((entry) => ({
                  workspace: { connect: { id: workspaceId } },
                  account: { connect: { id: entry.accountId } },
                  category: entry.categoryId ? { connect: { id: entry.categoryId } } : undefined,
                  amountMinor: BigInt(entry.amountMinor),
                  direction: entry.direction,
                  currency: entry.currency,
                  fxRate: entry.fxRate,
                })),
              },
            },
          });
          transactionId = transaction.id;
        }

        await tx.loanInterestAccrual.create({
          data: {
            workspaceId,
            loanId: loan.id,
            throughDate: throughIso,
            amountMinor: BigInt(amountMinor),
            transactionId,
          },
        });
      });
      return true;
    } catch (err) {
      /* The unique index did its job: another sweep, or another instance, has
         already recognised this period. Its row is as good as the one we were
         about to write, and the transaction above rolled back with it. */
      if (LoanInterestAccrualService.isDuplicatePeriod(err)) return false;
      throw err;
    }
  }

  /**
   * Lent: the receivable grows and income is earned. Borrowed: the expense is
   * incurred and the payable grows. Only the nominal leg carries a category —
   * the control account is not a category of anything.
   */
  private static entries(
    direction: LoanDirection,
    controlAccountId: string,
    nominalAccountId: string,
    categoryId: string,
    amountMinor: number,
  ): EntryDraft[] {
    const controlSide: EntryDirection = direction === 'LENT' ? 'DEBIT' : 'CREDIT';
    const nominalSide: EntryDirection = direction === 'LENT' ? 'CREDIT' : 'DEBIT';

    const entries: EntryDraft[] = [
      {
        accountId: controlAccountId,
        direction: controlSide,
        amountMinor,
        currency: LoanInterestAccrualService.CURRENCY,
        fxRate: 1,
        categoryId: null,
      },
      {
        accountId: nominalAccountId,
        direction: nominalSide,
        amountMinor,
        currency: LoanInterestAccrualService.CURRENCY,
        fxRate: 1,
        categoryId,
      },
    ];

    // Belt and braces: the pair says it balances, the DB trigger will say so too.
    assertBalanced(entries);
    return entries;
  }

  /**
   * The category the interest is filed under, found or created on first use.
   * Matched on the exact name so a workspace that already has one — from the
   * seed, from an import, from a repayment posted before this service existed —
   * gets that one rather than a near-duplicate sitting beside it in every picker.
   */
  private async resolveCategory(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    direction: LoanDirection,
  ): Promise<string> {
    const { kind, name } = LoanInterestAccrualService.CATEGORY[direction];

    const existing = await tx.category.findFirst({
      where: { workspaceId, kind, deletedAt: null, OR: [{ name }, { nameBn: name }] },
      select: { id: true },
    });
    if (existing) return existing.id;

    const created = await tx.category.create({
      data: {
        workspaceId,
        name,
        nameBn: name,
        kind,
        sortOrder: LoanInterestAccrualService.CATEGORY_SORT_ORDER,
      },
    });
    return created.id;
  }

  private static isDuplicatePeriod(err: unknown): boolean {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return false;
    if (err.code !== 'P2002') return false;
    const target = err.meta?.target;
    return Array.isArray(target) ? target.includes('throughDate') : true;
  }

  /**
   * The last day of the last complete month, in the workspace's own timezone.
   *
   * Day 0 of the current month is the last day of the previous one, whatever its
   * length, so February and a leap February both come out right without a table.
   */
  private static lastCompleteMonthEnd(now: Date, timezone: string): string {
    const todayIso = toLocalDateString(now, timezone);
    const year = Number(todayIso.slice(0, 4));
    const month = Number(todayIso.slice(5, 7));
    return localCalendarDate(new Date(year, month - 1, 0, 0, 0, 0, 0));
  }
}

// --- local date helpers ---------------------------------------------------------

const pad = (value: number, width: number): string => String(value).padStart(width, '0');

/** YYYY-MM-DD from a Date's *local* calendar components. */
function localCalendarDate(date: Date): string {
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)}`;
}

/**
 * A Date whose *local* components are that calendar day at midnight.
 *
 * `@hishab/core`'s loan maths reads dates by their local calendar day, so every
 * date crosses this boundary as the workspace's own calendar day first and
 * becomes an instant again only on the way back to the database.
 */
function calendarDay(isoDate: string): Date {
  const year = Number(isoDate.slice(0, 4));
  const month = Number(isoDate.slice(5, 7));
  const day = Number(isoDate.slice(8, 10));
  return new Date(year, month - 1, day, 0, 0, 0, 0);
}
