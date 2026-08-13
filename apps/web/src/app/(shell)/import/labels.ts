import type { DatePreference, ImportColumn } from '@hishab/core';

/**
 * What a spreadsheet column can be.
 *
 * One entry per `ImportColumn` in `@hishab/core`, plus `IGNORE` — which is a
 * real answer and not a missing one, since most bank exports carry two or three
 * columns nobody wants. The names are core's, so a mapping made here is exactly
 * a `ColumnMapping` and there is no translation table to drift.
 */
export type ColumnRole = ImportColumn | 'ignore';

export const ROLES: readonly (readonly [ColumnRole, string])[] = [
  ['date', 'তারিখ'],
  ['description', 'বিবরণ'],
  ['debit', 'ডেবিট'],
  ['credit', 'ক্রেডিট'],
  ['amount', 'টাকার অঙ্ক'],
  ['balance', 'স্থিতি'],
  ['reference', 'রেফারেন্স'],
  ['category', 'ক্যাটাগরি'],
  ['account', 'অ্যাকাউন্ট'],
  ['ignore', 'বাদ দিন'],
];

export function roleLabel(role: ColumnRole): string {
  return ROLES.find(([value]) => value === role)?.[1] ?? role;
}

/** dd/mm/yyyy or mm/dd/yyyy — `03/04/2026` is two different days. */
export const DATE_PREFERENCES: readonly (readonly [DatePreference, string])[] = [
  ['DMY', 'দিন/মাস/বছর (০৩/০৪/২০২৬ = ৩ এপ্রিল)'],
  ['MDY', 'মাস/দিন/বছর (০৩/০৪/২০২৬ = ৪ মার্চ)'],
];

export const BATCH_STATUS_LABEL: Record<string, string> = {
  PENDING: 'অপেক্ষমাণ',
  APPLIED: 'যোগ হয়েছে',
  REVERTED: 'ফিরিয়ে নেওয়া হয়েছে',
  FAILED: 'ব্যর্থ',
};

/* One implementation, in `lib/format.ts`, which follows the workspace's
   language. There were ten near-identical copies of these across the app and
   every one of them hardcoded Bengali digits. The old names are re-exported so
   the call sites in this folder stay as they are. */
import { fmtDate as bnDate, fmtDateTime12 as bnDateTime, fmtNumber as bnNum } from '@/lib/format';

export { bnDate, bnDateTime, bnNum };

/** Bytes as something a person reads, in Bengali digits. */
export function bnBytes(bytes: number): string {
  if (bytes < 1024) return `${bnNum(bytes)} বাইট`;
  const kb = Math.trunc(bytes / 1024);
  if (kb < 1024) return `${bnNum(kb)} কেবি`;
  const mb = Math.trunc(kb / 102) / 10;
  return `${bnNum(mb)} এমবি`;
}
