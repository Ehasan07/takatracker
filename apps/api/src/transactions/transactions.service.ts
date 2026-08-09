import { Injectable, NotFoundException } from '@nestjs/common';
import {
  assertBalanced,
  expandSimpleTransaction,
  reconciliationDelta,
  type EntryDraft,
} from '@hishab/core';
import {
  fromLocalDateString,
  toLocalDateString,
  type ReconcileInput,
  type SimpleTransactionInput,
  type TransactionQuery,
} from '@hishab/shared';
import type { Prisma, TransactionType } from '@prisma/client';
import { minorToNumber } from '../common/bigint-json';
import { PrismaService } from '../prisma/prisma.service';
import { AccountsService } from '../accounts/accounts.service';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { AuditService } from '../audit/audit.service';
import { CardRemindersService } from '../notifications/card-reminders.service';

/**
 * Who is asking, and on whose behalf. `workspaceId` is the tenant guard;
 * `id` only records authorship. The timezone rides along because the JWT
 * strategy has already loaded it to validate the membership, so every ledger
 * query gets it for free instead of re-reading the user row.
 */
export interface TenantContext {
  id: string;
  workspaceId: string;
  timezone: string;
}

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
    private readonly entitlements: EntitlementsService,
    private readonly cardReminders: CardRemindersService,
    private readonly audit: AuditService,
  ) {}

  /** Guard every referenced row belongs to the caller (spec §9). */
  private async assertOwnership(
    workspaceId: string,
    input: { accountId: string; counterAccountId?: string | null; categoryId?: string | null },
  ): Promise<void> {
    const accountIds = [input.accountId, input.counterAccountId].filter(
      (v): v is string => typeof v === 'string',
    );
    const found = await this.prisma.account.count({
      where: { id: { in: accountIds }, workspaceId, deletedAt: null, systemKey: null },
    });
    if (found !== new Set(accountIds).size) {
      throw new NotFoundException('অ্যাকাউন্ট পাওয়া যায়নি');
    }
    if (input.categoryId) {
      const cat = await this.prisma.category.count({
        where: { id: input.categoryId, workspaceId, deletedAt: null },
      });
      if (cat !== 1) throw new NotFoundException('ক্যাটাগরি পাওয়া যায়নি');
    }
  }

  async create(ctx: TenantContext, input: SimpleTransactionInput): Promise<TransactionView> {
    /* Only creation is metered. Editing, deleting and restoring stay available
     * at the ceiling, because locking someone out of correcting their own books
     * is a worse outcome than letting the count drift. */
    await this.entitlements.assertWithinLimit(
      ctx.workspaceId,
      'transactions.monthly.max',
      ctx.timezone,
    );
    await this.assertOwnership(ctx.workspaceId, input);
    const system = await this.accounts.systemAccounts(ctx.workspaceId);
    const tz = ctx.timezone;

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
        workspaceId: ctx.workspaceId,
        createdByUserId: ctx.id,
        date: fromLocalDateString(input.date, tz),
        type: input.type,
        description: input.description,
        notes: input.notes,
        payee: input.payee,
        externalRef: input.externalRef,
        source: input.source,
        entries: {
          create: entries.map((e) => TransactionsService.toEntryData(e, ctx.workspaceId)),
        },
      },
      include: txInclude,
    });

    /* Recording money into a credit card ends that cycle's reminders. Fired
     * after the write and deliberately not awaited into the response path —
     * a notification concern must never fail a ledger write. */
    void this.cardReminders.autoMuteOnPayment(
      ctx.workspaceId,
      entries.map((e) => e.accountId),
    );

    this.audit.emit({
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.id,
      action: 'transaction.created',
      entity: 'Transaction',
      entityId: created.id,
      after: { type: input.type, amountMinor: input.amountMinor, date: input.date },
    });

    return this.present(created, tz);
  }

  private static toEntryData(
    e: EntryDraft,
    workspaceId: string,
  ): Prisma.LedgerEntryCreateWithoutTransactionInput {
    return {
      workspace: { connect: { id: workspaceId } },
      account: { connect: { id: e.accountId } },
      category: e.categoryId ? { connect: { id: e.categoryId } } : undefined,
      amountMinor: BigInt(e.amountMinor),
      direction: e.direction,
      currency: e.currency,
      fxRate: e.fxRate,
    };
  }

  async update(
    ctx: TenantContext,
    id: string,
    input: SimpleTransactionInput,
  ): Promise<TransactionView> {
    const existing = await this.prisma.transaction.findFirst({
      where: { id, workspaceId: ctx.workspaceId, deletedAt: null },
      include: txInclude,
    });
    if (!existing) throw new NotFoundException('লেনদেন পাওয়া যায়নি');

    /* Captured before the write, because an audit line that records only what a
     * row became cannot answer the question people open an audit log to ask:
     * what did it say before somebody changed it? */
    const before = TransactionsService.auditSnapshot(existing);

    await this.assertOwnership(ctx.workspaceId, input);
    const system = await this.accounts.systemAccounts(ctx.workspaceId);
    const tz = ctx.timezone;

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
          entries: {
            create: entries.map((e) => TransactionsService.toEntryData(e, ctx.workspaceId)),
          },
        },
        include: txInclude,
      });
    });

    this.audit.emit({
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.id,
      action: 'transaction.updated',
      entity: 'Transaction',
      entityId: id,
      before,
      after: TransactionsService.auditSnapshot(updated),
    });

    return this.present(updated, tz);
  }

  async remove(ctx: TenantContext, id: string): Promise<{ id: string }> {
    const existing = await this.prisma.transaction.findFirst({
      where: { id, workspaceId: ctx.workspaceId, deletedAt: null },
      include: txInclude,
    });
    if (!existing) throw new NotFoundException('লেনদেন পাওয়া যায়নি');
    // Soft delete keeps the row for sync; the balance query filters it out.
    await this.prisma.transaction.update({ where: { id }, data: { deletedAt: new Date() } });
    this.audit.emit({
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.id,
      action: 'transaction.deleted',
      entity: 'Transaction',
      entityId: id,
      /* The whole row, not just its id. The transaction is only soft-deleted so
       * the record survives either way, but somebody reading the timeline
       * should not have to go digging to see what was removed. */
      before: TransactionsService.auditSnapshot(existing),
    });
    return { id };
  }

  /**
   * Undo a delete. Deletion is soft precisely so this is possible: the swipe
   * gesture on a phone is easy to trigger by accident, and an accounting app
   * must never lose an entry to a slip of the thumb.
   */
  async restore(ctx: TenantContext, id: string): Promise<TransactionView> {
    const existing = await this.prisma.transaction.findFirst({
      where: { id, workspaceId: ctx.workspaceId, deletedAt: { not: null } },
      include: txInclude,
    });
    if (!existing) throw new NotFoundException('লেনদেন পাওয়া যায়নি');
    await this.prisma.transaction.update({ where: { id }, data: { deletedAt: null } });
    this.audit.emit({
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.id,
      action: 'transaction.restored',
      entity: 'Transaction',
      entityId: id,
      after: TransactionsService.auditSnapshot(existing),
    });
    return this.findOne(ctx, id);
  }

  /**
   * What an audit line records about a transaction.
   *
   * The ledger legs are included because the amount alone does not say where
   * the money went: an edit that moves ৳500 from groceries to fuel changes no
   * total, and without the legs the log would show two identical rows.
   */
  private static auditSnapshot(row: {
    date: Date;
    type: string;
    description: string | null;
    payee: string | null;
    entries?: {
      accountId: string;
      direction: string;
      amountMinor: bigint;
      categoryId: string | null;
    }[];
  }): Prisma.InputJsonValue {
    return {
      date: row.date.toISOString().slice(0, 10),
      type: row.type,
      description: row.description,
      payee: row.payee,
      entries: (row.entries ?? []).map((e) => ({
        accountId: e.accountId,
        categoryId: e.categoryId,
        direction: e.direction,
        amountMinor: minorToNumber(e.amountMinor),
      })),
    };
  }

  async findOne(ctx: TenantContext, id: string): Promise<TransactionView> {
    const tx = await this.prisma.transaction.findFirst({
      where: { id, workspaceId: ctx.workspaceId, deletedAt: null },
      include: txInclude,
    });
    if (!tx) throw new NotFoundException('লেনদেন পাওয়া যায়নি');
    return this.present(tx, ctx.timezone);
  }

  async list(
    ctx: TenantContext,
    query: TransactionQuery,
  ): Promise<{ items: TransactionView[]; nextCursor: string | null }> {
    const tz = ctx.timezone;

    const where: Prisma.TransactionWhereInput = {
      workspaceId: ctx.workspaceId,
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

    if (query.accountId) {
      await this.attachRunningBalance(ctx.workspaceId, query.accountId, items, page);
    }

    return { items, nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null };
  }

  /**
   * Running balance for a single-account view. One aggregate for everything
   * newer than the top row, then walk the page downwards.
   */
  private async attachRunningBalance(
    workspaceId: string,
    accountId: string,
    items: TransactionView[],
    rows: TxWithEntries[],
  ): Promise<void> {
    const first = rows[0];
    if (!first) return;

    const account = await this.prisma.account.findFirst({
      where: { id: accountId, workspaceId },
      select: { type: true },
    });
    if (!account) return;

    const sign = (direction: 'DEBIT' | 'CREDIT'): number => (direction === 'DEBIT' ? 1 : -1);

    const newer = await this.prisma.$queryRaw<{ direction: string; total: bigint }[]>`
      SELECT e."direction"::text AS direction, COALESCE(SUM(e."amountMinor"), 0) AS total
      FROM "LedgerEntry" e
      JOIN "Transaction" t ON t."id" = e."transactionId"
      WHERE e."accountId" = ${accountId}
        AND t."workspaceId" = ${workspaceId}
        AND t."deletedAt" IS NULL
        AND (t."date", t."createdAt", t."id") > (${first.date}, ${first.createdAt}, ${first.id})
      GROUP BY e."direction"
    `;

    const newerEffect = newer.reduce(
      (sum, r) => sum + sign(r.direction as 'DEBIT' | 'CREDIT') * minorToNumber(BigInt(r.total)),
      0,
    );

    const currentBalance = (await this.accounts.balances(workspaceId)).get(accountId) ?? 0;
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
    ctx: TenantContext,
    accountId: string,
    input: ReconcileInput,
  ): Promise<{ delta: number; transaction: TransactionView | null }> {
    const account = await this.prisma.account.findFirst({
      where: { id: accountId, workspaceId: ctx.workspaceId, deletedAt: null, systemKey: null },
    });
    if (!account) throw new NotFoundException('অ্যাকাউন্ট পাওয়া যায়নি');

    const balances = await this.accounts.balances(ctx.workspaceId);
    const delta = reconciliationDelta(balances.get(accountId) ?? 0, input.actualBalanceMinor);
    if (delta === 0) return { delta: 0, transaction: null };

    const system = await this.accounts.systemAccounts(ctx.workspaceId);
    const tz = ctx.timezone;
    const entries = expandSimpleTransaction(
      { type: 'ADJUSTMENT', amountMinor: delta, accountId },
      system,
    );
    assertBalanced(entries);

    const created = await this.prisma.transaction.create({
      data: {
        workspaceId: ctx.workspaceId,
        createdByUserId: ctx.id,
        date: fromLocalDateString(input.date, tz),
        type: 'ADJUSTMENT',
        description: input.note ?? 'ব্যালেন্স সমন্বয়',
        source: 'MANUAL',
        entries: {
          create: entries.map((e) => TransactionsService.toEntryData(e, ctx.workspaceId)),
        },
      },
      include: txInclude,
    });

    this.audit.emit({
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.id,
      action: 'transaction.reconciled',
      entity: 'Account',
      entityId: accountId,
      after: { deltaMinor: delta, actualBalanceMinor: input.actualBalanceMinor },
    });

    return { delta, transaction: this.present(created, tz) };
  }

  /** Month totals for the dashboard. */
  async summary(
    ctx: TenantContext,
    from: Date,
    to: Date,
  ): Promise<{ incomeMinor: number; expenseMinor: number; netMinor: number }> {
    const system = await this.accounts.systemAccounts(ctx.workspaceId);
    const grouped = await this.prisma.ledgerEntry.groupBy({
      by: ['accountId'],
      where: {
        workspaceId: ctx.workspaceId,
        accountId: { in: [system.incomeAccountId, system.expenseAccountId] },
        transaction: { deletedAt: null, date: { gte: from, lt: to } },
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
    ctx: TenantContext,
    kind: 'INCOME' | 'EXPENSE',
    from: Date,
    to: Date,
  ): Promise<{ categoryId: string | null; name: string; totalMinor: number }[]> {
    const system = await this.accounts.systemAccounts(ctx.workspaceId);
    const nominalId = kind === 'INCOME' ? system.incomeAccountId : system.expenseAccountId;

    const grouped = await this.prisma.ledgerEntry.groupBy({
      by: ['categoryId'],
      where: {
        workspaceId: ctx.workspaceId,
        accountId: nominalId,
        transaction: { deletedAt: null, date: { gte: from, lt: to } },
      },
      _sum: { amountMinor: true },
    });

    const ids = grouped.map((g) => g.categoryId).filter((v): v is string => Boolean(v));
    const cats = await this.prisma.category.findMany({
      where: { id: { in: ids }, workspaceId: ctx.workspaceId },
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
