/**
 * The model behind the row-by-row review.
 *
 * Everything here is pure, so the interesting decisions — what starts ticked,
 * what a flagged row does, what is actually sent — can be read and tested
 * without a browser. `page.tsx` holds the state and this holds the rules.
 *
 * The parsing is not here and never will be: `@hishab/core` reads the grid,
 * exactly as it does for the CSV flow and exactly as the API does. Two
 * implementations of "what is in this file" drift, and the first symptom would
 * be this screen showing a row the server then refuses.
 */

import {
  buildRows,
  type ColumnMapping,
  type DatePreference,
  type ImportDirection,
} from '@hishab/core';
import type { CategoryDto } from '@/lib/api';
import type { DuplicateMatch, DuplicateReport } from './statement-types';
import type { CommitRow } from './transport';

/**
 * What a person has actually said about one row — and only that.
 *
 * Both halves are optional because absence is meaningful: a row nobody has
 * touched follows the default, and the default can change under it when the
 * duplicate check is re-run against a different account. A row somebody
 * *did* touch keeps their answer through all of that, which is the whole
 * reason this is a sparse map of overrides rather than a copy of every row's
 * state.
 */
export interface RowDecision {
  approved?: boolean;
  /** `''` means no category — a real answer, not a missing one. */
  categoryId?: string;
}

export interface ReviewRowModel {
  key: string;
  /** The row number in the file, which is what an error message will name. */
  lineNumber: number;
  date: string | null;
  description: string;
  reference: string | null;
  /** Always positive; `direction` carries the sign. Null when the row is broken. */
  amountMinor: number | null;
  direction: ImportDirection;
  /** Why this line could not be read, in Bengali, straight from core. */
  problem: string | null;
  /** Entries already in the books that this row might be. Never acted on. */
  matches: DuplicateMatch[];
  moreCount: number;
  approved: boolean;
  categoryId: string;
}

export interface ReviewCounts {
  /** Rows that parsed into something the ledger could accept. */
  readable: number;
  /** Of those, ticked. */
  approved: number;
  /** Of those, flagged as a possible duplicate. */
  flagged: number;
  /** Lines that could not be read at all. */
  broken: number;
  /** Ticked rows that carry a duplicate warning — the ones the server is told about. */
  approvedFlagged: number;
}

export interface Review {
  rows: ReviewRowModel[];
  counts: ReviewCounts;
  /** Signed total of the ticked rows, for the confirmation line. */
  netMinor: number;
}

/**
 * Match the file's own category text to a real category, the same way the
 * server would.
 *
 * Only so the picker opens on the right row. The commit sends the id, so this
 * is a convenience and never the thing that decides where a row lands.
 */
function categoryIdFor(
  name: string | null,
  direction: ImportDirection,
  categories: readonly CategoryDto[],
): string {
  if (!name) return '';
  const wanted = name.normalize('NFC').trim().toLowerCase();
  const kind = direction === 'IN' ? 'INCOME' : 'EXPENSE';
  const found = categories.find(
    (category) =>
      category.kind === kind &&
      [category.name, category.nameBn].some(
        (label) => (label ?? '').normalize('NFC').trim().toLowerCase() === wanted,
      ),
  );
  return found?.id ?? '';
}

/**
 * Whether a row starts ticked, before anybody touches it.
 *
 * Ticked, unless it carries a duplicate warning. That exception is the whole
 * safety property of this screen: if a flagged row started ticked, the default
 * action on an ambiguous row would be to double it, and the mistake this
 * feature exists to prevent would be one press away. Unticking something
 * wrongly ticked is one tap and visible; a doubled entry is neither.
 */
export function approvedByDefault(matches: readonly DuplicateMatch[]): boolean {
  return matches.length === 0;
}

/**
 * The grid, the mapping and the server's duplicate report into one list.
 *
 * Rows and unreadable lines are interleaved in file order, because the person
 * has the statement open beside the screen and is reading down it. A line that
 * could not be read is shown in its place rather than banished to a footnote —
 * silently dropping it is how somebody discovers three months later that four
 * transactions never arrived.
 */
