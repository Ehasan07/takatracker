import { describe, expect, it } from 'vitest';
import { addMonthsTo, monthOf, monthRange, spreadEvenly, spreadOverWindow } from './prepaid';

/**
 * The arithmetic behind "a year of insurance reads as ৳1,000 a month".
 *
 * One property matters more than all the others and every test here is
 * ultimately about it: **the shares add up to the payment**. A spread that
 * quietly loses four poisha is a screen somebody can check and find wrong, and
 * "it is only display" is not a defence — a figure nobody can reconcile is
 * worse than no figure.
 */

/** ৳12,000.00 — a year of ordinary car insurance. */
const YEAR_OF_INSURANCE = 1_200_000;
/** ৳10,000.00, which is the one that does not divide by twelve. */
const AWKWARD = 1_000_000;

describe('month arithmetic', () => {
  it('reads a month off a date, and off a month', () => {
    expect(monthOf('2026-04-17')).toBe('2026-04');
    expect(monthOf('2026-04')).toBe('2026-04');
  });

  it('crosses the year boundary in both directions', () => {
    expect(addMonthsTo('2026-11', 3)).toBe('2027-02');
    expect(addMonthsTo('2026-02', -3)).toBe('2025-11');
    expect(addMonthsTo('2026-12', 1)).toBe('2027-01');
    expect(addMonthsTo('2026-01', -1)).toBe('2025-12');
  });

  it('walks a window with no gap and no repeat', () => {
    const window = monthRange('2026-11', 4);
    expect(window).toEqual(['2026-11', '2026-12', '2027-01', '2027-02']);
    expect(new Set(window).size).toBe(4);
  });
});

describe('spreading one payment', () => {
  it('divides a year of insurance into twelve equal months', () => {
    const shares = spreadEvenly(YEAR_OF_INSURANCE, 12);
    expect(shares).toHaveLength(12);
    // ৳1,000.00 each, which is the whole point of the feature.
    expect(new Set(shares)).toEqual(new Set([100_000]));
  });

  it('loses no poisha when the total will not divide', () => {
    const shares = spreadEvenly(AWKWARD, 12);
    /* 83,333.33 poisha each. Four months carry the extra poisha and eight do
       not, and the twelve add up to exactly what was paid — which is the
       property somebody checking the arithmetic on paper will test. */
    expect(shares.reduce((sum, n) => sum + n, 0)).toBe(AWKWARD);
    expect(shares.filter((n) => n === 83_334)).toHaveLength(4);
    expect(shares.filter((n) => n === 83_333)).toHaveLength(8);
    // The leftover goes to the earliest months, never the last.
    expect(shares[0]).toBe(83_334);
    expect(shares.at(-1)).toBe(83_333);
  });

  it('has nothing to say about a term of zero', () => {
    expect(spreadEvenly(YEAR_OF_INSURANCE, 0)).toEqual([]);
    expect(spreadEvenly(0, 12).reduce((sum, n) => sum + n, 0)).toBe(0);
  });
});

describe('spreading several payments across a window', () => {
  const insurance = {
    transactionId: 'tx-insurance',
    date: '2026-04-10',
    description: 'গাড়ির বীমা',
    categoryName: 'যানবাহন',
    accountName: 'সিটি ব্যাংক',
    totalMinor: YEAR_OF_INSURANCE,
    startMonth: '2026-04',
    months: 12,
  };
  const licence = {
    transactionId: 'tx-licence',
    date: '2026-07-01',
    description: null,
    categoryName: 'ট্রেড লাইসেন্স',
    accountName: 'নগদ',
    totalMinor: 60_000,
    startMonth: '2026-07',
    months: 12,
  };

  it('adds the months that overlap and leaves the rest empty', () => {
    const months = spreadOverWindow([insurance, licence], '2026-01', 12);
    expect(months).toHaveLength(12);

    // January to March: neither payment has started.
    expect(months.slice(0, 3).map((m) => m.totalMinor)).toEqual([0, 0, 0]);
    // April to June: insurance only.
    expect(months[3]).toMatchObject({ month: '2026-04', totalMinor: 100_000 });
    // July onwards: both, ৳1,000 and ৳50.
    expect(months[6]).toMatchObject({ month: '2026-07', totalMinor: 105_000 });
    expect(months[6]?.lines.map((line) => line.transactionId)).toEqual([
      'tx-insurance',
      'tx-licence',
    ]);
  });

  it('labels a row with no description by its category', () => {
    const months = spreadOverWindow([licence], '2026-07', 1);
    expect(months[0]?.lines[0]?.label).toBe('ট্রেড লাইসেন্স');
  });

  it('shows nothing for a payment whose cover ended before the window', () => {
    // Still the caller's to list — it just contributes no month here.
    const months = spreadOverWindow([insurance], '2027-04', 12);
    expect(months.every((m) => m.totalMinor === 0)).toBe(true);
    expect(months.every((m) => m.lines.length === 0)).toBe(true);
  });

  it('spreads the whole payment and no more of it across a wide enough window', () => {
    const months = spreadOverWindow([insurance, licence], '2026-01', 36);
    const total = months.reduce((sum, m) => sum + m.totalMinor, 0);
    expect(total).toBe(YEAR_OF_INSURANCE + 60_000);
  });
});
