import { createHash } from 'node:crypto';
import { BadRequestException, Injectable, PayloadTooLargeException } from '@nestjs/common';
import {
  buildRows,
  guessDatePreference,
  type ColumnMapping,
  type DatePreference,
  type ImportDirection,
  type RowError,
} from '@hishab/core';
import { fromLocalDateString, toBengaliDigits, toLocalDateString } from '@hishab/shared';
import type { ImportStatus, TransactionSource } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { minorToNumber } from '../common/bigint-json';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../transactions/transactions.service';
import { ImportService, type LimitSnapshot } from './import.service';
import {
  findTableStart,
  preambleOf,
  readStatement,
  type StatementFormat,
} from './statement-reader';

/**
 * A statement in whatever format it arrived, read and checked against the books.
 *
 * This service does the two things the old CSV-only preview could not:
 *
 *  1. **It opens PDFs and Excel workbooks**, via `statement-reader.ts`, and
 *     hands back the same grid of strings a CSV produces — so the client can go
 *     on re-parsing live as the user corrects a column, exactly as it does now.
 *  2. **It says which rows might already be in the books**, and stops there.
 *
 * ## The second one is the point of the feature
 *
 * In Bangladesh a transaction reaches these books by two independent routes. A
 * bank or wallet sends an SMS and it is recorded the same minute; or it sends
 * nothing at all and the only record is the statement, weeks later. Nobody
 * knows which transactions took which route, so every statement is part
 * already-entered and part missing, and the person uploading it has no way to
 * tell the halves apart by eye.
 *
 * So each parsed row is compared against what is recorded — **same amount, same
 * date, same account** — and every match is *reported*, with the existing entry
 * attached so it can be looked at. Nothing is skipped, nothing is merged,
 * nothing is hidden.
 *
 * ## Why it may only ever say "possible"
 *
 * Because somebody really can withdraw ৳500 twice on the same day. There is no
 * amount of matching that can distinguish that from one withdrawal recorded
 * twice, and a feature that quietly dropped the second one would be silently
 * deleting a real transaction from somebody's books. The app surfaces the
 * suspicion and the person decides — which they can, because they were there.
 *
 * ## Why the date is exact
 *
 * A window of a day either side would catch the late-night payment that posts
 * the next morning, and it was considered. It was left out because widening it
 * roughly triples the number of flagged rows on a busy account — a month of
 * daily ৳500 withdrawals would flag every one of them against its neighbours —
 * and a warning that fires on everything is a warning nobody reads. Exact is
 * also what can be explained in one sentence on screen, which matters more than
 * the marginal catch.
 */

/** Binary formats compress, so the cap is on the upload rather than on its text. */
export const MAX_STATEMENT_BYTES = 8 * 1024 * 1024;

/** Rows handed back for review. The same ceiling one commit can write. */
export const MAX_STATEMENT_ROWS = 2_000;

/** Existing entries listed against one row before the list is cut short. */
const MAX_MATCHES_PER_ROW = 5;

const MAX_REPORTED_ERRORS = 200;

const bn = (value: number): string => toBengaliDigits(value.toLocaleString('en-US'));

// --- views -------------------------------------------------------------------

/** One transaction already in the books that a statement row could be. */
export interface DuplicateMatch {
  transactionId: string;
  /** `YYYY-MM-DD` in the workspace's timezone. */
  date: string;
  /** Positive integer poisha. */
  amountMinor: number;
  direction: ImportDirection;
  description: string | null;
  reference: string | null;
  accountId: string;
  accountName: string;
  /** MANUAL, SMS, IMPORT… — "where did this come from" is the first question. */
  source: TransactionSource;
  createdAt: string;
}

export interface RowMatches {
  /** The spreadsheet row this is about, same numbering the review screen shows. */
  lineNumber: number;
  matches: DuplicateMatch[];
  /** Matches beyond the cap, counted rather than listed. */
  moreCount: number;
}

/** Which accounts the comparison covered. Said on screen, because it changes the answer. */
export type DuplicateScope = 'ACCOUNT' | 'ALL_ACCOUNTS';

export interface DuplicateReport {
  scope: DuplicateScope;
  accountId: string | null;
  rows: RowMatches[];
  /** How many rows got at least one match. */
  flaggedRows: number;
}

export interface StatementPreview {
  filename: string;
  fileHash: string;
  format: StatementFormat;
  /** Every tab in a workbook, so a different one can be asked for. */
  sheetNames: string[];
  sheetName: string | null;
  pageCount: number | null;
  /** Bengali, when there is something about the reading worth saying. */
  note: string | null;

  /** The table, heading row first. This is what the client re-parses. */
  grid: string[][];
  gridTruncated: boolean;
  /** Which row of the original file the heading was; `null` when none was found. */
  headerRow: number | null;
  /** The letterhead above the table, kept as context rather than as errors. */
  preamble: string[];

