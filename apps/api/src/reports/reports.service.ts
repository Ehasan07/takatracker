import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  type AccountBalanceRow,
  assertReconciles,
  type BalanceSheet,
  type BalanceSheetComparison,
  buildBalanceSheet,
  buildCashFlow,
  buildSectionedCashFlow,
  buildTrend,
  type CashFlow,
  cashFlowSection,
  type CashFlowSectionTotals,
  type CategoryNode,
  type CategoryTotal,
  compareBalanceSheets,
  LIQUID_TYPES,
  nextDateKey,
  nextDayOfMonthAfter,
  rollUpToParents,
  statementPeriodFor,
  SYSTEM_ACCOUNT_KEYS,
  topWithRest,
  type TrendPoint,
  withShares,
} from '@hishab/core';
import { displayName, fromLocalDateString, toLocalDateString, type Locale } from '@hishab/shared';
import type { AccountType, AssetKind } from '@prisma/client';
import { minorToNumber } from '../common/bigint-json';
import { AccountsService } from '../accounts/accounts.service';
import { PrismaService } from '../prisma/prisma.service';
import { TagsService } from '../tags/tags.service';
import type { TenantContext } from '../transactions/transactions.service';

export interface PeriodQuery {
  from: string;
  to: string;
}

/** What `GET /reports/balance-sheet` accepts. Both dates are YYYY-MM-DD. */
export interface BalanceSheetQuery {
  /** End of this local day. Absent means every entry on the books. */
  asOf?: string;
  /** An earlier day to measure the movement against. */
  compareTo?: string;
}

/**
 * The basis every statement is prepared on, in the one place it is decided.
 *
 * All four statements carry the same literal from here rather than four copies
 * of `'CASH'`, so the day this product ever offers a second basis there is one
 * thing to change and no statement can be left behind on the old one.
 */
const BASIS = 'CASH' as const;

/**
 * Disclosures that belong to the position rather than to a period.
 *
 * ## Why on the response and not only on the screen
 *
 * The reports page already prints a basis-of-preparation block, and this does
 * not duplicate it: that block is prose for whoever is holding the printout,
 * this is for whoever is holding the JSON. A balance sheet reaching a bank's
 * spreadsheet, an export, or somebody else's app arrives with no page attached,
 * and a statement that does not say what basis it is on cannot be checked.
 *
 * ## Why depreciation is named
 *
 * Because its absence is otherwise invisible. A reader who knows business
 * accounting sees a car at what it cost three years ago and reasonably assumes
 * somebody forgot to depreciate it. They did not: depreciating a household car
 * is an artefact of business accounting, and revaluing it to market is simpler,
 * more honest and how personal financial statements are prepared everywhere
 * (docs/PLAN-v3.md, M44). Saying so turns a suspected omission into a stated
 * policy, which is the whole job of a note.
 */
const BALANCE_SHEET_NOTES: readonly string[] = [
  'সম্পদ ক্রয়মূল্যে দেখানো হয়েছে। অবচয় (depreciation) হিসাব করা হয় না — বাজারমূল্য বদলালে পুনর্মূল্যায়নের মাধ্যমে সংশোধন করা হয়।',
];

/**
 * A balance sheet that says what it is prepared on, as well as what it says.
 *
 * The bare `BalanceSheet` from @hishab/core is arithmetic over account
 * balances; this is that arithmetic presented as a statement, which means it
 * has to declare its basis the way the other three do.
 */
export interface PreparedBalanceSheet extends BalanceSheet {
  /**
   * Cash basis, always, and said out loud. The same literal and the same shape
   * as `IncomeStatement.basis` and `ChangesInNetWorth.basis`, so a consumer
   * reads one field name across all four statements.
   */
  basis: typeof BASIS;
  /** Disclosures a reader needs to interpret the figures. See `BALANCE_SHEET_NOTES`. */
  notes: string[];
}

/**
 * A balance sheet that says which day it is true for.
 *
 * `asOf` and `comparison` are absent from the response when nothing was asked
 * for, so the undated call returns exactly the object it always did.
 */
export interface DatedBalanceSheet extends PreparedBalanceSheet {
  asOf: string;
  comparison?: BalanceSheetComparison & { asOf: string };
}

/**
 * The cash flow as it leaves the API: the statement, its sections, its basis,
 * and its own verdict on whether it adds up.
 */
export interface CashFlowStatement extends CashFlow, CashFlowSectionTotals {
  basis: typeof BASIS;
  /**
   * `opening + operating + investing + financing === closing`.
   *
   * Normally true and worth sending anyway: a consumer that has to derive it
   * will one day derive it differently from the server, and the point of the
   * check is that there is exactly one answer.
   */
  reconciled: boolean;
  /** `closing − (opening + the three sections)`, in poisha. Zero when reconciled. */
  discrepancyMinor: number;
  accounts: string[];
}

/** One line of the by-tag report. `tagId: null` is the untagged bucket. */
export interface TagTotalRow {
  tagId: string | null;
  name: string;
  color: string | null;
  icon: string | null;
  /** The `kind` side only — expenses on an expense report, income on an income one. */
  totalMinor: number;
  transactionCount: number;
  /**
   * Share of `totalMinor` on the report, **not** of the sum of these rows. See
   * `TagReport.overlapMinor`: on a multi-tagged period these add up to more than
   * a hundred, and that is the honest answer rather than a bug.
   */
  sharePercent: number;
}

export interface TagReport {
  kind: 'INCOME' | 'EXPENSE';
  from: string;
  to: string;
  /**
   * What the period actually cost (or earned): **every transaction counted
   * exactly once**, however many tags it carries. This is the figure that must
   * agree with `by-category` and with the dashboard summary.
   */
  totalMinor: number;
  transactionCount: number;
  /** The part of `totalMinor` carrying at least one tag, each transaction once. */
  taggedMinor: number;
  /** The rest. Also present as a row, because a bucket nobody can see is a lie. */
  untaggedMinor: number;
  /**
   * The sum of `rows[].totalMinor` over the real tags — what the per-tag lines
   * add up to. Greater than `taggedMinor` whenever a transaction carries more
   * than one tag.
   */
  attributedMinor: number;
  /**
   * `attributedMinor − taggedMinor`: money the rows report more than once.
   *
   * Named in the response on purpose. Somebody will eventually add the tag
   * column up, get a bigger number than the month's spending, and "fix" it —
   * either by dividing a transaction's amount between its tags, or by keeping
   * only the first tag. Both are wrong: ৳৫০০ of groceries tagged পারিবারিক and
   * রমজান is ৳৫০০ of family spending *and* ৳৫০০ of Ramadan spending, and
   * halving it would make both answers false. The overlap is a real property of
   * tagging, so it is measured and published rather than hidden.
   */
  overlapMinor: number;
  rows: TagTotalRow[];
}

/**
 * The buckets that are not a row in any table.
 *
 * Every other name on a report comes from a category or a tag, which each carry
 * both languages. These two are invented by the report itself, so they have to
 * carry their own pair or an English reader gets one Bengali line in the middle
 * of an otherwise English table — and it is the line most likely to need acting
 * on, because it is the money that has not been filed.
 */
