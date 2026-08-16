import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { displayName, fromLocalDateString, toLocalDateString } from '@hishab/shared';
import type { Prisma } from '@prisma/client';
import { minorToNumber } from '../common/bigint-json';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from './transactions.service';
import {
  addMonthsTo,
  monthOf,
  spreadEvenly,
  spreadOverWindow,
  type Month,
  type PrepaidMonthView,
  type PrepaidSource,
} from './prepaid';

/**
 * An expense paid once for a period longer than the month it was paid in.
 *
 * The car insurance, the trade licence, the school session's fee, the two-year
 * domain renewal. ৳12,000 leaves the bank in one month; the household's real
 * question is what a month costs, and on a screen that only shows the day the
 * money moved that question has no answer — one month looks ৳12,000 worse and
 * the eleven that follow look no better.
 *
 * ## Display only. This is the decision, not a first step towards another one
 *
 * Nothing in this file writes a ledger row, and nothing in it ever should.
 * There is no prepaid asset recognised, no monthly release entry, no scheduled
 * job. The whole ৳12,000 posts on the day it was paid, exactly as it does
 * without this feature; `prepaidStartDate` and `prepaidMonths` are two columns
 * that say what the payment bought, and the arithmetic below divides them for
 * the eye at the moment somebody looks.
 *
 * ## Why not do it properly
 *
 * Recognising the prepayment as an asset and releasing it month by month is
 * more correct — IAS 1.27 asks for the accrual basis, and this is the textbook
 * case for it. It is still the wrong trade here, and the reason is a promise
 * the app already makes: every statement response declares `basis: 'CASH'`,
 * from one shared constant. Booking an accrual while four responses go on
 * saying the books are cash-basis makes that declaration false. A ledger that
 * is plainly cash-basis and honest about it is worth more than one with a
 * nicer monthly figure and a statement header that lies, and a reader who
 * cannot trust the header cannot trust anything under it either.
 *
 * So the division lives here, in the presentation layer, where nothing can
 * mistake it for a posting — and the screen that renders it says out loud that
 * the money already left.
 *
 * ## What that costs, said plainly
 *
 *  - The spread is not the income statement, and the two will not agree. That
 *    is not a defect; the income statement is right and the spread is a way of
 *    reading it.
 *  - Nothing carries forward into a balance sheet as an asset, because under
 *    cash basis there is nothing there to carry.
 *  - Deleting the transaction takes its spread with it, which is correct: a
 *    payment that did not happen bought no months.
 */

/** How long a single payment may be said to cover. */
const MIN_MONTHS = 2;
/**
 * Ten years. Long enough for the longest prepayment anybody actually makes — a
 * five-year domain, a decade of a burial society's dues — and short enough that
 * a fat-fingered `120000` cannot ask one screen to draw ten thousand months.
 */
const MAX_MONTHS = 120;

/** How wide a window the spread screen may ask for at once. */
const MAX_WINDOW_MONTHS = 60;

/** One payment as the screen lists it, whether or not it touches the window. */
export interface PrepaidItemView {
  transactionId: string;
  /** The day the money actually left. Not the day the cover starts. */
  date: string;
  description: string | null;
  categoryName: string | null;
  accountName: string | null;
  totalMinor: number;
  startMonth: Month;
  /** The last month covered — inclusive, so twelve months from April end in March. */
  endMonth: Month;
  months: number;
  /**
   * A typical month's share. The first months carry a poisha more when the
   * total does not divide, so this is the smallest of the shares, not an
   * average — and the month rows are what add up to the payment.
   */
  perMonthMinor: number;
}

export interface PrepaidSpreadView {
  /** First month of the window, `YYYY-MM`. */
  from: Month;
  /** Last month of the window, inclusive. */
  to: Month;
  months: PrepaidMonthView[];
  items: PrepaidItemView[];
  /** Everything the window's months add up to. Never a period's total expense. */
  windowTotalMinor: number;
}

const prepaidInclude = {
  entries: {
    include: {
      account: { select: { id: true, name: true, systemKey: true } },
      category: { select: { id: true, name: true, nameBn: true } },
    },
  },
} satisfies Prisma.TransactionInclude;

type PrepaidRow = Prisma.TransactionGetPayload<{ include: typeof prepaidInclude }>;

