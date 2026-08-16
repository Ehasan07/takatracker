import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  accountTypeFromWallet,
  assertBalanced,
  detailIsComplete,
  detailKindOf,
  expandSimpleTransaction,
  migrationFromCsv,
  migrationStartFromCsv,
  migrationToCsv,
  splitNameAndPhone,
  suggestNonCategory,
  type DetailKind,
  type EntryDraft,
  type MigrationDecision,
  type MigrationDetail,
  type MigrationRow,
} from '@hishab/core';
import {
  formatMinor,
  fromLocalDateString,
  parseMoneyToMinor,
  toLocalDateString,
} from '@hishab/shared';
import { Prisma, type AccountType } from '@prisma/client';
import { AccountsService } from '../accounts/accounts.service';
import { AuditService } from '../audit/audit.service';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { PeopleService } from '../people/people.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletClient, type WalletRecord } from './wallet.client';

/**
 * Moving a chart of accounts in from another product, reversibly.
 *
 * ## Everything is staged, and nothing here is clever
 *
 * A pull writes rows to `MigrationItem` and creates nothing. Apply reads those
 * rows and creates what they say. Rollback reads what apply wrote down and
 * removes it. Three passes over one table, and the reason it is three rather
 * than one is that the middle step is a person deciding two hundred times —
 * possibly over two sittings, possibly in Excel — and a browser closed halfway
 * through must lose nothing.
 *
 * ## Why apply never throws part-way
 *
 * Two hundred rows, and row 140 hits the plan's account ceiling. Aborting there
 * leaves 139 created, no record of which, and a person with no way to try
 * again. So every row is attempted inside its own try, a failure is written to
 * `skippedReason` in the row's own language, and the batch finishes. What went
 * in and what did not is then a list on screen rather than a stack trace.
 *
 * ## What rollback will not do
 *
 * It removes what this batch created and nothing else. An account that has
 * since been posted to is kept, with the reason, because deleting it would take
 * the ledger with it — and a migration tool that can destroy real entries is one
 * nobody should press twice.
 */

export type BatchStatus = 'DRAFT' | 'APPLIED' | 'ROLLED_BACK';

export interface MigrationItemView {
  id: string;
  kind: 'ACCOUNT' | 'CATEGORY';
  sourceId: string;
  sourceName: string;
  /** What it will be called here, when that is not what it arrived as. */
  targetName: string | null;
  usageCount: number;
  decision: MigrationDecision;
  targetType: string | null;
  targetId: string | null;
  createdEntityId: string | null;
  createdEntityKind: string | null;
  skippedReason: string | null;
  /** Currency, group, archived — whatever the source said, for the screen. */
  detail: string;
  /**
   * The heading the row had over there — Wallet's own group, or an account's
   * type. What makes deciding 296 rows a job of about ten decisions instead.
   */
  group: string | null;
  /** This row *is* one of those headings, staged so it can be the parent. */
  isGroup: boolean;
  /** Which questions this row raises, if any, and whether they are answered. */
  needs: DetailKind | null;
  needsComplete: boolean;
  targetDetail: MigrationDetail | null;
}

export interface BatchView {
  id: string;
  source: string;
  status: BatchStatus;
  createdAt: string;
  appliedAt: string | null;
  rolledBackAt: string | null;
  note: string | null;
  counts: {
    accounts: number;
    categories: number;
    created: number;
    skipped: number;
    /** Rows still waiting on a figure the other product never held. */
    needsDetail: number;
  };
}

export interface BatchDetail extends BatchView {
  items: MigrationItemView[];
}

/**
 * What one page of the record import did.
 *
 * The arithmetic is meant to be checkable: `imported + skipped` is exactly how
 * many records the page held. A transfer is two records and one transaction, so
 * its second side counts as a skip rather than disappearing from the count —
 * an import that cannot account for every row it read should not run.
 */
export interface RecordPageResult {
  /** Transactions written by this page. */
  imported: number;
  /** Records read and not written: already here, a mirror, or a problem. */
  skipped: number;
  /** Of `imported`, how many were a TRANSFER rather than income or spending. */
  transfersWritten: number;
  /** Where the next page starts. `null` is the end — a short page is not. */
  nextOffset: number | null;
  /** What somebody should look at, in their own language, each said once. */
  problems: string[];
  /** The one `ImportBatch` every page writes into, so it can all be undone. */
  importBatchId: string | null;
}

/** The one import batch a whole migration's records land in. */
const RECORD_BATCH_FILENAME = 'wallet-history';

/* Long enough for 200 inserts, short enough that a stuck write releases its
   locks the same minute. Both figures are the CSV importer's, for a write of
   the same shape and size. */
const RECORD_WRITE_TIMEOUT_MS = 120_000;
const RECORD_WRITE_MAX_WAIT_MS = 15_000;

/** Problems listed individually. Past this the last line carries the count. */
const MAX_RECORD_PROBLEMS = 50;

/** One record, read and turned into ledger lines, not yet written. */
interface RecordWrite {
  externalRef: string;
  date: Date;
  type: 'INCOME' | 'EXPENSE' | 'TRANSFER';
  description: string | null;
  payee: string | null;
  entries: EntryDraft[];
}

/**
 * What a record will be called in the books, and what makes a re-run harmless.
 *
 * A transfer is keyed by the transfer rather than by either record, because it
 * is one movement written once: whichever of its two sides is read first, both
 * ask about the same reference and only one of them can find it missing.
 */
function walletRefOf(record: WalletRecord): string {
  const transferId = record.transfer?.transferId?.trim();
  return transferId ? `wallet-transfer:${transferId}` : `wallet:${record.id}`;
}

/** One ledger line, in the shape a nested create wants. */
function ledgerEntryData(
  entry: EntryDraft,
  workspaceId: string,
): Prisma.LedgerEntryCreateWithoutTransactionInput {
  return {
    workspace: { connect: { id: workspaceId } },
    account: { connect: { id: entry.accountId } },
    category: entry.categoryId ? { connect: { id: entry.categoryId } } : undefined,
    amountMinor: BigInt(entry.amountMinor),
    direction: entry.direction,
    currency: entry.currency,
    fxRate: entry.fxRate,
  };
}

/** Wallet's "Income" group is the only one that is not spending. */
function categoryKindOf(groupName: string | undefined): 'INCOME' | 'EXPENSE' {
  return (groupName ?? '').toLowerCase() === 'income' ? 'INCOME' : 'EXPENSE';
}

/** Names compare with case and surrounding space ignored, nothing else. */
function normalise(name: string): string {
  return name.trim().toLowerCase();
}

