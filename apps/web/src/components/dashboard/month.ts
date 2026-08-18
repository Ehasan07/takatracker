/**
 * The two stretches of time this month is compared against, and the arithmetic
 * of "how far into the month are we".
 *
 * ## Why there is a file for what looks like two date subtractions
 *
 * Because the obvious comparison is a lie. Eighteen days of August against the
 * whole of July says spending has halved when nothing has changed at all, and it
 * is the single easiest way for a dashboard to be confidently wrong — every
 * month, for the first thirty days of it. So the current window is the 1st to
 * *today*, and the window it is measured against is the 1st of last month to the
 * **same day of that month**. Both are "the first N days of a month", which is a
 * comparison that means what it looks like.
 *
 * February makes that impossible on the 29th, 30th and 31st: there is no such
 * day to stop at. The window is clamped to the month's last day and
 * `unevenDays` is set, so the panel can say on screen that it is eighteen days
 * against sixteen rather than quietly presenting them as equals.
 *
 * ## Why nothing here invents date arithmetic
 *
 * `presetRange` in @hishab/core is this product's one definition of "এই মাস" and
 * "গত মাস" — the loan statement chips and the reports range bar both run on it,
 * and it is unit-tested there. A second implementation here would disagree with
 * it on the 1st of a month, which is precisely the day somebody opens the app to
 * see how last month ended. All this file does is turn its `Date`s into the
 * `YYYY-MM-DD` the API speaks and pick the day to stop at.
 */

import { presetRange } from '@hishab/core';

/** An inclusive `YYYY-MM-DD` window and the number of days in it. */
export interface DayWindow {
  from: string;
  to: string;
  /** Inclusive, so a window of the 1st to the 1st is one day. */
  days: number;
}

export interface MonthComparison {
  /** The 1st of this month to today. */
  current: DayWindow;
  /** The 1st of last month to the same day of it — the like-for-like window. */
  previous: DayWindow;
  /** All of last month. Context, never the thing `current` is measured against. */
  previousFull: DayWindow;
  /** `YYYY-MM`, for picking a month out of the trend series. */
  currentMonth: string;
  previousMonth: string;
  /** Days in the current calendar month — 28 to 31. */
  daysInMonth: number;
  /** Today is the last day of the month, so `current` is the whole of it. */
  complete: boolean;
  /** Last month was too short to reach today's date. The windows differ in length. */
  unevenDays: boolean;
}

/**
 * A `Date`'s own calendar fields as `YYYY-MM-DD`.
 *
 * Deliberately not `toLocalDateString`, which projects into Asia/Dhaka: these
 * dates come out of `presetRange`, which is built from local calendar
 * components, and projecting one of those through a second timezone would move
 * "আজ" by a day for anybody not sitting in Dhaka.
 */
export function isoOf(date: Date): string {
  const y = String(date.getFullYear()).padStart(4, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function monthComparison(today: Date): MonthComparison {
  const thisMonth = presetRange('thisMonth', today);
  const lastMonth = presetRange('lastMonth', today);

  const elapsed = today.getDate();
  const daysInMonth = thisMonth.to.getDate();
  /* `presetRange('lastMonth')` ends on day 0 of this month, which the `Date`
     constructor resolves to the last day of last month whatever its length. */
  const daysInLastMonth = lastMonth.to.getDate();
  const stopAt = Math.min(elapsed, daysInLastMonth);

  const previousTo = new Date(
    lastMonth.from.getFullYear(),
    lastMonth.from.getMonth(),
    stopAt,
    0,
    0,
    0,
    0,
  );

  return {
    current: { from: isoOf(thisMonth.from), to: isoOf(today), days: elapsed },
    previous: { from: isoOf(lastMonth.from), to: isoOf(previousTo), days: stopAt },
    previousFull: {
      from: isoOf(lastMonth.from),
      to: isoOf(lastMonth.to),
      days: daysInLastMonth,
    },
    currentMonth: isoOf(thisMonth.from).slice(0, 7),
    previousMonth: isoOf(lastMonth.from).slice(0, 7),
    daysInMonth,
    complete: elapsed === daysInMonth,
    unevenDays: stopAt !== elapsed,
  };
}

/**
 * Where the month is against where the money is.
 *
 * Both figures are percentages of their own whole — days elapsed out of days in
 * the month, and spending so far out of *all* of last month's — so the two can
 * be drawn on one 0–100 scale and read against each other. That is the entire
 * question this answers: at 60% of the month with 85% of last month's spending
 * gone, this month is going to be worse, and it is worth knowing on the 18th
 * rather than on the 1st of next month.
 */
export interface Pace {
  /** 0–100. Never null: the calendar always knows how far through it is. */
  elapsedPercent: number;
  /**
   * Spending so far as a share of last month's whole. Null when last month spent
   * nothing — a share of zero is not 0%, it is undefined, and printing either is
   * a number that looks meaningful and is not.
   */
  spentPercent: number | null;
  /**
   * Integer poisha: what the month lands on if the rest of it looks like the
   * part that has happened. Null while it is too early for that to mean
   * anything — three days of a month predict nothing, and a projection from
   * them would be the least trustworthy number on the screen presented in the
   * same type as the ones that are certain.
   */
  projectedMinor: number | null;
}

/** Under this many days elapsed, the rate is noise and no projection is made. */
export const PROJECTION_FLOOR_DAYS = 5;

export function pace(
  window: MonthComparison,
  spentMinor: number,
  lastMonthFullMinor: number,
): Pace {
  const elapsedPercent = (window.current.days / window.daysInMonth) * 100;

  return {
    elapsedPercent,
    spentPercent: lastMonthFullMinor > 0 ? (spentMinor / lastMonthFullMinor) * 100 : null,
    projectedMinor:
      window.current.days >= PROJECTION_FLOOR_DAYS && !window.complete
        ? /* Poisha in, poisha out. The division is a rate, not an amount, and
             the result is floored back onto an integer the moment it becomes one
             — `Math.floor(x + 0.5)` is the repo's half-up step, because
             `Math.round` is banned anywhere near money. */
          Math.floor((spentMinor * window.daysInMonth) / window.current.days + 0.5)
        : null,
  };
}

/**
 * The change from one figure to another, in the three shapes it can take.
 *
 * A percentage change from zero is undefined, not 100%: somebody who spent
 * nothing on medicine last month and ৳500 this month has not increased their
 * spending by any percentage at all. `ratio` is null in that case and the caller
 * says so in words rather than printing a number.
 */
export interface Change {
  deltaMinor: number;
  direction: 'up' | 'down' | 'flat';
  /** Tenths of a percent — 111 is 11.1%. Null when the base is zero. */
  tenths: number | null;
}

export function changeOf(currentMinor: number, previousMinor: number): Change {
  const deltaMinor = currentMinor - previousMinor;
  return {
    deltaMinor,
    direction: deltaMinor === 0 ? 'flat' : deltaMinor > 0 ? 'up' : 'down',
    tenths:
      previousMinor === 0
        ? null
        : Math.floor((Math.abs(deltaMinor) / Math.abs(previousMinor)) * 1000 + 0.5),
  };
}
