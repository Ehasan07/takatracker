import type { Direction, DraftStatus, IngestionChannel, RejectReason } from './types';

/* One implementation, in `lib/format.ts`, which follows the workspace's
   language. There were ten near-identical copies of these across the app and
   every one of them hardcoded Bengali digits. The old names are re-exported so
   the call sites in this folder stay as they are. */
import { fmtDate as bnDate, fmtDateTime as bnDateTime, fmtNumber as bnNum } from '@/lib/format';

export { bnDate, bnDateTime, bnNum };

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
  /* Named for what it is rather than for taka. The whole point of the field is
     that the message was in some other money. */
  fxAmountMinor: 'বার্তায় লেখা মূল অঙ্ক',
  direction: 'কোন দিকে গেল',
  date: 'তারিখ',
  payee: 'কার সাথে',
  balanceMinor: 'বার্তায় লেখা জের',
  accountHint: 'অ্যাকাউন্টের সূত্র',
};

/** The same names again, short enough to sit on a highlight inside the message. */
export const FIELD_TAG: Record<string, string> = {
  amountMinor: 'টাকা',
  fxAmountMinor: 'মূল অঙ্ক',
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
  /* The same tint as the amount it stands in for: to a reader it is the amount,
     and giving it a colour of its own would suggest a second figure. */
  fxAmountMinor: 'bg-brass/25 decoration-brass',
  direction: 'bg-income/20 decoration-income',
  date: 'bg-ink/10 decoration-ink-muted',
  balanceMinor: 'bg-greenbar decoration-ink-muted',
  payee: 'bg-brass/12 decoration-brass',
  accountHint: 'bg-income/10 decoration-income',
};

export function fieldTint(field: string): string {
  return FIELD_TINT[field] ?? 'bg-greenbar decoration-ink-muted';
}
