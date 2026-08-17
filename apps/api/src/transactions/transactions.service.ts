import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  assertBalanced,
  expandSimpleTransaction,
  reconciliationDelta,
  searchDocs,
  searchAliasField,
  searchField,
  searchTokens,
  type EntryDraft,
  type SearchDoc,
} from '@hishab/core';
import {
  compareByDisplayName,
  displayName,
  fromLocalDateString,
  toBengaliDigits,
  toLocalDateString,
  type Locale,
  type ReconcileInput,
  type SimpleTransactionInput,
  type TransactionQuery,
} from '@hishab/shared';
import type { Prisma, TransactionType } from '@prisma/client';
import { minorToNumber } from '../common/bigint-json';
import { escapeLike } from '../common/like';
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
  /**
   * Which of a category's or tag's two names a response carries.
   *
   * Required rather than optional on purpose. Every real caller hands over an
   * `AuthUser`, which has read it from the membership row already; a caller
   * that has to invent one — a job, a test — is a caller that has to decide
   * what language its output is in, and a silent default is how a background
   * task ends up mailing somebody a report in the wrong one.
   */
  locale: Locale;
}

/** A tag as it rides along on a transaction. Enough to render a chip, no more. */
export interface TransactionTagView {
  id: string;
  name: string;
  color: string | null;
  icon: string | null;
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
  /**
   * Exactly one category — *what* the money went on. The pair below is *who for*
   * or *what project*, and there may be any number of those. Keeping the two
   * apart is the whole reason `Tag` is a separate table: forcing পারিবারিক into
   * the category would turn খাবার into two categories and corrupt every
   * "what do we spend on food?" report in the application.
   */
  categoryId: string | null;
  categoryName: string | null;
  /**
   * The খাত the one above hangs off, when it hangs off one.
   *
   * `categoryId` is whichever level the user actually filed under — the tree is
   * two deep and a sub-খাত is what most rows end up on — so `categoryName` is
   * already the leaf and this pair is the branch above it. Null when the row was
   * filed straight under a top-level category, which is also how a client tells
   * "this *is* the খাত" from "this is a sub-খাত of one".
   *
   * Both halves are needed together or neither is any use: the khata leads its
   * rows with the leaf, and রেস্টুরেন্ট under খাবার ও বাজার and রেস্টুরেন্ট
   * under বেড়ানো are the same word for two different questions. The parent is
   * what tells them apart, on a line the row was already drawing.
   */
  parentCategoryId: string | null;
  parentCategoryName: string | null;
  /**
   * Who the money was with, if anybody. Not the same question as `payee`, which
   * is free text: this one is a row in `Person`, so it groups, filters and adds
   * up on the party ledger. Returned because a client that can set a field has
   * to be able to read it back — the same reason `tags` is here.
   */
  personId: string | null;
  /** The DPS, FDR or Sanchayapatra this belongs to. Null for ordinary money. */
  savingsPlanId: string | null;
  /**
   * The period a one-off payment covers, when it covers more than one month.
   *
   * Read by the spread screen and by nothing else. **Neither column generates a
   * transaction**: the whole expense still posts on `date`, and the division is
   * done for the eye at the moment it is drawn. See `prepaid.service.ts` for
   * why this ledger stays strictly cash-basis.
   */
  prepaidStartDate: string | null;
  prepaidMonths: number | null;
  personName: string | null;
  /** Thousandths of `quantityUnit`. 500 is half a kilo. */
  quantityMilli: number | null;
  /** কেজি, লিটার, পিস… free text, and null on almost every entry. */
  quantityUnit: string | null;
  /** ISO 4217 the money was actually in, or null when it was the workspace's own. */
  fxCurrency: string | null;
  /** The amount in `fxCurrency`. The rate is `amountMinor / fxAmountMinor`. */
  fxAmountMinor: number | null;
  tags: TransactionTagView[];
  /**
   * Receipt ids, in the order they were attached.
   *
   * Written since the attachment picker shipped and never read back, so the
   * receipt sheet could upload bytes, save them, and then show the transaction
   * as having no receipt — it detects that and deletes what it uploaded rather
   * than leaving orphans on disk. Returning the column is the whole fix.
   */
  attachmentIds: string[];
  createdAt: string;
  balanceAfterMinor?: number;
}

