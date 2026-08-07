import { describe, expect, it } from 'vitest';
import { fromLocalDateString, toLocalDateString } from '@hishab/shared';
import {
  activeCycle,
  buildCycle,
  clampDayToMonth,
  clampLeadDays,
  daysUntilDue,
  decideReminder,
  describeDueDistance,
  dueDateFor,
} from './card-reminders.js';

const TZ = 'Asia/Dhaka';
const at = (isoDate: string): Date => fromLocalDateString(isoDate, TZ);
const local = (d: Date): string => toLocalDateString(d, TZ);

describe('day clamping', () => {
  it('keeps a normal day', () => {
    expect(clampDayToMonth(2026, 8, 12)).toBe(12);
  });

  it('pulls the 31st back to the end of a short month', () => {
    expect(clampDayToMonth(2026, 2, 31)).toBe(28);
    expect(clampDayToMonth(2026, 4, 31)).toBe(30);
  });

  it('handles a leap February', () => {
    expect(clampDayToMonth(2028, 2, 31)).toBe(29);
  });

  it('never returns zero', () => {
    expect(clampDayToMonth(2026, 8, 0)).toBe(1);
  });
});

describe('due dates', () => {
  it('lands on the requested day', () => {
    expect(local(dueDateFor('2026-08', 12, TZ))).toBe('2026-08-12');
  });

  it('clamps rather than spilling into the next month', () => {
    // The failure this guards against is a card due on the 31st reminding on
    // 3 March, three days after the money was already late.
    expect(local(dueDateFor('2026-02', 31, TZ))).toBe('2026-02-28');
  });
});

describe('cycle windows', () => {
  const cycle = buildCycle('2026-08', 12, 7, TZ);

  it('opens leadDays before the due date', () => {
    expect(local(cycle.windowStart)).toBe('2026-08-05');
    expect(local(cycle.dueDate)).toBe('2026-08-12');
  });

  it('runs until the next cycle opens, not until the due date', () => {
    expect(local(cycle.windowEnd)).toBe('2026-09-05');
  });

  it('leaves no gap between consecutive cycles', () => {
    const next = buildCycle('2026-09', 12, 7, TZ);
    expect(cycle.windowEnd.getTime()).toBe(next.windowStart.getTime());
  });

  it('clamps an absurd lead time instead of trusting it', () => {
    expect(clampLeadDays(0)).toBe(1);
    expect(clampLeadDays(400)).toBe(28);
    expect(clampLeadDays(null)).toBe(7);
  });
});

describe('active cycle', () => {
  it('is the current month once its window has opened', () => {
    expect(activeCycle(at('2026-08-06'), 12, 7, TZ).cycleMonth).toBe('2026-08');
  });

  it('is still last month before this month s window opens', () => {
    // 3 August is before 5 August, so July's overdue bill is still the live one.
    expect(activeCycle(at('2026-08-03'), 12, 7, TZ).cycleMonth).toBe('2026-07');
  });

  it('rolls over on the day the next window opens', () => {
    expect(activeCycle(at('2026-09-04'), 12, 7, TZ).cycleMonth).toBe('2026-08');
    expect(activeCycle(at('2026-09-05'), 12, 7, TZ).cycleMonth).toBe('2026-09');
  });

  it('crosses a year boundary', () => {
    expect(activeCycle(at('2027-01-02'), 12, 7, TZ).cycleMonth).toBe('2026-12');
  });
});

describe('daysUntilDue', () => {
  it('counts down and then goes negative', () => {
    expect(daysUntilDue(at('2026-08-07'), at('2026-08-12'), TZ)).toBe(5);
    expect(daysUntilDue(at('2026-08-12'), at('2026-08-12'), TZ)).toBe(0);
    expect(daysUntilDue(at('2026-08-15'), at('2026-08-12'), TZ)).toBe(-3);
  });
});