const UNTAGGED_LABEL: Record<Locale, string> = { bn: 'ট্যাগবিহীন', en: 'Untagged' };
const UNCATEGORISED: Record<Locale, string> = { bn: 'খাত ছাড়া', en: 'Uncategorised' };
/** The report's own word for a row whose category is filed under no name at all. */
const UNFILED: Record<Locale, string> = { bn: 'অশ্রেণিবদ্ধ', en: 'Unfiled' };
/** A category id the name map does not have. Should not happen; says so if it does. */
const UNKNOWN_CATEGORY: Record<Locale, string> = { bn: 'অজানা', en: 'Unknown' };

/**
 * One period's income statement figures, without the period itself.
 *
 * Shared by the current column and the comparative one, so the two can never
 * be computed differently — which is the only way a comparison means anything.
 */
export interface IncomeStatementFigures {
  incomeMinor: number;
  expenseMinor: number;
  /** Income less expenses. "Surplus", because a household does not trade. */
  surplusMinor: number;
  /** Share of income kept, in basis points. 25% is 2500. */
  savingsRateBps: number;
  income: CategoryNode[];
  expenses: CategoryNode[];
}

export interface IncomeStatement extends IncomeStatementFigures {
  from: string;
  to: string;
  /**
   * Cash basis, always, and said out loud.
   *
   * A report handed to a bank has to state what it is. These are a household's
   * books: an unpaid bill is not a liability here, and money is recognised when
   * it moves rather than when it is earned or incurred.
   */
  basis: typeof BASIS;
  comparison?: IncomeStatementFigures & { from: string; to: string };
}

/**
 * How net worth moved over a period, and why.
 *
 * `opening + surplus + other = closing`, always. If that ever fails to hold,
 * one of the other statements is wrong and this is where it shows.
 */
export interface ChangesInNetWorth {
  from: string;
  to: string;
  basis: typeof BASIS;
  openingMinor: number;
  incomeMinor: number;
  expenseMinor: number;
  surplusMinor: number;
  /** Everything that changed net worth without passing through income or expense. */
  otherMinor: number;
  /** What that line is made of, so far as revaluations explain it. */
  revaluations: {
    id: string;
    date: string;
    accountName: string;
    note: string | null;
    deltaMinor: number;
  }[];
  closingMinor: number;
  /** `closingMinor − openingMinor`, stated so nobody has to subtract. */
  movementMinor: number;
}

/**
 * What one credit card's last statement says is owed, and what it cannot say.
 *
 * ## What `statementMinor` is
 *
 * The balance on the card at the end of the statement day, derived from the
 * ledger. It is **not** today's balance and it is **not** today's balance with
 * later payments added back: a bill is a photograph of a moment, and either of
 * those two would produce a figure that looks like the bank's and is not.
 *
 * ## What it is not, and cannot be
 *
 * These books hold what the household recorded. A real card statement also
 * carries interest, the late fee, the annual fee, the 1% foreign-currency
 * markup and any purchase the bank posted into a different cycle than the day
 * it happened. None of that is here unless somebody typed it in, so this is
 * *what your books say the statement should be*, which is a genuinely useful
 * number for checking a bill and a dangerous one for paying it blind. The
 * screen says so; `reports.cards.caveat` is that sentence.
 *
 * It also cannot say what the minimum payment is. That is a term of the card's
 * contract, nothing in the schema records it, and inventing a percentage would
 * be the worst kind of plausible.
 */
export interface CardStatementRow {
  id: string;
  name: string;
  accountNumberMasked: string | null;
  statementDayOfMonth: number | null;
  dueDayOfMonth: number | null;
  /** The day the last bill closed, or null when the card has no statement day. */
  statementDate: string | null;
  /** The bill before it. The period is `(previousStatementDate, statementDate]`. */
  previousStatementDate: string | null;
  /** When that bill falls due, when the card carries a payment day. */
  dueDate: string | null;
  /** Owed at the previous statement date — the figure this bill opened on. */
  openingMinor: number;
  /** What the period added to the debt: purchases, fees, anything recorded. */
  purchasesMinor: number;
  /** What the period took off it. */
  paymentsMinor: number;
  /**
   * Owed at the statement date. Positive means money is owed, the same way the
   * balance sheet's liabilities are. Null when no statement day is set, because
   * with no day there is no statement and a number here would be a guess.
   */
  statementMinor: number | null;
  /** Owed right now, from the same sum the balance sheet above it is built on. */
  currentMinor: number;
  /**
   * What has happened since the bill was cut. Positive means the card has been
   * used again; negative means some of the bill has been paid. Named rather
   * than left for the reader to subtract, because the gap between the statement
   * figure and today's is the thing that misleads people about card debt.
   */
  sinceStatementMinor: number | null;
  creditLimitMinor: number;
  /**
   * Disclosed, never added to anything. An undrawn limit is money the bank
   * still holds and may withdraw — not cash under IAS 7.6, not a resource the
   * entity controls. IAS 7.50(a): a figure beside the sheet, not a line in it.
   */
  undrawnMinor: number;
  /**
   * `opening + purchases − payments === statement`, and the ledger-walk agrees
   * with the balance the rest of the application uses.
   *
   * Sent on every row including the ones where it is true, for the reason
   * `CashFlowStatement.reconciled` is: a field that only appears when things
   * are broken is a field no client remembers to check.
   */
  reconciled: boolean;
}

export interface CardStatementsReport {
  /** Today, in the workspace's timezone — the day `currentMinor` is true for. */
  asOf: string;
  cards: CardStatementRow[];
  /** Owed across the cards that have a statement to report. */
  statementTotalMinor: number;
  /** Owed across every card right now. Agrees with the balance sheet's card lines. */
  currentTotalMinor: number;
  /** Cards that cannot produce a statement figure because no day is set. */
  withoutStatementDay: number;
}

/**
 * What a cash flow that does not add up should do to the request.
 *
 * ## Both obvious answers are wrong
 *
 * Throwing turns a report screen into a 500 for somebody who only wanted to see
 * last month, over a defect they cannot act on and probably a discrepancy of a
 * few poisha — and it hides the data they *could* still read. Not throwing, and
 * serving a statement with nothing on it saying the arithmetic failed, is how a
 * wrong number ends up in front of a bank. Between "the app is broken" and "the
 * app is confidently wrong", the second is the one that costs somebody money.
 *
 * ## So: throw where somebody will fix it, disclose where somebody will read it
 *
 * In test and development a mismatch is a bug being written right now, and the
 * loudest possible failure is the cheapest one — the stack trace lands on the
 * machine of the person who caused it, and the e2e suite goes red before the
 * commit. In production nobody is watching the console, so the failure has to
 * travel: an error in the log with the workspace and the gap in it, and
 * `reconciled: false` plus the signed `discrepancyMinor` on the response, so
 * the screen can say হিসাব মিলছে না instead of quietly presenting a total that
 * is not the sum of its parts.
 *
 * The response carries `reconciled` on every build either way, including the
 * successful ones. A field that only appears when things are broken is a field
 * no client remembers to check.
 */
