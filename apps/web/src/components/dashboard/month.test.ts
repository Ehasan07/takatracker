import { describe, expect, it } from 'vitest';
import { PROJECTION_FLOOR_DAYS, changeOf, monthComparison, pace } from './month';

/** Local midnight, the way `presetRange` builds its own dates. */
const on = (y: number, m: number, d: number): Date => new Date(y, m - 1, d, 12, 0, 0, 0);

describe('monthComparison', () => {
  it('measures the same stretch of each month', () => {
    const w = monthComparison(on(2026, 8, 18));
    expect(w.current).toEqual({ from: '2026-08-01', to: '2026-08-18', days: 18 });
    expect(w.previous).toEqual({ from: '2026-07-01', to: '2026-07-18', days: 18 });
    expect(w.unevenDays).toBe(false);
    expect(w.complete).toBe(false);
  });

  it('keeps the whole of last month separately, for context', () => {
    const w = monthComparison(on(2026, 8, 18));
    expect(w.previousFull).toEqual({ from: '2026-07-01', to: '2026-07-31', days: 31 });
  });

  it('clamps to a short month and says the windows are uneven', () => {
    /* The case the obvious implementation gets wrong: there is no 30th of
       February to stop at, so the comparison is 30 days against 28 — which is
       fine so long as the screen says so. */
    const w = monthComparison(on(2026, 3, 30));
    expect(w.previous).toEqual({ from: '2026-02-01', to: '2026-02-28', days: 28 });
    expect(w.unevenDays).toBe(true);
  });

  it('knows when the month is over, so the two windows are whole months', () => {
    const w = monthComparison(on(2026, 8, 31));
    expect(w.complete).toBe(true);
    expect(w.current.days).toBe(31);
    expect(w.daysInMonth).toBe(31);
  });

  it('crosses a year boundary without inventing a thirteenth month', () => {
    const w = monthComparison(on(2026, 1, 9));
    expect(w.current.from).toBe('2026-01-01');
    expect(w.previous).toEqual({ from: '2025-12-01', to: '2025-12-09', days: 9 });
    expect(w.previousMonth).toBe('2025-12');
    expect(w.currentMonth).toBe('2026-01');
  });

  it('is one day long on the 1st, on both sides', () => {
    const w = monthComparison(on(2026, 8, 1));
    expect(w.current.days).toBe(1);
    expect(w.previous.days).toBe(1);
  });
});

describe('pace', () => {
  const window = monthComparison(on(2026, 8, 18));

  it('puts the calendar and the money on one scale', () => {
    const p = pace(window, 60_000_00, 100_000_00);
    // 18 of 31 days; ৳60,000 of last month's ৳100,000.
    expect(p.elapsedPercent).toBeCloseTo(58.06, 1);
    expect(p.spentPercent).toBeCloseTo(60, 5);
  });

  it('refuses a percentage of a month that spent nothing', () => {
    expect(pace(window, 60_000_00, 0).spentPercent).toBeNull();
  });

  it('projects the month end in integer poisha', () => {
    const p = pace(window, 60_000_00, 100_000_00);
    // 6,000,000 × 31 ÷ 18 = 10,333,333.33 → 10,333,333
    expect(p.projectedMinor).toBe(10_333_333);
    expect(Number.isInteger(p.projectedMinor)).toBe(true);
  });

  it('makes no projection from the first few days', () => {
    const early = monthComparison(on(2026, 8, PROJECTION_FLOOR_DAYS - 1));
    expect(pace(early, 10_000_00, 100_000_00).projectedMinor).toBeNull();
  });

  it('makes no projection once the month is over — that is a total, not a guess', () => {
    const done = monthComparison(on(2026, 8, 31));
    expect(pace(done, 100_000_00, 100_000_00).projectedMinor).toBeNull();
  });
});

describe('changeOf', () => {
  it('gives the direction, the amount and the share', () => {
    expect(changeOf(5_000_00, 4_000_00)).toEqual({
      deltaMinor: 100_000,
      direction: 'up',
      tenths: 250,
    });
  });

  it('reports a fall as a fall', () => {
    const change = changeOf(3_000_00, 4_000_00);
    expect(change.direction).toBe('down');
    expect(change.deltaMinor).toBe(-100_000);
    expect(change.tenths).toBe(250);
  });

  it('has no percentage to give when there was nothing before', () => {
    /* ৳0 to ৳500 is not a 100% rise and not an infinite one — it is a change
       with no percentage, and the panel says that in words. */
    expect(changeOf(500_00, 0).tenths).toBeNull();
  });

  it('calls no change no change', () => {
    expect(changeOf(500_00, 500_00)).toEqual({
      deltaMinor: 0,
      direction: 'flat',
      tenths: 0,
    });
  });

  it('rounds a share half-up without touching the amounts', () => {
    // 1,005 / 10,000 = 10.05% → 100.5 tenths → 101
    expect(changeOf(11_005, 10_000).tenths).toBe(101);
  });
});