const txInclude = {
  entries: {
    include: {
      account: { select: { id: true, name: true, type: true, systemKey: true } },
      /* `parent` rather than a second lookup by `parentId`. Prisma resolves a
       * nested relation with one extra statement for the whole page, not one
       * per row, so a fifty-row khata costs the same single join it always did
       * — and the alternative, having the client match `parentId` against its
       * own cached category tree, silently prints nothing for the second or
       * two before that tree has arrived. */
      category: {
        select: {
          id: true,
          name: true,
          nameBn: true,
          parent: { select: { id: true, name: true, nameBn: true } },
        },
      },
    },
  },
  /* Name, never the phone or the note: this rides along on every row of the
   * khata's infinite list, and a list screen has no use for a contact's
   * details. `/people` is where those live. */
  person: { select: { id: true, name: true } },
  /* One extra left join on an indexed foreign key, on every read of a
   * transaction. It is not optional: a client that can set tags has to be able
   * to read them back, and a list screen that omitted them would show a
   * transaction as untagged the moment it was saved. */
  tags: {
    include: {
      tag: {
        select: { id: true, name: true, nameBn: true, color: true, icon: true, sortOrder: true },
      },
    },
  },
} satisfies Prisma.TransactionInclude;

type TxWithEntries = Prisma.TransactionGetPayload<{ include: typeof txInclude }>;

/**
 * What a create or update accepts.
 *
 * Both aliases now, `tagIds` and `tagId` having reached @hishab/shared — kept
 * as names rather than deleted because every signature in this file reads
 * better for saying which of the two it takes.
 */
export type TransactionWriteInput = SimpleTransactionInput;
export type ListTransactionsQuery = TransactionQuery;

/**
 * How many tags one transaction may carry.
 *
 * Generous, because the whole point of a tag is that a row can have several —
 * capping it at three would reintroduce the constraint tags exist to remove. It
 * is a cap at all because every id is a row in the join table and a write path
 * with no ceiling is a write path somebody will paste a thousand ids into.
 */
export const MAX_TAGS_PER_TRANSACTION = 20;

/**
 * The two names the summary invents rather than reads from a row.
 *
 * Every other name it prints comes from a category, which carries both
 * languages. These do not, so they carry their own pair — otherwise an English
 * reader gets one Bengali line in an otherwise English breakdown, and it is the
 * line most worth acting on, because it is the money nobody has filed.
 */
