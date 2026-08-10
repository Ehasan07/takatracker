import { Injectable, NotFoundException } from '@nestjs/common';
import {
  buildBalanceSheet,
  buildCashFlow,
  buildTrend,
  LIQUID_TYPES,
  rollUpToParents,
  topWithRest,
  withShares,
  type BalanceSheet,
  type CashFlow,
  type CategoryNode,
  type CategoryTotal,
  type TrendPoint,
} from '@hishab/core';
import { fromLocalDateString, toLocalDateString } from '@hishab/shared';
import { minorToNumber } from '../common/bigint-json';
import { AccountsService } from '../accounts/accounts.service';
import { PrismaService } from '../prisma/prisma.service';
import { TagsService } from '../tags/tags.service';
import type { TenantContext } from '../transactions/transactions.service';

export interface PeriodQuery {
  from: string;
  to: string;
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

/** The Bengali label for the bucket of transactions carrying no tag at all. */
const UNTAGGED_LABEL = 'ট্যাগবিহীন';

@Injectable()
export class ReportsService {
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
    const nameById = new Map(cats.map((c) => [c.id, c.nameBn ?? c.name]));
    const parentOf = new Map(cats.map((c) => [c.id, c.parentId]));

    const rows: CategoryTotal[] = grouped.map((g) => {
      const parentId = g.categoryId ? parentOf.get(g.categoryId) : null;
      return {
        categoryId: g.categoryId,
        name: g.categoryId ? (nameById.get(g.categoryId) ?? 'অজানা') : 'অশ্রেণিবদ্ধ',
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
        name: tag.nameBn ?? tag.name,
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
      name: UNTAGGED_LABEL,
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
   * Assets, liabilities and net worth, always with the breakdown.
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
  async balanceSheet(ctx: TenantContext): Promise<BalanceSheet> {
    const accounts = await this.prisma.account.findMany({
      where: { workspaceId: ctx.workspaceId, deletedAt: null },
      select: { id: true, name: true, type: true },
    });
    const balances = await this.accounts.balances(ctx.workspaceId);

    return buildBalanceSheet(
      accounts.map((a) => ({
        id: a.id,
        name: a.name,
        type: a.type,
        balanceMinor: balances.get(a.id) ?? 0,
      })),
    );
  }

  /**
   * Cash in and out over a period, across the liquid accounts. The closing
   * figure must equal those accounts' balance at the end of the period — if it
   * does not, a query missed an entry.
   */
  async cashFlow(
    ctx: TenantContext,
    period: PeriodQuery,
  ): Promise<CashFlow & { accounts: string[] }> {
    const liquid = await this.prisma.account.findMany({
      where: {
        workspaceId: ctx.workspaceId,
        systemKey: null,
        deletedAt: null,
        type: { in: [...LIQUID_TYPES] },
      },
      select: { id: true, name: true, type: true, openingBalance: true },
    });
    const ids = liquid.map((a) => a.id);
    if (ids.length === 0) {
      return {
        openingMinor: 0,
        inflowMinor: 0,
        outflowMinor: 0,
        netMinor: 0,
        closingMinor: 0,
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

    const openingMinor =
      liquid.reduce((sum, a) => sum + minorToNumber(a.openingBalance), 0) +
      before.reduce((sum, row) => sum + signed(row), 0);

    let inflowMinor = 0;
    let outflowMinor = 0;
    for (const row of during) {
      const effect = signed(row);
      if (effect >= 0) inflowMinor += effect;
      else outflowMinor += -effect;
    }

    return {
      ...buildCashFlow({ openingMinor, inflowMinor, outflowMinor }),
      accounts: liquid.map((a) => a.name),
    };
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
      category: { id: category.id, name: category.nameBn ?? category.name, kind: category.kind },
      totalMinor: items.reduce((s, i) => s + i.amountMinor, 0),
      items,
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
