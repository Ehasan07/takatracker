/**
 * Date helpers. The user's ledger day is defined in their own timezone
 * (default Asia/Dhaka, a fixed +06:00 offset with no DST), while storage is UTC.
 */

export const DEFAULT_TIMEZONE = 'Asia/Dhaka';

/** YYYY-MM-DD in the given timezone. */
export function toLocalDateString(date: Date, timeZone: string = DEFAULT_TIMEZONE): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Offset of `timeZone` from UTC in minutes at the given instant. */
export function timezoneOffsetMinutes(date: Date, timeZone: string = DEFAULT_TIMEZONE): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second'),
  );
  return (asUtc - date.getTime()) / 60000;
}

/** Parse a YYYY-MM-DD ledger date into the UTC instant of local midnight. */
export function fromLocalDateString(dateString: string, timeZone: string = DEFAULT_TIMEZONE): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateString);
  if (!m) throw new TypeError(`Expected YYYY-MM-DD, got ${JSON.stringify(dateString)}`);
  const [, y, mo, d] = m;
  const naive = Date.UTC(Number(y), Number(mo) - 1, Number(d));
  // Correct twice: the offset itself can differ once we shift (DST-safe).
  let instant = new Date(naive - timezoneOffsetMinutes(new Date(naive), timeZone) * 60000);
  instant = new Date(naive - timezoneOffsetMinutes(instant, timeZone) * 60000);
  return instant;
}

/** First instant of the local month containing `date`. */
export function startOfMonth(date: Date, timeZone: string = DEFAULT_TIMEZONE): Date {
  const local = toLocalDateString(date, timeZone);
  return fromLocalDateString(`${local.slice(0, 7)}-01`, timeZone);
}

/** First instant of the next local month (exclusive upper bound). */
export function startOfNextMonth(date: Date, timeZone: string = DEFAULT_TIMEZONE): Date {
  const local = toLocalDateString(date, timeZone);
  const year = Number(local.slice(0, 4));
  const month = Number(local.slice(5, 7));
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return fromLocalDateString(
    `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}-01`,
    timeZone,
  );
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

export function daysBetween(a: Date, b: Date): number {
  return Math.trunc((b.getTime() - a.getTime()) / 86_400_000);
}

const BN_MONTHS = [
  'জানুয়ারি',
  'ফেব্রুয়ারি',
  'মার্চ',
  'এপ্রিল',
  'মে',
  'জুন',
  'জুলাই',
  'আগস্ট',
  'সেপ্টেম্বর',
  'অক্টোবর',
  'নভেম্বর',
  'ডিসেম্বর',
];

/** "১৫ জুলাই ২০২৬" / "15 Jul 2026" */
export function formatLedgerDate(
  date: Date,
  locale: 'bn' | 'en' = 'bn',
  timeZone: string = DEFAULT_TIMEZONE,
): string {
  const iso = toLocalDateString(date, timeZone);
  const [y, m, d] = iso.split('-') as [string, string, string];
  if (locale === 'en') {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone,
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }).format(date);
  }
  const bnDigits = (s: string) => s.replace(/\d/g, (ch) => '০১২৩৪৫৬৭৮৯'[Number(ch)] as string);
  return `${bnDigits(String(Number(d)))} ${BN_MONTHS[Number(m) - 1]} ${bnDigits(y)}`;
}
