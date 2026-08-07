import { fromLocalDateString, toLocalDateString } from '@hishab/shared';

/**
 * When to nag someone about a credit-card bill.
 *
 * Two rules drive everything here, and both are deliberate:
 *
 *  1. A due day of 31 lands on 28 February, not 3 March. Cards are billed on a
 *     day-of-month, and months are not all the same length.
 *  2. Passing the due date does **not** stop the reminders. An unpaid card is
 *     more urgent after the deadline, not less, so a cycle's window runs until
 *     the *next* cycle's window opens. Coverage is therefore continuous, and
 *     only a mute or a recorded payment ends a cycle early.
 *
 * Pure functions over `YYYY-MM` strings and local dates, so the same code runs
 * in the worker, the API and the browser.
 */

export interface CardCycle {
  /** `YYYY-MM` — the identity of this billing cycle. */
  cycleMonth: string;
  /** Local midnight on the day payment is due. */
  dueDate: Date;
  /** Local midnight when reminders start. */
  windowStart: Date;
  /** Local midnight when the next cycle takes over. Exclusive. */
  windowEnd: Date;
}

export const MIN_LEAD_DAYS = 1;
export const MAX_LEAD_DAYS = 28;
export const DEFAULT_LEAD_DAYS = 7;

export function daysInMonth(year: number, month: number): number {
  // Day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** A card due on the 31st is due on the 28th in February. */
export function clampDayToMonth(year: number, month: number, day: number): number {
  return Math.min(Math.max(1, day), daysInMonth(year, month));
}

function monthKey(year: number, month: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}

function shiftMonth(year: number, month: number, delta: number): [number, number] {
  const zeroBased = year * 12 + (month - 1) + delta;
  return [Math.floor(zeroBased / 12), (zeroBased % 12) + 1];
}

export function parseCycleMonth(cycleMonth: string): [number, number] {
  const match = /^(\d{4})-(\d{2})$/.exec(cycleMonth);
  if (!match) throw new TypeError(`Expected YYYY-MM, got ${JSON.stringify(cycleMonth)}`);
  return [Number(match[1]), Number(match[2])];
}

/** Local midnight on the due day of the given cycle, clamped to the month. */
export function dueDateFor(cycleMonth: string, dueDayOfMonth: number, timezone: string): Date {
  const [year, month] = parseCycleMonth(cycleMonth);
  const day = clampDayToMonth(year, month, dueDayOfMonth);
  return fromLocalDateString(`${monthKey(year, month)}-${String(day).padStart(2, '0')}`, timezone);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

export function clampLeadDays(leadDays: number | null | undefined): number {
  if (leadDays === null || leadDays === undefined || !Number.isFinite(leadDays)) {
    return DEFAULT_LEAD_DAYS;
  }
  return Math.min(MAX_LEAD_DAYS, Math.max(MIN_LEAD_DAYS, Math.trunc(leadDays)));
}

export function buildCycle(
  cycleMonth: string,
  dueDayOfMonth: number,
  leadDays: number,
  timezone: string,
): CardCycle {
  const lead = clampLeadDays(leadDays);
  const [year, month] = parseCycleMonth(cycleMonth);
  const [nextYear, nextMonth] = shiftMonth(year, month, 1);

  const dueDate = dueDateFor(cycleMonth, dueDayOfMonth, timezone);
  const nextDue = dueDateFor(monthKey(nextYear, nextMonth), dueDayOfMonth, timezone);

  return {
    cycleMonth,
    dueDate,
    windowStart: addDays(dueDate, -lead),
    // The moment the next bill's reminders begin, this cycle is finished with.
    windowEnd: addDays(nextDue, -lead),
  };
}

/**
 * The cycle whose window contains `now`.
 *
 * Because windows are back-to-back there is always exactly one, and an overdue
 * bill keeps reminding right up until the next bill's window opens.
 */
export function activeCycle(
  now: Date,
  dueDayOfMonth: number,
  leadDays: number,
  timezone: string,
): CardCycle {
  const localToday = toLocalDateString(now, timezone);
  const year = Number(localToday.slice(0, 4));
  const month = Number(localToday.slice(5, 7));

  const thisMonth = buildCycle(monthKey(year, month), dueDayOfMonth, leadDays, timezone);
  if (now.getTime() >= thisMonth.windowStart.getTime()) return thisMonth;

  const [prevYear, prevMonth] = shiftMonth(year, month, -1);
  return buildCycle(monthKey(prevYear, prevMonth), dueDayOfMonth, leadDays, timezone);
}

/** Negative once the due date has passed. */
export function daysUntilDue(now: Date, dueDate: Date, timezone: string): number {
  const a = fromLocalDateString(toLocalDateString(now, timezone), timezone).getTime();
  const b = fromLocalDateString(toLocalDateString(dueDate, timezone), timezone).getTime();
  /* Both ends are local midnight, but a timezone with daylight saving makes some
   * days 23 or 25 hours long, so the gap is not always an exact multiple. Round
   * to the nearest whole day rather than truncating, which would report 23 hours
   * as zero days. (Written without Math.round: the lint rule that bans it is
   * there to keep floats out of money, and this is days.) */
  return Math.floor((b - a) / 86_400_000 + 0.5);
}

export interface ReminderDecision {
  send: boolean;
  reason:
    | 'in-window'
    | 'outside-window'
    | 'before-first-cycle'
    | 'muted'
    | 'already-sent-today'
    | 'no-due-day'
    | 'not-connected';
  /** The cycle the decision was made about, when there was one. */
  cycle?: CardCycle;
}

export interface ReminderInput {
  now: Date;
  timezone: string;
  dueDayOfMonth: number | null;
  leadDays: number | null;
  /** `YYYY-MM-DD` of the last send for this cycle, if any. */
  lastSentOn: string | null;
  mutedAt: Date | null;
  hasActiveConnection: boolean;
  /**
   * When this card started being tracked. Windows are back-to-back, so without
   * this a card added today would immediately start reminding about last
   * month's bill — one it never had. Any cycle whose due date falls before this
   * is not ours to nag about.
   */
  remindFrom?: Date | null;
}

/**
 * One decision per card per run. The `already-sent-today` guard is the
 * idempotency key: a worker restart, a retry or a second instance must never
 * produce two messages on the same day.
 */
export function decideReminder(input: ReminderInput): ReminderDecision {
  if (input.dueDayOfMonth === null) return { send: false, reason: 'no-due-day' };
  if (!input.hasActiveConnection) return { send: false, reason: 'not-connected' };

  const cycle = activeCycle(
    input.now,
    input.dueDayOfMonth,
    clampLeadDays(input.leadDays),
    input.timezone,
  );

  if (input.remindFrom && cycle.dueDate.getTime() < input.remindFrom.getTime()) {
    return { send: false, reason: 'before-first-cycle', cycle };
  }

  const withinWindow =
    input.now.getTime() >= cycle.windowStart.getTime() &&
    input.now.getTime() < cycle.windowEnd.getTime();
  if (!withinWindow) return { send: false, reason: 'outside-window', cycle };

  if (input.mutedAt) return { send: false, reason: 'muted', cycle };

  const today = toLocalDateString(input.now, input.timezone);
  if (input.lastSentOn === today) return { send: false, reason: 'already-sent-today', cycle };

  return { send: true, reason: 'in-window', cycle };
}

/**
 * "আর ৫ দিন" before the date, "৩ দিন পার হয়েছে" after it. The wording has to
 * change or a message repeating unchanged for weeks becomes background noise.
 */
export function describeDueDistance(days: number): { bn: string; overdue: boolean } {
  const bnDigits = (n: number): string =>
    String(Math.abs(n)).replace(/\d/g, (d) => '০১২৩৪৫৬৭৮৯'[Number(d)] as string);

  if (days > 1) return { bn: `আর ${bnDigits(days)} দিন`, overdue: false };
  if (days === 1) return { bn: 'আগামীকাল', overdue: false };
  if (days === 0) return { bn: 'আজই শেষ দিন', overdue: false };
  if (days === -1) return { bn: 'গতকাল পার হয়েছে', overdue: true };
  return { bn: `${bnDigits(days)} দিন পার হয়েছে`, overdue: true };
}
