import { Injectable, NotFoundException } from '@nestjs/common';
import {
  assertBalanced,
  expandSimpleTransaction,
  reconciliationDelta,
  type EntryDraft,
} from '@hishab/core';
import {
  fromLocalDateString,
  isDebitNormal,
  toLocalDateString,
  type ReconcileInput,
  type SimpleTransactionInput,
  type TransactionQuery,
} from '@hishab/shared';
import type { Prisma, TransactionType } from '@prisma/client';
import { minorToNumber } from '../common/bigint-json';
import { PrismaService } from '../prisma/prisma.service';
import { AccountsService } from '../accounts/accounts.service';

export interface TransactionView {
  id: string;
  date: string;
  type: TransactionType;
  description: string | null;
  payee: string | null;
  notes: string | null;
  source: string;
  /** Signed from the user's point of view: negative = money left. */
  amountMinor: number;
  accountId: string | null;
  accountName: string | null;
  counterAccountId: string | null;
  counterAccountName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  createdAt: string;
  balanceAfterMinor?: number;
}

const txInclude = {
  entries: {
    include: {
      account: { select: { id: true, name: true, type: true, systemKey: true } },
      category: { select: { id: true, name: true, nameBn: true } },
    },
  },
} satisfies Prisma.TransactionInclude;

type TxWithEntries = Prisma.TransactionGetPayload<{ include: typeof txInclude }>;

