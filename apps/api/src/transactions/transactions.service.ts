import { Injectable, NotFoundException } from '@nestjs/common';
import {
  assertBalanced,
  expandSimpleTransaction,
  reconciliationDelta,
  searchDocs,
  searchField,
  searchTokens,
  type EntryDraft,
  type SearchDoc,
} from '@hishab/core';
import {
  fromLocalDateString,
  toBengaliDigits,
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

    /* Built before the `where` so the unfiltered list path — the app's main
     * screen — pays nothing for search: no tokenising, no reference reads, no
     * extra predicates, no change to the plan the `[workspaceId, date desc]`
     * index already serves. `query.q` absent means not one line of this runs. */
    const search = query.q ? await this.buildSearchWhere(ctx.workspaceId, query.q) : null;

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
      ...(search ?? {}),
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
   * The `?q=` filter, and the only place Banglish crosses into SQL.
   *
   * Two reads, in parallel, both workspace-scoped and both over a reference
   * table a household counts in dozens. Neither filters `deletedAt`: a
   * soft-deleted category still labels the historical rows it was attached to
   * and `present()` still prints its name, so it has to stay findable by that
   * name — the same rule the relation `ILIKE` this replaced followed.
   *
   * Each token is resolved separately so the AND across tokens keeps meaning
   * what it meant: `করিম bhara` is "this person, and that word", and the person
   * may be matched by id while the word is matched in the description.
   */
  private async buildSearchWhere(
    workspaceId: string,
    raw: string,
  ): Promise<Prisma.TransactionWhereInput | null> {
    const tokens = searchTokens(raw).slice(0, MAX_SEARCH_TOKENS);
    if (tokens.length === 0) return null;

    const [categories, persons] = await Promise.all([
      this.prisma.category.findMany({
        where: { workspaceId },
        select: { id: true, name: true, nameBn: true },
      }),
      this.prisma.person.findMany({
        where: { workspaceId },
        select: { id: true, name: true },
      }),
    ]);

    /* Keys are built once for the whole request and reused for every token —
     * `searchDocs` never mutates a doc, and rebuilding them per token would be
     * the only part of this that scaled badly. */
    const categoryDocs: SearchDoc<{ id: string }>[] = categories.map((c) => ({
      id: c.id,
      row: { id: c.id },
      fields: [searchField('nameBn', 'PRIMARY', c.nameBn), searchField('name', 'PRIMARY', c.name)],
    }));
    /* The same two category columns and the same one person column the relation
     * `ILIKE` searched, deliberately not one more. `phone`, `relation` and the
     * person note are all searchable data this endpoint has never covered, and
     * widening what `q` reaches is a different decision from teaching it to
     * cross scripts — `?q=17` should not return every transaction with someone
     * whose phone number contains a seventeen. */
    const personDocs: SearchDoc<{ id: string }>[] = persons.map((p) => ({
      id: p.id,
      row: { id: p.id },
      fields: [searchField('name', 'PRIMARY', p.name)],
    }));

    const scopes = tokens.map((token) => ({
      categoryIds: resolveIds(categoryDocs, token),
      personIds: resolveIds(personDocs, token),
    }));

    return buildSearchWhereFor(workspaceId, tokens, scopes);
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

/**
 * How many tokens of `q` reach SQL.
 *
 * The schema caps `q` at 200 characters, which can tokenise into roughly a
 * hundred words. Each token costs four ILIKE branches, up to two id-set
 * branches — one of them across a relation — and one pass over the category and
 * person lists in memory. The ceiling stops one search from planning several
 * hundred predicates. Dropped tokens would only ever have *narrowed* the result
 * (tokens are ANDed), so truncating widens slightly rather than hiding a row the
 * user asked for.
 */
const MAX_SEARCH_TOKENS = 8;

/**
 * Escape the LIKE metacharacters before a token reaches `contains`.
 *
 * Prisma interpolates `contains` straight into `ILIKE '%' || $1 || '%'`, so an
 * unescaped `%` is a wildcard: searching `50%` would return the whole ledger and
 * `_` would match any single character. Postgres's default LIKE escape is the
 * backslash and the Prisma filter exposes no ESCAPE clause, so prefixing the
 * three metacharacters is both necessary and sufficient.
 */
function escapeLike(token: string): string {
  return token.replace(/[\\%_]/g, '\\$&');
}

/**
 * The forms of one token worth putting to SQL.
 *
 * `searchTokens` folds Bengali numerals to ASCII so `৫০০০` and `5000` are the
 * same query — but the *stored* description is whatever the user typed, and
 * Postgres will not fold it back. A token carrying digits is therefore matched
 * in both scripts, which covers the pair in either direction. Letters need no
 * such twin: ILIKE handles case, and Bengali has none.
 */
function needlesFor(token: string): string[] {
  const ascii = escapeLike(token);
  const bengali = escapeLike(toBengaliDigits(token));
  return ascii === bengali ? [ascii] : [ascii, bengali];
}

/**
 * The category and person ids one query token resolves to, in memory.
 *
 * `filtered: false` means core decided the token was not a filter at all (one
 * character, or nothing but punctuation) and handed back the whole list. Taking
 * those ids would turn `?q=ও 5000` into "every category in the workspace", so
 * the unfiltered answer is discarded rather than used.
 */
function resolveIds<T extends { id: string }>(
  docs: readonly SearchDoc<T>[],
  token: string,
): string[] {
  /* Suggestions off, for the reason the loans list has them off: this endpoint
   * returns a bare page of transactions with nowhere to mark a row as a guess,
   * and a ledger that quietly includes rows matching something adjacent to what
   * was typed is wrong in the one place being wrong is unforgivable. */
  const result = searchDocs(docs, token, { allowSuggestions: false });
  return result.filtered ? result.hits.map((hit) => hit.id) : [];
}

/** What one query token can match, beyond the row's own text. */
interface TokenScope {
  readonly categoryIds: readonly string[];
  readonly personIds: readonly string[];
}

/**
 * Translate `q` into a workspace-scoped `WHERE`: every token must appear
 * somewhere on the row, in any one of its searchable fields.
 *
 * ANDing the tokens and ORing the fields is what makes `করিম bhara` work — the
 * name can sit on the person while the word sits in the description. It is also
 * why the old single `contains` over the raw string was wrong: it required the
 * user to type a contiguous substring of one column.
 *
 * Tokenisation comes from `@hishab/core` so the server and the in-memory
 * matcher the client runs over small lists agree on what a token *is* — NFC,
 * case-folded, punctuation split out. That is also why a query that normalises
 * to nothing (`q=###`, `q=৳`) returns `null` and applies no filter at all: core
 * §4.1 treats an empty normalisation as *no query*, and the two paths must not
 * disagree about it.
 *
 * ## Banglish, and where it comes from
 *
 * **Postgres cannot transliterate**, and no configuration makes it able to:
 * `khabar` and `খাবার` share not one code point, so neither is a substring of
 * the other and `pg_trgm` similarity between them is exactly zero. The bridge
 * is `@hishab/core`'s five-rung fold, and that runs in TypeScript over a loaded
 * list — which the ledger is not.
 *
 * So the query is resolved against the two lists that *are* small enough to
 * load: the workspace's categories and its people, a few dozen rows each,
 * matched with the same `searchDocs` the pickers use. `khabar` becomes "the id
 * of খাবার ও বাজার", and the SQL asks for transactions filed under that id —
 * ORed with the script-preserving `ILIKE` over the row's own text, so nothing
 * that matched before stops matching.
 *
 * A **denormalised `searchFold` column on `Transaction`** was the other
 * candidate and is the reason `buildStoredSearchKeys` exists in core. It is not
 * built, and should not be: it copies the category and person names onto every
 * transaction row, and the copy goes stale the moment somebody renames a
 * category — with nothing on screen to say a row has become unsearchable. This
 * way cannot drift, because there is no copy. It costs two small indexed reads
 * on a search request and nothing at all on the unfiltered list.
 *
 * ## What it still cannot do
 *
 *  - **Free text stays script-bound.** A description reading `খাবার কিনলাম` on
 *    an uncategorised row is not reachable from `khabar`; only the row's
 *    category and counterparty cross scripts. Categorising is what makes a row
 *    findable, which is also what makes it reportable.
 *  - **No ranking.** Rows come back newest-first, not best-match-first; the tier
 *    and score model in core has no SQL equivalent.
 *  - **No fuzziness in the free text.** A typo in a description misses. A typo
 *    in a category or person name misses too — suggestions are off here.
 *  - **No normalisation on the stored side.** The query is NFC-folded; a
 *    description typed on a keyboard that emits `ে`+`া` rather than `ো` is stored
 *    decomposed and stays invisible to a composed query.
 */
function buildSearchWhereFor(
  workspaceId: string,
  tokens: readonly string[],
  scopes: readonly TokenScope[],
): Prisma.TransactionWhereInput {
  return {
    AND: tokens.map((token, i) => {
      const scope = scopes[i] ?? { categoryIds: [], personIds: [] };
      const text = needlesFor(token).flatMap((needle) => {
        const contains = { contains: needle, mode: 'insensitive' } as const;
        return [
          { description: contains },
          { payee: contains },
          { notes: contains },
          /* Kept from the filter this replaced. A bank reference is how someone
           * finds the one transaction they have a receipt for. */
          { externalRef: contains },
        ];
      });

      /* Both id branches repeat `workspaceId` even though the ids came from a
       * workspace-scoped read and the transaction is already scoped. Search is
       * exactly the endpoint where a missing tenant guard hands one person's
       * counterparties to another, and the redundant predicate costs an index
       * lookup the join was doing anyway. */
      const ids: Prisma.TransactionWhereInput[] = [];
      if (scope.categoryIds.length > 0) {
        ids.push({
          entries: { some: { workspaceId, categoryId: { in: [...scope.categoryIds] } } },
        });
      }
      if (scope.personIds.length > 0) {
        ids.push({ personId: { in: [...scope.personIds] }, person: { workspaceId } });
      }

      return { OR: [...text, ...ids] };
    }),
  };
}