@Injectable()
export class PrepaidService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Say that an expense covers a period — or take that back.
   *
   * `months: null` clears both columns. Nothing is recalculated and nothing is
   * unwound, because nothing was ever written: clearing a spread removes a way
   * of reading the row, not a posting.
   */
  async setPeriod(
    ctx: TenantContext,
    transactionId: string,
    input: { startDate: string | null; months: number | null },
  ): Promise<PrepaidItemView | { transactionId: string; months: null }> {
    const row = await this.prisma.transaction.findFirst({
      where: { id: transactionId, workspaceId: ctx.workspaceId, deletedAt: null },
      include: prepaidInclude,
    });
    if (!row) throw new NotFoundException('লেনদেন পাওয়া যায়নি');

    const before = {
      prepaidStartDate: row.prepaidStartDate
        ? toLocalDateString(row.prepaidStartDate, ctx.timezone)
        : null,
      prepaidMonths: row.prepaidMonths,
    };

    if (input.months === null || input.startDate === null) {
      await this.prisma.transaction.update({
        where: { id: row.id },
        data: { prepaidStartDate: null, prepaidMonths: null },
      });
      this.emit(ctx, row.id, before, { prepaidStartDate: null, prepaidMonths: null });
      return { transactionId: row.id, months: null };
    }

    /* Only an expense. Income spread across a year is a different question with
       a different answer — a year's rent received in advance is a *liability*
       under accrual, not a prepaid asset — and offering one control that
       silently means two things is how a screen teaches somebody the wrong
       thing. A transfer covers no period at all: no month is bought by moving
       your own money between two of your own accounts. */
    if (row.type !== 'EXPENSE') {
      throw new BadRequestException('শুধু খরচের ক্ষেত্রেই বলা যায় যে এটি কয়েক মাসের');
    }
    if (input.months < MIN_MONTHS || input.months > MAX_MONTHS) {
      throw new BadRequestException('কত মাসের খরচ — ২ থেকে ১২০ মাসের মধ্যে লিখুন');
    }

    await this.prisma.transaction.update({
      where: { id: row.id },
      data: {
        prepaidStartDate: fromLocalDateString(input.startDate, ctx.timezone),
        prepaidMonths: input.months,
      },
    });
    this.emit(ctx, row.id, before, {
      prepaidStartDate: input.startDate,
      prepaidMonths: input.months,
    });

    return this.present(row, monthOf(input.startDate), input.months, ctx);
  }

  /**
   * Every marked payment, and what the window's months come to.
   *
   * The whole workspace's marked rows are loaded rather than filtered down to
   * the window in SQL: overlap between a start month plus a count and a window
   * is arithmetic Postgres would need a generated column to do, and a household
   * marks a handful of rows among thousands — the index on
   * `(workspaceId, prepaidMonths)` skips the thousands, and the handful sorts
   * in memory for nothing. Every one of them is returned in `items` too, so a
   * payment whose cover ended last year is still visible to be corrected rather
   * than vanishing the moment the window moves past it.
   */
  async spread(
    ctx: TenantContext,
    query: { from?: string; months?: number },
  ): Promise<PrepaidSpreadView> {
    const from = query.from ?? monthOf(toLocalDateString(new Date(), ctx.timezone));
    const count = Math.min(query.months ?? 12, MAX_WINDOW_MONTHS);

    const rows = await this.prisma.transaction.findMany({
      where: {
        workspaceId: ctx.workspaceId,
        deletedAt: null,
        type: 'EXPENSE',
        prepaidMonths: { not: null },
      },
      include: prepaidInclude,
      orderBy: [{ prepaidStartDate: 'desc' }, { date: 'desc' }],
    });

    const items = rows.map((row) =>
      this.present(
        row,
        monthOf(toLocalDateString(row.prepaidStartDate ?? row.date, ctx.timezone)),
        row.prepaidMonths ?? 0,
        ctx,
      ),
    );

    const sources: PrepaidSource[] = items.map((item) => ({
      transactionId: item.transactionId,
      date: item.date,
      description: item.description,
      categoryName: item.categoryName,
      accountName: item.accountName,
      totalMinor: item.totalMinor,
      startMonth: item.startMonth,
      months: item.months,
    }));

    const months = spreadOverWindow(sources, from, count);

    return {
      from,
      to: addMonthsTo(from, Math.max(0, count - 1)),
      months,
      items,
      windowTotalMinor: months.reduce((sum, month) => sum + month.totalMinor, 0),
    };
  }

  private present(
    row: PrepaidRow,
    startMonth: Month,
    months: number,
    ctx: TenantContext,
  ): PrepaidItemView {
    /* The magnitude off the ledger, not off a column: `Transaction` carries no
       amount — the money lives on its two legs. An EXPENSE credits the account
       the money left and debits the expense nominal, so the leg on a *real*
       account is what was paid. `systemKey: null` is what separates them. */
    const real = row.entries.find((entry) => entry.account.systemKey === null);
    const nominal = row.entries.find((entry) => entry.account.systemKey !== null);
    const totalMinor = minorToNumber(real?.amountMinor ?? BigInt(0));

    return {
      transactionId: row.id,
      date: toLocalDateString(row.date, ctx.timezone),
      description: row.description,
      categoryName: nominal?.category ? displayName(nominal.category, ctx.locale) : null,
      accountName: real?.account.name ?? null,
      totalMinor,
      startMonth,
      endMonth: addMonthsTo(startMonth, Math.max(0, months - 1)),
      months,
      /* The last share, which is the smallest when the total does not divide.
         Calling the largest "per month" would let somebody multiply it by the
         term and get more than they paid. */
      perMonthMinor: spreadEvenly(totalMinor, months).at(-1) ?? 0,
    };
  }

  /**
   * Filed as an ordinary edit to the transaction, because that is what it is.
   *
   * No `prepaid.*` audit action was added: this writes two columns on one row
   * and posts nothing, and a reader scanning the timeline for what happened to
   * a transaction should find it under the transaction rather than under a verb
   * they have to learn.
   */
  private emit(
    ctx: TenantContext,
    transactionId: string,
    before: { prepaidStartDate: string | null; prepaidMonths: number | null },
    after: { prepaidStartDate: string | null; prepaidMonths: number | null },
  ): void {
    this.audit.emit({
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.id,
      action: 'transaction.updated',
      entity: 'Transaction',
      entityId: transactionId,
      before,
      after,
    });
  }
}
