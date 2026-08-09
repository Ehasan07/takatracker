/**
 * The date logic behind the range control, pinned at the boundaries where it
 * would otherwise be wrong quietly: the 1st of a month, the 1st of January, a
 * 31-day month compared against a 28-day one, and a range older than the trend
 * endpoint can reach.
 */

import { describe, expect, it } from 'vitest';
import {
  inclusiveDays,
  previousPeriod,
  rangeForPreset,
  resolveRange,
  trendWindow,
  withinWindow,
} from './range';

/** Local midnight, the way `presetRange` reads a date. */
const on = (y: number, m: number, d: number) => new Date(y, m - 1, d);

describe('preset ranges', () => {
  it('gives whole calendar months', () => {
    expect(rangeForPreset('thisMonth', on(2026, 8, 9))).toEqual({
      preset: 'thisMonth',
      from: '2026-08-01',
      to: '2026-08-31',
    });
  });

  it('reads "গত মাস" the same way on the 1st as on the 20th', () => {
    const first = rangeForPreset('lastMonth', on(2026, 3, 1));
    const later = rangeForPreset('lastMonth', on(2026, 3, 20));
    expect(first).toEqual(later);
    expect(first.from).toBe('2026-02-01');
    expect(first.to).toBe('2026-02-28');
  });

  it('rolls "গত বছর" back over the January boundary', () => {
    expect(rangeForPreset('lastYear', on(2026, 1, 1))).toEqual({
      preset: 'lastYear',
      from: '2025-01-01',
      to: '2025-12-31',
    });
  });
});

describe('the previous equivalent period', () => {
  it('compares a 31-day month against however long the month before was', () => {
    const march = rangeForPreset('thisMonth', on(2026, 3, 15));
    expect(previousPeriod(march, on(2026, 3, 15))).toEqual({
      from: '2026-02-01',
      to: '2026-02-28',
    });
  });

  it('compares last month against the month before it', () => {
    const range = rangeForPreset('lastMonth', on(2026, 1, 5));
    expect(range.from).toBe('2025-12-01');
    expect(previousPeriod(range, on(2026, 1, 5))).toEqual({
      from: '2025-11-01',
      to: '2025-11-30',
    });
  });

  it('compares a custom range against the same number of days before it', () => {
    const range = { preset: 'custom', from: '2026-03-05', to: '2026-03-14' } as const;
    expect(inclusiveDays(range)).toBe(10);
    expect(previousPeriod(range, on(2026, 3, 20))).toEqual({
      from: '2026-02-23',
      to: '2026-03-04',
    });
  });

  it('compares "আজ" against yesterday, across a month boundary', () => {
    const range = rangeForPreset('today', on(2026, 3, 1));
    expect(previousPeriod(range, on(2026, 3, 1))).toEqual({
      from: '2026-02-28',
      to: '2026-02-28',
    });
  });
});

describe('reading a range out of the URL', () => {
  const params = (init: Record<string, string>) => new URLSearchParams(init);

  it('defaults to the current month when the URL says nothing', () => {
    expect(resolveRange(params({}), on(2026, 8, 9)).preset).toBe('thisMonth');
  });

  it('falls back rather than blanking on a preset it does not know', () => {
    expect(resolveRange(params({ preset: 'sinceForever' }), on(2026, 8, 9)).preset).toBe(
      'thisMonth',
    );
  });

  it('takes two bare dates as a custom range', () => {
    expect(resolveRange(params({ from: '2025-01-01', to: '2025-06-30' }), on(2026, 8, 9))).toEqual({
      preset: 'custom',
      from: '2025-01-01',
      to: '2025-06-30',
    });
  });

  it('reads hand-reversed bounds the way round that has days in it', () => {
    expect(
      resolveRange(
        params({ preset: 'custom', from: '2025-06-30', to: '2025-01-01' }),
        on(2026, 8, 9),
      ),
    ).toEqual({ preset: 'custom', from: '2025-01-01', to: '2025-06-30' });
  });
});

describe('the trend window', () => {
  it('asks for enough months to reach the start of the range', () => {
    const range = rangeForPreset('lastYear', on(2026, 8, 9));
    const window = trendWindow(range, on(2026, 8, 9));
    // 2025-01 through 2026-08 inclusive.
    expect(window.months).toBe(20);
    expect(window.firstMonth).toBe('2025-01');
    expect(window.lastMonth).toBe('2025-12');
    expect(window.partialMonths).toBe(false);
    expect(window.truncated).toBe(false);
  });

  it('keeps only the months the range covers', () => {
    const range = rangeForPreset('lastMonth', on(2026, 8, 9));
    const window = trendWindow(range, on(2026, 8, 9));
    const points = [
      { month: '2026-06', incomeMinor: 0, expenseMinor: 0, netMinor: 0 },
      { month: '2026-07', incomeMinor: 0, expenseMinor: 0, netMinor: 0 },
      { month: '2026-08', incomeMinor: 0, expenseMinor: 0, netMinor: 0 },
    ];
    expect(withinWindow(points, window).map((p) => p.month)).toEqual(['2026-07']);
  });

  it('flags a range that is not whole months, so the bars are not misread', () => {
    const range = { preset: 'custom', from: '2026-08-05', to: '2026-08-20' } as const;
    expect(trendWindow(range, on(2026, 8, 9)).partialMonths).toBe(true);
  });

  it('flags a range older than the endpoint will go back', () => {
    const range = { preset: 'custom', from: '2019-01-01', to: '2019-12-31' } as const;
    const window = trendWindow(range, on(2026, 8, 9));
    expect(window.months).toBe(36);
    expect(window.truncated).toBe(true);
  });
});
