import { describe, expect, it } from 'vitest';
import {
  addMonthsToDate,
  daysUntil,
  nextDueDate,
  RENEWAL_DEFAULTS,
  RENEWAL_KINDS,
  renewalStatus,
} from './renewals.js';

/**
 * The arithmetic behind "your fitness certificate expires in three weeks".
 *
 * Everything here is a date, not an instant, and every case below is one of the
 * ways date arithmetic goes wrong when it is done by adding milliseconds: short
 * months, leap years, and the difference between counting from the day a thing
 * was due and the day it was actually done.
 */

describe('the month step', () => {
  it('keeps the day of the month where the month is long enough', () => {
    expect(addMonthsToDate('2026-03-15', 12)).toBe('2027-03-15');
    expect(addMonthsToDate('2026-03-15', 3)).toBe('2026-06-15');
  });

  it('clamps to the end of a shorter month rather than spilling over', () => {
    /* Renewed on 31 March, due 28 February — not 3 March. Spilling would also
       drag every following year a day later each time, and a yearly obligation
       would slowly become a different date entirely. */
    expect(addMonthsToDate('2026-03-31', 11)).toBe('2027-02-28');
    expect(addMonthsToDate('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonthsToDate('2026-08-31', 1)).toBe('2026-09-30');
  });

  it('knows which Februaries have 29 days', () => {
    expect(addMonthsToDate('2028-01-31', 1)).toBe('2028-02-29');
    /* 2100 is divisible by 4 and is not a leap year. Adding 365 days would get
       this wrong; asking the calendar does not. */
    expect(addMonthsToDate('2100-01-31', 1)).toBe('2100-02-28');
  });

  it('crosses the year boundary', () => {
    expect(addMonthsToDate('2026-12-15', 1)).toBe('2027-01-15');
    expect(addMonthsToDate('2026-11-30', 14)).toBe('2028-01-30');
  });
});

describe('the next due date', () => {
  it('counts from the day it was done, not the day it was due', () => {
    /* A fitness certificate issued three weeks late is valid for a year from
       issue. Counting from the missed deadline would shorten the next period
       and keep somebody permanently behind. */
    expect(nextDueDate('YEARLY', '2026-04-21')).toBe('2027-04-21');
    expect(nextDueDate('HALF_YEARLY', '2026-04-21')).toBe('2026-10-21');
    expect(nextDueDate('QUARTERLY', '2026-04-21')).toBe('2026-07-21');
    expect(nextDueDate('MONTHLY', '2026-04-21')).toBe('2026-05-21');
  });

  it('does not reschedule something that happens once', () => {
    /* A passport is not a subscription. */
    expect(nextDueDate('ONE_OFF', '2026-04-21')).toBeNull();
  });
});

describe('days until', () => {
  it('counts whole days, and goes negative once the date has passed', () => {
    expect(daysUntil('2026-08-16', '2026-08-16')).toBe(0);
    expect(daysUntil('2026-08-16', '2026-09-15')).toBe(30);
    expect(daysUntil('2026-08-16', '2026-08-01')).toBe(-15);
  });

  it('is not confused by a month or a year boundary', () => {
    expect(daysUntil('2026-12-31', '2027-01-01')).toBe(1);
    expect(daysUntil('2028-02-28', '2028-03-01')).toBe(2);
  });
});

describe('where a renewal stands', () => {
  it('says nothing until it comes inside the warning period', () => {
    const status = renewalStatus('2026-08-16', '2026-12-31', 30);
    expect(status.urgency).toBe('UPCOMING');
    expect(status.shouldRemind).toBe(false);
  });

  it('starts warning exactly on the lead day, not the day after', () => {
    /* Off by one here is a person finding out about a 30-day warning with 29
       days left, every time. */
    expect(renewalStatus('2026-08-16', '2026-09-15', 30).urgency).toBe('DUE_SOON');
    expect(renewalStatus('2026-08-16', '2026-09-16', 30).urgency).toBe('UPCOMING');
  });

  it('keeps saying so after the date has gone', () => {
    /* Going quiet at the moment the fine starts accruing would be the worst
       possible behaviour. The once-a-day guard is what stops it nagging. */
    const late = renewalStatus('2026-08-16', '2026-07-01', 30);
    expect(late.urgency).toBe('OVERDUE');
    expect(late.daysLeft).toBe(-46);
    expect(late.shouldRemind).toBe(true);
  });

  it('treats the due date itself as due, not as passed', () => {
    const today = renewalStatus('2026-08-16', '2026-08-16', 30);
    expect(today.urgency).toBe('DUE_SOON');
    expect(today.daysLeft).toBe(0);
  });
});

describe('the Bangladesh defaults', () => {
  it('has a name and a sensible warning for every kind', () => {
    /* A blank "define your own reminder" form is a form nobody fills in. */
    for (const kind of RENEWAL_KINDS) {
      const preset = RENEWAL_DEFAULTS[kind];
      expect(preset.label.length).toBeGreaterThan(0);
      expect(preset.leadDays).toBeGreaterThanOrEqual(30);
    }
  });

  it('warns further ahead where the queue is longer', () => {
    /* A passport takes months and a licence takes weeks; a khajna payment takes
       an afternoon. The warning should match. */
    expect(RENEWAL_DEFAULTS.PASSPORT.leadDays).toBeGreaterThan(RENEWAL_DEFAULTS.KHAJNA.leadDays);
    expect(RENEWAL_DEFAULTS.PASSPORT.recurrence).toBe('ONE_OFF');
  });
});
