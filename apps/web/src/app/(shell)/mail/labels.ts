import {
  DEFAULT_TIMEZONE,
  formatLedgerDate,
  fromLocalDateString,
  toBengaliDigits,
} from '@hishab/shared';
import type { MailAccountStatus, MailFolder } from './types';

export const bnNum = (value: number | string): string => toBengaliDigits(String(value));

/**
 * The contract says `YYYY-MM-DD`, but a stray ISO timestamp must not take the
 * screen down: `fromLocalDateString` throws on anything else.
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

/** "৭ আগস্ট ২০২৬, ১১:০৫" — when the message reached the mailbox. */
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

/** Just the clock, for rows whose date is already obvious from the group above. */
export function bnClock(iso: string | null | undefined): string {
  if (!iso) return '';
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return '';
  return toBengaliDigits(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: DEFAULT_TIMEZONE,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(when),
  );
}

/**
 * The four folders the worker knows how to fill.
 *
 * There is deliberately no "সব" tab. The store key is
 * `(mailAccountId, folder, externalId)`, and Gmail reports one message under
 * both `\Inbox` and `\All` — which this API maps to `INBOX` and `ARCHIVE`. An
 * unfiltered list would therefore show a Gmail user every message twice, and
 * looking like a duplication bug is worse than one more tab.
 */
export const FOLDERS: readonly (readonly [MailFolder, string])[] = [
  ['INBOX', 'ইনবক্স'],
  ['SENT', 'পাঠানো'],
  ['DRAFTS', 'খসড়া'],
  ['ARCHIVE', 'আর্কাইভ'],
];

export const FOLDER_LABEL: Record<MailFolder, string> = {
  INBOX: 'ইনবক্স',
  SENT: 'পাঠানো',
  DRAFTS: 'খসড়া',
  ARCHIVE: 'আর্কাইভ',
};

/**
 * Status in the user's language.
 *
 * `AUTH_FAILED` says *stopped*, not *failed*. A mailbox in that state is not
 * being retried — deliberately, so a rejected password is not presented to
 * Google ninety-six times a day — and a label that only implied an error would
 * leave somebody waiting for mail that is never coming.
 */
export const STATUS_LABEL: Record<MailAccountStatus, string> = {
  ACTIVE: 'সচল',
  AUTH_FAILED: 'সিঙ্ক বন্ধ',
  DISABLED: 'বন্ধ করা আছে',
};

export function statusLabel(status: string): string {
  return STATUS_LABEL[status as MailAccountStatus] ?? status;
}

/**
 * How often the worker sweeps, in minutes.
 *
 * The API does not publish this — `MAIL_SYNC_INTERVAL_MS` is a server
 * environment variable and `POST /:id/sync` only reports the wait for *that*
 * request. Fifteen is the shipped default, and every sentence built on it below
 * says "আনুমানিক" for exactly that reason.
 */
export const SWEEP_MINUTES = 15;

/** "৳" of time: minutes, or hours once minutes stop being readable. */
export function bnDuration(minutes: number): string {
  if (minutes < 1) return 'এক মিনিটের কম';
  if (minutes < 60) return `${bnNum(minutes)} মিনিট`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${bnNum(hours)} ঘণ্টা`;
  return `${bnNum(Math.floor(hours / 24))} দিন`;
}

/**
 * Seconds, for the 202 body's `estimatedSeconds`.
 *
 * Rounded up, not to nearest. Every duration on this screen is a promise about
 * when something will happen, and the only comfortable direction to be wrong in
 * is "sooner than we said".
 */
export function bnSeconds(seconds: number): string {
  if (seconds < 60) return `${bnNum(seconds)} সেকেন্ড`;
  return bnDuration(Math.ceil(seconds / 60));
}

/**
 * When this mailbox was last read, and roughly when it will be read next.
 *
 * `now` is passed in rather than read from the clock so that nothing here runs
 * during server rendering — a relative time computed in `render()` hydrates to a
 * different string a second later and React complains, rightly.
 */
export function lastSyncLine(lastSyncAt: string | null): string {
  if (!lastSyncAt) return 'এখনো একবারও সিঙ্ক হয়নি';
  return `শেষ সিঙ্ক ${bnDateTime(lastSyncAt)}`;
}

export function nextSweepLine(
  status: MailAccountStatus,
  lastSyncAt: string | null,
  now: number | null,
): string | null {
  if (status === 'AUTH_FAILED') return 'নতুন পাসওয়ার্ড না দেওয়া পর্যন্ত আর সিঙ্ক হবে না';
  if (status === 'DISABLED') return 'বন্ধ আছে, তাই সিঙ্ক হচ্ছে না';
  if (now === null) return null;
  if (!lastSyncAt) return 'প্রথম সিঙ্কের অপেক্ষায়';

  const last = new Date(lastSyncAt).getTime();
  if (Number.isNaN(last)) return null;

  const dueIn = Math.ceil((last + SWEEP_MINUTES * 60_000 - now) / 60_000);
  if (dueIn <= 0) return 'পরের সিঙ্ক যেকোনো সময়';
  return `পরের সিঙ্ক আনুমানিক ${bnDuration(dueIn)} পর`;
}