const OTHER_CATEGORY: Record<Locale, string> = { bn: 'অন্যান্য', en: 'Other' };
const UNFILED: Record<Locale, string> = { bn: 'অশ্রেণিবদ্ধ', en: 'Unfiled' };

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
    input: {
      accountId: string;
      counterAccountId?: string | null;
      categoryId?: string | null;
      tagIds?: readonly string[];
      personId?: string | null;
      savingsPlanId?: string | null;
    },
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
    /* Every tag proved to be this workspace's *before* a single join row is
     * written. `TransactionTag` carries its own `workspaceId`, so an unchecked
     * id here would not just be a wrong label — it would be the one row in the
     * schema whose tenancy column disagrees with the tag it points at, and every
     * later query that trusts that column would inherit the mistake. */
    const tagIds = normaliseTagIds(input.tagIds);
    if (tagIds && tagIds.length > 0) {
      const tags = await this.prisma.tag.count({
        where: { id: { in: tagIds }, workspaceId, deletedAt: null },
      });
      if (tags !== tagIds.length) throw new NotFoundException('ট্যাগ পাওয়া যায়নি');
    }
    /* The counterparty, proved to be this workspace's before the id is written.
     * `Transaction.personId` has no composite foreign key back to the
     * workspace, so an unchecked id here would file somebody else's tenant's
     * contact against this row — and `/people` counts, the khata's person
     * filter and the party ledger all read that column back. */
    if (input.personId) {
      const person = await this.prisma.person.count({
        where: { id: input.personId, workspaceId, deletedAt: null },
      });
      if (person !== 1) throw new NotFoundException('ব্যক্তি পাওয়া যায়নি');
    }
    /* The savings instrument, proved the same way and for the same reason: the
     * column has no composite key back to the workspace, and the yearly profit
     * report reads it. A matured plan is still a legal target — last year's
     * profit belongs to it whether or not it is still running. */
    if (input.savingsPlanId) {
      const plan = await this.prisma.savingsPlan.count({
        where: { id: input.savingsPlanId, workspaceId, deletedAt: null },
      });
      if (plan !== 1) throw new NotFoundException('সঞ্চয় পাওয়া যায়নি');
    }
  }

  async create(ctx: TenantContext, input: TransactionWriteInput): Promise<TransactionView> {
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

    const tagIds = normaliseTagIds(input.tagIds) ?? [];

    const created = await this.prisma.transaction.create({
      data: {
        workspaceId: ctx.workspaceId,
        /* `|| null`, because not every writer is a person. A trusted forwarder
           posts entries with no user behind them and an empty string is not a
           user id — it is a foreign key violation. The column is nullable for
           exactly this, and null is the honest value: attributing a machine's
           write to the workspace owner would put their name on a row they never
           touched. */
        createdByUserId: ctx.id || null,
        date: fromLocalDateString(input.date, tz),
        type: input.type,
        description: input.description,
        notes: input.notes,
        payee: input.payee,
        // Who the money was with. Until now only the loan module wrote this.
        personId: input.personId ?? null,
        // Which DPS, FDR or Sanchayapatra this profit came from, if any.
        savingsPlanId: input.savingsPlanId ?? null,
        /* The original, when the money was not the workspace's own currency.
         * `amountMinor` above is already converted; these two are the receipt. */
        fxCurrency: input.fxCurrency ?? null,
        fxAmountMinor: input.fxAmountMinor == null ? null : BigInt(input.fxAmountMinor),
        // How much of a thing. Thousandths, so half a kilo is 500.
        quantityMilli: input.quantityMilli == null ? null : BigInt(input.quantityMilli),
        quantityUnit: input.quantityUnit ?? null,
        externalRef: input.externalRef,
        source: input.source,
        /* Receipts. The column and the schema field have both existed since the
         * attachment picker shipped, but nothing wrote it — so a photographed
         * receipt was uploaded, validated, and then silently dropped. */
        attachmentIds: input.attachmentIds ?? [],
        entries: {
          create: entries.map((e) => TransactionsService.toEntryData(e, ctx.workspaceId)),
        },
        ...(tagIds.length > 0
          ? { tags: { create: tagIds.map((id) => toTagLinkData(id, ctx.workspaceId)) } }
          : {}),
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

    return this.present(created, ctx);
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
    input: TransactionWriteInput,
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

    /* Absent leaves the tags alone; present replaces the whole set, including
     * with an empty list. Every other field on this body behaves that way
     * already — `description: undefined` is "unchanged", not "clear it" — and a
     * client that edits an amount without sending `tagIds` must not silently
     * strip a row's labels. */
    const tagIds = normaliseTagIds(input.tagIds);

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.ledgerEntry.deleteMany({ where: { transactionId: id } });
      if (tagIds !== undefined) {
        await tx.transactionTag.deleteMany({
          where: { transactionId: id, workspaceId: ctx.workspaceId },
        });
      }
      return tx.transaction.update({
        where: { id },
        data: {
          date: fromLocalDateString(input.date, tz),
          type: input.type,
          description: input.description,
          notes: input.notes,
          payee: input.payee,
          // Omitted leaves the receipts alone; `[]` clears them, matching tags.
          ...(input.attachmentIds === undefined ? {} : { attachmentIds: input.attachmentIds }),
          /* Omitted leaves the counterparty alone; `null` detaches them. Prisma
           * reads `undefined` as "do not touch", so spelling it out matters:
           * `personId: input.personId` would look identical and behave the
           * same, but the reader could not tell which of the two was meant. */
          ...(input.personId === undefined ? {} : { personId: input.personId }),
          // Same three-way rule: absent is untouched, `null` unfiles it.
          ...(input.savingsPlanId === undefined ? {} : { savingsPlanId: input.savingsPlanId }),
          /* Both move together or neither does — the schema already refuses a
           * half-pair, so writing them as one keeps that true through an edit. */
          ...(input.fxCurrency === undefined && input.fxAmountMinor === undefined
            ? {}
            : {
                fxCurrency: input.fxCurrency ?? null,
                fxAmountMinor: input.fxAmountMinor == null ? null : BigInt(input.fxAmountMinor),
              }),
          // Both move together or neither does, like the currency pair above.
          ...(input.quantityMilli === undefined && input.quantityUnit === undefined
            ? {}
            : {
                quantityMilli: input.quantityMilli == null ? null : BigInt(input.quantityMilli),
                quantityUnit: input.quantityUnit ?? null,
              }),
          externalRef: input.externalRef,
          entries: {
            create: entries.map((e) => TransactionsService.toEntryData(e, ctx.workspaceId)),
          },
          ...(tagIds && tagIds.length > 0
            ? { tags: { create: tagIds.map((tagId) => toTagLinkData(tagId, ctx.workspaceId)) } }
            : {}),
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

    return this.present(updated, ctx);
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
    tags?: { tagId: string }[];
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
      /* Included for the same reason the legs are: re-tagging a transaction
       * changes no amount and no date, so without this an edit that moved a
       * grocery bill from পারিবারিক to ব্যবসা would write two audit rows that
       * are byte-for-byte identical. Sorted so a set that did not change never
       * looks like it did just because Postgres returned it in another order. */
      tagIds: (row.tags ?? []).map((t) => t.tagId).sort(),
    };
  }

  async findOne(ctx: TenantContext, id: string): Promise<TransactionView> {
    const tx = await this.prisma.transaction.findFirst({
      where: { id, workspaceId: ctx.workspaceId, deletedAt: null },
      include: txInclude,
    });
    if (!tx) throw new NotFoundException('লেনদেন পাওয়া যায়নি');
    return this.present(tx, ctx);
  }

  async list(
    ctx: TenantContext,
    query: ListTransactionsQuery,
  ): Promise<{ items: TransactionView[]; nextCursor: string | null }> {
    const tz = ctx.timezone;

    /* Built before the `where` so the unfiltered list path — the app's main
     * screen — pays nothing for search: no tokenising, no reference reads, no
     * extra predicates, no change to the plan the `[workspaceId, date desc]`
     * index already serves. `query.q` absent means not one line of this runs. */
    const search = query.q ? await this.buildSearchWhere(ctx.workspaceId, query.q) : null;

    /* A tag from another workspace answers 404, not an empty page. Filtering on
     * an id that is not ours would return nothing either way — the `some` below
     * is workspace-scoped — but "no transactions" and "no such tag" are
     * different facts, and a client that cannot tell them apart shows an empty
     * list where it should show an error. One indexed read, only when asked. */
    if (query.tagId) {
      const tag = await this.prisma.tag.count({
        where: { id: query.tagId, workspaceId: ctx.workspaceId, deletedAt: null },
      });
      if (tag !== 1) throw new NotFoundException('ট্যাগ পাওয়া যায়নি');
    }

    const where: Prisma.TransactionWhereInput = {
      workspaceId: ctx.workspaceId,
      deletedAt: null,
      ...(query.type ? { type: query.type } : {}),
      ...(query.source ? { source: query.source } : {}),
      ...(query.personId ? { personId: query.personId } : {}),
      ...(query.savingsPlanId ? { savingsPlanId: query.savingsPlanId } : {}),
      /* `workspaceId` repeated on the join even though the transaction is
       * already scoped and the tag was just proved. The join table carries its
       * own tenancy column and this is the query that reads it; a redundant
       * predicate on an index the lookup uses anyway is the cheapest possible
       * insurance against the one row that was written wrong. */
      ...(query.tagId
        ? { tags: { some: { tagId: query.tagId, workspaceId: ctx.workspaceId } } }
        : {}),
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
    const items = page.map((row) => this.present(row, ctx, query.accountId));

    if (query.accountId) {
      await this.attachRunningBalance(ctx.workspaceId, query.accountId, items, page);
    }

    return { items, nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null };
  }

  /**
   * The `?q=` filter, and the only place Banglish crosses into SQL.
   *
   * Three reads, in parallel, all workspace-scoped and all over reference tables
   * a household counts in dozens. Categories and people do not filter
   * `deletedAt`: a soft-deleted category still labels the historical rows it was
   * attached to and `present()` still prints its name, so it has to stay
   * findable by that name — the same rule the relation `ILIKE` this replaced
   * followed. **Tags are different and are filtered**: deleting a tag detaches
   * it from every transaction, so a dead tag labels nothing, matches nothing,
   * and indexing it would be work spent to find zero rows.
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

    const [categories, persons, tags] = await Promise.all([
      this.prisma.category.findMany({
        where: { workspaceId },
        select: { id: true, name: true, nameBn: true, searchAliases: true },
      }),
      this.prisma.person.findMany({
        where: { workspaceId },
        select: { id: true, name: true },
      }),
      this.prisma.tag.findMany({
        where: { workspaceId, deletedAt: null },
        select: { id: true, name: true, nameBn: true, searchAliases: true },
      }),
    ]);

    /* Keys are built once for the whole request and reused for every token —
     * `searchDocs` never mutates a doc, and rebuilding them per token would be
     * the only part of this that scaled badly. */
    const categoryDocs: SearchDoc<{ id: string }>[] = categories.map((c) => ({
      id: c.id,
      row: { id: c.id },
      fields: [searchField('nameBn', 'PRIMARY', c.nameBn), searchField('name', 'PRIMARY', c.name)],
      /* Aliases too, or `?q=poribohon` finds the category on the categories
       * screen and nothing in the ledger — the same word answering differently
       * on two screens is worse than it not working on either. */
      aliases: searchAliasField('aliases', 'SECONDARY', c.searchAliases),
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
    /* Tags, resolved exactly like categories and for the same reason. `?q=রমজান`
     * has to reach the ledger, not only the tag screen — and `?q=romjan` has to
     * reach it too, which no `ILIKE` can do because the two spellings share no
     * code points. Aliases included, so a household that wrote `shoshur` on
     * শ্বশুরবাড়ি keeps finding those rows. */
    const tagDocs: SearchDoc<{ id: string }>[] = tags.map((t) => ({
      id: t.id,
      row: { id: t.id },
      fields: [searchField('nameBn', 'PRIMARY', t.nameBn), searchField('name', 'PRIMARY', t.name)],
      aliases: searchAliasField('aliases', 'SECONDARY', t.searchAliases),
    }));

    const scopes = tokens.map((token) => ({
      categoryIds: resolveIds(categoryDocs, token),
      personIds: resolveIds(personDocs, token),
      tagIds: resolveIds(tagDocs, token),
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

  /**
   * Mark an asset to what it is worth now.
   *
   * ## Why this is not `reconcile`
   *
   * Reconciling says the ledger was wrong about money that already existed;
   * revaluing says the world moved. The entries are identical — the account
   * against equity — and the meaning is not, which is why `REVALUATION` is its
   * own transaction type. A reader looking at the statement of changes in net
   * worth and asking "why did I get ৳2,00,000 richer without earning anything"
   * needs the answer to be nameable.
   *
   * ## Why only non-monetary accounts
   *
   * Cash does not appreciate. If a bank balance disagrees with the ledger, one
   * of them is wrong and the fix is a reconciliation, not a revaluation —
   * offering both on a wallet would let somebody quietly paper over a
   * bookkeeping error as a market gain.
   *
   * ## What it deliberately does not do
   *
   * It never touches income or expense, so a revaluation cannot inflate a
   * month's earnings, and it never touches a liquid account, so it stays out of
   * the cash flow statement entirely. Both are what IFRS's revaluation model
   * requires and both fall out of posting against equity.
   */
  async revalue(
    ctx: TenantContext,
    accountId: string,
    input: { valueMinor: number; date: string; note?: string },
  ): Promise<{ deltaMinor: number; transaction: TransactionView | null }> {
    const account = await this.prisma.account.findFirst({
      where: { id: accountId, workspaceId: ctx.workspaceId, deletedAt: null, systemKey: null },
    });
    if (!account) throw new NotFoundException('অ্যাকাউন্ট পাওয়া যায়নি');

    if (account.type !== 'ASSET' && account.type !== 'LIABILITY') {
      throw new BadRequestException(
        'শুধু সম্পদ (জমি, স্বর্ণ, গাড়ি) বা দায়ের হিসাবের মূল্যায়ন বদলানো যায় — নগদ বা ব্যাংকের জন্য “সমন্বয়” ব্যবহার করুন',
      );
    }

    const balances = await this.accounts.balances(ctx.workspaceId);
    const deltaMinor = input.valueMinor - (balances.get(accountId) ?? 0);
    if (deltaMinor === 0) return { deltaMinor: 0, transaction: null };

    const system = await this.accounts.systemAccounts(ctx.workspaceId);
    const entries = expandSimpleTransaction(
      { type: 'REVALUATION', amountMinor: deltaMinor, accountId },
      system,
    );
    assertBalanced(entries);

    const created = await this.prisma.transaction.create({
      data: {
        workspaceId: ctx.workspaceId,
        createdByUserId: ctx.id,
        date: fromLocalDateString(input.date, ctx.timezone),
        type: 'REVALUATION',
        description: input.note?.trim() || 'পুনর্মূল্যায়ন',
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
      action: 'account.revalued',
      entity: 'Account',
      entityId: accountId,
      before: { valueMinor: balances.get(accountId) ?? 0 },
      after: { valueMinor: input.valueMinor, deltaMinor, note: input.note ?? null },
    });

    return { deltaMinor, transaction: this.present(created, ctx) };
  }

  /**
   * Selling the asset: the land, the car, the gold, the shares.
   *
   * ## Why this is not a revaluation, and not a transfer
   *
   * Revaluing says the world moved and the money has not: it posts against
   * equity and touches no cash (IAS 16.39). Selling is the moment that stops
   * being true. The asset leaves the books, cash arrives, and the difference
   * between the two is a **realised** gain or loss that belongs in profit or
   * loss (IAS 16.68).
   *
   * Booking a sale as a revaluation would leave a realised gain sitting in
   * equity; booking it as a plain transfer would silently lose the gain
   * altogether, because a transfer of the sale price out of an account holding
   * less than that cannot balance. Both errors run in the direction that
   * flatters, which is why this is its own operation rather than three things a
   * careful person could assemble by hand.
   *
   * ## The three legs
   *
   * ```
   *   DEBIT   the destination account      the price actually received
   *   CREDIT  the asset                    its carrying amount — it goes to zero
   *   CREDIT  income  (or DEBIT expense)   the difference, whichever way it fell
   * ```
   *
   * The carrying amount is read from the ledger rather than taken from the
   * caller. It is cost plus every revaluation since, and asking somebody to
   * retype a figure the books already know is how the asset ends up not quite
   * at zero.
   *
   * ## Only the gain reaches income
   *
   * Land bought at ৳8,00,000, revalued to ৳9,00,000, sold for ৳11,00,000 books
   * ৳2,00,000 of income — not ৳3,00,000. The first lakh went to equity when it
   * was revalued and is not earned twice. Nothing here moves it out of equity
   * either: IAS 16.41 permits transferring the surplus to retained earnings on
   * disposal, and this product has no retained-earnings line to move it to.
   */
  async sell(
    ctx: TenantContext,
    accountId: string,
    input: {
      proceedsMinor: number;
      destinationAccountId: string;
      categoryId: string;
      date: string;
      note?: string;
    },
  ): Promise<{
    proceedsMinor: number;
    carryingMinor: number;
    gainMinor: number;
    transaction: TransactionView;
  }> {
    const account = await this.prisma.account.findFirst({
      where: { id: accountId, workspaceId: ctx.workspaceId, deletedAt: null, systemKey: null },
    });
    if (!account) throw new NotFoundException('অ্যাকাউন্ট পাওয়া যায়নি');
    if (account.type !== 'ASSET') {
      throw new BadRequestException(
        'শুধু সম্পদ (জমি, গাড়ি, স্বর্ণ, শেয়ার) বিক্রি করা যায় — নগদ বা ব্যাংকের জন্য “স্থানান্তর” ব্যবহার করুন',
      );
    }
    if (accountId === input.destinationAccountId) {
      throw new BadRequestException('টাকাটা অন্য একটি অ্যাকাউন্টে নিতে হবে');
    }

    const destination = await this.prisma.account.findFirst({
      where: {
        id: input.destinationAccountId,
        workspaceId: ctx.workspaceId,
        deletedAt: null,
        systemKey: null,
      },
    });
    if (!destination) throw new NotFoundException('যে অ্যাকাউন্টে টাকা যাবে সেটি পাওয়া যায়নি');

    const balances = await this.accounts.balances(ctx.workspaceId);
    const carryingMinor = balances.get(accountId) ?? 0;
    /* A negative carrying amount is not a cheap asset, it is a broken one —
       something has been booked the wrong way round — and pretending to sell it
       would write that error into the income statement as a gain. */
    if (carryingMinor < 0) {
      throw new BadRequestException(
        'এই সম্পদের হিসাব ঋণাত্মক দেখাচ্ছে — বিক্রির আগে সেটি ঠিক করে নিন',
      );
    }
    const gainMinor = input.proceedsMinor - carryingMinor;

    /* The category has to sit on the right side of the ledger, because the leg
       it labels is decided by the sign of the gain. An income খাত on a loss
       would file the loss where nobody looking for it would ever find it. */
    const category = await this.prisma.category.findFirst({
      where: { id: input.categoryId, workspaceId: ctx.workspaceId, deletedAt: null },
    });
    if (!category) throw new NotFoundException('খাত পাওয়া যায়নি');
    if (gainMinor > 0 && category.kind !== 'INCOME') {
      throw new BadRequestException('লাভ হয়েছে — আয়ের একটি খাত বেছে নিন');
    }
    if (gainMinor < 0 && category.kind !== 'EXPENSE') {
      throw new BadRequestException('লোকসান হয়েছে — খরচের একটি খাত বেছে নিন');
    }

    const system = await this.accounts.systemAccounts(ctx.workspaceId);
    /* The workspace's own currency throughout. The three legs of a sale are all
       denominated the same way — the price, the carrying amount and the
       difference between them — so a per-leg currency here would only be a way
       to get them out of step. */
    const currency = destination.currency;
    const leg = (
      legAccountId: string,
      direction: 'DEBIT' | 'CREDIT',
      amountMinor: number,
      categoryId?: string,
    ): EntryDraft => ({
      accountId: legAccountId,
      direction,
      amountMinor,
      currency,
      fxRate: 1,
      categoryId: categoryId ?? null,
    });

    const entries: EntryDraft[] = [leg(input.destinationAccountId, 'DEBIT', input.proceedsMinor)];
    /* Nothing to relieve when the books already carry it at zero — a fully
       written-down car, or one that arrived with no opening balance. The whole
       price is then the gain, which is correct. A zero-amount leg would be
       refused by the ledger and is meaningless anyway. */
    if (carryingMinor > 0) entries.push(leg(accountId, 'CREDIT', carryingMinor));
    if (gainMinor > 0) {
      entries.push(leg(system.incomeAccountId, 'CREDIT', gainMinor, input.categoryId));
    } else if (gainMinor < 0) {
      entries.push(leg(system.expenseAccountId, 'DEBIT', -gainMinor, input.categoryId));
    }
    assertBalanced(entries);

    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.transaction.create({
        data: {
          workspaceId: ctx.workspaceId,
          createdByUserId: ctx.id,
          date: fromLocalDateString(input.date, ctx.timezone),
          type: 'DISPOSAL',
          description: input.note?.trim() || `${account.name} — বিক্রি`,
          source: 'MANUAL',
          entries: {
            create: entries.map((e) => TransactionsService.toEntryData(e, ctx.workspaceId)),
          },
        },
        include: txInclude,
      });

      /* Archived in the same transaction, so a sold asset can never be left
         sitting at zero among the things somebody still owns. It is archived
         rather than deleted: the sale is the last chapter of a history that
         has to stay readable. */
      await tx.account.update({ where: { id: accountId }, data: { isArchived: true } });
      return row;
    });

    this.audit.emit({
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.id,
      action: 'account.sold',
      entity: 'Account',
      entityId: accountId,
      before: { carryingMinor },
      after: {
        proceedsMinor: input.proceedsMinor,
        gainMinor,
        destinationAccountId: input.destinationAccountId,
        date: input.date,
      },
    });

    return {
      proceedsMinor: input.proceedsMinor,
      carryingMinor,
      gainMinor,
      transaction: this.present(created, ctx),
    };
  }

  /** Every revaluation of one account, newest first. The history IFRS expects. */
  async revaluations(ctx: TenantContext, accountId: string) {
    const rows = await this.prisma.transaction.findMany({
      where: {
        workspaceId: ctx.workspaceId,
        deletedAt: null,
        type: 'REVALUATION',
        entries: { some: { accountId } },
      },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      select: {
        id: true,
        date: true,
        description: true,
        entries: { where: { accountId }, select: { direction: true, amountMinor: true } },
      },
    });

    return rows.map((row) => {
      const entry = row.entries[0];
      const magnitude = entry ? minorToNumber(entry.amountMinor) : 0;
      return {
        id: row.id,
        date: toLocalDateString(row.date, ctx.timezone),
        note: row.description,
        /* Signed the way a reader means it: positive is worth more than before. */
        deltaMinor: entry?.direction === 'DEBIT' ? magnitude : -magnitude,
      };
    });
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

    return { delta, transaction: this.present(created, ctx) };
  }

  /**
   * Month totals for the dashboard.
   *
   * ## Where the foreign-currency fence stops
   *
   * `AccountsService.position` leaves accounts in another currency out of the
   * *balance* figures, because adding $500 to a taka net worth as ৳500 is a
   * silent invention of a 1.00 rate. This month total is not fenced, and the
   * distinction is worth stating rather than leaving as an oversight.
   *
   * It sums entries on the two nominal accounts, not account balances, and the
   * design those entries were written under is a single-currency ledger:
   * `expandSimpleTransaction` books every leg in the workspace's currency, and
   * a transaction whose money was originally something else records the
   * original as `Transaction.fxCurrency` / `fxAmountMinor` beside an
   * `amountMinor` the user already converted — the spot-rate-on-the-day
   * treatment IAS 21.21 asks for, done at entry time by the person who knows
   * the rate they got.
   *
   * A foreign-currency *account* sits outside that design: its entries
   * accumulate in its own money, so a $50 grocery bill lands in this month's
   * খরচ as 5,000 minor units beside taka ones. Fixing that is not a `where`
   * clause — it needs an answer to what "this month's expense" even means when
   * part of it is in dollars, which is the retranslation work (IAS 21.23(a),
   * IAS 21.28) this change deliberately is not. Until then the balance figures
   * are honest about their scope and this one is not, and a reader of either
   * should know which they are holding.
   */
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
    const nameById = new Map(cats.map((c) => [c.id, displayName(c, ctx.locale)]));

    return grouped
      .map((g) => ({
        categoryId: g.categoryId,
        name: g.categoryId
          ? (nameById.get(g.categoryId) ?? OTHER_CATEGORY[ctx.locale])
          : UNFILED[ctx.locale],
        totalMinor: minorToNumber(g._sum.amountMinor ?? 0n),
      }))
      .sort((a, b) => b.totalMinor - a.totalMinor);
  }

  /** Collapse balanced double-entry lines back into what the user typed. */
  /**
   * Take the whole context, not a timezone string.
   *
   * Every caller already had one and pulled `ctx.timezone` out of it. Adding a
   * second scalar parameter for the locale would have made five call sites read
   * `present(row, tz, locale, query.accountId)` — three positional arguments of
   * which two are strings, which is the shape that eventually gets swapped.
   */
  private present(tx: TxWithEntries, ctx: TenantContext, focusAccountId?: string): TransactionView {
    const tz = ctx.timezone;
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
      categoryName: category ? displayName(category, ctx.locale) : null,
      parentCategoryId: category?.parent?.id ?? null,
      parentCategoryName: category?.parent ? displayName(category.parent, ctx.locale) : null,
      personId: tx.personId,
      savingsPlanId: tx.savingsPlanId,
      prepaidStartDate: tx.prepaidStartDate ? toLocalDateString(tx.prepaidStartDate, tz) : null,
      prepaidMonths: tx.prepaidMonths,
      personName: tx.person?.name ?? null,
      quantityMilli: tx.quantityMilli == null ? null : minorToNumber(tx.quantityMilli),
      quantityUnit: tx.quantityUnit,
      fxCurrency: tx.fxCurrency,
      fxAmountMinor: tx.fxAmountMinor == null ? null : minorToNumber(tx.fxAmountMinor),
      attachmentIds: tx.attachmentIds,
      /* Sorted here rather than in the query. Prisma can order an included
       * relation by a field of *its* relation, but doing so turns one join into
       * an ordered subquery on the main list screen; a handful of chips per row
       * sorts for free in memory. The user's own arrangement first, then the
       * name, so the chips on two transactions carrying the same tags always
       * appear in the same order. */
      tags: [...tx.tags]
        .sort(
          (a, b) =>
            a.tag.sortOrder - b.tag.sortOrder || compareByDisplayName(a.tag, b.tag, ctx.locale),
        )
        .map((link) => ({
          id: link.tag.id,
          name: displayName(link.tag, ctx.locale),
          color: link.tag.color,
          icon: link.tag.icon,
        })),
      createdAt: tx.createdAt.toISOString(),
    };
  }
}

/**
 * A join row, built the way `toEntryData` builds a ledger leg: through the
 * relations rather than the raw columns, so `TransactionTag.workspaceId` can
 * only ever be a workspace that exists, and is the one the caller was proved to
 * be in.
 */
function toTagLinkData(
  tagId: string,
  workspaceId: string,
): Prisma.TransactionTagCreateWithoutTransactionInput {
  return {
    tag: { connect: { id: tagId } },
    workspace: { connect: { id: workspaceId } },
  };
}

/**
 * Trim, drop blanks and de-duplicate a submitted tag list, or `undefined` when
 * the field was absent — which is what leaves an existing set alone.
 *
 * De-duplication is not tidiness: `(transactionId, tagId)` is the primary key of
 * the join, so the same id twice in one body is a 500 from Postgres rather than
 * a 400 from us. The cap is refused rather than truncated, for the reason the
 * alias cap is: silently keeping twenty of the thirty labels somebody sent is
 * worse than saying no.
 */
function normaliseTagIds(value: readonly string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const id = raw.trim();
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  if (out.length > MAX_TAGS_PER_TRANSACTION) {
    throw new BadRequestException(
      `একটি লেনদেনে সর্বোচ্চ ${toBengaliDigits(String(MAX_TAGS_PER_TRANSACTION))}টি ট্যাগ দেওয়া যায়`,
    );
  }
  return out;
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
  readonly tagIds: readonly string[];
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
      const scope = scopes[i] ?? { categoryIds: [], personIds: [], tagIds: [] };
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
      if (scope.tagIds.length > 0) {
        ids.push({ tags: { some: { workspaceId, tagId: { in: [...scope.tagIds] } } } });
      }

      return { OR: [...text, ...ids] };
    }),
  };
}
