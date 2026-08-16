/**
 * The bridge between the mapping dropdowns and `@hishab/core`.
 *
 * There is no parsing in this file. Reading a delimited file, guessing the
 * columns, reading an ambiguous date, turning a record into a ledger row and
 * deciding what is a duplicate all happen in `@hishab/core/import`, which is
 * the same module the API runs. That is the whole point: two implementations of
 * the dedupe rule drift, and the first symptom is this screen promising to skip
 * a row the server then imports.
 *
 * What is left here is presentation — the UI thinks in "column 3 is the date",
 * core thinks in `{ date: { index: 2 } }`.
 */

import type { ColumnMapping, ImportColumn } from '@hishab/core';
import { roleLabel, type ColumnRole } from './labels';

/* -------------------------------------------------------------------------
 * Roles ⇄ core's ColumnMapping
 * ---------------------------------------------------------------------- */

/** Which roles are a column of the file rather than our "leave it out". */
const isColumn = (role: ColumnRole): role is ImportColumn => role !== 'ignore';

/** One role per header, for the dropdowns. */
export function rolesFromMapping(mapping: ColumnMapping, headers: readonly string[]): ColumnRole[] {
  const roles: ColumnRole[] = headers.map(() => 'ignore');
  for (const [column, match] of Object.entries(mapping)) {
    if (match && match.index >= 0 && match.index < roles.length) {
      roles[match.index] = column as ImportColumn;
    }
  }
  return roles;
}

/**
 * The dropdowns back into a `ColumnMapping`.
 *
 * First column wins when two carry the same role, which is what
 * `mappingProblems` warns about — core's own guesser is one-to-one, so this
 * only arises when a person picks the same thing twice.
 */
export function mappingFromRoles(
  roles: readonly ColumnRole[],
  headers: readonly string[],
): ColumnMapping {
  const mapping: ColumnMapping = {};
  roles.forEach((role, index) => {
    if (!isColumn(role) || mapping[role]) return;
    mapping[role] = { index, header: (headers[index] ?? '').trim(), confidence: 100 };
  });
  return mapping;
}

/**
 * Trouble with the mapping itself, said once at the top rather than repeated on
 * five hundred rows. `blocking` mirrors the two mapping errors `buildRows`
 * refuses to run without; `warnings` only explain what we are about to do.
 */
export function mappingProblems(
  roles: readonly ColumnRole[],
  mapping: ColumnMapping,
): { blocking: string[]; warnings: string[] } {
  const blocking: string[] = [];
  const warnings: string[] = [];

  if (!mapping.date) blocking.push('তারিখের কলাম বেছে নিন।');
  if (!mapping.amount && !mapping.debit && !mapping.credit) {
    blocking.push('টাকার অঙ্কের কলাম বেছে নিন — অথবা ডেবিট ও ক্রেডিট আলাদা করে দেখান।');
  }

  const counted = new Map<ColumnRole, number>();
  for (const role of roles) {
    if (isColumn(role)) counted.set(role, (counted.get(role) ?? 0) + 1);
  }
  for (const [role, count] of counted) {
    if (count > 1) {
      warnings.push(`একাধিক কলামকে “${roleLabel(role)}” ধরা হয়েছে — প্রথমটিই ব্যবহার হবে।`);
    }
  }

  if (mapping.account) {
    warnings.push(
      'অ্যাকাউন্টের কলামটি পড়া হবে, তবে ব্যবহার হবে না — এক ইমপোর্টের সব সারি উপরে বেছে নেওয়া একটি অ্যাকাউন্টেই যাবে।',
    );
  }

  return { blocking, warnings };
}

/* -------------------------------------------------------------------------
 * One row, ready to render
 * ---------------------------------------------------------------------- */

export interface DisplayRow {
  key: string;
  lineNumber: number;
  date: string | null;
  description: string;
  reference: string | null;
  categoryName: string | null;
  /** Signed for display only — money out is negative. The wire keeps core's form. */
  amountMinor: number | null;
  /** Why this row cannot be imported, in Bengali, straight from core. */
  problem: string | null;
  duplicate: boolean;
}

/* Building the rows themselves moved to `review.ts` when the preview became a
 * row-by-row approval rather than a summary. There is no second copy of the
 * parsing here or there: both call `@hishab/core`, which is what the API runs. */
