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
import { fromLocalDateString, isDebitNormal, toLocalDateString } from '@hishab/shared';
import { minorToNumber } from '../common/bigint-json';
import { AccountsService } from '../accounts/accounts.service';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../transactions/transactions.service';

export interface PeriodQuery {
  from: string;
  to: string;
}

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountsService,
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

  /** Assets, liabilities and net worth, always with the breakdown. */
  async balanceSheet(ctx: TenantContext): Promise<BalanceSheet> {
    const accounts = await this.prisma.account.findMany({
      where: { workspaceId: ctx.workspaceId, systemKey: null, deletedAt: null },
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
      return (row.direction === 'DEBIT') === isDebitNormal(type) ? magnitude : -magnitude;
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