@Injectable()
export class TransactionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountsService,
  ) {}

  private async timezone(userId: string): Promise<string> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { timezone: true },
    });
    return user.timezone;
  }

  /** Guard every referenced row belongs to the caller (spec §9). */
  private async assertOwnership(
    userId: string,
    input: { accountId: string; counterAccountId?: string | null; categoryId?: string | null },
  ): Promise<void> {
    const accountIds = [input.accountId, input.counterAccountId].filter(
      (v): v is string => typeof v === 'string',
    );
    const found = await this.prisma.account.count({
      where: { id: { in: accountIds }, userId, deletedAt: null, systemKey: null },
    });
    if (found !== new Set(accountIds).size) {
      throw new NotFoundException('অ্যাকাউন্ট পাওয়া যায়নি');
    }
    if (input.categoryId) {
      const cat = await this.prisma.category.count({
        where: { id: input.categoryId, userId, deletedAt: null },
      });
      if (cat !== 1) throw new NotFoundException('ক্যাটাগরি পাওয়া যায়নি');
    }
  }

  async create(userId: string, input: SimpleTransactionInput): Promise<TransactionView> {
    await this.assertOwnership(userId, input);
    const system = await this.accounts.systemAccounts(userId);
    const tz = await this.timezone(userId);

    const entries = expandSimpleTransaction(
      {
        type: input.type,
        amountMinor: input.amountMinor,
        accountId: input.accountId,
        counterAccountId: input.counterAccountId,
        categoryId: input.categoryId,
      },
      system,
    );
    // Belt and braces: the engine says it balances, the DB trigger will too.
    assertBalanced(entries);

    const created = await this.prisma.transaction.create({
      data: {
        userId,
        date: fromLocalDateString(input.date, tz),
        type: input.type,
        description: input.description,
        notes: input.notes,
        payee: input.payee,
        externalRef: input.externalRef,
        source: input.source,
        entries: { create: entries.map(TransactionsService.toEntryData) },
      },
      include: txInclude,
    });

    return this.present(created, tz);
  }

  private static toEntryData(e: EntryDraft): Prisma.LedgerEntryCreateWithoutTransactionInput {
    return {
      account: { connect: { id: e.accountId } },
      category: e.categoryId ? { connect: { id: e.categoryId } } : undefined,
      amountMinor: BigInt(e.amountMinor),
      direction: e.direction,
      currency: e.currency,
      fxRate: e.fxRate,
    };
  }

  async update(
    userId: string,
    id: string,
    input: SimpleTransactionInput,
  ): Promise<TransactionView> {
    const existing = await this.prisma.transaction.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('লেনদেন পাওয়া যায়নি');

    await this.assertOwnership(userId, input);
    const system = await this.accounts.systemAccounts(userId);
    const tz = await this.timezone(userId);

    const entries = expandSimpleTransaction(
      {
        type: input.type,
        amountMinor: input.amountMinor,
        accountId: input.accountId,
        counterAccountId: input.counterAccountId,
        categoryId: input.categoryId,
      },
      system,
    );
    assertBalanced(entries);

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.ledgerEntry.deleteMany({ where: { transactionId: id } });
      return tx.transaction.update({
        where: { id },
        data: {
          date: fromLocalDateString(input.date, tz),
          type: input.type,
          description: input.description,
          notes: input.notes,
          payee: input.payee,
          externalRef: input.externalRef,
          entries: { create: entries.map(TransactionsService.toEntryData) },
        },
        include: txInclude,
      });
    });

    return this.present(updated, tz);
  }

  async remove(userId: string, id: string): Promise<{ id: string }> {
    const existing = await this.prisma.transaction.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('লেনদেন পাওয়া যায়নি');
    // Soft delete keeps the row for sync; the balance query filters it out.
    await this.prisma.transaction.update({ where: { id }, data: { deletedAt: new Date() } });
    return { id };
  }

  async findOne(userId: string, id: string): Promise<TransactionView> {
    const tx = await this.prisma.transaction.findFirst({
      where: { id, userId, deletedAt: null },
      include: txInclude,
    });
    if (!tx) throw new NotFoundException('লেনদেন পাওয়া যায়নি');
    return this.present(tx, await this.timezone(userId));
  }

  async list(
    userId: string,
    query: TransactionQuery,
  ): Promise<{ items: TransactionView[]; nextCursor: string | null }> {
    const tz = await this.timezone(userId);

    const where: Prisma.TransactionWhereInput = {
      userId,
      deletedAt: null,
      ...(query.type ? { type: query.type } : {}),
      ...(query.source ? { source: query.source } : {}),
      ...(query.personId ? { personId: query.personId } : {}),
      ...(query.from || query.to
        ? {
            date: {
              ...(query.from ? { gte: fromLocalDateString(query.from, tz) } : {}),
              ...(query.to ? { lt: addOneDay(fromLocalDateString(query.to, tz)) } : {}),
            },
          }
        : {}),
      ...(query.accountId || query.categoryId || query.minAmount || query.maxAmount
        ? {
            entries: {
              some: {
                ...(query.accountId ? { accountId: query.accountId } : {}),
                ...(query.categoryId ? { categoryId: query.categoryId } : {}),
                ...(query.minAmount !== undefined || query.maxAmount !== undefined
                  ? {
                      amountMinor: {
                        ...(query.minAmount !== undefined ? { gte: BigInt(query.minAmount) } : {}),
                        ...(query.maxAmount !== undefined ? { lte: BigInt(query.maxAmount) } : {}),
                      },
                    }
                  : {}),
              },
            },
          }
        : {}),
      ...(query.q
        ? {
            OR: [
              { description: { contains: query.q, mode: 'insensitive' } },
              { payee: { contains: query.q, mode: 'insensitive' } },
              { notes: { contains: query.q, mode: 'insensitive' } },
              { externalRef: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const rows = await this.prisma.transaction.findMany({
      where,
      include: txInclude,
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const items = page.map((row) => this.present(row, tz, query.accountId));

    if (query.accountId) await this.attachRunningBalance(userId, query.accountId, items, page);

    return { items, nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null };
  }

  /**
   * Running balance for a single-account view. One aggregate for everything
   * newer than the top row, then walk the page downwards.
   */
  private async attachRunningBalance(
    userId: string,
    accountId: string,
    items: TransactionView[],
    rows: TxWithEntries[],
  ): Promise<void> {
    const first = rows[0];
    if (!first) return;

    const account = await this.prisma.account.findFirst({
      where: { id: accountId, userId },
      select: { type: true },
    });
    if (!account) return;

    const sign = (direction: 'DEBIT' | 'CREDIT'): number =>
      (direction === 'DEBIT') === isDebitNormal(account.type) ? 1 : -1;

    const newer = await this.prisma.$queryRaw<{ direction: string; total: bigint }[]>`
      SELECT e."direction"::text AS direction, COALESCE(SUM(e."amountMinor"), 0) AS total
      FROM "LedgerEntry" e
      JOIN "Transaction" t ON t."id" = e."transactionId"
      WHERE e."accountId" = ${accountId}
        AND t."userId" = ${userId}
        AND t."deletedAt" IS NULL
        AND (t."date", t."createdAt", t."id") > (${first.date}, ${first.createdAt}, ${first.id})
      GROUP BY e."direction"
    `;

    const newerEffect = newer.reduce(
      (sum, r) => sum + sign(r.direction as 'DEBIT' | 'CREDIT') * minorToNumber(BigInt(r.total)),
      0,
    );

    const currentBalance = (await this.accounts.balances(userId)).get(accountId) ?? 0;
    // Balance right after the newest row on this page.
    let running = currentBalance - newerEffect;

    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i]!;
      const effect = row.entries
        .filter((e) => e.accountId === accountId)
        .reduce((sum, e) => sum + sign(e.direction) * minorToNumber(e.amountMinor), 0);
      items[i]!.balanceAfterMinor = running;
      running -= effect;
    }
  }

  /** Reconcile: user enters the real balance, we book the difference. */
  async reconcile(
    userId: string,
    accountId: string,
    input: ReconcileInput,
  ): Promise<{ delta: number; transaction: TransactionView | null }> {
    const account = await this.prisma.account.findFirst({
      where: { id: accountId, userId, deletedAt: null, systemKey: null },
    });
    if (!account) throw new NotFoundException('অ্যাকাউন্ট পাওয়া যায়নি');

    const balances = await this.accounts.balances(userId);
    const delta = reconciliationDelta(balances.get(accountId) ?? 0, input.actualBalanceMinor);
    if (delta === 0) return { delta: 0, transaction: null };

    const system = await this.accounts.systemAccounts(userId);
    const tz = await this.timezone(userId);
    const entries = expandSimpleTransaction(
      { type: 'ADJUSTMENT', amountMinor: delta, accountId },
      system,
    );
    assertBalanced(entries);

    const created = await this.prisma.transaction.create({
      data: {
        userId,
        date: fromLocalDateString(input.date, tz),
        type: 'ADJUSTMENT',
        description: input.note ?? 'ব্যালেন্স সমন্বয়',
        source: 'MANUAL',
        entries: { create: entries.map(TransactionsService.toEntryData) },
      },
      include: txInclude,
    });

    return { delta, transaction: this.present(created, tz) };
  }

  /** Month totals for the dashboard. */
  async summary(
    userId: string,
    from: Date,
    to: Date,
  ): Promise<{ incomeMinor: number; expenseMinor: number; netMinor: number }> {
    const system = await this.accounts.systemAccounts(userId);
    const grouped = await this.prisma.ledgerEntry.groupBy({
      by: ['accountId'],
      where: {
        accountId: { in: [system.incomeAccountId, system.expenseAccountId] },
        transaction: { userId, deletedAt: null, date: { gte: from, lt: to } },
      },
      _sum: { amountMinor: true },
    });

    const sumFor = (id: string): number =>
      minorToNumber(grouped.find((g) => g.accountId === id)?._sum.amountMinor ?? 0n);

    const incomeMinor = sumFor(system.incomeAccountId);
    const expenseMinor = sumFor(system.expenseAccountId);
    return { incomeMinor, expenseMinor, netMinor: incomeMinor - expenseMinor };
  }

  /** Expense (or income) split by category for the dashboard and reports. */
  async byCategory(
    userId: string,
    kind: 'INCOME' | 'EXPENSE',
    from: Date,
    to: Date,
  ): Promise<{ categoryId: string | null; name: string; totalMinor: number }[]> {
    const system = await this.accounts.systemAccounts(userId);
    const nominalId = kind === 'INCOME' ? system.incomeAccountId : system.expenseAccountId;

    const grouped = await this.prisma.ledgerEntry.groupBy({
      by: ['categoryId'],
      where: {
        accountId: nominalId,
        transaction: { userId, deletedAt: null, date: { gte: from, lt: to } },
      },
      _sum: { amountMinor: true },
    });

    const ids = grouped.map((g) => g.categoryId).filter((v): v is string => Boolean(v));
    const cats = await this.prisma.category.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, nameBn: true },
    });
    const nameById = new Map(cats.map((c) => [c.id, c.nameBn ?? c.name]));

    return grouped
      .map((g) => ({
        categoryId: g.categoryId,
        name: g.categoryId ? (nameById.get(g.categoryId) ?? 'অন্যান্য') : 'অশ্রেণিবদ্ধ',
        totalMinor: minorToNumber(g._sum.amountMinor ?? 0n),
      }))
      .sort((a, b) => b.totalMinor - a.totalMinor);
  }

  /** Collapse balanced double-entry lines back into what the user typed. */
  private present(tx: TxWithEntries, tz: string, focusAccountId?: string): TransactionView {
    const realEntries = tx.entries.filter((e) => !e.account.systemKey);
    const nominalEntry = tx.entries.find((e) => e.account.systemKey);

    let primary = realEntries[0] ?? null;
    let counter = realEntries[1] ?? null;

    if (tx.type === 'TRANSFER') {
      // Source is the credited side; destination is the debited side.
      primary = realEntries.find((e) => e.direction === 'CREDIT') ?? primary;
      counter = realEntries.find((e) => e.direction === 'DEBIT') ?? counter;
      if (focusAccountId && counter?.accountId === focusAccountId) {
        [primary, counter] = [counter, primary];
      }
    }

    const magnitude = minorToNumber((primary ?? counter ?? tx.entries[0])?.amountMinor ?? 0n);

    let signed = magnitude;
    if (tx.type === 'EXPENSE') signed = -magnitude;
    else if (tx.type === 'TRANSFER')
      signed = focusAccountId ? computeTransferSign(tx, focusAccountId, magnitude) : -magnitude;
    else if (tx.type === 'ADJUSTMENT' || tx.type === 'OPENING_BALANCE') {
      signed = primary?.direction === 'CREDIT' ? -magnitude : magnitude;
    }

    const category = nominalEntry?.category ?? null;

    return {
      id: tx.id,
      date: toLocalDateString(tx.date, tz),
      type: tx.type,
      description: tx.description,
      payee: tx.payee,
      notes: tx.notes,
      source: tx.source,
      amountMinor: signed,
      accountId: primary?.accountId ?? null,
      accountName: primary?.account.name ?? null,
      counterAccountId: tx.type === 'TRANSFER' ? (counter?.accountId ?? null) : null,
      counterAccountName: tx.type === 'TRANSFER' ? (counter?.account.name ?? null) : null,
      categoryId: category?.id ?? null,
      categoryName: category ? (category.nameBn ?? category.name) : null,
      createdAt: tx.createdAt.toISOString(),
    };
  }
}

function computeTransferSign(tx: TxWithEntries, accountId: string, magnitude: number): number {
  const entry = tx.entries.find((e) => e.accountId === accountId);
  if (!entry) return -magnitude;
  return entry.direction === 'DEBIT' ? magnitude : -magnitude;
}

function addOneDay(d: Date): Date {
  return new Date(d.getTime() + 86_400_000);
}
