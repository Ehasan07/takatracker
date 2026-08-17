import { describe, expect, it } from 'vitest';
import {
  buildInstalmentSchedule,
  growLumpSum,
  projectSavings,
  summariseProgress,
  type SavingsPlanInput,
} from './savings.js';

/**
 * Every figure below is one a customer could check against their own passbook.
 * Where the arithmetic is long the expectation is a range, because the point is
 * that the model behaves like a bank — not that it matches one rounding choice.
 */

describe('growLumpSum', () => {
  it('leaves money alone at a zero rate', () => {
    expect(growLumpSum(100_000, 0, 60, 'COMPOUND_YEARLY')).toBe(100_000);
  });

  it('matches simple interest exactly', () => {
    // ৳1,000 at 10% simple for 2 years = ৳1,200
    expect(growLumpSum(100_000, 1000, 24, 'SIMPLE')).toBe(120_000);
  });

  it('matches annual compounding exactly', () => {
    // ৳1,000 at 10% compounded yearly for 2 years = 1000 × 1.1² = ৳1,210
    expect(growLumpSum(100_000, 1000, 24, 'COMPOUND_YEARLY')).toBe(121_000);
  });

  it('earns more the more often it compounds', () => {
    const yearly = growLumpSum(100_000, 1000, 24, 'COMPOUND_YEARLY');
    const quarterly = growLumpSum(100_000, 1000, 24, 'COMPOUND_QUARTERLY');
    const monthly = growLumpSum(100_000, 1000, 24, 'COMPOUND_MONTHLY');
    expect(quarterly).toBeGreaterThan(yearly);
    expect(monthly).toBeGreaterThan(quarterly);
  });

  it('never produces a fractional poisha', () => {
    const grown = growLumpSum(333_333, 837, 37, 'COMPOUND_MONTHLY');
    expect(Number.isInteger(grown)).toBe(true);
  });
});

describe('projectSavings — a plain FDR', () => {
  // ৳100,000 for 3 years at 9%, compounded yearly:
  //   100000 × 1.09³ = ৳129,503.00
  const fdr: SavingsPlanInput = {
    installmentMinor: 0,
    principalMinor: 10_000_000,
    frequency: 'YEARLY',
    termMonths: 36,
    profitRateBps: 900,
    profitCalc: 'COMPOUND_YEARLY',
  };

  it('grows the lump sum and reports the profit', () => {
    const p = projectSavings(fdr);
    expect(p.installmentCount).toBe(0);
    expect(p.depositedMinor).toBe(10_000_000);
    expect(p.maturityMinor).toBe(12_950_290); // 100000 × 1.09³, truncated
    expect(p.profitMinor).toBe(p.maturityMinor - p.depositedMinor);
  });

  it('shows its working, and says the figure is before tax', () => {
    const p = projectSavings(fdr);
    expect(p.formula).toContain('9.00%');
    // Tax and AIT are deliberately not modelled, so the label has to say so.
    expect(p.formula).toContain('কর কাটার আগের হিসাব');
  });
});

describe('projectSavings — a monthly DPS', () => {
  // ৳2,000 a month for 5 years at 8%. Sixty instalments, ৳120,000 deposited.
  const dps: SavingsPlanInput = {
    installmentMinor: 200_000,
    principalMinor: 0,
    frequency: 'MONTHLY',
    termMonths: 60,
    profitRateBps: 800,
    profitCalc: 'COMPOUND_MONTHLY',
  };

  it('counts the instalments the term actually contains', () => {
    expect(projectSavings(dps).installmentCount).toBe(60);
    expect(projectSavings(dps).depositedMinor).toBe(12_000_000);
  });

  it('grows each instalment only for the time it is on deposit', () => {
    const p = projectSavings(dps);
    /* The common mistake is treating all ৳120,000 as if it sat there for five
     * years, which gives ৳178,000-odd. The truth is nearer ৳147,000 because the
     * last instalment earns almost nothing. */
    expect(p.maturityMinor).toBeGreaterThan(14_500_000);
    expect(p.maturityMinor).toBeLessThan(15_000_000);
    expect(p.maturityMinor).toBeLessThan(growLumpSum(12_000_000, 800, 60, 'COMPOUND_MONTHLY'));
  });

  it('always earns something above what was put in', () => {
    const p = projectSavings(dps);
    expect(p.profitMinor).toBeGreaterThan(0);
    expect(p.maturityMinor).toBe(p.depositedMinor + p.profitMinor);
  });

  it('returns exactly the deposits at a zero rate', () => {
    const p = projectSavings({ ...dps, profitRateBps: 0 });
    expect(p.maturityMinor).toBe(12_000_000);
    expect(p.profitMinor).toBe(0);
  });
});

describe('projectSavings — quarterly', () => {
  it('fits four instalments into a year', () => {
    const p = projectSavings({
      installmentMinor: 500_000,
      principalMinor: 0,
      frequency: 'QUARTERLY',
      termMonths: 12,
      profitRateBps: 700,
      profitCalc: 'COMPOUND_QUARTERLY',
    });
    expect(p.installmentCount).toBe(4);
    expect(p.depositedMinor).toBe(2_000_000);
  });

  it('ignores a part period rather than inventing an instalment', () => {
    // 14 months of quarterly payments is four, not four and two thirds.
    const p = projectSavings({
      installmentMinor: 500_000,
      principalMinor: 0,
      frequency: 'QUARTERLY',
      termMonths: 14,
      profitRateBps: 700,
      profitCalc: 'COMPOUND_QUARTERLY',
    });
    expect(p.installmentCount).toBe(4);
  });
});

