import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  accountTypeFromWallet,
  detailIsComplete,
  detailKindOf,
  migrationFromCsv,
  migrationStartFromCsv,
  migrationToCsv,
  suggestNonCategory,
  type DetailKind,
  type MigrationDecision,
  type MigrationDetail,
  type MigrationRow,
} from '@hishab/core';
import { fromLocalDateString } from '@hishab/shared';
import { Prisma, type AccountType } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletClient } from './wallet.client';

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
      usageCount: item.usageCount,
      decision: item.decision as MigrationDecision,
      targetType: item.targetType,
      targetId: item.targetId,
      createdEntityId: item.createdEntityId,
      createdEntityKind: item.createdEntityKind,
      skippedReason: item.skippedReason,
      detail: bits.join(' · '),
      group:
        typeof payload.group === 'string' && payload.group
          ? payload.group
          : typeof payload.sourceType === 'string' && payload.sourceType
            ? payload.sourceType
            : null,
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
    },
  ): Promise<MigrationItemView> {
    const batch = await this.requireBatch(workspaceId, batchId, 'DRAFT');
    const item = await this.prisma.migrationItem.findFirst({
      where: { id: itemId, batchId: batch.id, workspaceId },
    });
    if (!item) throw new NotFoundException('সারিটি পাওয়া যায়নি');

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

    const updated = await this.prisma.migrationItem.update({
      where: { id: item.id },
      data: {
        decision,
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
    const batch = await this.requireBatch(workspaceId, batchId, 'DRAFT');
    const parsed = migrationFromCsv(csv);
    const errors = [...parsed.errors];

    const items = await this.prisma.migrationItem.findMany({
      where: { batchId: batch.id, workspaceId },
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
        errors.push(`"${row.name}" (${row.sourceId}) এই খসড়ায় নেই`);
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
          targetDetail: row.detail === null ? undefined : (row.detail as Prisma.InputJsonObject),
        },
      });
      updated += 1;
    }

    return { updated, errors };
  }

  // ------------------------------------------------------------------ apply

  async apply(
    workspaceId: string,
    userId: string,
    batchId: string,
    timezone: string,
  ): Promise<BatchDetail> {
    const batch = await this.requireBatch(workspaceId, batchId, 'DRAFT');

    const items = await this.prisma.migrationItem.findMany({
      where: { batchId: batch.id, workspaceId },
      /* Accounts before categories. Nothing here depends on that today, but a
         later phase that imports records does, and the order costs nothing. */
      orderBy: [{ kind: 'asc' }, { usageCount: 'desc' }],
    });

    for (const item of items) {
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

    await this.prisma.migrationBatch.update({
      where: { id: batch.id },
      data: { status: 'APPLIED', appliedAt: new Date() },
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
      decision: string;
      targetType: string | null;
      targetId: string | null;
      sourcePayload: Prisma.JsonValue;
      targetDetail: Prisma.JsonValue;
    },
    timezone: string,
  ): Promise<void> {
    const payload = (item.sourcePayload ?? {}) as Record<string, unknown>;
    const detail = (item.targetDetail ?? {}) as MigrationDetail;
    const done = (data: Prisma.MigrationItemUpdateInput): Promise<unknown> =>
      this.prisma.migrationItem.update({ where: { id: item.id }, data });

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
        where: { workspaceId, deletedAt: null, name: item.sourceName },
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
          name: item.sourceName,
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
          planName: item.sourceName,
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
          insurer: item.sourceName,
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

    /* Money owed, either way round.
     *
     * An account, not a `Loan` record. A loan posts a disbursement transaction,
     * and this knows neither the principal nor which account the money moved
     * through — writing one would be inventing entries in somebody's books. An
     * account of the right type puts the debt or the credit on the balance
     * sheet with nothing made up, and the loan proper can be recorded against
     * it later.
     *
     * Both directions, because offering only one pushes everything somebody is
     * owed into the expense column: money lent reads as spending and never
     * comes back when it is repaid. */
    const owedType =
      item.decision === 'LIABILITY'
        ? 'LIABILITY'
        : item.decision === 'RECEIVABLE'
          ? 'RECEIVABLE'
          : null;

    if (owedType) {
      const clashing = await this.prisma.account.findFirst({
        where: { workspaceId, deletedAt: null, name: item.sourceName },
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
          name: item.sourceName,
          type: owedType,
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

    const clash = await this.prisma.category.findFirst({
      where: {
        workspaceId,
        deletedAt: null,
        OR: [{ name: item.sourceName }, { nameBn: item.sourceName }],
      },
      select: { id: true },
    });
    if (clash) {
      await done({ skippedReason: 'একই নামে খাত আগে থেকেই আছে' });
      return;
    }

    /* Re-checked rather than trusted: the parent was valid when it was chosen,
       and a category deleted in between would otherwise put this one at the top
       level without anybody being told the shape had changed. Refusing the row
       is the honest answer — it can be made by hand, and a wrong place in the
       tree is the kind of thing nobody notices for a year. */
    if (item.targetId) {
      const parent = await this.prisma.category.findFirst({
        where: { id: item.targetId, workspaceId, deletedAt: null },
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
        name: item.sourceName,
        nameBn: item.sourceName,
        kind: item.targetType === 'INCOME' ? 'INCOME' : 'EXPENSE',
        parentId: item.targetId,
      },
    });
    await done({ createdEntityId: created.id, createdEntityKind: 'Category', skippedReason: null });
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
    const batch = await this.requireBatch(workspaceId, batchId, 'APPLIED');
    const items = await this.prisma.migrationItem.findMany({
      where: { batchId: batch.id, workspaceId, NOT: { createdEntityId: null } },
    });

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

    await this.prisma.migrationBatch.update({
      where: { id: batch.id },
      data: { status: 'ROLLED_BACK', rolledBackAt: now },
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
