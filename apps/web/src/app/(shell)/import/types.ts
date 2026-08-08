/**
 * The shipped shapes of `/v1/import/*`, mirroring `apps/api/src/import`.
 *
 * These were guesses once and are not any more, so the multi-shape readers that
 * used to live here are gone: a boundary that quietly accepts four spellings of
 * a field also quietly hides the day the API changes one of them. The only
 * defence kept is against a missing array or a missing number, because a
 * `.map` of `undefined` takes the screen down and an older deployment is a
 * real thing.
 */

import type { ColumnMapping, DatePreference, ParsedRow, RowError } from '@hishab/core';

export type ImportStatus = 'PENDING' | 'APPLIED' | 'REVERTED';

/** A sample row: core's `ParsedRow` plus what the server knows about repeats. */
export interface PreviewRow extends ParsedRow {
  dedupeKey: string;
  isDuplicate: boolean;
}

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
  fileHash: string;
  delimiter: string;
  headers: string[];
  mapping: ColumnMapping;
  datePreference: DatePreference;
  /** False when the file itself never proved which convention it uses. */
  datePreferenceConfident: boolean;
  totalRows: number;
  parsedRows: number;
  duplicateRows: number;
  errorRows: number;
  importableRows: number;
  /** The first twenty rows only. */
  sample: PreviewRow[];
  errors: RowError[];
  errorsTruncated: boolean;
  alreadyImported: {
    batchId: string;
    filename: string;
    createdAt: string;
    status: ImportStatus;
  } | null;
  limit: LimitSnapshot;
}

export interface CommitResult {
  batchId: string;
  status: ImportStatus;
  /** Rows offered. */
  rowCount: number;
  importedCount: number;
  skippedCount: number;
  skipped: { lineNumber: number; date: string; amountMinor: number; reason: string }[];
  skippedTruncated: boolean;
}

export interface ImportBatchView {
  id: string;
  filename: string;
  fileHash: string;
  rowCount: number;
  importedCount: number;
  skippedCount: number;
  status: ImportStatus;
  /** Rows from this batch still in the books — a revert is not the only way one leaves. */
  liveCount: number;
  createdAt: string;
  appliedAt: string | null;
  revertedAt: string | null;
}

export interface RevertResult {
  id: string;
  status: ImportStatus;
  revertedCount: number;
}
