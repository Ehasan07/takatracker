import { createHash } from 'node:crypto';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import {
  assertBalanced,
  buildRows,
  dedupeKeysFor,
  describeBreach,
  detectDelimiter,
  expandSimpleTransaction,
  guessDatePreference,
  guessMapping,
  isWithinLimit,
  limitFor,
  markDuplicates,
  parseDelimited,
  type ColumnMapping,
  type DatePreference,
  type DedupeSource,
  type EntryDraft,
  type ImportDirection,
  type ParsedRow,
  type RowError,
} from '@hishab/core';
import {
  fromLocalDateString,
  toBengaliDigits,
  toLocalDateString,
  type CategoryKind,
} from '@hishab/shared';
import type { ImportStatus, Prisma } from '@prisma/client';
import { AccountsService } from '../accounts/accounts.service';
import { AuditService } from '../audit/audit.service';
import { minorToNumber } from '../common/bigint-json';
import { EntitlementsService, FeatureLimitException } from '../entitlements/entitlements.service';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../transactions/transactions.service';
import type { CommitImportInput } from './import.controller';

/**
 * Spreadsheet import.
 *
 * All the difficult reading lives in `@hishab/core`'s `import.ts`, which is
 * pure and heavily tested; this file is the part that touches a database. It
 * does three things core cannot:
 *
 *  1. **Says no before it says yes.** Size, row count and the monthly
 *     transaction entitlement are all checked up front, because a 402 halfway
 *     through two hundred rows would leave somebody's books in a state they did
 *     not ask for and cannot easily undo.
 *  2. **Knows what is already in the books.** Core states the deduplication
 *     rule; this file builds the "already there" side of the comparison from
 *     the ledger — through `dedupeKeysFor`, the very same function, so the two
 *     sides can never drift.
 *  3. **Writes the whole thing or none of it.** One `$transaction` covers the
 *     batch row and every transaction in it.
 *
 * Preview writes nothing to the ledger. It records an `import.uploaded` audit
 * event and stops there — no `ImportBatch` row, which is why a batch is created
 * already `APPLIED` and the schema's `PENDING` state is never persisted: a
 * batch that exists is a batch that landed.
 *
 * Audit actions emitted here, all three already declared in AUDIT_ACTIONS:
 *   'import.uploaded', 'import.applied', 'import.reverted'
 */

/** 2 MiB of text. About 20,000 statement lines; far more than the row cap. */
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

/** How many records `preview` will read out of one file. */
export const MAX_PREVIEW_ROWS = 5_000;

/**
 * How many rows one commit may write.
 *
 * Every row is an insert inside a single interactive transaction, so this is a
 * ceiling on how long that transaction holds its locks. Splitting a year of
 * statements into a few files is a mild annoyance; a ten-minute write that
 * blocks everything else is not.
 */
export const MAX_COMMIT_ROWS = 2_000;

/** Rows sent back in the preview grid. Enough to see the shape of the file. */
const PREVIEW_SAMPLE_SIZE = 20;

/** Errors returned in full. Past this the count still tells the whole truth. */
const MAX_REPORTED_ERRORS = 200;

/** Skipped duplicates listed individually in the commit response. */
const MAX_REPORTED_SKIPS = 200;

const COMMIT_TIMEOUT_MS = 120_000;
const COMMIT_MAX_WAIT_MS = 15_000;

const CURRENCY = 'BDT';

const bn = (value: number): string => toBengaliDigits(value.toLocaleString('en-US'));

// --- views -------------------------------------------------------------------

export type PreviewRow = ParsedRow & { dedupeKey: string; isDuplicate: boolean };

export interface LimitSnapshot {
  featureKey: 'transactions.monthly.max';
  /** null means unlimited. */
  limit: number | null;
  used: number;
  /** null means unlimited. */
  remaining: number | null;
}

