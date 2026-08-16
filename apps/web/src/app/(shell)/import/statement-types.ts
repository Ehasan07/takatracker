/**
 * The shipped shapes of `/v1/import/statement*`, mirroring
 * `apps/api/src/import/statement.service.ts`.
 *
 * Kept beside `types.ts` rather than inside it because the two endpoints answer
 * different questions and one of them is new: `/import/preview` reads a CSV and
 * summarises it, `/import/statement` reads anything and hands back every row so
 * a person can approve them one at a time.
 */

import type { ColumnMapping, DatePreference, ImportDirection, RowError } from '@hishab/core';
import type { ImportStatus, LimitSnapshot } from './types';

export type StatementFormat = 'CSV' | 'XLSX' | 'PDF';

/** One transaction already in the books that a statement row could be. */
export interface DuplicateMatch {
  transactionId: string;
  date: string;
  amountMinor: number;
  direction: ImportDirection;
  description: string | null;
  reference: string | null;
  accountId: string;
  accountName: string;
  /** MANUAL, SMS, IMPORT… — the first thing anybody wants to know. */
  source: string;
  createdAt: string;
}

export interface RowMatches {
  lineNumber: number;
  matches: DuplicateMatch[];
  /** Matches past the cap, counted rather than listed. */
  moreCount: number;
}

/**
 * Which accounts the comparison covered.
 *
 * `ALL_ACCOUNTS` means no account had been chosen yet, so a match may be in a
 * different account entirely. Said on screen, because it changes what the
 * warning means.
 */
export type DuplicateScope = 'ACCOUNT' | 'ALL_ACCOUNTS';

export interface DuplicateReport {
  scope: DuplicateScope;
  accountId: string | null;
  /** Only the rows that matched something. An absent row matched nothing. */
  rows: RowMatches[];
  flaggedRows: number;
}

export interface StatementPreview {
  filename: string;
  fileHash: string;
  format: StatementFormat;
  /** Every tab in a workbook, so another one can be asked for. */
  sheetNames: string[];
  sheetName: string | null;
  pageCount: number | null;
  /** Bengali, when there is something about the reading worth saying. */
  note: string | null;

  /** The table, heading row first. This is what the screen re-parses. */
  grid: string[][];
  gridTruncated: boolean;
  headerRow: number | null;
  /** The letterhead above the table, as context rather than as errors. */
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