describe('decideReminder', () => {
  const base = {
    timezone: TZ,
    dueDayOfMonth: 12,
    leadDays: 7,
    lastSentOn: null,
    mutedAt: null,
    hasActiveConnection: true,
  };

  it('does not nag about a bill from before the card was added', () => {
    /* Windows are back-to-back, so on 4 August the *live* cycle is July's.
     * A card only added on 2 August never had a July bill, and reminding about
     * one would be inventing a debt. */
    const d = decideReminder({
      ...base,
      now: at('2026-08-04'),
      dueDayOfMonth: 20,
      remindFrom: at('2026-08-02'),
    });
    expect(d.send).toBe(false);
    expect(d.reason).toBe('before-first-cycle');

    // Its own first cycle starts on time.
    expect(
      decideReminder({
        ...base,
        now: at('2026-08-13'),
        dueDayOfMonth: 20,
        remindFrom: at('2026-08-02'),
      }).send,
    ).toBe(true);
  });

  it('covers a card that has been tracked for a while, with no gaps', () => {
    const tracked = { ...base, remindFrom: at('2026-01-01') };
    for (const day of ['2026-08-05', '2026-08-12', '2026-08-20', '2026-09-04']) {
      expect(decideReminder({ ...tracked, now: at(day) }).send, day).toBe(true);
    }
  });

  it('sends inside the window', () => {
    expect(decideReminder({ ...base, now: at('2026-08-07') }).send).toBe(true);
  });

  it('keeps sending after the due date', () => {
    // The whole point: an unpaid card is more urgent late, not less.
    expect(decideReminder({ ...base, now: at('2026-08-20') }).send).toBe(true);
    expect(decideReminder({ ...base, now: at('2026-09-01') }).send).toBe(true);
  });

  it('goes quiet once muted, for that cycle only', () => {
    const muted = { ...base, mutedAt: at('2026-08-08') };
    expect(decideReminder({ ...muted, now: at('2026-08-09') }).reason).toBe('muted');
    // The next cycle is a different row, so the mute does not carry over.
    expect(decideReminder({ ...base, now: at('2026-09-06') }).send).toBe(true);
  });

  it('sends at most once a day', () => {
    const d = decideReminder({ ...base, now: at('2026-08-07'), lastSentOn: '2026-08-07' });
    expect(d.send).toBe(false);
    expect(d.reason).toBe('already-sent-today');

    // A worker restart the next day resumes normally.
    expect(decideReminder({ ...base, now: at('2026-08-08'), lastSentOn: '2026-08-07' }).send).toBe(
      true,
    );
  });

  it('does nothing without a due day or a connection', () => {
    expect(decideReminder({ ...base, now: at('2026-08-07'), dueDayOfMonth: null }).reason).toBe(
      'no-due-day',
    );
    expect(
      decideReminder({ ...base, now: at('2026-08-07'), hasActiveConnection: false }).reason,
    ).toBe('not-connected');
  });

  it('handles a card due on the 31st through February', () => {
    const feb = { ...base, dueDayOfMonth: 31 };
    expect(activeCycle(at('2026-02-25'), 31, 7, TZ).cycleMonth).toBe('2026-02');
    expect(local(activeCycle(at('2026-02-25'), 31, 7, TZ).dueDate)).toBe('2026-02-28');
    expect(decideReminder({ ...feb, now: at('2026-02-25') }).send).toBe(true);
  });
});

describe('wording', () => {
  it('changes once the date passes, so the message does not become wallpaper', () => {
    expect(describeDueDistance(5)).toEqual({ bn: 'আর ৫ দিন', overdue: false });
    expect(describeDueDistance(1)).toEqual({ bn: 'আগামীকাল', overdue: false });
    expect(describeDueDistance(0)).toEqual({ bn: 'আজই শেষ দিন', overdue: false });
    expect(describeDueDistance(-1)).toEqual({ bn: 'গতকাল পার হয়েছে', overdue: true });
    expect(describeDueDistance(-3)).toEqual({ bn: '৩ দিন পার হয়েছে', overdue: true });
  });
});
