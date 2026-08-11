import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Spending across every tenant, rolled up by category.
 *
 * ## The problem this has to solve
 *
 * A category belongs to a workspace. Two people who both spend on groceries
 * have two different `Category` rows with two different ids, and one of them
 * may have renamed theirs "বাজার-সদাই" or added it as a sub-category under
 * something else. So a cross-tenant question — "what does everybody spend most
 * on?" — cannot group by id. It groups by *name*, normalised, which is the only
 * key the two rows share.
 *
 * That is an approximation and it is worth being honest about which way it
 * errs: two households that write the same word are merged even if they meant
 * different things, and two that write different words for the same thing stay
 * apart. The seeded tree makes the first case common and the second rare —
 * nearly everybody keeps the twenty-one defaults — but a report built on this
 * is a picture of the *defaults*, not a census of Bangladeshi spending.
 *
 * ## Why raw SQL
 *
 * The rollup joins ledger entries to categories, normalises a name, sums by it
 * and counts distinct workspaces, in one pass over a table that grows with
 * every transaction in the product. Prisma's `groupBy` cannot express a
 * grouping key that is a function of a column, so the alternative is fetching
 * every row into Node and grouping there — which is the query that falls over
 * first as the platform grows.
 *
 * Every value is parameterised. The only interpolation is the sort direction,
 * which is chosen from a closed set below rather than taken from the request.
 */

export interface CategorySlice {
  /** The normalised name rows were grouped under. */
  name: string;
  kind: 'INCOME' | 'EXPENSE';
  totalMinor: number;
  transactionCount: number;
  /** How many workspaces contributed — the number that says "is this typical?" */
  workspaceCount: number;
}

export interface CategoryAnalyticsQuery {
  from?: string;
  to?: string;
  kind?: 'INCOME' | 'EXPENSE';
  /** Restrict to one plan's customers, for "what do paying users spend on?" */
  planCode?: string;
  limit?: number;
}

@Injectable()
export class AdminAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async byCategory(query: CategoryAnalyticsQuery): Promise<{
    slices: CategorySlice[];
    /** Workspaces with at least one matching entry, so a share can be computed. */
    workspacesCounted: number;
    currencyNote: string;
  }> {
    const limit = Math.min(100, Math.max(1, query.limit ?? 25));

    const conditions: Prisma.Sql[] = [
      Prisma.sql`t."deletedAt" IS NULL`,
      Prisma.sql`w."deletedAt" IS NULL`,
      Prisma.sql`c.id IS NOT NULL`,
    ];
    if (query.from) conditions.push(Prisma.sql`t."date" >= ${new Date(query.from)}`);
    if (query.to) conditions.push(Prisma.sql`t."date" < ${new Date(query.to)}`);
    if (query.kind) conditions.push(Prisma.sql`c."kind"::text = ${query.kind}`);
    if (query.planCode) conditions.push(Prisma.sql`p."code" = ${query.planCode}`);

    const where = Prisma.join(conditions, ' AND ');

    /* `coalesce(c."nameBn", c."name")` — the Bengali name is what nearly every
     * row carries and what the seeded tree uses, so grouping on the English
     * column would split the defaults in two. `lower(btrim(...))` folds the
     * hand-typed variants that differ only by case or a stray space. */
    const rows = await this.prisma.$queryRaw<
      { name: string; kind: string; total: bigint; txns: bigint; workspaces: bigint }[]
    >(Prisma.sql`
      SELECT lower(btrim(coalesce(c."nameBn", c."name"))) AS name,
             c."kind"::text                               AS kind,
             sum(e."amountMinor")                         AS total,
             count(DISTINCT t.id)                         AS txns,
             count(DISTINCT t."workspaceId")              AS workspaces
        FROM "LedgerEntry" e
        JOIN "Transaction" t ON t.id = e."transactionId"
        JOIN "Workspace"   w ON w.id = t."workspaceId"
        LEFT JOIN "Plan"     p ON p.id = w."planId"
        JOIN "Category"    c ON c.id = e."categoryId"
       WHERE ${where}
       GROUP BY 1, 2
       ORDER BY sum(e."amountMinor") DESC
       LIMIT ${limit}
    `);

    const counted = await this.prisma.$queryRaw<{ count: bigint }[]>(Prisma.sql`
      SELECT count(DISTINCT t."workspaceId") AS count
        FROM "LedgerEntry" e
        JOIN "Transaction" t ON t.id = e."transactionId"
        JOIN "Workspace"   w ON w.id = t."workspaceId"
        LEFT JOIN "Plan"     p ON p.id = w."planId"
        JOIN "Category"    c ON c.id = e."categoryId"
       WHERE ${where}
    `);

    return {
      slices: rows.map((r) => ({
        name: r.name,
        kind: r.kind === 'INCOME' ? 'INCOME' : 'EXPENSE',
        totalMinor: Number(r.total),
        transactionCount: Number(r.txns),
        workspaceCount: Number(r.workspaces),
      })),
      workspacesCounted: Number(counted[0]?.count ?? 0),
      /* Said out loud rather than silently summed away. Workspaces now choose
       * their own currency, so adding a yen total to a taka total produces a
       * number with no unit. Until this converts through a rate, the honest
       * reading of these figures is "minor units, mostly poisha" — and the
       * screen prints this sentence rather than a ৳ sign it cannot justify. */
      currencyNote:
        'সব ওয়ার্কস্পেসের অঙ্ক একসাথে যোগ করা — একাধিক মুদ্রা থাকলে যোগফলের একক মিশ্র।',
    };
  }

  /**
   * How many workspaces use each currency.
   *
   * The number that decides whether the note above is a footnote or a problem:
   * while every tenant is on taka the totals mean exactly what they look like.
   */
  async byCurrency(): Promise<{ currency: string; workspaces: number }[]> {
    const rows = await this.prisma.workspace.groupBy({
      by: ['currency'],
      where: { deletedAt: null },
      _count: { _all: true },
      orderBy: { _count: { currency: 'desc' } },
    });
    return rows.map((r) => ({ currency: r.currency, workspaces: r._count._all }));
  }
}
