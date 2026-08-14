import { describe, expect, it } from 'vitest';
import {
  TaxRegimeMissingError,
  estimateTax,
  fiscalYearOf,
  fiscalYearRange,
  rebateFor,
  surchargeFor,
  taxBySlabs,
  type TaxRegime,
} from './tax.js';

/**
 * The tax engine.
 *
 * Every figure below is arithmetic against a regime defined *in this file*, not
 * against Bangladesh's real slabs. That is deliberate: these tests are about
 * whether the machine computes what a rate table tells it to, and the day the
 * Finance Act changes they must not all go red. Whether the table matches the
 * gazette is a human's job, recorded by the `verified` flag — see the refusal
 * test at the bottom, which is the most important one here.
 *
 * Round numbers throughout so a reader can check the sums in their head. Poisha,
 * so ৳100,000 is 10_000_000.
 */

const TK = (taka: number): number => taka * 100;

/** A deliberately simple regime: free to ৳3 lakh, then 10%, 20%, 30%. */
const REGIME: TaxRegime = {
  country: 'BD',
  fiscalYearStart: '2025-07-01',
  fiscalYearEnd: '2026-06-30',
  slabs: [
    { fromMinor: TK(300_000), rateBps: 0 },
    { fromMinor: TK(400_000), rateBps: 1000 },
    { fromMinor: TK(700_000), rateBps: 2000 },
    { fromMinor: TK(1_100_000), rateBps: 3000 },
  ],
  thresholdByCategory: {
    GENERAL: TK(300_000),
    WOMAN_OR_SENIOR: TK(400_000),
    DISABLED: TK(475_000),
  },
  rebate: {
    rateOfInvestmentBps: 1500,
    capShareOfIncomeBps: 300,
    capAbsoluteMinor: TK(1_000_000),
  },
  minimumTaxByArea: {
    DHAKA_CTG_CITY: TK(5_000),
    OTHER_CITY: TK(4_000),
    ELSEWHERE: TK(3_000),
  },
  surchargeBands: [
    { fromMinor: TK(40_000_000), rateBps: 1000 },
    { fromMinor: TK(100_000_000), rateBps: 2000 },
  ],
  sourceCitation: 'Test regime, not a real one',
  verified: true,
};

describe('taxBySlabs', () => {
  it('charges nothing at or below the threshold', () => {
    expect(taxBySlabs(TK(300_000), REGIME.slabs, TK(300_000)).totalMinor).toBe(0);
    expect(taxBySlabs(TK(120_000), REGIME.slabs, TK(300_000)).totalMinor).toBe(0);
  });

  it('charges band by band, not on the whole amount', () => {
    /* ৳5,00,000 against the table above: ৳3–4L at 0%, then ৳4–5L at 10% =
       ৳10,000. A rule that charged 10% on the lot would say ৳50,000, which is
       the mistake this test exists for. */
    const result = taxBySlabs(TK(500_000), REGIME.slabs, TK(300_000));
    expect(result.totalMinor).toBe(TK(10_000));
  });

  it('moves the first boundary for a category with a higher threshold, and no other', () => {
    /* A woman over 65 on ৳5,00,000: her threshold swallows the 0% band whole,
       so the first taka she is charged on is at 10% — ৳1,00,000 of it, giving
       ৳10,000. The rates above are untouched, which is the whole of what a
       category does. */
    const result = taxBySlabs(TK(500_000), REGIME.slabs, TK(400_000));
    expect(result.totalMinor).toBe(TK(10_000));
  });

  it('leaves the top band open-ended', () => {
    /* ৳20,00,000: ৳3L at 0%, ৳3L at 10% = ৳30,000, ৳4L at 20% = ৳80,000, and
       the remaining ৳9L at 30% = ৳2,70,000. The last band has to keep going
       rather than stopping at its own floor, which is what this checks. */
    const result = taxBySlabs(TK(2_000_000), REGIME.slabs, TK(300_000));
    expect(result.totalMinor).toBe(TK(30_000) + TK(80_000) + TK(270_000));
  });

  it('never produces a fraction of a poisha', () => {
    /* 55 poisha inside the 10% band. Floats would give 5.5 of a poisha here and
       the ledger has no room for half of one. */
    const result = taxBySlabs(TK(400_000) + 55, REGIME.slabs, TK(300_000));
    expect(Number.isInteger(result.totalMinor)).toBe(true);
    expect(result.totalMinor).toBe(5);
  });
});

describe('rebateFor', () => {
  it('takes the investment percentage when that is the smallest', () => {
    /* ৳1,00,000 invested at 15% = ৳15,000, against 3% of ৳10,00,000 = ৳30,000
       and an absolute cap of ৳10,00,000. */
    const result = rebateFor(TK(1_000_000), TK(100_000), REGIME.rebate);
    expect(result.amountMinor).toBe(TK(15_000));
    expect(result.boundBy).toBe('investment');
  });

  it('is capped by income when somebody invests a great deal', () => {
    /* ৳50,00,000 invested at 15% would be ৳7,50,000 — but 3% of ৳10,00,000 is
       ৳30,000, and the lower cap wins. Saying *which* cap bound it is why this
       returns a reason and not only a number. */
    const result = rebateFor(TK(1_000_000), TK(5_000_000), REGIME.rebate);
    expect(result.amountMinor).toBe(TK(30_000));
    expect(result.boundBy).toBe('income');
  });

  it('is never negative, whatever it is handed', () => {
    expect(rebateFor(0, 0, REGIME.rebate).amountMinor).toBe(0);
  });
});