describe('instalment schedule', () => {
  it('spaces monthly instalments one month apart', () => {
    const rows = buildInstalmentSchedule({
      installmentMinor: 200_000,
      principalMinor: 0,
      frequency: 'MONTHLY',
      termMonths: 6,
      profitRateBps: 800,
      profitCalc: 'COMPOUND_MONTHLY',
    });
    expect(rows).toHaveLength(6);
    expect(rows[0]).toEqual({ index: 1, monthOffset: 0, expectedMinor: 200_000 });
    expect(rows[5]?.monthOffset).toBe(5);
  });

  it('spaces quarterly instalments three months apart', () => {
    const rows = buildInstalmentSchedule({
      installmentMinor: 500_000,
      principalMinor: 0,
      frequency: 'QUARTERLY',
      termMonths: 12,
      profitRateBps: 700,
      profitCalc: 'COMPOUND_QUARTERLY',
    });
    expect(rows.map((r) => r.monthOffset)).toEqual([0, 3, 6, 9]);
  });

  it('is empty for a lump-sum FDR, which has nothing to pay monthly', () => {
    expect(
      buildInstalmentSchedule({
        installmentMinor: 0,
        principalMinor: 10_000_000,
        frequency: 'YEARLY',
        termMonths: 36,
        profitRateBps: 900,
        profitCalc: 'COMPOUND_YEARLY',
      }),
    ).toHaveLength(0);
  });
});

describe('progress', () => {
  const rows = [
    { status: 'PAID', expectedMinor: 200_000 },
    { status: 'PAID', expectedMinor: 200_000 },
    { status: 'MISSED', expectedMinor: 200_000 },
    { status: 'DUE', expectedMinor: 200_000 },
  ];

  it('counts what is paid, missed and left', () => {
    const p = summariseProgress(rows);
    expect(p.paidCount).toBe(2);
    expect(p.missedCount).toBe(1);
    expect(p.remainingCount).toBe(2);
    expect(p.paidMinor).toBe(400_000);
    expect(p.percentComplete).toBe(50);
  });

  it('does not divide by zero on a plan with no instalments', () => {
    expect(summariseProgress([]).percentComplete).toBe(0);
  });
});

/**
 * A lump sum has no instalments, so its progress is the calendar.
 *
 * This existed because every FDR and Sanchayapatra read 0% forever: the ring
 * counted instalments, a lump sum has none, and the branch returned zero. Time
 * is the honest measure there — the money went in on day one and nothing
 * remains that could fail to happen — and it is the wrong measure for a DPS,
 * where a skipped month must not look like progress.
 */
describe('progress on a lump sum', () => {
  const span = (start: string, maturity: string | null, today: string) => ({
    startDate: new Date(`${start}T00:00:00.000Z`),
    maturityDate: maturity ? new Date(`${maturity}T00:00:00.000Z`) : null,
    today: new Date(`${today}T00:00:00.000Z`),
  });

  it('reports how much of the term has run', () => {
    /* A two-year FDR at its midpoint. 2025 and 2026 are both common years, so
       the halfway day is exactly halfway — 2024 is a leap year and would put
       this at 50.1, which is correct arithmetic and a confusing assertion. */
    expect(
      summariseProgress([], span('2025-01-01', '2027-01-01', '2026-01-01')).percentComplete,
    ).toBe(50);
  });

  it('is zero on the day it starts and 100 at maturity', () => {
    expect(
      summariseProgress([], span('2024-01-01', '2026-01-01', '2024-01-01')).percentComplete,
    ).toBe(0);
    expect(
      summariseProgress([], span('2024-01-01', '2026-01-01', '2026-01-01')).percentComplete,
    ).toBe(100);
  });

  it('never exceeds 100, however long it is left', () => {
    expect(
      summariseProgress([], span('2024-01-01', '2026-01-01', '2030-01-01')).percentComplete,
    ).toBe(100);
  });

  it('stays at zero when nothing is known about the term', () => {
    /* No maturity date is not a 0% plan, it is an unanswerable question — and
       the honest answer to that is the same zero it always gave. */
    expect(summariseProgress([], span('2024-01-01', null, '2025-01-01')).percentComplete).toBe(0);
    expect(summariseProgress([]).percentComplete).toBe(0);
  });

  it('refuses to divide by a term that ends before it starts', () => {
    expect(
      summariseProgress([], span('2026-01-01', '2024-01-01', '2025-01-01')).percentComplete,
    ).toBe(0);
  });

  it('leaves a plan with instalments counting instalments', () => {
    /* The dates are supplied and deliberately ignored: somebody who skipped
       three months of a DPS is not as far along as somebody who did not, and a
       ring driven by the calendar would say they were. */
    const rows = [
      { status: 'PAID', expectedMinor: 100_000 },
      { status: 'DUE', expectedMinor: 100_000 },
      { status: 'DUE', expectedMinor: 100_000 },
      { status: 'DUE', expectedMinor: 100_000 },
    ];
    expect(
      summariseProgress(rows, span('2024-01-01', '2026-01-01', '2025-12-01')).percentComplete,
    ).toBe(25);
  });
});