export function buildReview(
  grid: readonly (readonly string[])[],
  mapping: ColumnMapping,
  datePreference: DatePreference,
  duplicates: DuplicateReport,
  categories: readonly CategoryDto[],
  decisions: ReadonlyMap<number, RowDecision>,
): Review {
  const { rows, errors } = buildRows(grid, mapping, { datePreference });

  const matchesByLine = new Map(duplicates.rows.map((row) => [row.lineNumber, row]));

  const parsed: ReviewRowModel[] = rows.map((row) => {
    const found = matchesByLine.get(row.lineNumber);
    const matches = found?.matches ?? [];
    const said = decisions.get(row.lineNumber);
    return {
      key: `r${row.lineNumber}`,
      lineNumber: row.lineNumber,
      date: row.date,
      description: row.description,
      reference: row.reference,
      amountMinor: row.amountMinor,
      direction: row.direction,
      problem: null,
      matches,
      moreCount: found?.moreCount ?? 0,
      approved: said?.approved ?? approvedByDefault(matches),
      categoryId: said?.categoryId ?? categoryIdFor(row.categoryName, row.direction, categories),
    };
  });

  /* Line 1 errors are about the mapping, not about a row — "no date column
     chosen" is one problem with the file and belongs above the list, not
     repeated five hundred times inside it. */
  const broken: ReviewRowModel[] = errors
    .filter((error) => error.lineNumber > 1)
    .map((error, index) => ({
      key: `e${error.lineNumber}-${index}`,
      lineNumber: error.lineNumber,
      date: null,
      description: error.value,
      reference: null,
      amountMinor: null,
      direction: 'OUT' as const,
      problem: error.message,
      matches: [],
      moreCount: 0,
      approved: false,
      categoryId: '',
    }));

  const all = [...parsed, ...broken].sort((a, b) => a.lineNumber - b.lineNumber);

  const counts: ReviewCounts = {
    readable: parsed.length,
    approved: parsed.filter((row) => row.approved).length,
    flagged: parsed.filter((row) => row.matches.length > 0).length,
    broken: broken.length,
    approvedFlagged: parsed.filter((row) => row.approved && row.matches.length > 0).length,
  };

  const netMinor = parsed.reduce(
    (total, row) =>
      row.approved
        ? total + (row.direction === 'OUT' ? -(row.amountMinor ?? 0) : (row.amountMinor ?? 0))
        : total,
    0,
  );

  return { rows: all, counts, netMinor };
}

/** What the duplicate re-check needs, out of the rows that actually parsed. */
export function probesFrom(
  rows: readonly ReviewRowModel[],
): { lineNumber: number; date: string; amountMinor: number }[] {
  return rows
    .filter((row) => row.problem === null && row.date !== null && row.amountMinor !== null)
    .map((row) => ({
      lineNumber: row.lineNumber,
      date: row.date as string,
      amountMinor: row.amountMinor as number,
    }));
}

/**
 * The approved rows, in the shape `/import/commit` takes.
 *
 * `acceptDuplicate` is set only where there was in fact a warning, so it can
 * never mean anything except "this person saw the warning and said yes". Sent
 * blanket-true on every row it would be a switch that turns the server's own
 * duplicate check off, which is not what it is for.
 */
export function toApprovedRows(rows: readonly ReviewRowModel[]): CommitRow[] {
  return rows
    .filter((row) => row.approved && row.problem === null && row.date !== null)
    .map((row) => ({
      lineNumber: row.lineNumber,
      date: row.date as string,
      description: row.description,
      amountMinor: row.amountMinor ?? 0,
      direction: row.direction,
      reference: row.reference,
      categoryName: null,
      categoryId: row.categoryId === '' ? null : row.categoryId,
      ...(row.matches.length > 0 ? { acceptDuplicate: true } : {}),
    }));
}