const THROW_ON_UNRECONCILED = process.env.NODE_ENV !== 'production';

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountsService,
    private readonly tags: TagsService,
  ) {}

  /** `to` is inclusive for the user; the query uses a half-open range. */
  private range(period: PeriodQuery, timezone: string): { gte: Date; lt: Date } {
    return {
      gte: fromLocalDateString(period.from, timezone),
      lt: new Date(fromLocalDateString(period.to, timezone).getTime() + 86_400_000),
    };
  }

  async byCategory(
    ctx: TenantContext,
    kind: 'INCOME' | 'EXPENSE',
    period: PeriodQuery,
  ): Promise<{ total: number; rows: ReturnType<typeof withShares> }> {
    const system = await this.accounts.systemAccounts(ctx.workspaceId);
    const nominalId = kind === 'INCOME' ? system.incomeAccountId : system.expenseAccountId;
    const date = this.range(period, ctx.timezone);

    const grouped = await this.prisma.ledgerEntry.groupBy({
      by: ['categoryId'],
      where: {
        workspaceId: ctx.workspaceId,
        accountId: nominalId,
        transaction: { deletedAt: null, date },
      },
      _sum: { amountMinor: true },
    });

    /* Every category, not only the ones with spending: a parent whose money is
     * all in its children still has to appear, or that money vanishes. */
    const cats = await this.prisma.category.findMany({
      where: { workspaceId: ctx.workspaceId, deletedAt: null },
      select: { id: true, name: true, nameBn: true, parentId: true },
    });
    const nameById = new Map(cats.map((c) => [c.id, displayName(c, ctx.locale)]));
    const parentOf = new Map(cats.map((c) => [c.id, c.parentId]));

    const rows: CategoryTotal[] = grouped.map((g) => {
      const parentId = g.categoryId ? parentOf.get(g.categoryId) : null;
      return {
        categoryId: g.categoryId,
        name: g.categoryId
          ? (nameById.get(g.categoryId) ?? UNKNOWN_CATEGORY[ctx.locale])
          : UNFILED[ctx.locale],
        totalMinor: minorToNumber(g._sum.amountMinor ?? 0n),
        parentName: parentId ? (nameById.get(parentId) ?? undefined) : undefined,
      };
    });

    const withShare = withShares(rows);
    return { total: withShare.reduce((s, r) => s + r.totalMinor, 0), rows: withShare };
  }

  /**
   * The same period, folded to parents. This is what a report shows by default:
   * "যাতায়াত ৳৪,০০০" rather than four separate lines the reader has to add up.
   */
  async byParentCategory(
    ctx: TenantContext,
    kind: 'INCOME' | 'EXPENSE',
    period: PeriodQuery,
  ): Promise<{ total: number; nodes: CategoryNode[] }> {
    const { rows, total } = await this.byCategory(ctx, kind, period);
    const cats = await this.prisma.category.findMany({
      where: { workspaceId: ctx.workspaceId, deletedAt: null },
      select: { id: true, parentId: true },
    });
    const parentOf = new Map(cats.map((c) => [c.id, c.parentId]));
    return { total, nodes: rollUpToParents(rows, parentOf) };
  }

  /** Same data, folded to a slice count a pie chart can actually read. */
  async byCategoryTop(ctx: TenantContext, kind: 'INCOME' | 'EXPENSE', period: PeriodQuery, n = 6) {
    const { nodes, total } = await this.byParentCategory(ctx, kind, period);
    const parents: CategoryTotal[] = nodes.map((node) => ({
      categoryId: node.categoryId,
      name: node.name,
      totalMinor: node.rolledUpMinor,
    }));
    return { total, rows: withShares(topWithRest(parents, n)) };
  }

  /**
   * The same period, cut by tag instead of by category.
   *
   * The category report answers "what did we spend it on?"; this one answers
   * "who was it for?" — পারিবারিক, শ্বশুরবাড়ি, রমজান, গাড়ি. It is the reason
   * tags exist at all: one grocery bill is a family expense this week and a
   * business one the next, and a category that tried to record both would ruin
   * every "what do we spend on food?" answer in the application.
   *
   * ## Two things the obvious version gets wrong
   *
   * **Double counting.** A transaction with three tags appears on three rows. So
   * `rows` sum to more than the period's spending, and they *should* — each row
   * is a true statement about that tag. What must not inflate is the headline:
   * `totalMinor` counts every transaction exactly once, comes from its own
   * aggregate rather than from adding the rows up, and is what `sharePercent` is
   * a share of. The difference between the two is published as `overlapMinor`
   * rather than quietly reconciled.
   *
   * **Untagged.** A report that lists only the tags a user created lets them
   * believe those tags cover their whole month. They rarely do. The untagged
   * bucket is a row like any other — sorted by amount, with its own share — and
   * it is emitted even at zero, because "everything this month is tagged" is
   * itself worth saying.
   *
   * `withShares` from @hishab/core is not reused here, and the reason is the
   * denominator: it divides by the sum of the rows it is given, which is exactly
   * the inflated figure above. `shareOfTotal` below applies the identical
   * rounding so the two reports round the same way.
   */
  async byTag(
    ctx: TenantContext,
    kind: 'INCOME' | 'EXPENSE',
    period: PeriodQuery,
  ): Promise<TagReport> {
    const system = await this.accounts.systemAccounts(ctx.workspaceId);
    const nominalId = kind === 'INCOME' ? system.incomeAccountId : system.expenseAccountId;
    const date = this.range(period, ctx.timezone);

    const [perTag, tags, totals] = await Promise.all([
      /* Shared with `GET /tags` so the list and the report cannot drift apart. */
      this.tags.tagTotals(ctx.workspaceId, date),
      this.prisma.tag.findMany({
        where: { workspaceId: ctx.workspaceId, deletedAt: null },
        select: { id: true, name: true, nameBn: true, color: true, icon: true, sortOrder: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
      this.periodTotals(ctx.workspaceId, nominalId, date),
    ]);

    const rows: TagTotalRow[] = [];
    for (const tag of tags) {
      const found = perTag.get(tag.id);
      if (!found) continue;
      const totalMinor = kind === 'INCOME' ? found.incomeMinor : found.expenseMinor;
      const transactionCount = kind === 'INCOME' ? found.incomeCount : found.expenseCount;
      /* A tag used only on transfers has no nominal leg on either side, so it
       * belongs on neither report. Omitted rather than printed as a zero line
       * that the user cannot act on. */
      if (totalMinor === 0 && transactionCount === 0) continue;
      rows.push({
        tagId: tag.id,
        name: displayName(tag, ctx.locale),
        color: tag.color,
        icon: tag.icon,
        totalMinor,
        transactionCount,
        sharePercent: 0,
      });
    }

    const attributedMinor = rows.reduce((sum, row) => sum + row.totalMinor, 0);
    const taggedMinor = totals.totalMinor - totals.untaggedMinor;

    rows.push({
      tagId: null,
      name: UNTAGGED_LABEL[ctx.locale],
      color: null,
      icon: null,
      totalMinor: totals.untaggedMinor,
      transactionCount: totals.untaggedCount,
      sharePercent: 0,
    });

    const ranked = rows
      .map((row) => ({ ...row, sharePercent: shareOfTotal(row.totalMinor, totals.totalMinor) }))
      .sort((a, b) => b.totalMinor - a.totalMinor);

    return {
      kind,
      from: period.from,
      to: period.to,
      totalMinor: totals.totalMinor,
      transactionCount: totals.transactionCount,
      taggedMinor,
      untaggedMinor: totals.untaggedMinor,
      attributedMinor,
      overlapMinor: attributedMinor - taggedMinor,
      rows: ranked,
    };
  }

  /**
   * The period's real total and its untagged part, each transaction once.
   *
   * Deliberately a separate aggregate from the per-tag one rather than a sum of
   * it: the whole point is a denominator that no amount of multi-tagging can
   * inflate. `EXISTS` is evaluated once per ledger row against the
   * `(workspaceId, tagId)` index, and is hoisted into a sub-select because a
   * correlated subquery is not allowed inside an aggregate `FILTER`.
   */
  private async periodTotals(
    workspaceId: string,
    nominalId: string,
    date: { gte: Date; lt: Date },
  ): Promise<{
    totalMinor: number;
    transactionCount: number;
    untaggedMinor: number;
    untaggedCount: number;
  }> {
    const [row] = await this.prisma.$queryRaw<
      { total: bigint; txn_count: number; untagged: bigint; untagged_count: number }[]
    >`
      SELECT COALESCE(SUM(x.amount), 0)::bigint AS total,
             COUNT(DISTINCT x.tx_id)::int AS txn_count,
             COALESCE(SUM(CASE WHEN x.is_tagged THEN 0 ELSE x.amount END), 0)::bigint AS untagged,
             COUNT(DISTINCT CASE WHEN x.is_tagged THEN NULL ELSE x.tx_id END)::int AS untagged_count
      FROM (
        SELECT t."id" AS tx_id,
               e."amountMinor" AS amount,
               EXISTS (
                 SELECT 1 FROM "TransactionTag" tt
                 WHERE tt."transactionId" = t."id" AND tt."workspaceId" = ${workspaceId}
               ) AS is_tagged
        FROM "LedgerEntry" e
        JOIN "Transaction" t ON t."id" = e."transactionId"
        WHERE e."workspaceId" = ${workspaceId}
          AND e."accountId" = ${nominalId}
          AND t."deletedAt" IS NULL
          AND t."date" >= ${date.gte}
          AND t."date" < ${date.lt}
      ) x
    `;

    return {
      totalMinor: minorToNumber(BigInt(row?.total ?? 0n)),
      transactionCount: Number(row?.txn_count ?? 0),
      untaggedMinor: minorToNumber(BigInt(row?.untagged ?? 0n)),
      untaggedCount: Number(row?.untagged_count ?? 0),
    };
  }

  /**
   * Income and expense per month. Grouped in SQL because doing it in JavaScript
   * would mean pulling every entry of the year into memory.
   */
  async trend(ctx: TenantContext, months = 12): Promise<TrendPoint[]> {
    const system = await this.accounts.systemAccounts(ctx.workspaceId);

    const rows = await this.prisma.$queryRaw<{ month: string; income: bigint; expense: bigint }[]>`
      SELECT to_char(t."date" AT TIME ZONE 'UTC' AT TIME ZONE ${ctx.timezone}, 'YYYY-MM') AS month,
             COALESCE(SUM(CASE WHEN e."accountId" = ${system.incomeAccountId} THEN e."amountMinor" ELSE 0 END), 0) AS income,
             COALESCE(SUM(CASE WHEN e."accountId" = ${system.expenseAccountId} THEN e."amountMinor" ELSE 0 END), 0) AS expense
      FROM "LedgerEntry" e
      JOIN "Transaction" t ON t."id" = e."transactionId"
      WHERE e."workspaceId" = ${ctx.workspaceId}
        AND t."deletedAt" IS NULL
        AND e."accountId" IN (${system.incomeAccountId}, ${system.expenseAccountId})
      GROUP BY 1
    `;

    const endMonth = toLocalDateString(new Date(), ctx.timezone).slice(0, 7);
    return buildTrend(
      rows.map((r) => ({
        month: r.month,
        incomeMinor: minorToNumber(BigInt(r.income)),
        expenseMinor: minorToNumber(BigInt(r.expense)),
      })),
      endMonth,
      months,
    );
  }

  /**
   * Assets, liabilities and net worth **as at a day**, always with the
   * breakdown.
   *
   * A balance sheet is a photograph, so it needs a date. Without `asOf` it can
   * only answer "right now", which is why the reports screen has to label নিট
   * সম্পদ আজকের হিসাবে and tell the reader its date range does not apply — and
   * why *was I better off in June than I am now?*, the one question anybody
   * actually asks of a balance sheet, had no answer at all. With `asOf` the
   * answer is the position at the end of that day in the **workspace's**
   * timezone, not the server's.
   *
   * Absent `asOf`, this is byte for byte what it always returned, including the
   * absence of the `asOf` field. That is not quite the same as `asOf=<today>`:
   * undated means *every entry on the books*, so a transaction dated next month
   * counts, while a dated sheet stops at the day it names. Every existing
   * caller keeps the answer it has been getting; the difference only shows in a
   * workspace holding future-dated entries, and there the honest reading of
   * "today" is the one that stops today.
   *
   * Deliberately **not** filtered on `systemKey`. What belongs on a balance
   * sheet is decided by account class, and `buildBalanceSheet` already drops
   * everything `ACCOUNT_CLASS` calls NOMINAL — which is exactly the three
   * EQUITY nominal accounts the old `systemKey: null` was there to remove. The
   * two loan control accounts also carry a `systemKey`, to keep them off the
   * wallet list, but ঋণ পাওনা is an asset and ঋণ দেনা is a liability: filtering
   * them out here would drop every loan in the workspace off the statement that
   * is supposed to show debts. Hiding a screen and omitting a balance are
   * different jobs, and only one of them belongs to `systemKey`.
   */
  async balanceSheet(
    ctx: TenantContext,
    query: BalanceSheetQuery = {},
  ): Promise<PreparedBalanceSheet | DatedBalanceSheet> {
    /* Fetched once and reused by both sides of a comparison: the rows carry
     * only id, name and type, all of which are properties of the account today
     * rather than of the date. Which of them existed on each date is decided
     * per date, by `balances`. */
    const accounts = await this.prisma.account.findMany({
      where: { workspaceId: ctx.workspaceId, deletedAt: null },
      select: { id: true, name: true, type: true, assetKind: true },
    });

    const [current, earlier] = await Promise.all([
      this.balanceSheetLines(ctx, accounts, query.asOf),
      query.compareTo
        ? this.balanceSheetLines(ctx, accounts, query.compareTo)
        : Promise.resolve(null),
    ]);

    /* The basis and the notes are attached once, here, so every shape this
       method can return carries them — undated, dated, and compared alike. An
       API consumer who has to know which of the three calls gets the basis will
       pick the wrong call. `notes` is a fresh array each time rather than the
       module constant, so a caller mutating what it was handed cannot change
       what the next request says. */
    const sheet: PreparedBalanceSheet = {
      ...buildBalanceSheet(current),
      basis: BASIS,
      notes: [...BALANCE_SHEET_NOTES],
    };
    if (!query.asOf && !query.compareTo) return sheet;

    // A response that carries a comparison has to say what date it is a
    // comparison *of*, even when the caller only named the earlier one.
    const asOf = query.asOf ?? toLocalDateString(new Date(), ctx.timezone);
    const dated: DatedBalanceSheet = { ...sheet, asOf };
    if (!earlier || !query.compareTo) return dated;

    return {
      ...dated,
      comparison: {
        asOf: query.compareTo,
        ...compareBalanceSheets(sheet, buildBalanceSheet(earlier)),
      },
    };
  }

  /**
   * One balance-sheet row per account that existed on `asOf`, at its balance
   * that day. `undefined` means no cut-off at all — the whole ledger.
   *
   * The as-of arithmetic lives entirely in `AccountsService.balances`; this
   * only converts the day into the instant it ends. The keyset of that map is
   * the authority on which accounts existed, so the rule is stated once rather
   * than re-derived beside every query that needs it.
   */
  private async balanceSheetLines(
    ctx: TenantContext,
    accounts: readonly {
      id: string;
      name: string;
      type: AccountType;
      assetKind: AssetKind | null;
    }[],
    asOf?: string,
  ): Promise<AccountBalanceRow[]> {
    /* The exclusive upper bound of the local day: midnight at the start of the
     * next one, in the workspace's timezone. `nextDateKey` then
     * `fromLocalDateString` rather than `+ 86_400_000`, so the boundary is a
     * real local midnight even across an offset change. */
    const before =
      asOf === undefined ? undefined : fromLocalDateString(nextDateKey(asOf), ctx.timezone);
    const balances = await this.accounts.balances(ctx.workspaceId, before);

    return accounts
      .filter((a) => balances.has(a.id))
      .map((a) => ({
        id: a.id,
        name: a.name,
        type: a.type,
        balanceMinor: balances.get(a.id) ?? 0,
        assetKind: a.assetKind,
      }));
  }

  /**
   * What each credit card's last statement says is owed.
   *
   * ## Why this is its own report and not a column on the balance sheet
   *
   * The balance sheet answers "what do I owe on this card **now**". A bill
   * answers "what did I owe on the day the bank drew the line", and the two are
   * different numbers for most of every month — a card cut on the 5th and used
   * on the 6th, 8th and 11th shows a statement of ৳12,400 and a balance of
   * ৳19,000 on the 12th. Paying the second figure is harmless; reading the
   * second figure as the bill and being surprised by interest is not. So both
   * are on the row, each labelled with the day it is true for.
   *
   * ## Where the dates come from
   *
   * `statementPeriodFor` in @hishab/core, which clamps through the same
   * `clampDayToMonth` the payment reminders use. That shared clamp is the point:
   * a card billed on the 31st closes on the 28th in February, and the Telegram
   * reminder and this report must not disagree about which day that was.
   *
   * ## Two routes to today's balance, checked against each other
   *
   * `currentMinor` comes from `AccountsService.balances` — the one summing
   * convention in the application, and the one the balance sheet on the same
   * screen is built from, so this panel and that one cannot quietly differ. The
   * dated figures come from walking the card's own entries, because a balance
   * "as at" two arbitrary days is not something that aggregate can answer
   * without being run twice per card. `reconciled` is where the two are made to
   * agree: it holds only if the walk reaches the same total the aggregate does
   * *and* the statement's own arithmetic closes.
   *
   * The walk fetches every entry on the card accounts rather than aggregating
   * per date. A card carries one entry per transaction on it — a heavily used
   * card is a few thousand rows after several years — and one indexed read that
   * answers all three dates is cheaper than three aggregates per card, as well
   * as being obviously consistent between them.
   */
  async cardStatements(ctx: TenantContext): Promise<CardStatementsReport> {
    const asOf = toLocalDateString(new Date(), ctx.timezone);

    /* Archived cards are fetched and then dropped only if they are settled. A
       card somebody has closed and still owes ৳40,000 on is exactly the debt a
       position panel exists to surface; a closed card at zero is furniture. */
    const cards = await this.prisma.account.findMany({
      where: { workspaceId: ctx.workspaceId, type: 'CREDIT_CARD', deletedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        name: true,
        accountNumberMasked: true,
        statementDayOfMonth: true,
        dueDayOfMonth: true,
        creditLimitMinor: true,
        isArchived: true,
      },
    });

    if (cards.length === 0) {
      return {
        asOf,
        cards: [],
        statementTotalMinor: 0,
        currentTotalMinor: 0,
        withoutStatementDay: 0,
      };
    }

    const ids = cards.map((c) => c.id);
    const [balances, entries] = await Promise.all([
      this.accounts.balances(ctx.workspaceId),
      this.prisma.ledgerEntry.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          accountId: { in: ids },
          transaction: { deletedAt: null },
        },
        select: {
          accountId: true,
          direction: true,
          amountMinor: true,
          transaction: { select: { date: true } },
        },
      }),
    ]);

    const byCard = new Map<string, { at: number; owedMinor: number }[]>();
    for (const entry of entries) {
      /* A credit card is credit-normal: a purchase credits it and what is owed
         goes *up*. Signed as "owed" from here down, so every figure on the row
         reads the way a bill does and nothing has to be flipped on the way out. */
      const magnitude = minorToNumber(entry.amountMinor);
      const owedMinor = entry.direction === 'CREDIT' ? magnitude : -magnitude;
      const list = byCard.get(entry.accountId) ?? [];
      list.push({ at: entry.transaction.date.getTime(), owedMinor });
      byCard.set(entry.accountId, list);
    }

    const rows: CardStatementRow[] = [];

    for (const card of cards) {
      const own = byCard.get(card.id) ?? [];
      /* The authority. `balances` signs an account the ledger's way, so what is
         owed on a card is the negative of it — the same flip
         `buildBalanceSheet` performs to put a liability on the sheet. */
      const currentMinor = -(balances.get(card.id) ?? 0);
      if (card.isArchived && currentMinor === 0) continue;

      const period =
        card.statementDayOfMonth === null
          ? null
          : statementPeriodFor(asOf, card.statementDayOfMonth);

      /* Exclusive upper bounds: local midnight at the *start of the day after*
         the statement day, in the workspace's timezone. `nextDateKey` then
         `fromLocalDateString`, never `+ 86_400_000`, so the boundary survives an
         offset change — the same two-step `balanceSheetLines` uses. */
      const closeAt = period
        ? fromLocalDateString(nextDateKey(period.statementDate), ctx.timezone).getTime()
        : null;
      const openAt = period
        ? fromLocalDateString(nextDateKey(period.previousDate), ctx.timezone).getTime()
        : null;

      let walkedMinor = 0;
      let openingMinor = 0;
      let closingMinor = 0;
      let purchasesMinor = 0;
      let paymentsMinor = 0;

      for (const entry of own) {
        walkedMinor += entry.owedMinor;
        if (openAt === null || closeAt === null) continue;
        if (entry.at < openAt) openingMinor += entry.owedMinor;
        if (entry.at < closeAt) closingMinor += entry.owedMinor;
        if (entry.at >= openAt && entry.at < closeAt) {
          if (entry.owedMinor > 0) purchasesMinor += entry.owedMinor;
          else paymentsMinor += -entry.owedMinor;
        }
      }

      const limit = minorToNumber(card.creditLimitMinor);
      const statementMinor = period ? closingMinor : null;
      const reconciled =
        walkedMinor === currentMinor &&
        (period === null || openingMinor + purchasesMinor - paymentsMinor === closingMinor);

      if (!reconciled) {
        /* Not thrown. A card whose walk disagrees with the aggregate is a
           defect worth a log line and a flag on the row the screen can print;
           it is not worth turning the whole reports page into a 500 for
           somebody who wanted to see their land and their cash. */
        this.logger.error(
          `Card statement does not reconcile for account ${card.id} in workspace ` +
            `${ctx.workspaceId}: walked ${walkedMinor}, balance ${currentMinor}, ` +
            `opening ${openingMinor} + ${purchasesMinor} − ${paymentsMinor} vs ${closingMinor}`,
        );
      }

      rows.push({
        id: card.id,
        name: card.name,
        accountNumberMasked: card.accountNumberMasked,
        statementDayOfMonth: card.statementDayOfMonth,
        dueDayOfMonth: card.dueDayOfMonth,
        statementDate: period?.statementDate ?? null,
        previousStatementDate: period?.previousDate ?? null,
        dueDate:
          period && card.dueDayOfMonth !== null
            ? nextDayOfMonthAfter(period.statementDate, card.dueDayOfMonth)
            : null,
        openingMinor,
        purchasesMinor,
        paymentsMinor,
        statementMinor,
        currentMinor,
        sinceStatementMinor: statementMinor === null ? null : currentMinor - statementMinor,
        creditLimitMinor: limit,
        /* Never below zero: over the limit is a fact about the debt, not spare
           room, and a negative "left to spend" would read as one. The same rule
           `AccountsService.present` keeps, so the wallet and this agree. */
        undrawnMinor: Math.max(0, limit - Math.max(0, currentMinor)),
        reconciled,
      });
    }

    return {
      asOf,
      cards: rows,
      /* Only the cards that have a statement. A card with no statement day
         contributes nothing here rather than contributing today's balance,
         which would put a figure that is not on any bill into a total labelled
         as being off the bills. `withoutStatementDay` is how the screen says so. */
      statementTotalMinor: rows.reduce((sum, row) => sum + (row.statementMinor ?? 0), 0),
      currentTotalMinor: rows.reduce((sum, row) => sum + row.currentMinor, 0),
      withoutStatementDay: rows.filter((row) => row.statementDate === null).length,
    };
  }

  /**
   * Cash in and out over a period, across the liquid accounts. The closing
   * figure must equal those accounts' balance at the end of the period — if it
   * does not, a query missed an entry.
   *
   * ## The two independent computations, and why they are checked against each
   * other
   *
   * `openingMinor`, `inflowMinor` and `outflowMinor` come from an aggregate over
   * ledger entries on the liquid accounts, which knows nothing about sections.
   * `cashFlowSections` walks the same window transaction by transaction and
   * files each movement by the account on the other side of it. Two routes to
   * the same money, and `buildSectionedCashFlow` puts them side by side: if the
   * three sections do not add up to the movement the balances show, one of them
   * is wrong. That is the check, and it is now run rather than described.
   */
  async cashFlow(ctx: TenantContext, period: PeriodQuery): Promise<CashFlowStatement> {
    const liquid = await this.prisma.account.findMany({
      where: {
        workspaceId: ctx.workspaceId,
        systemKey: null,
        deletedAt: null,
        type: { in: [...LIQUID_TYPES] },
      },
      select: { id: true, name: true, type: true },
    });
    const ids = liquid.map((a) => a.id);
    if (ids.length === 0) {
      /* No liquid accounts: nothing moved, and nothing can fail to reconcile.
         Still says so in the same fields, so a client never has to branch on
         whether the workspace has a wallet yet. */
      return {
        basis: BASIS,
        openingMinor: 0,
        inflowMinor: 0,
        outflowMinor: 0,
        netMinor: 0,
        closingMinor: 0,
        operatingMinor: 0,
        investingMinor: 0,
        financingMinor: 0,
        reconciled: true,
        discrepancyMinor: 0,
        accounts: [],
      };
    }

    const date = this.range(period, ctx.timezone);

    const [before, during] = await Promise.all([
      this.prisma.ledgerEntry.groupBy({
        by: ['accountId', 'direction'],
        where: {
          workspaceId: ctx.workspaceId,
          accountId: { in: ids },
          transaction: { deletedAt: null, date: { lt: date.gte } },
        },
        _sum: { amountMinor: true },
      }),
      this.prisma.ledgerEntry.groupBy({
        by: ['accountId', 'direction'],
        where: {
          workspaceId: ctx.workspaceId,
          accountId: { in: ids },
          transaction: { deletedAt: null, date },
        },
        _sum: { amountMinor: true },
      }),
    ]);

    const typeById = new Map(liquid.map((a) => [a.id, a.type]));
    const signed = (row: {
      accountId: string;
      direction: 'DEBIT' | 'CREDIT';
      _sum: { amountMinor: bigint | null };
    }) => {
      const type = typeById.get(row.accountId);
      if (!type) return 0;
      const magnitude = minorToNumber(row._sum.amountMinor ?? 0n);
      return row.direction === 'DEBIT' ? magnitude : -magnitude;
    };

    /* Entries dated before the window, and nothing else. An opening balance is
       an OPENING_BALANCE transaction now rather than a dateless column added on
       top here, so it is in `before` when it predates the window and an inflow
       when it does not — which is the honest reading either way. */
    const openingMinor = before.reduce((sum, row) => sum + signed(row), 0);

    let inflowMinor = 0;
    let outflowMinor = 0;
    for (const row of during) {
      const effect = signed(row);
      if (effect >= 0) inflowMinor += effect;
      else outflowMinor += -effect;
    }

    const sections = await this.cashFlowSections(ctx, ids, date);
    const balances = buildCashFlow({ openingMinor, inflowMinor, outflowMinor });

    const proved = buildSectionedCashFlow({
      openingMinor,
      closingMinor: balances.closingMinor,
      inflowMinor,
      outflowMinor,
      ...sections,
    });

    if (!proved.reconciled) {
      /* Development and test: fail loudly, at the point of the defect. See
         THROW_ON_UNRECONCILED for why production does not. */
      if (THROW_ON_UNRECONCILED) assertReconciles(proved);

      this.logger.error(
        `Cash flow does not reconcile for workspace ${ctx.workspaceId} ` +
          `(${period.from}..${period.to}): opening ${proved.openingMinor} + sections ` +
          `${proved.netMinor} = ${proved.openingMinor + proved.netMinor}, closing ` +
          `${proved.closingMinor}, off by ${proved.discrepancyMinor} poisha`,
      );
    }

    /* `netMinor` stays the balance-derived movement (`inflow − outflow`) rather
       than the sum of the sections. The two are the same number whenever the
       statement reconciles, and when it does not, the one a reader wants at the
       bottom of the page is the one the accounts actually moved by — the
       sections are the side that is wrong. `discrepancyMinor` is the difference
       between them, so nothing is hidden by the choice. */
    return {
      ...balances,
      ...sections,
      basis: BASIS,
      reconciled: proved.reconciled,
      discrepancyMinor: proved.discrepancyMinor,
      accounts: liquid.map((a) => a.name),
    };
  }

  /**
   * The same movements, split into operating, investing and financing (IAS 7).
   *
   * ## How a movement is classified
   *
   * By the account on the *other* side of it, never by the transaction's type.
   * A `TRANSFER` between two bank accounts is not a cash flow; a `TRANSFER`
   * from a bank account into a land account is an investing outflow. Same type,
   * different sections, and the whole difference is what sat opposite.
   *
   * A transaction can have more than two entries — a shared bill has three, and
   * one of them is on the liquid side. So the liquid movement is apportioned
   * across the counter-entries in proportion to their amounts, which is the
   * only reading that adds up: ৳3,000 leaving a wallet against ৳1,000 of
   * expense and ৳2,000 of receivable is ৳1,000 operating and ৳2,000 financing,
   * and any other split would misstate both.
   *
   * ## Proved, not asserted
   *
   * The three sections must sum to the movement the balances actually show. The
   * caller hands what comes back here to `buildSectionedCashFlow`, which checks
   * exactly that and refuses to produce a statement without a verdict on
   * itself, because a cash flow statement that does not reconcile is arithmetic
   * wearing a report's clothes.
   *
   * A movement filed as `INTERNAL` is dropped here, which is correct only for
   * money that never left the household — a transfer between two of your own
   * pockets. Anything else classified into `INTERNAL` disappears from the
   * sections while staying in the closing balance, and is precisely the defect
   * the reconciliation catches.
   */
  private async cashFlowSections(
    ctx: TenantContext,
    liquidIds: string[],
    date: { gte?: Date; lt?: Date },
  ): Promise<CashFlowSectionTotals> {
    if (liquidIds.length === 0) {
      return { operatingMinor: 0, investingMinor: 0, financingMinor: 0 };
    }

    /* Every transaction that touched a liquid account in the window, with all
       of its entries — including the ones on the other side, which are what the
       classification reads. */
    const transactions = await this.prisma.transaction.findMany({
      where: {
        workspaceId: ctx.workspaceId,
        deletedAt: null,
        date,
        entries: { some: { accountId: { in: liquidIds } } },
      },
      select: {
        entries: {
          select: {
            accountId: true,
            direction: true,
            amountMinor: true,
            account: { select: { type: true, systemKey: true } },
          },
        },
      },
    });

    const liquid = new Set(liquidIds);
    let operatingMinor = 0;
    let investingMinor = 0;
    let financingMinor = 0;

    for (const transaction of transactions) {
      const own = transaction.entries.filter((e) => liquid.has(e.accountId));
      const others = transaction.entries.filter((e) => !liquid.has(e.accountId));

      const movement = own.reduce(
        (sum, e) => sum + (e.direction === 'DEBIT' ? 1 : -1) * minorToNumber(e.amountMinor),
        0,
      );
      if (movement === 0) continue; // money moved between two of your own pockets

      const weightTotal = others.reduce((sum, e) => sum + minorToNumber(e.amountMinor), 0);
      if (weightTotal === 0) continue;

      /* Apportioned in whole poisha with the remainder given to the largest
         counter-entry, so the sections still add up to `movement` exactly. */
      let assigned = 0;
      const shares = others.map((entry, index) => {
        const weight = minorToNumber(entry.amountMinor);
        const share =
          index === others.length - 1
            ? movement - assigned
            : Math.trunc((movement * weight) / weightTotal);
        assigned += share;
        return { entry, share };
      });

      for (const { entry, share } of shares) {
        const role = ReportsService.systemRole(entry.account.systemKey);
        switch (cashFlowSection(entry.account.type, role)) {
          case 'OPERATING':
            operatingMinor += share;
            break;
          case 'INVESTING':
            investingMinor += share;
            break;
          case 'FINANCING':
            financingMinor += share;
            break;
          default:
            break;
        }
      }
    }

    return { operatingMinor, investingMinor, financingMinor };
  }

  /** The three nominal accounts share one type and mean three different things. */
  private static systemRole(systemKey: string | null): 'INCOME' | 'EXPENSE' | 'EQUITY' | null {
    if (systemKey === SYSTEM_ACCOUNT_KEYS.income) return 'INCOME';
    if (systemKey === SYSTEM_ACCOUNT_KEYS.expense) return 'EXPENSE';
    if (systemKey === SYSTEM_ACCOUNT_KEYS.equity) return 'EQUITY';
    return null;
  }

  /**
   * The income statement: what came in, what went out, what was left.
   *
   * ## Why this is a statement and not the by-category report again
   *
   * `by-category` answers "where did the money go"; this answers "how did the
   * year go". Both sides on one page, a net figure at the bottom, and — the part
   * IAS 1 requires and the part that makes it worth reading — a comparative
   * column. A period with nothing beside it tells a reader the numbers but not
   * the direction, and direction is the whole question.
   *
   * ## Cash basis, stated plainly
   *
   * These are a household's books. An electricity bill that has arrived and not
   * been paid is not in here, and should not be: accrual accounting for a
   * family means recording obligations nobody tracks, and a report full of
   * estimates is less honest than one that says what actually moved. The basis
   * travels on the response so the page can print it, because a statement that
   * does not say what basis it is on cannot be checked.
   */
  async incomeStatement(
    ctx: TenantContext,
    period: PeriodQuery,
    compareTo?: PeriodQuery,
  ): Promise<IncomeStatement> {
    const [current, previous] = await Promise.all([
      this.incomeStatementLines(ctx, period),
      compareTo ? this.incomeStatementLines(ctx, compareTo) : Promise.resolve(null),
    ]);

    return {
      from: period.from,
      to: period.to,
      basis: BASIS,
      ...current,
      comparison: previous
        ? { from: compareTo?.from ?? '', to: compareTo?.to ?? '', ...previous }
        : undefined,
    };
  }

  private async incomeStatementLines(
    ctx: TenantContext,
    period: PeriodQuery,
  ): Promise<IncomeStatementFigures> {
    const [income, expense] = await Promise.all([
      this.byParentCategory(ctx, 'INCOME', period),
      this.byParentCategory(ctx, 'EXPENSE', period),
    ]);

    const incomeMinor = income.total;
    const expenseMinor = expense.total;

    return {
      incomeMinor,
      expenseMinor,
      /* "Surplus" rather than "profit". A household does not trade, and calling
         what is left over a profit invites the reader to compare it with a
         business's, which is a comparison that means nothing. */
      surplusMinor: incomeMinor - expenseMinor,
      /* How much of what came in was kept. The single most useful number on the
         page for anybody assessing whether somebody can take on a commitment,
         and zero rather than a division by zero in a month with no income. */
      savingsRateBps:
        incomeMinor > 0 ? Math.trunc(((incomeMinor - expenseMinor) * 10_000) / incomeMinor) : 0,
      income: income.nodes,
      expenses: expense.nodes,
    };
  }

  /**
   * The statement of changes in net worth — and the arithmetic that proves the
   * other three agree with each other.
   *
   * ## Why this is the most valuable page of the four
   *
   * An income statement and a balance sheet can each be internally consistent
   * and still disagree: the income statement says ৳50,000 was kept, the balance
   * sheet says net worth rose ৳30,000, and nothing on either page reveals it.
   * This is where they have to meet.
   *
   *     opening net worth + surplus ± other movements = closing net worth
   *
   * `otherMinor` is the balancing figure, and its job is to be *visible*. It
   * covers everything that changed what somebody is worth without passing
   * through income or expense — a revaluation when M44 lands, an opening
   * balance entered mid-period, a correction. Naming it is what makes it
   * checkable; folding it silently into the surplus is what makes a report
   * something nobody can audit.
   *
   * The personal equivalent of a statement of changes in equity, which IAS 1
   * requires and which a household needs for the same reason a company does.
   */
  async changesInNetWorth(ctx: TenantContext, period: PeriodQuery): Promise<ChangesInNetWorth> {
    /* The day before the window opens, so the opening figure is the position
       the period started from rather than the one it started with halfway
       through. */
    const dayBefore = toLocalDateString(
      new Date(fromLocalDateString(period.from, ctx.timezone).getTime() - 86_400_000),
      ctx.timezone,
    );

    const [opening, closing, statement] = await Promise.all([
      this.balanceSheet(ctx, { asOf: dayBefore }),
      this.balanceSheet(ctx, { asOf: period.to }),
      this.incomeStatement(ctx, period),
    ]);

    const openingMinor = opening.netWorthMinor;
    const closingMinor = closing.netWorthMinor;
    const movementMinor = closingMinor - openingMinor;

    return {
      from: period.from,
      to: period.to,
      basis: BASIS,
      openingMinor,
      incomeMinor: statement.incomeMinor,
      expenseMinor: statement.expenseMinor,
      surplusMinor: statement.surplusMinor,
      /* Whatever the surplus does not explain. Zero on ordinary books; a real
         number the month somebody revalues their land, and the line that says
         so rather than hiding it. */
      otherMinor: movementMinor - statement.surplusMinor,
      /* Itemised, because "other movements: ৳2,00,000" is not an explanation.
         It is also what tells the basis-of-preparation footer to stop saying
         assets are carried at cost — a claim that becomes false the moment one
         of them is revalued, and a false basis makes the whole statement
         uncheckable. */
      revaluations: await this.revaluationsInPeriod(ctx, period),
      closingMinor,
      movementMinor,
    };
  }

  /** Every revaluation inside a window, so the "other" line can be read. */
  private async revaluationsInPeriod(ctx: TenantContext, period: PeriodQuery) {
    const rows = await this.prisma.transaction.findMany({
      where: {
        workspaceId: ctx.workspaceId,
        deletedAt: null,
        type: 'REVALUATION',
        date: this.range(period, ctx.timezone),
      },
      orderBy: { date: 'asc' },
      select: {
        id: true,
        date: true,
        description: true,
        entries: {
          where: { account: { systemKey: null } },
          select: { direction: true, amountMinor: true, account: { select: { name: true } } },
        },
      },
    });

    return rows.map((row) => {
      const entry = row.entries[0];
      const magnitude = entry ? minorToNumber(entry.amountMinor) : 0;
      return {
        id: row.id,
        date: toLocalDateString(row.date, ctx.timezone),
        accountName: entry?.account.name ?? '',
        note: row.description,
        deltaMinor: entry?.direction === 'DEBIT' ? magnitude : -magnitude,
      };
    });
  }

  /** Every transaction behind one slice of the pie. */
  async categoryDrilldown(ctx: TenantContext, categoryId: string, period: PeriodQuery) {
    const category = await this.prisma.category.findFirst({
      where: { id: categoryId, workspaceId: ctx.workspaceId, deletedAt: null },
    });
    if (!category) throw new NotFoundException('ক্যাটাগরি পাওয়া যায়নি');

    /* Drilling into a parent must include what was filed under its children,
     * or the total on screen would not match the slice that was tapped. */
    const children = await this.prisma.category.findMany({
      where: { workspaceId: ctx.workspaceId, parentId: categoryId, deletedAt: null },
      select: { id: true },
    });
    const categoryIds = [categoryId, ...children.map((c) => c.id)];

    const date = this.range(period, ctx.timezone);
    const entries = await this.prisma.ledgerEntry.findMany({
      where: {
        workspaceId: ctx.workspaceId,
        categoryId: { in: categoryIds },
        transaction: { deletedAt: null, date },
      },
      include: {
        transaction: { select: { id: true, date: true, description: true, payee: true } },
      },
      orderBy: { transaction: { date: 'desc' } },
      take: 200,
    });

    const items = entries.map((e) => ({
      transactionId: e.transaction.id,
      date: toLocalDateString(e.transaction.date, ctx.timezone),
      description: e.transaction.description,
      payee: e.transaction.payee,
      amountMinor: minorToNumber(e.amountMinor),
    }));

    return {
      category: { id: category.id, name: displayName(category, ctx.locale), kind: category.kind },
      totalMinor: items.reduce((s, i) => s + i.amountMinor, 0),
      items,
    };
  }

  /**
   * How much of each thing, per unit and category.
   *
   * The question the taka figures cannot answer. "৳12,000 on fuel this year" is
   * already on every report; "340 litres" is the one somebody acts on, because
   * a price rise and a habit change look identical in money and completely
   * different in litres.
   *
   * Grouped by unit *first*, because adding kilos to litres produces a number
   * with no meaning. Every row is a total within one unit, and units never mix.
   */
  async byQuantity(ctx: TenantContext, query: PeriodQuery) {
    const { gte, lt } = this.range(query, ctx.timezone);

    const rows = await this.prisma.transaction.findMany({
      where: {
        workspaceId: ctx.workspaceId,
        deletedAt: null,
        quantityUnit: { not: null },
        quantityMilli: { not: null },
        date: { gte, lt },
      },
      select: {
        quantityMilli: true,
        quantityUnit: true,
        entries: {
          where: { categoryId: { not: null } },
          select: { category: { select: { id: true, name: true, nameBn: true } } },
          take: 1,
        },
      },
    });

    /* Unit names are compared case- and space-insensitively so "কেজি" and
     * "কেজি " are one row. The *first* spelling seen is what gets printed —
     * lowercasing a Bengali unit would be a no-op anyway, and second-guessing
     * somebody's own word for their own unit is not this function's business. */
    const buckets = new Map<
      string,
      {
        unit: string;
        totalMilli: number;
        count: number;
        byCategory: Map<string, { name: string; totalMilli: number }>;
      }
    >();

    for (const row of rows) {
      const unit = (row.quantityUnit ?? '').trim();
      if (!unit) continue;
      const key = unit.toLowerCase();
      const bucket = buckets.get(key) ?? {
        unit,
        totalMilli: 0,
        count: 0,
        byCategory: new Map<string, { name: string; totalMilli: number }>(),
      };

      const milli = minorToNumber(row.quantityMilli ?? 0n);
      bucket.totalMilli += milli;
      bucket.count += 1;

      const category = row.entries[0]?.category;
      const categoryKey = category?.id ?? 'none';
      const name = category ? displayName(category, ctx.locale) : UNCATEGORISED[ctx.locale];
      const seen = bucket.byCategory.get(categoryKey) ?? { name, totalMilli: 0 };
      seen.totalMilli += milli;
      bucket.byCategory.set(categoryKey, seen);

      buckets.set(key, bucket);
    }

    return {
      from: query.from,
      to: query.to,
      units: [...buckets.values()]
        .sort((a, b) => b.totalMilli - a.totalMilli)
        .map((bucket) => ({
          unit: bucket.unit,
          totalMilli: bucket.totalMilli,
          transactionCount: bucket.count,
          categories: [...bucket.byCategory.values()]
            .sort((a, b) => b.totalMilli - a.totalMilli)
            .map((c) => ({ name: c.name, totalMilli: c.totalMilli })),
        })),
    };
  }
}

/**
 * A row's share of a total that is **not** the sum of the rows.
 *
 * `withShares` in @hishab/core is the convention for this and is reused
 * everywhere it fits; it does not fit here, on two counts. Its denominator is
 * the sum of the rows it is handed, which for tags is inflated by every
 * multi-tagged transaction, and its row type is keyed `categoryId`. What is
 * copied exactly is the arithmetic: integer poisha in, one decimal out, and
 * `Math.floor(x + 0.5)` rather than `Math.round`, which is banned repo-wide
 * because money must never touch float rounding.
 */
function shareOfTotal(amountMinor: number, totalMinor: number): number {
  if (totalMinor === 0) return 0;
  return Math.floor((amountMinor / totalMinor) * 1000 + 0.5) / 10;
}
