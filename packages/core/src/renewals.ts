/**
 * Papers that expire.
 *
 * A car needs a fitness certificate and a tax token every year. Land carries
 * khajna, a flat carries holding tax, a business carries a trade licence. Miss
 * one and the penalty is a fine, an impounded vehicle, or a mutation that will
 * not go through — none of it bookkeeping, all of it a calendar with money
 * attached.
 *
 * This module is the calendar arithmetic and nothing else: no database, no
 * clock of its own, no notion of who is being reminded. Every function takes
 * `YYYY-MM-DD` strings in the workspace's own local dates and returns them,
 * because a deadline is a day rather than an instant — "khajna is due on the
 * 30th" is true regardless of which hour the server is having.
 */

/** How often the paper comes round again. */
export const RENEWAL_RECURRENCES = [
  'YEARLY',
  'HALF_YEARLY',
  'QUARTERLY',
  'MONTHLY',
  /** A passport is not a subscription. */
  'ONE_OFF',
] as const;
export type RenewalRecurrence = (typeof RENEWAL_RECURRENCES)[number];

const MONTHS_PER: Record<Exclude<RenewalRecurrence, 'ONE_OFF'>, number> = {
  YEARLY: 12,
  HALF_YEARLY: 6,
  QUARTERLY: 3,
  MONTHLY: 1,
};

/**
 * The obligations that actually recur in Bangladesh.
 *
 * A blank "define your own reminder" form is a form nobody fills in. This list
 * turns the feature into ticking the ones you have. `OTHER` is last and exists
 * because any list like this is always missing one.
 */
export const RENEWAL_KINDS = [
  'FITNESS',
  'TAX_TOKEN',
  'ROUTE_PERMIT',
  'DRIVING_LICENCE',
  'KHAJNA',
  'HOLDING_TAX',
  'TRADE_LICENCE',
  'PASSPORT',
  'INSURANCE',
  'TAX_RETURN',
  'OTHER',
] as const;
export type RenewalKind = (typeof RENEWAL_KINDS)[number];

/** What each one is called, and how much warning it usually deserves. */
export const RENEWAL_DEFAULTS: Record<
  RenewalKind,
  { label: string; recurrence: RenewalRecurrence; leadDays: number }
> = {
  FITNESS: { label: 'গাড়ির ফিটনেস', recurrence: 'YEARLY', leadDays: 30 },
  TAX_TOKEN: { label: 'ট্যাক্স টোকেন', recurrence: 'YEARLY', leadDays: 30 },
  ROUTE_PERMIT: { label: 'রুট পারমিট', recurrence: 'YEARLY', leadDays: 30 },
  DRIVING_LICENCE: { label: 'ড্রাইভিং লাইসেন্স', recurrence: 'YEARLY', leadDays: 60 },
  KHAJNA: { label: 'খাজনা (ভূমি উন্নয়ন কর)', recurrence: 'YEARLY', leadDays: 30 },
  HOLDING_TAX: { label: 'হোল্ডিং ট্যাক্স', recurrence: 'YEARLY', leadDays: 30 },
  TRADE_LICENCE: { label: 'ট্রেড লাইসেন্স', recurrence: 'YEARLY', leadDays: 30 },
  /* Ten years, and the queue is long — the warning has to be long too. */
  PASSPORT: { label: 'পাসপোর্ট', recurrence: 'ONE_OFF', leadDays: 90 },
  INSURANCE: { label: 'ইনস্যুরেন্স', recurrence: 'YEARLY', leadDays: 30 },
  TAX_RETURN: { label: 'আয়কর রিটার্ন', recurrence: 'YEARLY', leadDays: 45 },
  OTHER: { label: 'অন্যান্য', recurrence: 'YEARLY', leadDays: 30 },
};

/** Days in a month, Gregorian, leap years included. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * The same day, some months later — clamped to the end of a shorter month.
 *
 * A fitness certificate renewed on 31 March falls due on 28 February in a
 * common year, not on 3 March. Spilling into the next month would also drag
 * every following renewal a day later each time, which is how a yearly
 * obligation slowly becomes a different date entirely.
 */
export function addMonthsToDate(date: string, months: number): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));

  const zeroBased = year * 12 + (month - 1) + months;
  const nextYear = Math.floor(zeroBased / 12);
  const nextMonth = (zeroBased % 12) + 1;
  const nextDay = Math.min(day, daysInMonth(nextYear, nextMonth));

  return `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}-${String(
    nextDay,
  ).padStart(2, '0')}`;
}

/**
 * When it falls due again, having been done on `completedOn`.
 *
 * Counted from the day it was completed rather than from the day it was due,
 * because that is what the department does: a fitness certificate issued three
 * weeks late is valid for a year from issue, not a year from the date it
 * should have been renewed. Anything else would quietly shorten the next
 * period and keep the person permanently behind.
 *
 * `ONE_OFF` returns null — it is finished, not rescheduled.
 */
export function nextDueDate(recurrence: RenewalRecurrence, completedOn: string): string | null {
  if (recurrence === 'ONE_OFF') return null;
  return addMonthsToDate(completedOn, MONTHS_PER[recurrence]);
}

/** Whole days from `today` to `dueDate`; negative once it has passed. */
export function daysUntil(today: string, dueDate: string): number {
  const from = Date.UTC(
    Number(today.slice(0, 4)),
    Number(today.slice(5, 7)) - 1,
    Number(today.slice(8, 10)),
  );
  const to = Date.UTC(
    Number(dueDate.slice(0, 4)),
    Number(dueDate.slice(5, 7)) - 1,
    Number(dueDate.slice(8, 10)),
  );
  return Math.round((to - from) / 86_400_000);
}

export type RenewalUrgency = 'OVERDUE' | 'DUE_SOON' | 'UPCOMING';

export interface RenewalStatus {
  daysLeft: number;
  urgency: RenewalUrgency;
  /** Whether a reminder should go out today. */
  shouldRemind: boolean;
}

/**
 * Where a renewal stands today.
 *
 * `shouldRemind` stays true after the date has passed, which is deliberate: a
 * fitness certificate that expired last week is more urgent than one expiring
 * next month, and going quiet at exactly the moment the fine starts accruing
 * would be the worst possible behaviour. The caller's once-a-day guard is what
 * stops that becoming a daily nag.
 */
export function renewalStatus(today: string, dueDate: string, leadDays: number): RenewalStatus {
  const daysLeft = daysUntil(today, dueDate);
  const urgency: RenewalUrgency =
    daysLeft < 0 ? 'OVERDUE' : daysLeft <= leadDays ? 'DUE_SOON' : 'UPCOMING';
  return { daysLeft, urgency, shouldRemind: urgency !== 'UPCOMING' };
}
