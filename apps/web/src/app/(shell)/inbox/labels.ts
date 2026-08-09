import {
  DEFAULT_TIMEZONE,
  formatLedgerDate,
  fromLocalDateString,
  toBengaliDigits,
} from '@hishab/shared';
import type { Direction, DraftStatus, IngestionChannel, RejectReason } from './types';

export const bnNum = (value: number | string): string => toBengaliDigits(String(value));

/**
 * The contract says YYYY-MM-DD, but an ISO timestamp must not take the screen
 * down: `fromLocalDateString` throws on anything else.
 */
export function bnDate(value: string | null | undefined): string {
  if (!value) return '—';
  const iso = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return toBengaliDigits(value);
  try {
    return formatLedgerDate(fromLocalDateString(iso));
  } catch {
    return toBengaliDigits(value);
  }
}

/** "৭ আগস্ট ২০২৬, ১১:০৫" — when the message reached the phone. */
export function bnDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return toBengaliDigits(iso);
  const clock = new Intl.DateTimeFormat('en-GB', {
    timeZone: DEFAULT_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(when);
  return `${formatLedgerDate(when)}, ${toBengaliDigits(clock)}`;
}

export const STATUS_LABEL: Record<DraftStatus, string> = {
  PENDING: 'যাচাইয়ের অপেক্ষায়',
  ACCEPTED: 'খাতায় যোগ হয়েছে',
  REJECTED: 'বাতিল করা হয়েছে',
  DUPLICATE: 'একই বার্তা',
};

export function statusLabel(status: string): string {
  return STATUS_LABEL[status as DraftStatus] ?? status;
}

/** '' is "everything" — the API reads a missing or empty status as no filter. */
export const STATUS_FILTERS: readonly (readonly [string, string])[] = [
  ['PENDING', 'যাচাইয়ের অপেক্ষায়'],
  ['', 'সব'],
  ['ACCEPTED', 'যোগ হয়েছে'],
  ['REJECTED', 'বাতিল'],
  ['DUPLICATE', 'একই বার্তা'],
];

export const DIRECTIONS: readonly (readonly [Direction, string])[] = [
  ['IN', 'টাকা ঢুকেছে'],
  ['OUT', 'টাকা বেরিয়েছে'],
];

export const DIRECTION_LABEL: Record<Direction, string> = {
  IN: 'টাকা ঢুকেছে',
  OUT: 'টাকা বেরিয়েছে',
};

export const CHANNEL_LABEL: Record<IngestionChannel, string> = {
  SMS: 'এসএমএস',
  EMAIL: 'ইমেইল',
  WEBHOOK: 'ওয়েবহুক',
};

export function channelLabel(channel: string | null | undefined): string {
  if (!channel) return 'বার্তা';
  return CHANNEL_LABEL[channel as IngestionChannel] ?? channel;
}

export const REJECT_REASONS: readonly (readonly [RejectReason, string])[] = [
  ['BAD_PARSE', 'ভুলভাবে পড়া হয়েছে'],
  ['DUPLICATE', 'এই লেনদেন আগেই খাতায় আছে'],
  ['NOT_MINE', 'এটি আমার লেনদেন নয়'],
  ['OTHER', 'অন্য কারণ'],
];

/**
 * The parser's field names in the user's language. `balanceMinor` and
 * `accountHint` are read out of the message but have nowhere to go on a draft —
 * they are shown as context, never as something to accept.
 */
export const FIELD_LABEL: Record<string, string> = {
  amountMinor: 'টাকার পরিমাণ',
  direction: 'কোন দিকে গেল',
  date: 'তারিখ',
  payee: 'কার সাথে',
  balanceMinor: 'বার্তায় লেখা জের',
  accountHint: 'অ্যাকাউন্টের সূত্র',
};

/** The same names again, short enough to sit on a highlight inside the message. */
export const FIELD_TAG: Record<string, string> = {
  amountMinor: 'টাকা',
  direction: 'দিক',
  date: 'তারিখ',
  payee: 'নাম',
  balanceMinor: 'জের',
  accountHint: 'অ্যাকাউন্ট',
};

export function fieldLabel(field: string): string {
  return FIELD_LABEL[field] ?? field;
}

export function fieldTag(field: string): string {
  return FIELD_TAG[field] ?? field;
}

/**
 * A tint per field, so two figures in one message are told apart at a glance.
 * Never the only signal: every highlight also carries its name in text.
 */
export const FIELD_TINT: Record<string, string> = {
  amountMinor: 'bg-brass/25 decoration-brass',
  direction: 'bg-income/20 decoration-income',
  date: 'bg-ink/10 decoration-ink-muted',
  balanceMinor: 'bg-greenbar decoration-ink-muted',
  payee: 'bg-brass/12 decoration-brass',
  accountHint: 'bg-income/10 decoration-income',
};

export function fieldTint(field: string): string {
  return FIELD_TINT[field] ?? 'bg-greenbar decoration-ink-muted';
}