describe('surchargeFor', () => {
  it('is nothing below the first band', () => {
    expect(surchargeFor(TK(10_000_000), TK(100_000), REGIME.surchargeBands).amountMinor).toBe(0);
  });

  it('takes the highest band the wealth reaches, not the first', () => {
    /* ৳12 crore is above both bands; the 20% one applies, not the 10%. Taking
       the first match is the classic version of this bug. */
    const result = surchargeFor(TK(120_000_000), TK(100_000), REGIME.surchargeBands);
    expect(result.rateBps).toBe(2000);
    expect(result.amountMinor).toBe(TK(20_000));
  });

  it('charges on the tax, not on the wealth', () => {
    const result = surchargeFor(TK(50_000_000), TK(100_000), REGIME.surchargeBands);
    expect(result.amountMinor).toBe(TK(10_000));
  });
});

describe('estimateTax', () => {
  const inputs = {
    incomeByHead: { SALARY: TK(800_000), HOUSE_PROPERTY: TK(200_000) },
    eligibleInvestmentMinor: TK(100_000),
    netWealthMinor: TK(5_000_000),
    taxDeductedAtSourceMinor: TK(20_000),
    category: 'GENERAL',
    area: 'DHAKA_CTG_CITY',
  };

  it('walks the whole computation and shows every step', () => {
    const result = estimateTax(inputs, REGIME);

    expect(result.totalIncomeMinor).toBe(TK(1_000_000));
    // ৳3L free, ৳3L at 10% = ৳30,000, ৳3L at 20% = ৳60,000
    expect(result.grossTaxMinor).toBe(TK(30_000) + TK(60_000));
    // 15% of ৳1,00,000 invested, which is below both other caps
    expect(result.rebateMinor).toBe(TK(15_000));
    expect(result.netTaxMinor).toBe(TK(75_000));
    // …less ৳20,000 already deducted at source
    expect(result.payableMinor).toBe(TK(55_000));

    /* The worksheet is the point. A total nobody can trace is a total nobody
       should act on. */
    const keys = result.lines.map((line) => line.key);
    expect(keys).toContain('income.SALARY');
    expect(keys).toContain('income.HOUSE_PROPERTY');
    expect(keys).toContain('grossTax');
    expect(keys).toContain('rebate');
    expect(keys).toContain('tds');
    expect(keys).toContain('payable');
  });

  it('shows a refund as a negative rather than hiding it at zero', () => {
    /* Over-deducted at source. Clamping this to zero would quietly lose the
       fact that the person is owed money. */
    const result = estimateTax({ ...inputs, taxDeductedAtSourceMinor: TK(500_000) }, REGIME);
    expect(result.payableMinor).toBeLessThan(0);
  });

  it('does not let a rebate larger than the tax become a refund', () => {
    const result = estimateTax(
      { ...inputs, eligibleInvestmentMinor: TK(50_000_000), taxDeductedAtSourceMinor: 0 },
      REGIME,
    );
    expect(result.netTaxMinor).toBeGreaterThanOrEqual(0);
  });

  it('applies the minimum tax as a floor, not as an addition', () => {
    /* Just over the threshold: the slab computation gives ৳100, the floor is
       ৳5,000, and the answer is ৳5,000 — not ৳5,100. */
    const result = estimateTax(
      {
        ...inputs,
        incomeByHead: { SALARY: TK(301_000) },
        eligibleInvestmentMinor: 0,
        taxDeductedAtSourceMinor: 0,
        netWealthMinor: 0,
      },
      REGIME,
    );
    expect(result.payableMinor).toBe(TK(5_000));
  });

  it('refuses outright when the year has not been verified', () => {
    /* The most important test in this file.
     *
     * A figure computed on last year's slabs looks exactly like one computed on
     * this year's, and the person carrying it to their accountant cannot tell.
     * So an unchecked regime produces no number at all — not a warning beside a
     * number, which people read past. */
    expect(() => estimateTax(inputs, { ...REGIME, verified: false })).toThrow(
      TaxRegimeMissingError,
    );
  });

  it('refuses a category or an area the table does not define', () => {
    expect(() => estimateTax({ ...inputs, category: 'MADE_UP' }, REGIME)).toThrow(
      TaxRegimeMissingError,
    );
    expect(() => estimateTax({ ...inputs, area: 'MADE_UP' }, REGIME)).toThrow(
      TaxRegimeMissingError,
    );
  });
});

describe('the fiscal year', () => {
  it('runs July to June', () => {
    expect(fiscalYearOf('2026-08-15')).toBe('2026-27');
    expect(fiscalYearOf('2026-05-15')).toBe('2025-26');
    /* The two days either side of the boundary, which is the only part of this
       anybody gets wrong. */
    expect(fiscalYearOf('2026-06-30')).toBe('2025-26');
    expect(fiscalYearOf('2026-07-01')).toBe('2026-27');
  });

  it('gives the inclusive bounds of a named year', () => {
    expect(fiscalYearRange('2025-26')).toEqual({ from: '2025-07-01', to: '2026-06-30' });
  });

  it('handles a January start for the country that has one', () => {
    expect(fiscalYearOf('2026-03-01', 1)).toBe('2026-27');
    expect(fiscalYearRange('2026-27', 1)).toEqual({ from: '2026-01-01', to: '2026-12-31' });
  });
});
