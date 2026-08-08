import type { DatePreference, ImportColumn } from '@hishab/core';
import { formatLedgerDate, fromLocalDateString, toBengaliDigits } from '@hishab/shared';

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

export const bnNum = (value: number | string): string => toBengaliDigits(String(value));

/**
 * The contract says YYYY-MM-DD, but an ISO timestamp — or anything else — must
 * not take the screen down: `fromLocalDateString` throws on any other shape.
 */
export function bnDate(value: string | null | undefined): string {
  if (!value) return '—';
  const iso = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return toBengaliDigits(String(value));
  try {
    return formatLedgerDate(fromLocalDateString(iso));
  } catch {
    return toBengaliDigits(String(value));
  }
}

/** "৭ আগস্ট ২০২৬, ৩:০৫ PM" — history needs the time of day to be readable. */
export function bnDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const day = bnDate(value);
  const stamp = new Date(value);
  if (Number.isNaN(stamp.getTime())) return day;
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(stamp);
  return `${day}, ${toBengaliDigits(time)}`;
}

/** Bytes as something a person reads, in Bengali digits. */
export function bnBytes(bytes: number): string {
  if (bytes < 1024) return `${bnNum(bytes)} বাইট`;
  const kb = Math.trunc(bytes / 1024);
  if (kb < 1024) return `${bnNum(kb)} কেবি`;
  const mb = Math.trunc(kb / 102) / 10;
  return `${bnNum(mb)} এমবি`;
}