@Injectable()
export class MigrationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletClient,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
    private readonly people: PeopleService,
    /* For `systemAccounts()`. A migrated record posts against the same hidden
       nominal accounts a hand-typed one does — there is no second ledger for
       imported money. */
    private readonly accounts: AccountsService,
  ) {}

  // ---------------------------------------------------------------- reading

  async list(workspaceId: string): Promise<BatchView[]> {
    const batches = await this.prisma.migrationBatch.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      include: {
        items: {
          select: {
            kind: true,
            decision: true,
            targetType: true,
            targetDetail: true,
            createdEntityId: true,
            skippedReason: true,
          },
        },
      },
    });
    return batches.map((batch) => this.presentBatch(batch, batch.items));
  }

  async detail(workspaceId: string, batchId: string): Promise<BatchDetail> {
    const batch = await this.prisma.migrationBatch.findFirst({
      where: { id: batchId, workspaceId },
      include: {
        items: {
          /* Accounts first because categories cannot be decided sensibly until
             the accounts are settled, then the rows a person should actually
             look at: the ones something was guessed about, then the busiest. */
          orderBy: [{ kind: 'asc' }, { usageCount: 'desc' }, { sourceName: 'asc' }],
        },
      },
    });
    if (!batch) throw new NotFoundException('মাইগ্রেশন খসড়া পাওয়া যায়নি');

    return {
      ...this.presentBatch(batch, batch.items),
      items: batch.items.map((item) => this.presentItem(item)),
    };
  }

  private presentBatch(
    batch: {
      id: string;
      source: string;
      status: string;
      createdAt: Date;
      appliedAt: Date | null;
      rolledBackAt: Date | null;
      note: string | null;
    },
    items: readonly {
      kind: string;
      decision: string;
      targetType: string | null;
      targetDetail: Prisma.JsonValue;
      createdEntityId: string | null;
      skippedReason: string | null;
    }[],
  ): BatchView {
    return {
      id: batch.id,
      source: batch.source,
      status: batch.status as BatchStatus,
      createdAt: batch.createdAt.toISOString(),
      appliedAt: batch.appliedAt?.toISOString() ?? null,
      rolledBackAt: batch.rolledBackAt?.toISOString() ?? null,
      note: batch.note,
      counts: {
        accounts: items.filter((i) => i.kind === 'ACCOUNT').length,
        categories: items.filter((i) => i.kind === 'CATEGORY').length,
        created: items.filter((i) => i.createdEntityId).length,
        skipped: items.filter((i) => i.skippedReason).length,
        needsDetail: items.filter((i) => {
          const needs = detailKindOf(i.kind as 'ACCOUNT' | 'CATEGORY', i.decision, i.targetType);
          return needs !== null && !detailIsComplete(needs, i.targetDetail as MigrationDetail);
        }).length,
      },
    };
  }

  private presentItem(item: {
    id: string;
    kind: string;
    sourceId: string;
    sourceName: string;
    targetName: string | null;
    usageCount: number;
    decision: string;
    targetType: string | null;
    targetId: string | null;
    createdEntityId: string | null;
    createdEntityKind: string | null;
    skippedReason: string | null;
    sourcePayload: Prisma.JsonValue;
    targetDetail: Prisma.JsonValue;
  }): MigrationItemView {
    const payload = (item.sourcePayload ?? {}) as Record<string, unknown>;
    const bits = [payload.group, payload.currency, payload.sourceType]
      .filter((v): v is string => typeof v === 'string' && v.length > 0)
      .filter((v, i, all) => all.indexOf(v) === i);
    if (payload.archived === true) bits.push('আর্কাইভ করা');

    const targetDetail = (item.targetDetail ?? null) as MigrationDetail | null;
    const needs = detailKindOf(item.kind as 'ACCOUNT' | 'CATEGORY', item.decision, item.targetType);

    return {
      id: item.id,
      kind: item.kind as 'ACCOUNT' | 'CATEGORY',
      sourceId: item.sourceId,
      sourceName: item.sourceName,
      targetName: item.targetName,
      usageCount: item.usageCount,
      decision: item.decision as MigrationDecision,
      targetType: item.targetType,
      targetId: item.targetId,
      createdEntityId: item.createdEntityId,
      createdEntityKind: item.createdEntityKind,
      skippedReason: item.skippedReason,
      detail: bits.join(' · '),
      /* A heading is filed under itself, so it sits with the rows it holds
         rather than alone at the bottom of the list. */
      group:
        payload.isGroup === true
          ? item.sourceName
          : typeof payload.group === 'string' && payload.group
            ? payload.group
            : typeof payload.sourceType === 'string' && payload.sourceType
              ? payload.sourceType
              : null,
      isGroup: payload.isGroup === true,
      needs,
      needsComplete: needs === null || detailIsComplete(needs, targetDetail),
      targetDetail,
    };
  }

  // ------------------------------------------------------------------- pull

  /**
   * Read the other product and stage what is there.
   *
   * The token is a parameter and never a column: it is used for the two calls
   * this needs and is gone when the method returns.
   */
  async pull(workspaceId: string, userId: string, token: string): Promise<BatchDetail> {
    /* One draft at a time. Two half-decided lists of two hundred rows is a way
       to apply the wrong one, and the screen has a discard button for the case
       where somebody wants to start over. */
    const open = await this.prisma.migrationBatch.findFirst({
      where: { workspaceId, status: 'DRAFT' },
    });
    if (open) {
      throw new BadRequestException(
        'আগের একটি খসড়া এখনো বাকি আছে — সেটি প্রয়োগ করুন বা বাতিল করে আবার চেষ্টা করুন',
      );
    }

    const [accounts, categories] = await Promise.all([
      this.wallet.accounts(token),
      this.wallet.categories(token),
    ]);

    /* What is here already, so a name that matches can default to merge rather
       than quietly making a second খাবার ও বাজার. */
    const [existingAccounts, existingCategories] = await Promise.all([
      this.prisma.account.findMany({
        where: { workspaceId, deletedAt: null },
        select: { id: true, name: true },
      }),
      this.prisma.category.findMany({
        where: { workspaceId, deletedAt: null },
        select: { id: true, name: true, nameBn: true },
      }),
    ]);

    const accountByName = new Map(existingAccounts.map((a) => [normalise(a.name), a.id]));
    const categoryByName = new Map<string, string>();
    for (const category of existingCategories) {
      categoryByName.set(normalise(category.name), category.id);
      if (category.nameBn) categoryByName.set(normalise(category.nameBn), category.id);
    }

    const items: Prisma.MigrationItemCreateManyBatchInput[] = [];

    for (const account of accounts) {
      const name = (account.name ?? '').trim() || 'নামহীন অ্যাকাউন্ট';
      const match = accountByName.get(normalise(name));
      items.push({
        workspaceId,
        kind: 'ACCOUNT',
        sourceId: account.id,
        sourceName: name,
        usageCount: account.recordStats?.recordCount ?? 0,
        decision: match ? 'MERGE' : 'CREATE',
        targetType: accountTypeFromWallet(account.accountType),
        targetId: match ?? null,
        sourcePayload: {
          sourceType: account.accountType ?? null,
          currency: account.currencyCode ?? 'BDT',
          archived: account.archived === true,
          accountNumber: account.bankAccountNumber ?? null,
        },
      });
    }

    /* The other product's groups are its categories' parents — thirteen of
       them over 296 categories, and not one exists in this workspace. Staged
       here as ordinary rows so the tree somebody spent years arranging arrives
       intact instead of flattening into 296 headings.
     *
     * Their ids are `group:<name>` rather than anything the source gave,
     * because a group is not a category over there and has no id of its own. */
    const groupRows = new Map<string, { name: string; kind: 'INCOME' | 'EXPENSE' }>();
    for (const category of categories) {
      const groupName = (category.group?.name ?? '').trim();
      if (!groupName) continue;
      const kind = categoryKindOf(category.group?.name);
      /* Keyed by name *and* kind: a group holding both income and spending
         cannot be one category here, because a parent's kind must match its
         children's. */
      groupRows.set(`${kind}:${groupName}`, { name: groupName, kind });
    }

    for (const [key, group] of groupRows) {
      const match = categoryByName.get(normalise(group.name));
      items.push({
        workspaceId,
        kind: 'CATEGORY',
        sourceId: `group:${key}`,
        sourceName: group.name,
        /* Sorted above its children by the count of what it holds. */
        usageCount: 0,
        decision: match ? 'MERGE' : 'CREATE',
        targetType: group.kind,
        targetId: match ?? null,
        sourcePayload: { group: null, isGroup: true },
      });
    }

    for (const category of categories) {
      const name = (category.name ?? '').trim() || 'নামহীন খাত';
      const match = categoryByName.get(normalise(name));
      /* The guess wins over the name match: a category called "DPS" that
         happens to exist here as a category is exactly the mistake being
         corrected, and merging it would carry the mistake across. */
      const guess = suggestNonCategory(name);
      const decision: MigrationDecision = guess ?? (match ? 'MERGE' : 'CREATE');

      items.push({
        workspaceId,
        kind: 'CATEGORY',
        sourceId: category.id,
        sourceName: name,
        usageCount: 0,
        decision,
        targetType: categoryKindOf(category.group?.name),
        targetId: decision === 'MERGE' ? (match ?? null) : null,
        /* The row that will become this one's parent, if the group produced
           one. Cleared by the screen the moment somebody chooses a different
           parent, so it is a starting point rather than a rule. */
        parentSourceId:
          decision === 'CREATE' && category.group?.name
            ? `group:${categoryKindOf(category.group?.name)}:${category.group.name.trim()}`
            : null,
        sourcePayload: {
          group: category.group?.name ?? null,
          custom: category.customCategory === true,
          archived: category.archived === true,
        },
      });
    }

    if (items.length === 0) {
      throw new BadRequestException('ওই অ্যাকাউন্টে আনার মতো কিছু পাওয়া যায়নি');
    }

    const batch = await this.prisma.migrationBatch.create({
      data: {
        workspaceId,
        source: 'WALLET',
        status: 'DRAFT',
        createdByUserId: userId || null,
        note: `${accounts.length}টি অ্যাকাউন্ট, ${categories.length}টি খাত`,
        items: { createMany: { data: items } },
      },
    });

    this.audit.emit({
      workspaceId,
      actorUserId: userId,
      action: 'migration.pulled',
      entity: 'MigrationBatch',
      entityId: batch.id,
      after: { source: 'WALLET', accounts: accounts.length, categories: categories.length },
    });

    return this.detail(workspaceId, batch.id);
  }

  /**
   * Start a batch from a spreadsheet instead of an API.
   *
   * The other way in, and the one most people will use: not everybody is
   * leaving a product with a REST API, and a list of headings typed in Excel is
   * a chart of accounts too. Nothing about the rest of this changes — same
   * staging table, same decisions, same apply, same rollback.
   */
  async startFromCsv(workspaceId: string, userId: string, csv: string): Promise<BatchDetail> {
    const open = await this.prisma.migrationBatch.findFirst({
      where: { workspaceId, status: 'DRAFT' },
    });
    if (open) {
      throw new BadRequestException(
        'আগের একটি খসড়া এখনো বাকি আছে — সেটি প্রয়োগ করুন বা বাতিল করে আবার চেষ্টা করুন',
      );
    }

    const parsed = migrationStartFromCsv(csv);
    if (parsed.rows.length === 0) {
      throw new BadRequestException(parsed.errors[0] ?? 'ফাইলে আনার মতো কিছু পাওয়া যায়নি');
    }

    const items: Prisma.MigrationItemCreateManyBatchInput[] = parsed.rows.map((row) => ({
      workspaceId,
      kind: row.kind,
      sourceId: row.sourceId,
      sourceName: row.name,
      targetName: row.rename || null,
      usageCount: row.usageCount,
      decision: row.decision,
      targetType: row.targetType || (row.kind === 'ACCOUNT' ? 'BANK' : 'EXPENSE'),
      targetDetail: (row.detail ?? undefined) as Prisma.InputJsonObject | undefined,
      sourcePayload: { source: 'CSV' },
    }));

    const batch = await this.prisma.migrationBatch.create({
      data: {
        workspaceId,
        source: 'CSV',
        status: 'DRAFT',
        createdByUserId: userId || null,
        note: `${items.length}টি সারি ফাইল থেকে`,
        items: { createMany: { data: items } },
      },
    });

    this.audit.emit({
      workspaceId,
      actorUserId: userId,
      action: 'migration.pulled',
      entity: 'MigrationBatch',
      entityId: batch.id,
      after: { source: 'CSV', rows: items.length },
    });

    const detail = await this.detail(workspaceId, batch.id);
    /* Rows the file could not be read for are reported alongside what worked,
       rather than swallowed — somebody who typed 40 rows and got 38 should be
       told which two, not left to count. */
    if (parsed.errors.length > 0)
      detail.note = `${detail.note} · ${parsed.errors.length}টি সারি বাদ`;
    return detail;
  }

  // --------------------------------------------------------------- deciding

  async setDecision(
    workspaceId: string,
    batchId: string,
    itemId: string,
    patch: {
      decision?: MigrationDecision;
      targetType?: string;
      targetId?: string | null;
      detail?: MigrationDetail | null;
      /** Empty string clears it, so a rename can be undone. */
      name?: string;
    },
  ): Promise<MigrationItemView> {
    /* Not "must be a draft".
     *
     * Somebody skipping 200 rows to get the other hundred in is not throwing
     * those 200 away — they are deferring them, and the batch closing over that
     * decision would make it permanent. So a row is changeable for as long as
     * it has not been created, whatever the batch's status, and a batch that
     * had been closed reopens when one of its rows is picked up again.
     *
     * The one thing that cannot change is a row already in the books: altering
     * a decision that has been carried out would say something untrue about
     * what happened. Rollback is how that gets undone. */
    const batch = await this.prisma.migrationBatch.findFirst({
      where: { id: batchId, workspaceId },
      select: { id: true, status: true },
    });
    if (!batch) throw new NotFoundException('মাইগ্রেশন খসড়া পাওয়া যায়নি');
    if (batch.status === 'ROLLED_BACK') {
      throw new BadRequestException('এটি ফিরিয়ে নেওয়া হয়েছে — আবার শুরু করুন');
    }

    const item = await this.prisma.migrationItem.findFirst({
      where: { id: itemId, batchId: batch.id, workspaceId },
    });
    if (!item) throw new NotFoundException('সারিটি পাওয়া যায়নি');
    if (item.createdEntityId) {
      throw new BadRequestException('এটি তৈরি হয়ে গেছে — বদলাতে হলে আগে ফিরিয়ে নিন');
    }

    const decision = patch.decision ?? (item.decision as MigrationDecision);

    /* A merge with nothing chosen yet is allowed to be saved.
     *
     * Refusing it was a deadlock: the control for choosing what to merge into
     * only appears once the row *is* a merge, so demanding the target at the
     * moment somebody picks "মেলাও" made the option impossible to pick at all.
     * This is a draft — half-made decisions are the normal state of one — and
     * apply is where an unfinished row is caught, with a reason on the row. */
    const targetId = patch.targetId ?? item.targetId;
    if (decision === 'MERGE' && targetId) {
      await this.assertMergeTarget(workspaceId, item.kind, targetId);
    }
    /* The same column, a different question. For a merge it is "which existing
       row is this one really"; for a category being created it is "which one
       does this sit under". Both are a pointer at a row here, so they share the
       field, and which is meant follows from the decision. */
    if (decision === 'CREATE' && item.kind === 'CATEGORY' && targetId) {
      await this.assertParentCategory(workspaceId, targetId, item.targetType);
    }

    /* Reopened, so the screen shows it as work in progress again rather than as
       something finished that mysteriously changed. */
    if (batch.status === 'APPLIED') {
      await this.prisma.migrationBatch.update({
        where: { id: batch.id },
        data: { status: 'DRAFT' },
      });
    }

    const updated = await this.prisma.migrationItem.update({
      where: { id: item.id },
      data: {
        /* Whatever it said last time about being left behind no longer holds. */
        skippedReason: null,
        decision,
        targetName:
          patch.name === undefined ? undefined : patch.name.trim() ? patch.name.trim() : null,
        targetType: patch.targetType ?? item.targetType,
        /* Cleared when the decision stops being one that uses it, so an
           abandoned choice cannot resurface if somebody switches back — but
           kept for a category being created, where it names the parent. */
        targetId:
          decision === 'MERGE' || (decision === 'CREATE' && item.kind === 'CATEGORY')
            ? (patch.targetId ?? item.targetId)
            : null,
        /* Merged, not replaced: the sheet sends only the fields it asked about,
           and a card sheet must not wipe a rate somebody typed earlier. An
           explicit `null` clears the lot, which is how "start again" works. */
        targetDetail:
          patch.detail === undefined
            ? undefined
            : patch.detail === null
              ? Prisma.DbNull
              : ({
                  ...((item.targetDetail ?? {}) as MigrationDetail),
                  ...patch.detail,
                } as Prisma.InputJsonObject),
      },
    });
    return this.presentItem(updated);
  }

  /**
   * A category may sit under exactly one other, and that one may sit under
   * none.
   *
   * The two-level rule is the product's, not this module's — a tree deeper than
   * that turns a report into an outline nobody reads. Checked here so a person
   * meets the refusal while deciding, rather than as a row that quietly did
   * nothing when the batch was applied.
   */
  /**
   * The same decision across many rows.
   *
   * Wallet's own groups are the shape somebody actually thinks in — "all of
   * Vehicle is a sub-category of যাতায়াত" — and making that 40 requests would
   * be 40 chances to lose one and a screen that stutters through it. Each row
   * still goes through `setDecision`, so nothing is validated more loosely
   * because it arrived in company.
   */
  async setDecisions(
    workspaceId: string,
    batchId: string,
    itemIds: readonly string[],
    patch: {
      decision?: MigrationDecision;
      targetType?: string;
      targetId?: string | null;
      detail?: MigrationDetail | null;
    },
  ): Promise<{ updated: number; errors: string[] }> {
    const errors: string[] = [];
    let updated = 0;

    for (const itemId of itemIds) {
      try {
        await this.setDecision(workspaceId, batchId, itemId, patch);
        updated += 1;
      } catch (error) {
        /* One row's refusal is that row's, not the batch's — a parent of the
           wrong kind among forty must not undo the other thirty-nine. */
        errors.push(error instanceof Error ? error.message : 'সারিটি বদলানো গেল না');
      }
    }

    /* The same complaint forty times is one complaint. */
    return { updated, errors: [...new Set(errors)] };
  }

  private async assertParentCategory(
    workspaceId: string,
    parentId: string,
    kind: string | null,
  ): Promise<void> {
    const parent = await this.prisma.category.findFirst({
      where: { id: parentId, workspaceId, deletedAt: null },
      select: { id: true, kind: true, parentId: true },
    });
    if (!parent) throw new NotFoundException('মূল খাত পাওয়া যায়নি');
    if (kind && parent.kind !== kind) {
      throw new BadRequestException('উপ-খাত ও মূল খাতের ধরন এক হতে হবে');
    }
    if (parent.parentId) {
      throw new BadRequestException('উপ-খাতের নিচে আরেকটি উপ-খাত রাখা যায় না');
    }
  }

  private async assertMergeTarget(
    workspaceId: string,
    kind: string,
    targetId: string,
  ): Promise<void> {
    const found =
      kind === 'ACCOUNT'
        ? await this.prisma.account.findFirst({
            where: { id: targetId, workspaceId, deletedAt: null },
            select: { id: true },
          })
        : await this.prisma.category.findFirst({
            where: { id: targetId, workspaceId, deletedAt: null },
            select: { id: true },
          });
    if (!found) throw new NotFoundException('যেটিতে যুক্ত করতে চান সেটি পাওয়া যায়নি');
  }

  // ------------------------------------------------------------ spreadsheet

  async toCsv(workspaceId: string, batchId: string): Promise<string> {
    const batch = await this.detail(workspaceId, batchId);

    /* Merge targets go out as names, not ids: the file is for a person, and a
       column of cuids is a column nobody can check. Import reads them back the
       same way. */
    const [accounts, categories] = await Promise.all([
      this.prisma.account.findMany({
        where: { workspaceId, deletedAt: null },
        select: { id: true, name: true },
      }),
      this.prisma.category.findMany({
        where: { workspaceId, deletedAt: null },
        select: { id: true, name: true, nameBn: true },
      }),
    ]);
    const nameById = new Map<string, string>();
    for (const account of accounts) nameById.set(account.id, account.name);
    for (const category of categories) nameById.set(category.id, category.nameBn ?? category.name);

    const rows: MigrationRow[] = batch.items.map((item) => ({
      kind: item.kind,
      sourceId: item.sourceId,
      name: item.sourceName,
      /* The source name stays in `name` — it is what a second pull matches on
         and what somebody recognises from the other product. A rename is its
         own column. */
      rename: item.targetName ?? '',
      usageCount: item.usageCount,
      decision: item.decision,
      targetType: item.targetType ?? '',
      /* The same column split in two on the way out, because the file is for a
         person: `mergeInto` where the row folds into another, `parent` where it
         sits under one. */
      mergeInto:
        item.decision === 'MERGE' && item.targetId ? (nameById.get(item.targetId) ?? '') : '',
      parent:
        item.decision === 'CREATE' && item.kind === 'CATEGORY' && item.targetId
          ? (nameById.get(item.targetId) ?? '')
          : '',
      note: item.detail,
      detail: item.targetDetail,
    }));

    return migrationToCsv(rows);
  }

  /**
   * The spreadsheet, back.
   *
   * Matches on `sourceId` and updates only the decision columns. A row whose id
   * is not in this batch is reported rather than inserted: a file from the wrong
   * batch should tell somebody so, not half-import.
   */
  async fromCsv(
    workspaceId: string,
    batchId: string,
    csv: string,
  ): Promise<{ updated: number; errors: string[] }> {
    /* Same rule as the row controls: changeable until it is created. */
    const batch = await this.prisma.migrationBatch.findFirst({
      where: { id: batchId, workspaceId },
      select: { id: true, status: true },
    });
    if (!batch) throw new NotFoundException('মাইগ্রেশন খসড়া পাওয়া যায়নি');
    if (batch.status === 'ROLLED_BACK') {
      throw new BadRequestException('এটি ফিরিয়ে নেওয়া হয়েছে — আবার শুরু করুন');
    }
    const parsed = migrationFromCsv(csv);
    const errors = [...parsed.errors];

    const items = await this.prisma.migrationItem.findMany({
      /* Rows already in the books are left alone rather than reported as
         errors: a spreadsheet exported before a group was approved still
         carries them, and refusing the whole file over that would be useless. */
      where: { batchId: batch.id, workspaceId, createdEntityId: null },
      select: { id: true, kind: true, sourceId: true },
    });
    const itemBySource = new Map(items.map((i) => [`${i.kind}:${i.sourceId}`, i]));

    const [accounts, categories] = await Promise.all([
      this.prisma.account.findMany({
        where: { workspaceId, deletedAt: null },
        select: { id: true, name: true },
      }),
      this.prisma.category.findMany({
        where: { workspaceId, deletedAt: null },
        select: { id: true, name: true, nameBn: true },
      }),
    ]);
    const accountIdByName = new Map(accounts.map((a) => [normalise(a.name), a.id]));
    const categoryIdByName = new Map<string, string>();
    for (const category of categories) {
      categoryIdByName.set(normalise(category.name), category.id);
      if (category.nameBn) categoryIdByName.set(normalise(category.nameBn), category.id);
    }

    let updated = 0;

    for (const row of parsed.rows) {
      const item = itemBySource.get(`${row.kind}:${row.sourceId}`);
      if (!item) {
        /* Either not in this batch, or already created. Both are "nothing to
           do here" rather than a mistake worth stopping for. */
        continue;
      }

      let targetId: string | null = null;
      if (row.decision === 'MERGE') {
        const lookup = row.kind === 'ACCOUNT' ? accountIdByName : categoryIdByName;
        targetId = lookup.get(normalise(row.mergeInto)) ?? null;
        if (!targetId) {
          /* Named something that is not here. Refusing the row is the only safe
             answer — the alternative is creating it, which is a different
             decision from the one written in the file. */
          errors.push(`"${row.name}" — "${row.mergeInto}" নামে কিছু পাওয়া যায়নি`);
          continue;
        }
      } else if (row.decision === 'CREATE' && row.kind === 'CATEGORY' && row.parent) {
        targetId = categoryIdByName.get(normalise(row.parent)) ?? null;
        if (!targetId) {
          errors.push(`"${row.name}" — "${row.parent}" নামে কোনো খাত পাওয়া যায়নি`);
          continue;
        }
      }

      await this.prisma.migrationItem.update({
        where: { id: item.id },
        data: {
          decision: row.decision,
          targetType: row.targetType || undefined,
          targetId,
          /* Absent columns leave what is there alone — a spreadsheet somebody
             made themselves, carrying only the decisions, must not wipe figures
             typed on the screen. */
          targetName: row.rename ? row.rename : undefined,
          targetDetail: row.detail === null ? undefined : (row.detail as Prisma.InputJsonObject),
        },
      });
      updated += 1;
    }

    return { updated, errors };
  }

  // ------------------------------------------------------------------ apply

  /**
   * Create what the decisions say — all of it, or only the rows named.
   *
   * Partial on purpose. 312 categories is not a thing anybody decides in one
   * sitting, and a batch that could only be approved whole meant either
   * finishing every row before getting anything, or approving rows nobody had
   * looked at. Approving a group at a time is how the work actually goes.
   *
   * The batch stays a draft while anything is left, so the rest can be decided
   * and approved later — and rollback keeps working throughout, because what it
   * undoes is what was created, not what state the batch is in.
   */
  async apply(
    workspaceId: string,
    userId: string,
    batchId: string,
    timezone: string,
    itemIds?: readonly string[],
  ): Promise<BatchDetail> {
    const batch = await this.requireBatch(workspaceId, batchId, 'DRAFT');

    const items = await this.prisma.migrationItem.findMany({
      where: {
        batchId: batch.id,
        workspaceId,
        ...(itemIds && itemIds.length > 0 ? { id: { in: [...itemIds] } } : {}),
      },
      /* Accounts before categories. Nothing here depends on that today, but a
         later phase that imports records does, and the order costs nothing. */
      orderBy: [{ kind: 'asc' }, { usageCount: 'desc' }],
    });

    /* A row that is somebody's parent goes first, because a child resolves its
       parent by looking for the row it already created. Sorting is enough —
       the tree is two deep by the product's own rule, so no parent has a
       parent and one pass cannot be out of order. */
    const isParent = new Set(
      items.map((item) => item.parentSourceId).filter((id): id is string => Boolean(id)),
    );
    const ordered = [
      ...items.filter((item) => isParent.has(item.sourceId)),
      ...items.filter((item) => !isParent.has(item.sourceId)),
    ];

    for (const item of ordered) {
      if (item.createdEntityId) continue;
      try {
        await this.applyOne(workspaceId, item, timezone);
      } catch (error) {
        /* One row failing is a row, not a batch. The reason is written where
           the person will see it, next to the name it belongs to. */
        const message = error instanceof Error ? error.message : 'কারণ জানা যায়নি';
        await this.prisma.migrationItem.update({
          where: { id: item.id },
          data: { skippedReason: message.slice(0, 300) },
        });
      }
    }

    /* Finished only when nothing is left to do. A row counts as handled once it
       has been created or has said why it was not; anything else is still
       waiting for a person, and closing the batch over it would strand it. */
    const outstanding = await this.prisma.migrationItem.count({
      where: {
        batchId: batch.id,
        workspaceId,
        createdEntityId: null,
        OR: [{ skippedReason: null }, { skippedReason: '' }],
      },
    });

    await this.prisma.migrationBatch.update({
      where: { id: batch.id },
      data:
        outstanding === 0
          ? { status: 'APPLIED', appliedAt: new Date() }
          : { appliedAt: new Date() },
    });

    const applied = await this.detail(workspaceId, batch.id);
    this.audit.emit({
      workspaceId,
      actorUserId: userId,
      action: 'migration.applied',
      entity: 'MigrationBatch',
      entityId: batch.id,
      after: applied.counts,
    });
    return applied;
  }

  private async applyOne(
    workspaceId: string,
    item: {
      id: string;
      kind: string;
      sourceName: string;
      targetName: string | null;
      decision: string;
      targetType: string | null;
      targetId: string | null;
      parentSourceId: string | null;
      batchId: string;
      sourcePayload: Prisma.JsonValue;
      targetDetail: Prisma.JsonValue;
    },
    timezone: string,
  ): Promise<void> {
    const payload = (item.sourcePayload ?? {}) as Record<string, unknown>;
    const detail = (item.targetDetail ?? {}) as MigrationDetail;
    /* What it will actually be called. Everything below — the duplicate check,
       the row it creates — uses this and never the source name. */
    const name = item.targetName?.trim() || item.sourceName;
    const done = (data: Prisma.MigrationItemUpdateInput): Promise<unknown> =>
      this.prisma.migrationItem.update({ where: { id: item.id }, data });

    if (item.decision === 'PERSON') {
      /* Through `PeopleService`, not a raw insert: it hands out the P-0001
         code, writes the identity keys the unique index is actually on, and
         refuses a second person on a number somebody already has. Reproducing
         any of that here is how two rows for one human appear. */
      const { name: personName, phone } = splitNameAndPhone(name);
      const created = await this.people.create(
        { id: '', workspaceId, timezone, locale: 'bn' },
        { name: personName, phone: phone ?? undefined },
      );
      await done({ createdEntityId: created.id, createdEntityKind: 'Person', skippedReason: null });
      return;
    }

    if (item.decision === 'LATER') {
      /* Untouched, and deliberately not given a reason: a reason is what marks
         a row as dealt with, and this one is waiting rather than done. That is
         also what keeps the batch open. */
      return;
    }
    if (item.decision === 'SKIP') {
      await done({ skippedReason: 'বাদ দেওয়া হয়েছে' });
      return;
    }
    if (item.decision === 'MERGE') {
      /* Nothing was ever chosen to merge into, so there is nothing to do and
         nothing to guess. Said on the row rather than silently treated as a
         skip, which would read as a decision somebody made. */
      if (!item.targetId) {
        await done({ skippedReason: 'কোনটার সাথে মেলাবেন বেছে নেওয়া হয়নি' });
        return;
      }
      await done({ skippedReason: 'আগের একটিতে যুক্ত করা হয়েছে' });
      return;
    }

    if (item.kind === 'ACCOUNT') {
      const clash = await this.prisma.account.findFirst({
        where: { workspaceId, deletedAt: null, name: name },
        select: { id: true },
      });
      if (clash) {
        await done({ skippedReason: 'একই নামে অ্যাকাউন্ট আগে থেকেই আছে' });
        return;
      }
      await this.entitlements.assertWithinLimit(workspaceId, 'accounts.max', timezone);

      const created = await this.prisma.account.create({
        data: {
          workspaceId,
          name: name,
          type: (item.targetType ?? 'BANK') as AccountType,
          currency: typeof payload.currency === 'string' ? payload.currency : 'BDT',
          openingBalance: BigInt(0),
          accountNumberMasked:
            typeof payload.accountNumber === 'string' ? payload.accountNumber : null,
          isArchived: payload.archived === true,
          /* Only a credit card has these, and only if somebody typed them.
             Null means no reminder, which is the honest state for a card whose
             dates nobody has looked up yet. */
          statementDayOfMonth: detail.statementDay ?? null,
          dueDayOfMonth: detail.dueDay ?? null,
          reminderLeadDays: detail.reminderLeadDays ?? null,
        },
      });
      await done({
        createdEntityId: created.id,
        createdEntityKind: 'Account',
        skippedReason: null,
      });
      return;
    }

    // ---- categories, and the four things a category can turn out to be

    if (item.decision === 'SAVINGS') {
      /* Whatever was filled in on the draft, and nothing at all where it was
         not. A term still has to be a number the column can hold — twelve, and
         the note says so out loud, because the difference between a figure
         somebody chose and one this invented has to be visible on the plan
         itself rather than only in this file. */
      const known = Boolean(detail.termMonths);
      const created = await this.prisma.savingsPlan.create({
        data: {
          workspaceId,
          planName: name,
          planType: 'DPS',
          installmentMinor: BigInt(detail.installmentMinor ?? 0),
          principalMinor: BigInt(detail.principalMinor ?? 0),
          termMonths: detail.termMonths ?? 12,
          profitRateBps: detail.profitRateBps ?? 0,
          startDate: detail.startDate
            ? fromLocalDateString(detail.startDate, timezone)
            : new Date(),
          note: known
            ? 'আগের সফটওয়্যার থেকে আনা'
            : 'আগের সফটওয়্যার থেকে আনা — মেয়াদ ১২ মাস ধরে নেওয়া হয়েছে, দেখে ঠিক করে নিন',
        },
      });
      await done({
        createdEntityId: created.id,
        createdEntityKind: 'SavingsPlan',
        skippedReason: null,
      });
      return;
    }

    if (item.decision === 'INSURANCE') {
      /* A zero premium is legal and deliberately creates no schedule, so the
         policy arrives with nothing owed until the real figures go in. */
      const created = await this.prisma.insurancePolicy.create({
        data: {
          workspaceId,
          insurer: name,
          sumAssuredMinor: BigInt(detail.sumAssuredMinor ?? 0),
          premiumMinor: BigInt(detail.premiumMinor ?? 0),
          startDate: detail.startDate
            ? fromLocalDateString(detail.startDate, timezone)
            : new Date(),
          note: detail.premiumMinor
            ? 'আগের সফটওয়্যার থেকে আনা'
            : 'আগের সফটওয়্যার থেকে আনা — প্রিমিয়াম ও মেয়াদ বসিয়ে নিন',
        },
      });
      await done({
        createdEntityId: created.id,
        createdEntityKind: 'InsurancePolicy',
        skippedReason: null,
      });
      return;
    }

    /* Money owed to an institution.
     *
     * An account, not a `Loan` record: a loan posts a disbursement transaction,
     * and this knows neither the principal nor which account the money moved
     * through. An account of the right type puts the debt on the balance sheet
     * with nothing made up.
     *
     * Only this direction, and only for institutions. What a *person* owes goes
     * through `PERSON` and ঋণ, where it belongs — an account in somebody's name
     * beside a loan in their name is one debt counted twice. */
    if (item.decision === 'LIABILITY') {
      const clashing = await this.prisma.account.findFirst({
        where: { workspaceId, deletedAt: null, name: name },
        select: { id: true },
      });
      if (clashing) {
        await done({ skippedReason: 'একই নামে অ্যাকাউন্ট আগে থেকেই আছে' });
        return;
      }
      await this.entitlements.assertWithinLimit(workspaceId, 'accounts.max', timezone);

      const created = await this.prisma.account.create({
        data: {
          workspaceId,
          name: name,
          type: 'LIABILITY',
          currency: 'BDT',
          /* No balance, as with every account: Wallet's figure is today's, not
             the opening one, and importing it would double-count the history. */
          openingBalance: BigInt(0),
        },
      });
      await done({
        createdEntityId: created.id,
        createdEntityKind: 'Account',
        skippedReason: null,
      });
      return;
    }

    /* Everything above returned. What is left has to be `CREATE`, and if it is
       not, the row carries a decision this build no longer knows — a
       spreadsheet from an older version, or a choice retired while the draft
       sat open. Falling through would quietly make it a category, which is how
       a debt ends up in the spending report. */
    if (item.decision !== 'CREATE') {
      await done({
        skippedReason: `"${item.decision}" এখন আর চেনা যায় না — নতুন করে বেছে নিন`,
      });
      return;
    }

    const clash = await this.prisma.category.findFirst({
      where: {
        workspaceId,
        deletedAt: null,
        OR: [{ name: name }, { nameBn: name }],
      },
      select: { id: true },
    });
    if (clash) {
      await done({ skippedReason: 'একই নামে খাত আগে থেকেই আছে' });
      return;
    }

    /* A parent staged in this same batch: whatever it turned into, a moment
       ago, in this same loop. `MERGE` counts — a group folded into an existing
       category is still where its children belong — so the merge target is
       read as readily as a created id. */
    let parentId = item.targetId;
    if (!parentId && item.parentSourceId) {
      const staged = await this.prisma.migrationItem.findFirst({
        where: { batchId: item.batchId, workspaceId, sourceId: item.parentSourceId },
        select: { createdEntityId: true, createdEntityKind: true, targetId: true, decision: true },
      });
      const fromStaged =
        staged?.createdEntityKind === 'Category'
          ? staged.createdEntityId
          : staged?.decision === 'MERGE'
            ? staged.targetId
            : null;
      if (!fromStaged) {
        /* The group was skipped, or failed. Its children become headings of
           their own rather than disappearing — the name is what the person
           came for, and a top-level category is a thing they can move. */
        parentId = null;
      } else {
        parentId = fromStaged;
      }
    }

    /* Re-checked rather than trusted: the parent was valid when it was chosen,
       and a category deleted in between would otherwise put this one at the top
       level without anybody being told the shape had changed. Refusing the row
       is the honest answer — it can be made by hand, and a wrong place in the
       tree is the kind of thing nobody notices for a year. */
    if (parentId) {
      const parent = await this.prisma.category.findFirst({
        where: { id: parentId, workspaceId, deletedAt: null },
        select: { kind: true, parentId: true },
      });
      const usable = parent && !parent.parentId && parent.kind === (item.targetType ?? parent.kind);
      if (!usable) {
        await done({ skippedReason: 'যে খাতের নিচে বসার কথা ছিল সেটি আর নেই' });
        return;
      }
    }

    const created = await this.prisma.category.create({
      data: {
        workspaceId,
        name: name,
        nameBn: name,
        kind: item.targetType === 'INCOME' ? 'INCOME' : 'EXPENSE',
        parentId,
        /* Set at creation rather than left for later: an English name imported
           from an English-speaking product is not what anybody types. */
        searchAliases: detail.aliases ?? [],
      },
    });
    await done({ createdEntityId: created.id, createdEntityKind: 'Category', skippedReason: null });
  }

  // ---------------------------------------------------------------- records

  /**
   * Phase C: the history itself, one page at a time.
   *
   * ## Why a page per request
   *
   * 9,625 records. Written in one request, a timeout half way through leaves a
   * ledger nobody can describe — some of it in, no answer about which. A page
   * is 200 rows, a second or two of writing, and the screen loops. The worst
   * case is one page asked for twice, which `externalRef` already answers for.
   *
   * ## Why it is an ImportBatch and not something new
   *
   * `POST /import/batches/:id/revert` already undoes a whole batch in one
   * press, softly. Every page of this writes into the *same* batch, so the
   * migration's entire history is one button away from being taken back — which
   * is the only reason importing 9,625 rows is a decision somebody can make.
   *
   * ## The two ways this could be quietly, expensively wrong
   *
   * **Transfers.** Each side of one is a record. Written as they read, one
   * movement becomes an expense *and* an income and both totals are inflated
   * for four years. So a transfer is written once, as a TRANSFER, and only from
   * the side whose amount is negative — the side the money left. The other side
   * is skipped wherever it lands, which is what makes this independent of the
   * order the pages arrive in.
   *
   * **Floats.** `amount.value` is `-601.66` and `601.66 * 100` is 60165.999…
   * The conversion goes through the string form, which is exact.
   */
  async importRecords(
    ctx: { workspaceId: string; userId: string; timezone: string; currency: string },
    batchId: string,
    token: string,
    offset: number,
  ): Promise<RecordPageResult> {
    const { workspaceId, timezone } = ctx;

    const batch = await this.prisma.migrationBatch.findFirst({
      where: { id: batchId, workspaceId },
      select: { id: true, status: true, appliedAt: true },
    });
    if (!batch) throw new NotFoundException('মাইগ্রেশন খসড়া পাওয়া যায়নি');
    if (batch.status === 'ROLLED_BACK') {
      throw new BadRequestException('এটি ফিরিয়ে নেওয়া হয়েছে — আবার শুরু করুন');
    }
    /* Every record needs an account and a category that exist here *now*.
       Reading 9,625 rows in order to skip every one of them is a long way to
       say "approve the accounts first". */
    if (!batch.appliedAt) {
      throw new BadRequestException(
        'আগে অ্যাকাউন্ট আর খাতগুলো অনুমোদন করুন — নইলে লেনদেনগুলো কোথায় বসবে সেটি জানা যাবে না',
      );
    }

    const mapping = await this.recordMapping(workspaceId, batch.id);
    if (mapping.accountBySource.size === 0) {
      throw new BadRequestException(
        'এই খসড়ার কোনো অ্যাকাউন্ট এখানে তৈরি হয়নি — আগে সেগুলো অনুমোদন করুন',
      );
    }

    const page = await this.wallet.recordsPage(token, offset);
    const system = await this.accounts.systemAccounts(workspaceId);

    /* Asked once for the whole page rather than once per row; the index is
       `[workspaceId, externalRef]`.
     *
     * Deleted rows are deliberately *not* counted as present. A reverted batch
     * is soft-deleted, and a person who reverted in order to try again would
     * otherwise get a run that imports nothing and says nothing is wrong. */
    const refs = [...new Set(page.rows.map(walletRefOf))];
    const known = new Set(
      (
        await this.prisma.transaction.findMany({
          where: { workspaceId, deletedAt: null, externalRef: { in: refs } },
          select: { externalRef: true },
        })
      ).map((row) => row.externalRef ?? ''),
    );

    const problems: string[] = [];
    const writes: RecordWrite[] = [];
    let skipped = 0;

    /* A row a person can find again: the day and the amount, in their own
       numerals. One of the three unpairable transfers in the real account is a
       ৳225,000 salary — not a line to bury behind a record id. */
    const label = (date: Date, minor: number): string =>
      `${toLocalDateString(date, timezone)} তারিখের ${formatMinor(Math.abs(minor), {
        bengaliNumerals: true,
        decimals: false,
        currency: ctx.currency,
      })}`;

    for (const record of page.rows) {
      const ref = walletRefOf(record);

      /* The whole purpose of `externalRef`. A page asked for twice — a lost
         connection, a refresh, a second run months later — writes nothing the
         second time. `known` grows as this page writes, so the same reference
         appearing twice inside one page is caught too. */
      if (known.has(ref)) {
        skipped += 1;
        continue;
      }

      const accountId = mapping.accountBySource.get(record.accountId ?? '');
      if (!accountId) {
        /* Never guessed at. Putting somebody's records into whichever account
           happened to be first is worse than not importing them, because
           nothing on the screen would ever say so. Said once per account
           rather than once per record: 400 rows on one account is one
           complaint. */
        skipped += 1;
        problems.push(
          `"${mapping.nameOf(record.accountId)}" অ্যাকাউন্টটি এখানে তৈরি হয়নি — এর লেনদেনগুলো আনা হয়নি`,
        );
        continue;
      }

      const account = mapping.accountsById.get(accountId);
      /* Two USD accounts and one CNY, against books kept in taka. Nothing here
         converts, and writing 500 USD as ৳500 would be wrong in a way that adds
         up perfectly and so is never noticed. */
      if (account && account.currency !== ctx.currency) {
        skipped += 1;
        problems.push(
          `"${account.name}" অ্যাকাউন্টটি ${account.currency}-এ রাখা — এই অ্যাপ টাকায় রূপান্তর করে না, তাই এর লেনদেনগুলো আনা হয়নি`,
        );
        continue;
      }

      const instant = record.recordDate ? new Date(record.recordDate) : null;
      if (!instant || Number.isNaN(instant.getTime())) {
        skipped += 1;
        problems.push(`একটি সারির তারিখ পড়া গেল না (${record.id}) — সেটি আনা হয়নি`);
        continue;
      }
      /* The ledger day is the workspace's day: a record stamped 19:30 UTC is
         the next morning in Dhaka, and filing it under the wrong day moves it
         between two months of somebody's reports. */
      const date = fromLocalDateString(toLocalDateString(instant, timezone), timezone);

      let minor: number;
      try {
        /* Float in, integer poisha out, through the string form — which is
           exact, because JavaScript prints the shortest round-trip
           representation of a double. `* 100` is not. */
        minor = parseMoneyToMinor(String(record.amount?.value ?? ''));
      } catch {
        skipped += 1;
        problems.push(`একটি সারির টাকার অঙ্ক পড়া গেল না (${record.id}) — সেটি আনা হয়নি`);
        continue;
      }
      if (minor === 0) {
        skipped += 1;
        problems.push(
          `${toLocalDateString(date, timezone)} তারিখের একটি শূন্য টাকার সারি বাদ পড়েছে`,
        );
        continue;
      }

      const note = (record.note ?? '').trim().slice(0, 500);
      const payee = (record.payee ?? '').trim().slice(0, 200);
      const transfer = record.transfer ?? null;

      if (transfer) {
        /* The mirror. Whichever page it lands in, it is the negative side that
           writes the pair — so this needs no memory of other pages and no
           second pass, and writing both sides as an expense and an income (the
           single worst thing this feature could do) is impossible by shape
           rather than by care. */
        if (minor > 0) {
          skipped += 1;
          continue;
        }

        const transferId = transfer.transferId?.trim();
        const mirrorAccount = transfer.mirrorRecord?.accountId ?? '';
        const counterAccountId = mapping.accountBySource.get(mirrorAccount);
        /* Three records out of 9,625 resolve to neither an id nor a usable
           mirror. They belong in a list somebody can look at, not in a
           silence — and certainly not written as an expense, which is what
           "just import it" would mean here. */
        if (!transferId || !counterAccountId) {
          skipped += 1;
          problems.push(`${label(date, minor)} ট্রান্সফারটির অন্য দিকটি পাওয়া যায়নি — আনা হয়নি`);
          continue;
        }

        const entries = this.entriesFor(
          {
            type: 'TRANSFER',
            amountMinor: Math.abs(minor),
            /* The money left this side, so it is the source; `mirrorRecord`
               names the destination. */
            accountId,
            counterAccountId,
            currency: ctx.currency,
          },
          system,
        );
        if (typeof entries === 'string') {
          skipped += 1;
          problems.push(`${label(date, minor)} ট্রান্সফারটি আনা গেল না — ${entries}`);
          continue;
        }

        writes.push({
          externalRef: ref,
          date,
          type: 'TRANSFER',
          description: note || null,
          payee: payee || null,
          entries,
        });
        known.add(ref);
        continue;
      }

      /* A category that became a savings plan, a policy, a person or a
         liability is not a category here, and neither is one somebody skipped.
         The record still lands — the money moved — with no category, exactly
         as the spreadsheet importer leaves a name it cannot match. Dropping
         the record instead would lose real spending over a filing decision. */
      const categoryId = mapping.categoryBySource.get(record.category?.id ?? '') ?? null;

      /* The sign decides, not `recordType`. They agree in every row measured,
         and where they ever disagree the sign is the one the ledger has to
         obey: an "income" of −৳500 written as income moves the money the wrong
         way. */
      const type = minor < 0 ? 'EXPENSE' : 'INCOME';
      const entries = this.entriesFor(
        { type, amountMinor: Math.abs(minor), accountId, categoryId, currency: ctx.currency },
        system,
      );
      if (typeof entries === 'string') {
        skipped += 1;
        problems.push(`${label(date, minor)} সারিটি আনা গেল না — ${entries}`);
        continue;
      }

      writes.push({
        externalRef: ref,
        date,
        type,
        description: note || null,
        payee: payee || null,
        entries,
      });
      known.add(ref);
    }

    /* One batch for the whole migration, found by the id of the draft it came
       from. `fileHash` is what the `[workspaceId, fileHash]` index is for and
       what it already means — "have I seen this before" — so it holds the
       migration batch's id rather than a hash of bytes that never existed.
     *
     * A reverted batch is deliberately not reused: adding rows to it would
     * leave them outside the revert that already happened, and its status would
     * be a lie. A run after a revert starts a fresh batch. */
    const existing = await this.prisma.importBatch.findFirst({
      where: {
        workspaceId,
        filename: RECORD_BATCH_FILENAME,
        fileHash: `wallet:${batch.id}`,
        status: 'APPLIED',
      },
      select: { id: true },
    });

    let importBatchId = existing?.id ?? null;

    if (writes.length > 0 || importBatchId) {
      importBatchId = await this.prisma.$transaction(
        async (tx) => {
          const target =
            existing ??
            (await tx.importBatch.create({
              data: {
                workspaceId,
                createdByUserId: ctx.userId || null,
                filename: RECORD_BATCH_FILENAME,
                fileHash: `wallet:${batch.id}`,
                mapping: {
                  source: 'WALLET',
                  migrationBatchId: batch.id,
                } as unknown as Prisma.InputJsonValue,
                /* Already APPLIED, like the CSV importer's: a row in this table
                   can only mean the write succeeded, because the write and the
                   row are the same transaction. */
                status: 'APPLIED',
                appliedAt: new Date(),
              },
            }));

          for (const write of writes) {
            // Belt and braces: the engine says it balances, the DB trigger will too.
            assertBalanced(write.entries);
            await tx.transaction.create({
              data: {
                workspaceId,
                createdByUserId: ctx.userId || null,
                date: write.date,
                type: write.type,
                description: write.description,
                payee: write.payee,
                externalRef: write.externalRef,
                source: 'IMPORT',
                importBatchId: target.id,
                entries: { create: write.entries.map((e) => ledgerEntryData(e, workspaceId)) },
              },
            });
          }

          /* Counted across every page, so the batch's own figures describe the
             whole migration rather than whichever page went last. */
          await tx.importBatch.update({
            where: { id: target.id },
            data: {
              rowCount: { increment: page.rows.length },
              importedCount: { increment: writes.length },
              skippedCount: { increment: skipped },
            },
          });

          return target.id;
        },
        { timeout: RECORD_WRITE_TIMEOUT_MS, maxWait: RECORD_WRITE_MAX_WAIT_MS },
      );
    }

    const transfersWritten = writes.filter((w) => w.type === 'TRANSFER').length;

    if (writes.length > 0) {
      this.audit.emit({
        workspaceId,
        actorUserId: ctx.userId,
        action: 'migration.applied',
        entity: 'MigrationBatch',
        entityId: batch.id,
        after: {
          records: writes.length,
          transfers: transfersWritten,
          skipped,
          offset,
          importBatchId,
        },
      });
    }

    /* The same complaint forty times is one complaint, and a page of 200 must
       not answer with 200 lines nobody reads. */
    const unique = [...new Set(problems)];
    const listed = unique.slice(0, MAX_RECORD_PROBLEMS);
    if (unique.length > listed.length) {
      listed.push(`…আরও ${unique.length - listed.length}টি সমস্যা`);
    }

    return {
      imported: writes.length,
      skipped,
      transfersWritten,
      nextOffset: page.nextOffset,
      problems: listed,
      importBatchId,
    };
  }

  /**
   * Which source id became what, from the batch's own rows.
   *
   * `createdEntityId` where this batch made something, `targetId` where the
   * decision was MERGE — both are "the thing that source id means here", and
   * leaving the second out would skip every record on an account somebody
   * folded into one of their own.
   */
  private async recordMapping(
    workspaceId: string,
    batchId: string,
  ): Promise<{
    accountBySource: Map<string, string>;
    categoryBySource: Map<string, string>;
    accountsById: Map<string, { id: string; name: string; currency: string }>;
    nameOf: (sourceId: string | undefined) => string;
  }> {
    const items = await this.prisma.migrationItem.findMany({
      where: { batchId, workspaceId },
      select: {
        kind: true,
        sourceId: true,
        sourceName: true,
        decision: true,
        targetId: true,
        createdEntityId: true,
        createdEntityKind: true,
      },
    });

    const accountBySource = new Map<string, string>();
    const categoryBySource = new Map<string, string>();
    const sourceNames = new Map<string, string>();

    for (const item of items) {
      sourceNames.set(item.sourceId, item.sourceName);
      const mapped = item.createdEntityId ?? (item.decision === 'MERGE' ? item.targetId : null);
      if (!mapped) continue;

      /* What the row *became* decides which map it belongs in, never what it
         started as. A category that turned out to be a DPS created a
         SavingsPlan and a category that turned out to be a debt created an
         account; filing either as a category would tag records with a row that
         is not one. */
      const became = item.createdEntityId
        ? item.createdEntityKind
        : item.kind === 'ACCOUNT'
          ? 'Account'
          : 'Category';

      if (item.kind === 'ACCOUNT' && became === 'Account') {
        accountBySource.set(item.sourceId, mapped);
      } else if (item.kind === 'CATEGORY' && became === 'Category') {
        categoryBySource.set(item.sourceId, mapped);
      }
    }

    /* Re-read rather than trusted. A batch applied in March and its records
       imported in August is normal, and an account deleted in between maps to
       nothing again — better a row in `problems` than a foreign key error that
       takes the whole page down. */
    const [accounts, categories] = await Promise.all([
      this.prisma.account.findMany({
        where: { workspaceId, id: { in: [...new Set(accountBySource.values())] }, deletedAt: null },
        select: { id: true, name: true, currency: true },
      }),
      this.prisma.category.findMany({
        where: {
          workspaceId,
          id: { in: [...new Set(categoryBySource.values())] },
          deletedAt: null,
        },
        select: { id: true },
      }),
    ]);

    const accountsById = new Map(accounts.map((a) => [a.id, a]));
    const liveCategories = new Set(categories.map((c) => c.id));
    for (const [sourceId, id] of [...accountBySource]) {
      if (!accountsById.has(id)) accountBySource.delete(sourceId);
    }
    for (const [sourceId, id] of [...categoryBySource]) {
      if (!liveCategories.has(id)) categoryBySource.delete(sourceId);
    }

    return {
      accountBySource,
      categoryBySource,
      accountsById,
      nameOf: (sourceId) =>
        (sourceId ? sourceNames.get(sourceId) : null) ?? sourceId ?? 'অজানা অ্যাকাউন্ট',
    };
  }

  /**
   * The ledger lines for one record, or why there are none.
   *
   * A refusal from the engine — a transfer to the account it came from, an
   * amount of zero — is one row's problem and not the page's, so it comes back
   * as a string rather than as a throw that would take the other 199 with it.
   */
  private entriesFor(
    input: Parameters<typeof expandSimpleTransaction>[0],
    system: Parameters<typeof expandSimpleTransaction>[1],
  ): EntryDraft[] | string {
    try {
      return expandSimpleTransaction(input, system);
    } catch (error) {
      return error instanceof Error ? error.message : 'কারণ জানা যায়নি';
    }
  }

  // --------------------------------------------------------------- rollback

  /**
   * Undo exactly what one apply created.
   *
   * Anything that has been used since is kept, with the reason. That is the
   * whole safety property: pressing this cannot cost somebody a transaction.
   */
  async rollback(
    workspaceId: string,
    userId: string,
    batchId: string,
  ): Promise<{ removed: number; kept: { name: string; reason: string }[] }> {
    /* Not `requireBatch(… 'APPLIED')`: a batch approved a group at a time is
       still a draft, and what rollback undoes is what was created — the status
       is beside the point. A batch that created nothing has nothing to undo. */
    const batch = await this.prisma.migrationBatch.findFirst({
      where: { id: batchId, workspaceId },
      select: { id: true, status: true },
    });
    if (!batch) throw new NotFoundException('মাইগ্রেশন খসড়া পাওয়া যায়নি');
    if (batch.status === 'ROLLED_BACK') {
      throw new BadRequestException('এটি আগেই ফিরিয়ে নেওয়া হয়েছে');
    }

    const items = await this.prisma.migrationItem.findMany({
      where: { batchId: batch.id, workspaceId, NOT: { createdEntityId: null } },
    });
    if (items.length === 0) throw new BadRequestException('ফিরিয়ে নেওয়ার মতো কিছু তৈরি হয়নি');

    const kept: { name: string; reason: string }[] = [];
    let removed = 0;
    const now = new Date();

    for (const item of items) {
      const id = item.createdEntityId as string;
      const reason = await this.removeCreated(workspaceId, item.createdEntityKind, id, now);
      if (reason) {
        kept.push({ name: item.sourceName, reason });
        await this.prisma.migrationItem.update({
          where: { id: item.id },
          data: { skippedReason: reason },
        });
        continue;
      }
      removed += 1;
      /* The link is cleared so a second rollback does not try again, and so the
         row reads as "not created" — which, after this, it is not. */
      await this.prisma.migrationItem.update({
        where: { id: item.id },
        data: {
          createdEntityId: null,
          createdEntityKind: null,
          skippedReason: 'ফিরিয়ে নেওয়া হয়েছে',
        },
      });
    }

    /* A draft that had a group approved goes back to being a draft — there is
       still work in it. Only a finished batch becomes ROLLED_BACK. */
    await this.prisma.migrationBatch.update({
      where: { id: batch.id },
      data:
        batch.status === 'APPLIED'
          ? { status: 'ROLLED_BACK', rolledBackAt: now }
          : { rolledBackAt: now },
    });

    this.audit.emit({
      workspaceId,
      actorUserId: userId,
      action: 'migration.rolledBack',
      entity: 'MigrationBatch',
      entityId: batch.id,
      after: { removed, kept: kept.length },
    });

    return { removed, kept };
  }

  /** Returns why it was kept, or null when it went. */
  private async removeCreated(
    workspaceId: string,
    kind: string | null,
    id: string,
    now: Date,
  ): Promise<string | null> {
    if (kind === 'Account') {
      const used = await this.prisma.ledgerEntry.count({ where: { accountId: id } });
      if (used > 0) return `${used}টি লেনদেন হয়ে গেছে — রাখা হলো`;
      await this.prisma.account.updateMany({
        where: { id, workspaceId },
        data: { deletedAt: now },
      });
      return null;
    }

    if (kind === 'Category') {
      const used = await this.prisma.ledgerEntry.count({ where: { categoryId: id } });
      if (used > 0) return `${used}টি লেনদেনে ব্যবহার হয়েছে — রাখা হলো`;
      await this.prisma.category.updateMany({
        where: { id, workspaceId },
        data: { deletedAt: now },
      });
      return null;
    }

    if (kind === 'Person') {
      /* Kept if they are named on anything — a loan, a shared expense, a
         settlement. Removing the person would orphan the record of what they
         owe, which is the opposite of why the row was made one. */
      const [loans, members] = await Promise.all([
        this.prisma.loan.count({ where: { personId: id, deletedAt: null } }),
        /* A share points at a *member*, and a member points at the person, so
           this is the join that actually says "somebody is using them". */
        this.prisma.splitGroupMember.count({ where: { personId: id } }),
      ]);
      if (loans > 0) return `${loans}টি ঋণে আছেন — রাখা হলো`;
      if (members > 0) return `${members}টি ভাগাভাগির দলে আছেন — রাখা হলো`;
      await this.prisma.person.updateMany({
        where: { id, workspaceId },
        data: { deletedAt: now },
      });
      return null;
    }

    if (kind === 'SavingsPlan') {
      const paid = await this.prisma.savingsInstallment.count({
        where: { planId: id, status: 'PAID' },
      });
      if (paid > 0) return `${paid}টি কিস্তি দেওয়া হয়েছে — রাখা হলো`;
      await this.prisma.savingsPlan.updateMany({
        where: { id, workspaceId },
        data: { deletedAt: now },
      });
      return null;
    }

    if (kind === 'InsurancePolicy') {
      const paid = await this.prisma.premiumPayment.count({
        where: { policyId: id, status: 'PAID' },
      });
      if (paid > 0) return `${paid}টি প্রিমিয়াম দেওয়া হয়েছে — রাখা হলো`;
      await this.prisma.insurancePolicy.updateMany({
        where: { id, workspaceId },
        data: { deletedAt: now },
      });
      return null;
    }

    return 'কী তৈরি হয়েছিল বোঝা যায়নি — রাখা হলো';
  }

  // --------------------------------------------------------------- discard

  async remove(workspaceId: string, batchId: string): Promise<{ id: string }> {
    const batch = await this.prisma.migrationBatch.findFirst({
      where: { id: batchId, workspaceId },
      select: { id: true, status: true },
    });
    if (!batch) throw new NotFoundException('মাইগ্রেশন খসড়া পাওয়া যায়নি');
    if (batch.status === 'APPLIED') {
      throw new BadRequestException('প্রয়োগ করা হয়ে গেছে — আগে ফিরিয়ে নিন');
    }
    await this.prisma.migrationBatch.delete({ where: { id: batch.id } });
    return { id: batch.id };
  }

  private async requireBatch(
    workspaceId: string,
    batchId: string,
    status: BatchStatus,
  ): Promise<{ id: string; status: string }> {
    const batch = await this.prisma.migrationBatch.findFirst({
      where: { id: batchId, workspaceId },
      select: { id: true, status: true },
    });
    if (!batch) throw new NotFoundException('মাইগ্রেশন খসড়া পাওয়া যায়নি');
    if (batch.status !== status) {
      const said =
        batch.status === 'APPLIED'
          ? 'এটি প্রয়োগ করা হয়ে গেছে'
          : batch.status === 'ROLLED_BACK'
            ? 'এটি ফিরিয়ে নেওয়া হয়েছে'
            : 'এটি এখনো খসড়া';
      throw new BadRequestException(said);
    }
    return batch;
  }
}