export interface ImportPreview {
  filename: string;
  /** SHA-256 of the uploaded text, so the same file twice can be spotted. */
  fileHash: string;
  /** The separator that was detected: ',', ';' or a tab. */
  delimiter: string;
  headers: string[];
  mapping: ColumnMapping;
  datePreference: DatePreference;
  /** False when the file itself never proved which convention it uses. */
  datePreferenceConfident: boolean;
  /** Data records in the file, header excluded. */
  totalRows: number;
  /** Records that parsed into something the ledger could accept. */
  parsedRows: number;
  /** Of those, how many are already in the books. */
  duplicateRows: number;
  /** Records that could not be read at all; see `errors`. */
  errorRows: number;
  /** What a commit would actually write. */
  importableRows: number;
  sample: PreviewRow[];
  errors: RowError[];
  errorsTruncated: boolean;
  /** A previous batch with the same bytes, if this exact file was imported. */
  alreadyImported: {
    batchId: string;
    filename: string;
    createdAt: string;
    status: ImportStatus;
  } | null;
  limit: LimitSnapshot;
}

export interface ImportBatchView {
  id: string;
  filename: string;
  fileHash: string;
  mapping: Prisma.JsonValue;
  rowCount: number;
  importedCount: number;
  skippedCount: number;
  status: ImportStatus;
  /** Transactions from this batch that are still live, for an honest history. */
  liveCount: number;
  createdAt: string;
  appliedAt: string | null;
  revertedAt: string | null;
}

export interface CommitResult {
  batchId: string;
  status: ImportStatus;
  /** Rows offered. */
  rowCount: number;
  importedCount: number;
  skippedCount: number;
  /** Which rows were skipped and why, capped. */
  skipped: { lineNumber: number; date: string; amountMinor: number; reason: string }[];
  skippedTruncated: boolean;
}

export interface RevertResult {
  id: string;
  status: ImportStatus;
  revertedCount: number;
}

// --- service -----------------------------------------------------------------

