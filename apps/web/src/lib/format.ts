'use client';

import {
  DEFAULT_TIMEZONE,
  formatLedgerDate,
  fromLocalDateString,
  toBengaliDigits,
  type Locale,
} from '@hishab/shared';

/**
 * Digits, dates and clocks, in the language the books are read in.
 *
 * ## Why a module-level locale and not a hook
 *
 * There were ten near-identical copies of `bnDate`/`bnDateTime`/`bnClock`/
 * `bnNum` — one each in loans, inbox, mail, admin, audit, people, plans and
 * more — and about a hundred and seventy call sites between them, most of them
 * deep inside render bodies and helper functions that are not components. A
 * hook would have meant editing every one of those call sites and threading a
 * formatter through the functions that are not components at all.
 *
 * So the locale lives here, in one variable, and the formatters read it. The
 * two things that usually make that a bad idea are handled:
 *
 * - **A stale first paint.** The value is seeded synchronously from
 *   localStorage at module load, the same trick `THEME_BOOT` in the root layout
 *   uses for the dark palette and for the same reason: `/auth/me` resolves
 *   after the first frame, so anything waiting for it flashes the wrong answer.
 * - **A stale render after a change.** Nothing subscribes to this variable, so
 *   React would not re-render on a change. The language switch therefore
 *   reloads the page rather than mutating in place. A once-a-year action is
 *   allowed to cost a reload; a screen half in each language is not.
 *
 * `setActiveLocale` is called from `LocaleSync`, which reads the same cached
 * `['me']` query everything else does.
 */

const STORAGE_KEY = 'hishab.locale';

/** Bengali until something says otherwise — right for nearly every workspace. */
let activeLocale: Locale = 'bn';

/* Seeded at module load, before the first component renders. Wrapped because
   this module is imported by server components' children during SSR, where
   there is no localStorage and no reader to be wrong for. */
if (typeof window !== 'undefined') {
  try {
    if (window.localStorage.getItem(STORAGE_KEY) === 'en') activeLocale = 'en';
  } catch {
    /* Private mode, or storage disabled. Bengali is the right default. */
  }
}

export function getActiveLocale(): Locale {
  return activeLocale;
}

/**
 * Record the workspace's language.
 *
 * Returns true when this *changed* the answer, so the caller can decide whether
 * a reload is needed. It never reloads on its own: doing so inside a setter
 * would make a first-load sync — where the stored value simply had not been
 * written yet — indistinguishable from a deliberate switch.
 */
export function setActiveLocale(next: Locale): boolean {
  const changed = next !== activeLocale;
  activeLocale = next;
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* Nothing to do. The formatters still work for this session. */
    }
  }
  return changed;
}

/** `১২৩` or `123`. Everything that is not a digit passes through untouched. */
export function fmtNumber(value: number | string): string {
  const text = String(value);
  return activeLocale === 'en' ? text : toBengaliDigits(text);
}

/**
 * A `YYYY-MM-DD` from the API, as a date somebody can read.
 *
 * The contract says `YYYY-MM-DD`, but a stray ISO timestamp must not take a
 * screen down — `fromLocalDateString` throws on anything else. Every one of the
 * ten copies of this function had that guard; it is kept exactly.
 */
export function fmtDate(value: string | null | undefined): string {
  if (!value) return '—';
  const iso = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return fmtNumber(value);
  try {
    return formatLedgerDate(fromLocalDateString(iso), activeLocale);
  } catch {
    return fmtNumber(value);
  }
}

/** A `Date` rather than an ISO string — the dashboard's "today", and the like. */
export function fmtDateObject(date: Date): string {
  return formatLedgerDate(date, activeLocale);
}

/** "৭ আগস্ট ২০২৬, ১১:০৫" / "7 Aug 2026, 11:05". */
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return fmtNumber(iso);
  return `${formatLedgerDate(when, activeLocale)}, ${fmtClock(iso)}`;
}

/** Just the clock, for rows whose date is obvious from the group above. */
export function fmtClock(iso: string | null | undefined): string {
  if (!iso) return '';
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return '';
  /* Always `en-GB` and always 24-hour: the *format* is a house style, and only
     the digits follow the reader. A 12-hour clock would change what the string
     means, not merely how it is spelled. */
  const clock = new Intl.DateTimeFormat('en-GB', {
    timeZone: DEFAULT_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(when);
  return fmtNumber(clock);
}

/**
 * An ISO *timestamp* as a date, for the screens whose rows are events rather
 * than ledger days — the operator's tenant list, the audit trail.
 *
 * Separate from `fmtDate` because the input is different, not because the
 * output is: that one is handed `YYYY-MM-DD` from the API's date columns and
 * resolves it in the ledger's timezone, this one is handed a full instant.
 * Collapsing the two would silently shift an event recorded just after
 * midnight UTC onto the previous day.
 */
export function fmtStamp(value: string | null | undefined): string {
  if (!value) return '—';
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return fmtNumber(value);
  return formatLedgerDate(at, activeLocale);
}

/** "১৪:০৫" in the ledger's timezone. `—` rather than `''` where a row needs one. */
export function fmtTime(value: string | null | undefined): string {
  if (!value) return '—';
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return '—';
  return fmtClock(value);
}

/** Date and 24-hour clock, from an ISO timestamp. */
export function fmtStampTime(value: string | null | undefined): string {
  if (!value) return '—';
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return fmtNumber(value);
  return `${formatLedgerDate(at, activeLocale)}, ${fmtClock(value)}`;
}

/**
 * Date and a 12-hour clock — "৭ আগস্ট ২০২৬, ৩:০৫ PM".
 *
 * Kept apart from the 24-hour pair rather than unified. The import history is
 * the one screen a person reads to answer "did I already upload this?", and it
 * has always shown the time the way a phone's file list does. Changing that
 * while changing the digits would make one indistinguishable from the other if
 * anybody complained about either.
 */
export function fmtDateTime12(value: string | null | undefined): string {
  if (!value) return '—';
  const day = fmtDate(value);
  const stamp = new Date(value);
  if (Number.isNaN(stamp.getTime())) return day;
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: DEFAULT_TIMEZONE,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(stamp);
  return `${day}, ${fmtNumber(time)}`;
}

/**
 * `YYYY-MM-DD` or a bare `YYYY-MM`, whichever the audit entry carried.
 *
 * A reminder cycle is a month, so the month form drops the day rather than
 * inventing the first of it.
 */
export function fmtDateish(value: string): string {
  const iso = value.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    try {
      return formatLedgerDate(fromLocalDateString(iso), activeLocale);
    } catch {
      return fmtNumber(value);
    }
  }
  if (/^\d{4}-\d{2}$/.test(value)) {
    try {
      return formatLedgerDate(fromLocalDateString(`${value}-01`), activeLocale).replace(
        /^\S+\s/,
        '',
      );
    } catch {
      return fmtNumber(value);
    }
  }
  return fmtNumber(value);
}