  headers: string[];
  mapping: ColumnMapping;
  datePreference: DatePreference;
  datePreferenceConfident: boolean;

  totalRows: number;
  parsedRows: number;
  errorRows: number;
  errors: RowError[];
  errorsTruncated: boolean;

  duplicates: DuplicateReport;

  alreadyImported: {
    batchId: string;
    filename: string;
    createdAt: string;
    status: ImportStatus;
  } | null;
  limit: LimitSnapshot;
}

/** What a re-check of the duplicates needs to know about one row. */
export interface DuplicateProbe {
  lineNumber: number;
  /** `YYYY-MM-DD`. */
  date: string;
  /** Positive integer poisha. */
  amountMinor: number;
}

// --- service -----------------------------------------------------------------

@Injectable()
export class StatementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly imports: ImportService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Read an uploaded statement and say what is in it. Writes nothing.
   *
   * The whole grid goes back, not a twenty-row sample, because the review
   * screen approves row by row and cannot approve rows it has never been shown.
   */
  async preview(
    ctx: TenantContext,
    input: {
      filename: string;
      bytes: Buffer;
      accountId?: string;
      datePreference?: DatePreference;
      sheet?: string;
    },
  ): Promise<StatementPreview> {
    if (input.bytes.length > MAX_STATEMENT_BYTES) {
      throw new PayloadTooLargeException(
        `ফাইলটি খুব বড় — সর্বোচ্চ ${bn(MAX_STATEMENT_BYTES / (1024 * 1024))} মেগাবাইট পর্যন্ত নেওয়া যায়`,
      );
    }
    if (input.bytes.length === 0) throw new BadRequestException('ফাইলটি খালি');

    const read = await readStatement(input.bytes, { sheet: input.sheet });
    if (read.grid.length === 0) {
      throw new BadRequestException('ফাইলটিতে পড়ার মতো কিছু পাওয়া গেল না');
    }

    /* Finding the heading needs a date convention and choosing the convention
     * needs the heading, so the search runs on day-first — which is what this
     * ledger's world writes — or on whatever the caller has already settled.
     * The circularity is harmless: `findTableStart` is looking for the row that
     * yields the most parseable rows below it, and a table read the wrong way
     * round still parses further than the bank's address does. The convention
     * is then guessed properly from the date column alone, a few lines down. */
    const found = findTableStart(read.grid, input.datePreference ?? 'DMY');
    const headerRow = found.headerRow;

    const table = headerRow === null ? read.grid : read.grid.slice(headerRow);
    const mapping = headerRow === null ? {} : found.mapping;
    const headers = (table[0] ?? []).map((cell) => cell.trim());

    const dateColumn =
      mapping.date === undefined
        ? []
        : table.slice(1).map((record) => record[mapping.date?.index ?? 0] ?? '');
    const guessed = guessDatePreference(dateColumn);
    const datePreference = input.datePreference ?? guessed.preference;

    const { rows, errors } =
      headerRow === null
        ? { rows: [], errors: [] as RowError[] }
        : buildRows(table, mapping, { datePreference });

    const duplicates = await this.duplicates(
      ctx,
      input.accountId ?? null,
      rows.map((row) => ({
        lineNumber: row.lineNumber,
        date: row.date,
        amountMinor: row.amountMinor,
      })),
    );

    const fileHash = createHash('sha256').update(input.bytes).digest('hex');
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
        format: read.format,
        rowCount: Math.max(0, table.length - 1),
        parsedRows: rows.length,
        errorRows: errors.length,
        flaggedRows: duplicates.flaggedRows,
      },
    });

    const gridTruncated = table.length - 1 > MAX_STATEMENT_ROWS;

    return {
      filename: input.filename,
      fileHash,
      format: read.format,
      sheetNames: read.sheetNames,
      sheetName: read.sheetName,
      pageCount: read.pageCount,
      note: read.note,

      grid: gridTruncated ? table.slice(0, MAX_STATEMENT_ROWS + 1) : table,
      gridTruncated,
      headerRow,
      preamble: headerRow === null ? [] : preambleOf(read.grid, headerRow),

      headers,
      mapping,
      datePreference,
      datePreferenceConfident: input.datePreference !== undefined || guessed.confident,

      totalRows: Math.max(0, table.length - 1),
      parsedRows: rows.length,
      errorRows: errors.length,
      errors: errors.slice(0, MAX_REPORTED_ERRORS),
      errorsTruncated: errors.length > MAX_REPORTED_ERRORS,

      duplicates,

      alreadyImported: previous
        ? {
            batchId: previous.id,
            filename: previous.filename,
            createdAt: previous.createdAt.toISOString(),
            status: previous.status,
          }
        : null,
      limit: await this.imports.limitSnapshot(ctx),
    };
  }

  /**
   * Which of these rows might already be in the books.
   *
   * **The rule, in full: same amount, same date, same account.** Nothing about
   * the description is considered and nothing about the direction is required —
   * both are shown, neither filters. A statement's wording is the bank's, an
   * SMS's wording is the gateway's, and they agree on nothing but the number;
   * and a parser that read a debit column as a credit is exactly the mistake a
   * person needs to be shown, not the one that should hide the match.
   *
   * Every match found is returned. Not one row is removed, reordered or altered
   * on the strength of it — this method's entire output is a warning.
   */
  async duplicates(
    ctx: TenantContext,
    accountId: string | null,
    probes: readonly DuplicateProbe[],
  ): Promise<DuplicateReport> {
    const scope: DuplicateScope = accountId ? 'ACCOUNT' : 'ALL_ACCOUNTS';
    if (probes.length === 0) {
      return { scope, accountId, rows: [], flaggedRows: 0 };
    }

    let earliest = probes[0]!.date;
    let latest = probes[0]!.date;
    const amounts = new Set<number>();
    for (const probe of probes) {
      if (probe.date < earliest) earliest = probe.date;
      if (probe.date > latest) latest = probe.date;
      amounts.add(probe.amountMinor);
    }

    /* Only the days the file covers and only the amounts it names. Both bounds
     * matter on a workspace with years of history: without the amount filter
     * this reads every entry of every day in the statement's range, which for a
     * twelve-month statement is the whole ledger. */
    const from = fromLocalDateString(earliest, ctx.timezone);
    const to = new Date(fromLocalDateString(latest, ctx.timezone).getTime() + 86_400_000);

    const entries = await this.prisma.ledgerEntry.findMany({
      where: {
        workspaceId: ctx.workspaceId,
        /* With no account chosen yet, every real account is considered and the
         * response says so. That is the safe direction — it can only surface
         * *more* possibilities, and every one of them is a question, not an
         * action. */
        ...(accountId ? { accountId } : { account: { systemKey: null } }),
        amountMinor: { in: [...amounts].map((value) => BigInt(value)) },
        transaction: { deletedAt: null, date: { gte: from, lt: to } },
      },
      select: {
        accountId: true,
        direction: true,
        amountMinor: true,
        account: { select: { name: true } },
        transaction: {
          select: {
            id: true,
            date: true,
            createdAt: true,
            description: true,
            externalRef: true,
            source: true,
          },
        },
      },
      /* A ceiling, so a pathological statement cannot ask for the whole ledger.
       * Well past anything real: 2,000 rows each matching five existing
       * entries. */
      take: MAX_STATEMENT_ROWS * MAX_MATCHES_PER_ROW * 2,
    });

    /* Keyed on exactly the rule, so the lookup below cannot drift from the
     * sentence in the doc comment. */
    const byKey = new Map<string, DuplicateMatch[]>();
    const seen = new Set<string>();

    for (const entry of entries) {
      /* A transfer touches two real accounts and a split can touch one twice.
       * Either way the same transaction on the same account is one candidate,
       * not two — the person is being asked "is this that one?". */
      const identity = `${entry.transaction.id}|${entry.accountId}`;
      if (seen.has(identity)) continue;
      seen.add(identity);

      const date = toLocalDateString(entry.transaction.date, ctx.timezone);
      const amountMinor = minorToNumber(entry.amountMinor);
      const key = `${date}|${amountMinor}`;

      const match: DuplicateMatch = {
        transactionId: entry.transaction.id,
        date,
        amountMinor,
        // DEBIT on an account is money arriving, whatever the account type.
        direction: entry.direction === 'DEBIT' ? 'IN' : 'OUT',
        description: entry.transaction.description,
        reference: entry.transaction.externalRef,
        accountId: entry.accountId,
        accountName: entry.account.name,
        source: entry.transaction.source,
        createdAt: entry.transaction.createdAt.toISOString(),
      };

      const bucket = byKey.get(key);
      if (bucket) bucket.push(match);
      else byKey.set(key, [match]);
    }

    for (const bucket of byKey.values()) {
      // Oldest first: the entry that was there before the statement was.
      bucket.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    }

    /* Only the rows with something to say. A clean statement of two thousand
     * rows would otherwise send back two thousand empty answers, and "no match"
     * is already what the absence of an entry means. */
    const rows: RowMatches[] = [];
    for (const probe of probes) {
      const found = byKey.get(`${probe.date}|${probe.amountMinor}`);
      if (!found || found.length === 0) continue;
      rows.push({
        lineNumber: probe.lineNumber,
        matches: found.slice(0, MAX_MATCHES_PER_ROW),
        moreCount: Math.max(0, found.length - MAX_MATCHES_PER_ROW),
      });
    }

    return { scope, accountId, rows, flaggedRows: rows.length };
  }
}