@Injectable()
export class ImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountsService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Read the file and say what would happen. Nothing is written to the ledger.
   *
   * The date convention is guessed from the file where the file gives it away —
   * a single `19/01/2026` settles it — and reported with a `confident` flag so
   * the UI knows whether to ask. Guessing wrong here is the one mistake that
   * silently misfiles a whole statement, which is why it is surfaced rather
   * than buried.
   */
  async preview(
    ctx: TenantContext,
    input: { filename: string; text: string; datePreference?: DatePreference },
  ): Promise<ImportPreview> {
    const text = input.text;
    if (Buffer.byteLength(text, 'utf8') > MAX_IMPORT_BYTES) {
      throw new PayloadTooLargeException(
        `ফাইলটি খুব বড় — সর্বোচ্চ ${bn(MAX_IMPORT_BYTES / (1024 * 1024))} মেগাবাইট পর্যন্ত নেওয়া যায়`,
      );
    }

    const grid = parseDelimited(text);
    if (grid.length === 0) throw new BadRequestException('ফাইলটি খালি');
    if (grid.length - 1 > MAX_PREVIEW_ROWS) {
      throw new BadRequestException(
        `একবারে সর্বোচ্চ ${bn(MAX_PREVIEW_ROWS)}টি সারি পড়া যায় — ফাইলটি ভাগ করে নিন`,
      );
    }

    const headers = (grid[0] ?? []).map((h) => h.trim());
    const mapping = guessMapping(headers);

    /* Only the date column is sampled, and only its numeric rows carry any
     * evidence. An explicit preference from the caller always wins: the second
     * pass through this endpoint is the user telling us we guessed wrong. */
    const dateColumn =
      mapping.date === undefined
        ? []
        : grid.slice(1).map((record) => record[mapping.date?.index ?? 0] ?? '');
    const guessed = guessDatePreference(dateColumn);
    const datePreference = input.datePreference ?? guessed.preference;

    const { rows, errors } = buildRows(grid, mapping, { datePreference });

    const existingKeys = await this.existingKeys(ctx, null, rows);
    const marked = markDuplicates(rows, existingKeys);
    const duplicateRows = marked.filter((row) => row.isDuplicate).length;

    const fileHash = ImportService.hash(text);
    const previous = await this.prisma.importBatch.findFirst({
      where: { workspaceId: ctx.workspaceId, fileHash, status: { not: 'REVERTED' } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, filename: true, createdAt: true, status: true },
    });

    this.audit.emit({
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.id,
      action: 'import.uploaded',
      entity: 'ImportBatch',
      after: {
        filename: input.filename,
        fileHash,
        rowCount: Math.max(0, grid.length - 1),
        parsedRows: rows.length,
        errorRows: errors.length,
      },
    });

    return {
      filename: input.filename,
      fileHash,
      delimiter: detectFromGrid(text),
      headers,
      mapping,
      datePreference,
      datePreferenceConfident: input.datePreference !== undefined || guessed.confident,
      totalRows: Math.max(0, grid.length - 1),
      parsedRows: rows.length,
      duplicateRows,
      errorRows: errors.length,
      importableRows: rows.length - duplicateRows,
      sample: marked.slice(0, PREVIEW_SAMPLE_SIZE),
      errors: errors.slice(0, MAX_REPORTED_ERRORS),
      errorsTruncated: errors.length > MAX_REPORTED_ERRORS,
      alreadyImported: previous
        ? {
            batchId: previous.id,
            filename: previous.filename,
            createdAt: previous.createdAt.toISOString(),
            status: previous.status,
          }
        : null,
      limit: await this.limitSnapshot(ctx),
    };
  }

  /**
   * Write the rows the user accepted, as one batch, in one database
   * transaction.
   *
   * The rows come back from the client rather than being re-read from the file,
   * and that is deliberate: the preview grid is editable, and the whole point
   * of showing somebody their data before it lands is to let them fix the row
   * the parser got wrong. They are validated at the controller (integer poisha,
   * ISO date, a direction) and every referenced row is workspace-checked here.
   */
  async commit(ctx: TenantContext, input: CommitImportInput): Promise<CommitResult> {
    if (input.rows.length === 0) throw new BadRequestException('আমদানি করার মতো কোনো সারি নেই');
    if (input.rows.length > MAX_COMMIT_ROWS) {
      throw new BadRequestException(
        `একবারে সর্বোচ্চ ${bn(MAX_COMMIT_ROWS)}টি সারি আমদানি করা যায় — ফাইলটি ভাগ করে নিন`,
      );
    }

    const account = await this.requireAccount(ctx.workspaceId, input.accountId);

    /* Line numbers ride along so a skip can be reported against the row the
     * user is looking at, but they are the client's numbering and are never
     * trusted for anything but display. */
    const rows: (DedupeSource & {
      lineNumber: number;
      description: string;
      categoryName: string | null;
      categoryId: string | null;
      acceptDuplicate: boolean;
    })[] = input.rows.map((row, index) => ({
      lineNumber: row.lineNumber ?? index + 2,
      date: row.date,
      direction: row.direction,
      amountMinor: row.amountMinor,
      reference: row.reference ?? null,
      description: row.description ?? '',
      categoryName: row.categoryName ?? null,
      categoryId: row.categoryId ?? null,
      acceptDuplicate: row.acceptDuplicate ?? false,
    }));

    const existingKeys = await this.existingKeys(ctx, account.id, rows);
    const marked = markDuplicates(rows, existingKeys);

    /**
     * A row the user was shown as a possible duplicate and approved anyway is
     * written. That is the whole difference between the two ways into this
     * endpoint, and it is deliberate.
     *
     * The CSV flow sends a whole file at once, nobody has looked at the rows
     * one by one, and skipping what is already in the books is the only safe
     * default — a row wrongly skipped is reported and can be added by hand,
     * whereas a row wrongly doubled is invisible for weeks.
     *
     * The statement review flow is the opposite situation: every row on that
     * screen was flagged, shown beside the entry it matched, and individually
     * approved by somebody who knows whether they withdrew ৳500 once or twice.
     * Overriding that decision here would make the approval a lie. So the flag
     * only ever arrives on a row a person has actually decided about, and when
     * it does, their answer wins.
     */
    const accepted = marked.filter((row) => !row.isDuplicate || row.acceptDuplicate);
    const skipped = marked.filter((row) => row.isDuplicate && !row.acceptDuplicate);

    if (accepted.length === 0) {
      throw new BadRequestException(
        `এই সারিগুলো আগে থেকেই হিসাবে আছে — নতুন করে কিছু আমদানি করার নেই (${bn(skipped.length)}টি বাদ)`,
      );
    }

    /* Checked against the whole batch, not one row at a time. Half an import is
     * worse than none: the user cannot tell which half landed. */
    await this.assertRoomFor(ctx, accepted.length);

    const system = await this.accounts.systemAccounts(ctx.workspaceId);
    const categoryIds = await this.categoryResolver(ctx.workspaceId);

    const batch = await this.prisma.$transaction(
      async (tx) => {
        const created = await tx.importBatch.create({
          data: {
            workspaceId: ctx.workspaceId,
            createdByUserId: ctx.id,
            filename: input.filename,
            fileHash: input.fileHash ?? '',
            /* Kept so the next import of the same export can reuse it, which is
             * the reason the column exists (see schema.prisma §ImportBatch). */
            mapping: {
              columns: input.mapping ?? {},
              datePreference: input.datePreference,
              accountId: account.id,
            } as unknown as Prisma.InputJsonValue,
            rowCount: input.rows.length,
            importedCount: accepted.length,
            skippedCount: skipped.length,
            /* Created already APPLIED. The whole batch is written inside this
             * one transaction, so a row in this table can only ever mean the
             * import succeeded — there is no moment at which a PENDING batch
             * would be visible to anybody. */
            status: 'APPLIED',
            appliedAt: new Date(),
          },
        });

        for (const row of accepted) {
          const type = row.direction === 'IN' ? 'INCOME' : 'EXPENSE';
          const categoryId = categoryIds(row.categoryId, row.categoryName, row.direction);
          const entries = expandSimpleTransaction(
            {
              type,
              amountMinor: row.amountMinor,
              accountId: account.id,
              categoryId,
              currency: CURRENCY,
            },
            system,
          );
          // Belt and braces: the engine says it balances, the DB trigger will too.
          assertBalanced(entries);

          await tx.transaction.create({
            data: {
              workspaceId: ctx.workspaceId,
              createdByUserId: ctx.id,
              date: fromLocalDateString(row.date, ctx.timezone),
              type,
              description: row.description === '' ? null : row.description,
              externalRef: row.reference,
              source: 'IMPORT',
              importBatchId: created.id,
              entries: { create: entries.map((e) => ImportService.entryData(e, ctx.workspaceId)) },
            },
          });
        }

        return created;
      },
      { timeout: COMMIT_TIMEOUT_MS, maxWait: COMMIT_MAX_WAIT_MS },
    );

    this.audit.emit({
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.id,
      action: 'import.applied',
      entity: 'ImportBatch',
      entityId: batch.id,
      after: {
        filename: input.filename,
        accountId: account.id,
        rowCount: input.rows.length,
        importedCount: accepted.length,
        skippedCount: skipped.length,
      },
    });

    return {
      batchId: batch.id,
      status: batch.status,
      rowCount: input.rows.length,
      importedCount: accepted.length,
      skippedCount: skipped.length,
      skipped: skipped.slice(0, MAX_REPORTED_SKIPS).map((row) => ({
        lineNumber: row.lineNumber,
        date: row.date,
        amountMinor: row.amountMinor,
        reason: 'এই লেনদেনটি আগে থেকেই হিসাবে আছে',
      })),
      skippedTruncated: skipped.length > MAX_REPORTED_SKIPS,
    };
  }

  /** The history, newest first. */
  async batches(ctx: TenantContext, limit = 50): Promise<ImportBatchView[]> {
    const rows = await this.prisma.importBatch.findMany({
      where: { workspaceId: ctx.workspaceId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: Math.min(200, Math.max(1, limit)),
      include: { _count: { select: { transactions: true } } },
    });

    /* `_count.transactions` counts every row the batch ever wrote, deleted ones
     * included, so the live figure is asked for separately. A batch whose rows
     * were deleted by hand should not still claim to hold 200 transactions. */
    const live = await this.prisma.transaction.groupBy({
      by: ['importBatchId'],
      where: {
        workspaceId: ctx.workspaceId,
        deletedAt: null,
        importBatchId: { in: rows.map((r) => r.id) },
      },
      _count: { _all: true },
    });
    const liveById = new Map(live.map((g) => [g.importBatchId, g._count._all]));

    return rows.map((row) => ({
      id: row.id,
      filename: row.filename,
      fileHash: row.fileHash,
      mapping: row.mapping,
      rowCount: row.rowCount,
      importedCount: row.importedCount,
      skippedCount: row.skippedCount,
      status: row.status,
      liveCount: liveById.get(row.id) ?? 0,
      createdAt: row.createdAt.toISOString(),
      appliedAt: row.appliedAt?.toISOString() ?? null,
      revertedAt: row.revertedAt?.toISOString() ?? null,
    }));
  }

  /**
   * Undo a whole import in one action.
   *
   * This is why batches exist. Somebody who maps a column wrong and lands two
   * hundred rows in the wrong account needs one button, not two hundred
   * deletions — and the deletion is soft, exactly like every other reversal in
   * the ledger, so the rows stay for sync and for anyone reading the history.
   */
  async revert(ctx: TenantContext, id: string): Promise<RevertResult> {
    const batch = await this.prisma.importBatch.findFirst({
      where: { id, workspaceId: ctx.workspaceId },
    });
    // A batch id from another workspace is a 404, never a hint that it exists.
    if (!batch) throw new NotFoundException('ইমপোর্ট ব্যাচ পাওয়া যায়নি');
    if (batch.status === 'REVERTED') {
      throw new BadRequestException('এই ইমপোর্টটি আগেই ফিরিয়ে নেওয়া হয়েছে');
    }

    const revertedAt = new Date();
    const revertedCount = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.transaction.updateMany({
        where: { workspaceId: ctx.workspaceId, importBatchId: batch.id, deletedAt: null },
        data: { deletedAt: revertedAt },
      });
      await tx.importBatch.update({
        where: { id: batch.id },
        data: { status: 'REVERTED', revertedAt },
      });
      return count;
    });

    this.audit.emit({
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.id,
      action: 'import.reverted',
      entity: 'ImportBatch',
      entityId: batch.id,
      before: { status: batch.status, importedCount: batch.importedCount },
      after: { status: 'REVERTED', revertedCount },
    });

    return { id: batch.id, status: 'REVERTED', revertedCount };
  }

  // --- guards and helpers ------------------------------------------------------

  private async requireAccount(
    workspaceId: string,
    accountId: string,
  ): Promise<{ id: string; name: string }> {
    const account = await this.prisma.account.findFirst({
      where: { id: accountId, workspaceId, deletedAt: null, systemKey: null },
      select: { id: true, name: true, isArchived: true },
    });
    if (!account) throw new NotFoundException('অ্যাকাউন্ট পাওয়া যায়নি');
    if (account.isArchived) {
      throw new BadRequestException('আর্কাইভ করা অ্যাকাউন্টে লেনদেন আমদানি করা যায় না');
    }
    return { id: account.id, name: account.name };
  }

  /**
   * The "already in the books" side of the deduplication comparison.
   *
   * Only the days the incoming file actually covers are read, and only the
   * ledger entries touching the account being imported into — a statement for
   * one bank account has nothing to say about what is in the cash box. With no
   * account yet chosen (the preview) every account is considered, which is the
   * safe direction: it can only flag *more* rows as already present, and the
   * preview is a warning, not a write.
   *
   * `DEBIT` on the account is money arriving and `CREDIT` is money leaving,
   * whatever the account type — the same convention `signedEffect` uses in
   * @hishab/core, so a credit card purchase reads as OUT.
   */
  private async existingKeys(
    ctx: TenantContext,
    accountId: string | null,
    rows: readonly DedupeSource[],
  ): Promise<Set<string>> {
    if (rows.length === 0) return new Set();

    let earliest = rows[0]!.date;
    let latest = rows[0]!.date;
    for (const row of rows) {
      if (row.date < earliest) earliest = row.date;
      if (row.date > latest) latest = row.date;
    }

    const from = fromLocalDateString(earliest, ctx.timezone);
    const to = new Date(fromLocalDateString(latest, ctx.timezone).getTime() + 86_400_000);

    const entries = await this.prisma.ledgerEntry.findMany({
      where: {
        workspaceId: ctx.workspaceId,
        ...(accountId ? { accountId } : { account: { systemKey: null } }),
        transaction: { deletedAt: null, date: { gte: from, lt: to } },
      },
      select: {
        direction: true,
        amountMinor: true,
        transaction: {
          select: { id: true, date: true, createdAt: true, description: true, externalRef: true },
        },
      },
    });

    /* Sorted before numbering, because occurrence is part of the key: the same
     * rows in a different order would produce a different set and a re-import
     * would stop matching. */
    entries.sort((a, b) => {
      const byDate = a.transaction.date.getTime() - b.transaction.date.getTime();
      if (byDate !== 0) return byDate;
      const byCreated = a.transaction.createdAt.getTime() - b.transaction.createdAt.getTime();
      if (byCreated !== 0) return byCreated;
      return a.transaction.id < b.transaction.id ? -1 : 1;
    });

    const sources: DedupeSource[] = entries.map((entry) => ({
      date: toLocalDateString(entry.transaction.date, ctx.timezone),
      direction: (entry.direction === 'DEBIT' ? 'IN' : 'OUT') satisfies ImportDirection,
      amountMinor: minorToNumber(entry.amountMinor),
      reference: entry.transaction.externalRef,
      description: entry.transaction.description,
    }));

    return new Set(dedupeKeysFor(sources));
  }

  /**
   * Settle which category a row lands in.
   *
   * Two ways in, and the order between them matters:
   *
   *  1. **An id the user chose**, from the review screen's per-row picker. It
   *     is still checked — the workspace must own it and the kind must agree —
   *     but a person who was shown a list and pointed at a row in it has said
   *     something exact, and a name match cannot tell two "অন্যান্য" apart when
   *     they sit under different parents.
   *  2. **A name out of the file**, matched against what the workspace already
   *     has. Matched, never created: an import that invents twenty categories
   *     out of a bank's free-text column leaves a picker nobody can use, and
   *     those are the bank's words, not the user's. An unmatched name simply
   *     leaves the row uncategorised, which is fixable in bulk afterwards.
   *
   * The kind has to agree either way — money coming in cannot be filed under an
   * expense head, however well the name matches or however firmly it was
   * clicked.
   */
  private async categoryResolver(
    workspaceId: string,
  ): Promise<
    (id: string | null, name: string | null, direction: ImportDirection) => string | null
  > {
    const categories = await this.prisma.category.findMany({
      where: { workspaceId, deletedAt: null },
      select: { id: true, name: true, nameBn: true, kind: true },
    });

    const byName = new Map<string, string>();
    const kindById = new Map<string, CategoryKind>();
    const key = (kind: CategoryKind, name: string): string =>
      `${kind}:${name.normalize('NFC').trim().toLowerCase()}`;

    for (const category of categories) {
      kindById.set(category.id, category.kind);
      for (const label of [category.name, category.nameBn]) {
        if (!label) continue;
        const k = key(category.kind, label);
        if (!byName.has(k)) byName.set(k, category.id);
      }
    }

    return (id, name, direction) => {
      const kind: CategoryKind = direction === 'IN' ? 'INCOME' : 'EXPENSE';
      if (id && kindById.get(id) === kind) return id;
      if (!name) return null;
      return byName.get(key(kind, name)) ?? null;
    };
  }

  /** Would `count` more transactions this month still be inside the plan? */
  private async assertRoomFor(ctx: TenantContext, count: number): Promise<void> {
    const [entitlements, usage] = await Promise.all([
      this.entitlements.forWorkspace(ctx.workspaceId),
      this.entitlements.usage(ctx.workspaceId, ctx.timezone),
    ]);

    const used = usage['transactions.monthly.max'] ?? 0;
    if (isWithinLimit(entitlements, 'transactions.monthly.max', used, count)) return;

    /* 402, in the same shape every other limit in the app throws, so the client
     * that already understands one understands this. The preview reports the
     * headroom in advance precisely so nobody reaches this by surprise. */
    const breach = describeBreach(entitlements, 'transactions.monthly.max', used);
    if (breach) throw new FeatureLimitException(breach);
  }

  /** Public because the statement preview reports the same headroom. */
  async limitSnapshot(ctx: TenantContext): Promise<LimitSnapshot> {
    const [entitlements, usage] = await Promise.all([
      this.entitlements.forWorkspace(ctx.workspaceId),
      this.entitlements.usage(ctx.workspaceId, ctx.timezone),
    ]);
    const limit = limitFor(entitlements, 'transactions.monthly.max');
    const used = usage['transactions.monthly.max'] ?? 0;
    return {
      featureKey: 'transactions.monthly.max',
      limit,
      used,
      remaining: limit === null ? null : Math.max(0, limit - used),
    };
  }

  private static entryData(
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

  /**
   * SHA-256 of the uploaded text. Not a security boundary — it exists so the
   * same file offered twice can be recognised before it doubles anybody's
   * books, which is the schema's stated reason for the column.
   */
  private static hash(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex');
  }
}

/** The separator core settled on, reported back so the UI can say so. */
function detectFromGrid(text: string): string {
  const firstLine = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/, 1)[0] ?? '';
  return detectDelimiter(firstLine);
}
