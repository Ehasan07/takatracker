import { describe, expect, it } from 'vitest';
import {
  buildStatement,
  deriveLoanStatus,
  loanInterestMinor,
  nextLoanNumber,
  presetRange,
  summariseLoan,
  totalPayableMinor,
  type DatePreset,
  type LoanProgress,
  type LoanTerms,
} from './loans.js';

/**
 * Every figure below is one two people could check against each other on paper.
 * Amounts are poisha, so ৳100,000 is 10,000,000 — the comment beside each
 * number says it in taka.
 *
 * Dates are built from local components on purpose. The loan functions read
 * local calendar days, so a test written this way gives the same answer on a
 * laptop in Dhaka and in CI running UTC.
 */
const on = (year: number, month: number, day: number): Date => new Date(year, month - 1, day);

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/** 'YYYY-MM-DD HH:MM:SS.mmm' in local time, so a bound can be asserted whole. */
const stamp = (d: Date): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
  `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;

/** ৳100,000 lent to a cousin on new year's day, no interest, due in a year. */
const interestFree: LoanTerms = {
  principalMinor: 10_000_000,
  interestType: 'NONE',
  interestMinor: 0,
  interestRateBps: 0,
  loanDate: on(2026, 1, 1),
  dueDate: on(2026, 12, 31),
};

/** ৳100,000 at 10% a year, due exactly 365 days later on 1 Jan 2027. */
const atTenPercent: LoanTerms = {
  principalMinor: 10_000_000,
  interestType: 'PERCENT',
  interestMinor: 0,
  interestRateBps: 1000,
  loanDate: on(2026, 1, 1),
  dueDate: on(2027, 1, 1),
};

/** ৳30,000 borrowed from a colleague with a flat ৳2,000 agreed on top. */
const flatFee: LoanTerms = {
  principalMinor: 3_000_000,
  interestType: 'FIXED',
  interestMinor: 200_000,
  interestRateBps: 0,
  loanDate: on(2026, 3, 1),
  dueDate: on(2026, 9, 1),
};

describe('loanInterestMinor — NONE', () => {
  it('is zero, which is what most household lending here actually is', () => {
    expect(loanInterestMinor(interestFree, on(2026, 12, 31))).toBe(0);
  });

  it('stays zero even if a rate was left behind in the record', () => {
    /* A user who typed a rate and then switched the loan to "no interest" must
     * not be quietly charged it. The type is the agreement; the rate is a
     * leftover field. */
    expect(loanInterestMinor({ ...interestFree, interestRateBps: 1200 }, on(2026, 12, 31))).toBe(0);
  });
});

describe('loanInterestMinor — FIXED', () => {
  it('is the agreed lump sum: ৳2,000', () => {
    expect(loanInterestMinor(flatFee, on(2026, 9, 1))).toBe(200_000);
  });

  it('does not grow with time, because a flat fee is the point of a flat fee', () => {
    // One day in and two years late must both read ৳2,000.
    expect(loanInterestMinor(flatFee, on(2026, 3, 2))).toBe(200_000);
    expect(loanInterestMinor(flatFee, on(2028, 3, 2))).toBe(200_000);
  });
});

describe('loanInterestMinor — PERCENT', () => {
  it('charges the full annual rate after exactly one year', () => {
    // ৳100,000 at 10% for 365 days = ৳10,000 exactly, to the poisha.
    expect(loanInterestMinor(atTenPercent, on(2027, 1, 1))).toBe(1_000_000);
  });

  it('charges a fifth of the year for a fifth of the time', () => {
    /* 1 Jan to 15 Mar 2026 is 73 days, which is 365 ÷ 5. Simple interest, so
     * the answer is ৳10,000 ÷ 5 = ৳2,000. If this ever reads more, something
     * has started compounding. */
    expect(loanInterestMinor(atTenPercent, on(2026, 3, 15))).toBe(200_000);
  });

  it('is zero on the day the money changed hands', () => {
    expect(loanInterestMinor(atTenPercent, on(2026, 1, 1))).toBe(0);
  });

  it('is zero for a date before the loan existed', () => {
    // Guards against a negative-day span quietly producing negative interest.
    expect(loanInterestMinor(atTenPercent, on(2025, 12, 1))).toBe(0);
  });

  it('freezes at the due date instead of growing forever', () => {
    /* Eighteen months past the deadline the debt is a fixed sum being chased,
     * not a balance still compounding. A failure here means a loan left unpaid
     * would keep inflating until the number is one nobody would ever agree to. */
    expect(loanInterestMinor(atTenPercent, on(2028, 6, 30))).toBe(1_000_000);
  });

  it('keeps accruing when no due date was ever agreed', () => {
    // Two years open-ended at 10% = ৳20,000; there is no deadline to stop at.
    const openEnded: LoanTerms = { ...atTenPercent, dueDate: null };
    expect(loanInterestMinor(openEnded, on(2028, 1, 1))).toBe(2_000_000);
  });

  it('never produces a fractional poisha, however awkward the rate', () => {
    const awkward: LoanTerms = {
      ...atTenPercent,
      principalMinor: 7_777_777,
      interestRateBps: 837,
      dueDate: null,
    };
    expect(Number.isInteger(loanInterestMinor(awkward, on(2026, 4, 11)))).toBe(true);
  });
});

describe('totalPayableMinor', () => {
  it('is the bare principal when there is no interest', () => {
    expect(totalPayableMinor(interestFree, on(2026, 12, 31))).toBe(10_000_000);
  });

  it('adds the flat fee: ৳30,000 + ৳2,000 = ৳32,000', () => {
    expect(totalPayableMinor(flatFee, on(2026, 9, 1))).toBe(3_200_000);
  });

  it('adds accrued interest: ৳100,000 + ৳10,000 after a year', () => {
    expect(totalPayableMinor(atTenPercent, on(2027, 1, 1))).toBe(11_000_000);
  });

  it('is always an integer number of poisha', () => {
    const awkward: LoanTerms = { ...atTenPercent, principalMinor: 7_777_777, interestRateBps: 837 };
    expect(Number.isInteger(totalPayableMinor(awkward, on(2026, 4, 11)))).toBe(true);
  });
});

describe('summariseLoan — the worked example', () => {
  /* ৳100,000 lent interest-free, repaid ৳20,000 then ৳15,000 then ৳10,000.
   * ৳45,000 has come back, so ৳55,000 is still out there. */
  const payments = [
    { amountMinor: 2_000_000 },
    { amountMinor: 1_500_000 },
    { amountMinor: 1_000_000 },
  ];
  const progress = summariseLoan(interestFree, payments, on(2026, 6, 1));

  it('owes ৳100,000 in total, because nothing was charged on top', () => {
    expect(progress.totalPayableMinor).toBe(10_000_000);
  });

  it('counts ৳45,000 paid across three instalments', () => {
    expect(progress.paidMinor).toBe(4_500_000);
    expect(progress.paymentCount).toBe(3);
  });

  it('leaves ৳55,000 outstanding', () => {
    // The number the lender is actually waiting for. Everything else is decoration.
    expect(progress.outstandingMinor).toBe(5_500_000);
  });

  it('is 45% of the way through', () => {
    expect(progress.percentPaid).toBe(45);
  });

  it('is not settled, and is not late either — the due date is months away', () => {
    expect(progress.isSettled).toBe(false);
    expect(progress.daysOverdue).toBeLessThan(0);
    expect(deriveLoanStatus(progress)).toBe('ACTIVE');
  });

  it('keeps every money figure an integer number of poisha', () => {
    expect(Number.isInteger(progress.totalPayableMinor)).toBe(true);
    expect(Number.isInteger(progress.paidMinor)).toBe(true);
    expect(Number.isInteger(progress.outstandingMinor)).toBe(true);
  });
});

describe('summariseLoan — settling up', () => {
  const all = [
    { amountMinor: 2_000_000 },
    { amountMinor: 1_500_000 },
    { amountMinor: 1_000_000 },
    { amountMinor: 5_500_000 }, // the final ৳55,000
  ];

  it('lands on exactly zero, not on a stray poisha', () => {
    expect(summariseLoan(interestFree, all, on(2026, 11, 1)).outstandingMinor).toBe(0);
  });

  it('reads as settled, full, and COMPLETED', () => {
    const progress = summariseLoan(interestFree, all, on(2026, 11, 1));
    expect(progress.isSettled).toBe(true);
    expect(progress.percentPaid).toBe(100);
    expect(deriveLoanStatus(progress)).toBe('COMPLETED');
  });

  it('reports no payments and nothing paid on a brand new loan', () => {
    const progress = summariseLoan(interestFree, [], on(2026, 1, 1));
    expect(progress.paidMinor).toBe(0);
    expect(progress.paymentCount).toBe(0);
    expect(progress.percentPaid).toBe(0);
    expect(progress.outstandingMinor).toBe(10_000_000);
  });

  it('rounds the percentage to one decimal place', () => {
    // ৳33,333.33 of ৳100,000 is 33.333333…%, which a ring should show as 33.3%.
    expect(
      summariseLoan(interestFree, [{ amountMinor: 3_333_333 }], on(2026, 6, 1)).percentPaid,
    ).toBe(33.3);
  });
});

describe('summariseLoan — overpayment', () => {
  // Clearing ৳100,000 with ৳105,000 because the borrower rounded up.
  const progress = summariseLoan(interestFree, [{ amountMinor: 10_500_000 }], on(2026, 6, 1));

  it('clamps outstanding at zero instead of showing a debt the other way', () => {
    /* -৳5,000 outstanding would read as the lender now owing the borrower,
     * which is not what happened: they were handed ৳5,000 extra. */
    expect(progress.outstandingMinor).toBe(0);
  });

  it('clamps the ring at 100% rather than 105%', () => {
    expect(progress.percentPaid).toBe(100);
  });

  it('still remembers the full ৳105,000 that actually came in', () => {
    expect(progress.paidMinor).toBe(10_500_000);
    expect(progress.isSettled).toBe(true);
  });
});

describe('summariseLoan — how late it is', () => {
  const overdueTerms: LoanTerms = { ...interestFree, dueDate: on(2026, 1, 31) };

  it('counts three days across a month boundary', () => {
    /* 31 Jan to 3 Feb is three days. The failure this catches is day arithmetic
     * done inside a single month, which reports 3 − 31 = −28 in February. */
    const progress = summariseLoan(overdueTerms, [], on(2026, 2, 3));
    expect(progress.daysOverdue).toBe(3);
    expect(deriveLoanStatus(progress)).toBe('OVERDUE');
  });

  it('counts backwards while the due date is still ahead', () => {
    expect(summariseLoan(overdueTerms, [], on(2026, 1, 28)).daysOverdue).toBe(-3);
  });

  it('is zero on the due date itself, which is not yet late', () => {
    const progress = summariseLoan(overdueTerms, [], on(2026, 1, 31));
    expect(progress.daysOverdue).toBe(0);
    expect(deriveLoanStatus(progress)).toBe('ACTIVE');
  });

  it('is zero when no due date was agreed — nothing to be late for', () => {
    const openEnded: LoanTerms = { ...interestFree, dueDate: null };
    expect(summariseLoan(openEnded, [], on(2030, 1, 1)).daysOverdue).toBe(0);
  });

  it('is zero once the loan is settled, however long it took', () => {
    // A cleared debt is not late. A badge shouting "৩ দিন পার" at it is a bug.
    const progress = summariseLoan(overdueTerms, [{ amountMinor: 10_000_000 }], on(2026, 2, 3));
    expect(progress.daysOverdue).toBe(0);
    expect(progress.isSettled).toBe(true);
  });

  it('ignores the time of day, so an evening check is not a day late', () => {
    const evening = new Date(2026, 0, 31, 22, 30, 0, 0);
    expect(summariseLoan(overdueTerms, [], evening).daysOverdue).toBe(0);
  });
});

describe('deriveLoanStatus', () => {
  const base: LoanProgress = {
    totalPayableMinor: 10_000_000,
    paidMinor: 0,
    outstandingMinor: 10_000_000,
    percentPaid: 0,
    paymentCount: 0,
    daysOverdue: -10,
    isSettled: false,
  };

  it('is ACTIVE while money is owed and the date has not passed', () => {
    expect(deriveLoanStatus(base)).toBe('ACTIVE');
  });

  it('is OVERDUE from the first day past the date', () => {
    expect(deriveLoanStatus({ ...base, daysOverdue: 1 })).toBe('OVERDUE');
  });

  it('is COMPLETED once settled, even if it was repaid late', () => {
    /* Settled beats overdue: the list exists for chasing people, and a finished
     * loan is nobody to chase. */
    expect(
      deriveLoanStatus({ ...base, outstandingMinor: 0, isSettled: true, daysOverdue: 45 }),
    ).toBe('COMPLETED');
  });
});

describe('buildStatement', () => {
  // ৳100,000 lent, then the same three instalments back.
  const opening = 10_000_000;
  const movements = [
    { date: on(2026, 2, 10), description: 'প্রথম কিস্তি', deltaMinor: -2_000_000 },
    { date: on(2026, 3, 10), description: 'দ্বিতীয় কিস্তি', deltaMinor: -1_500_000 },
    { date: on(2026, 4, 10), description: 'তৃতীয় কিস্তি', deltaMinor: -1_000_000 },
  ];

  it('runs the balance down to the ৳55,000 still outstanding', () => {
    const statement = buildStatement(opening, movements);
    expect(statement.rows.map((r) => r.balanceMinor)).toEqual([8_000_000, 6_500_000, 5_500_000]);
  });

  it('closes on the balance of the last row', () => {
    /* The closing figure is what gets checked against the control account. If
     * it ever disagrees with the final row, a movement was dropped. */
    const statement = buildStatement(opening, movements);
    expect(statement.closingMinor).toBe(5_500_000);
    expect(statement.closingMinor).toBe(statement.rows[statement.rows.length - 1]?.balanceMinor);
  });

  it('reports the opening balance back unchanged', () => {
    expect(buildStatement(opening, movements).openingMinor).toBe(10_000_000);
  });

  it('puts a repayment in the credit column and nothing in the debit column', () => {
    const row = buildStatement(opening, movements).rows[0];
    expect(row?.creditMinor).toBe(2_000_000);
    expect(row?.debitMinor).toBe(0);
  });

  it('puts more money lent in the debit column', () => {
    // A second ৳5,000 handed over increases what is owed.
    const statement = buildStatement(opening, [
      { date: on(2026, 2, 10), description: 'আরও ধার', deltaMinor: 500_000 },
    ]);
    expect(statement.rows[0]?.debitMinor).toBe(500_000);
    expect(statement.rows[0]?.creditMinor).toBe(0);
    expect(statement.closingMinor).toBe(10_500_000);
  });

  it('sorts movements by date, because a running balance on an unsorted list is nonsense', () => {
    const shuffled = [movements[2]!, movements[0]!, movements[1]!];
    const statement = buildStatement(opening, shuffled);
    expect(statement.rows.map((r) => r.description)).toEqual([
      'প্রথম কিস্তি',
      'দ্বিতীয় কিস্তি',
      'তৃতীয় কিস্তি',
    ]);
    expect(statement.closingMinor).toBe(5_500_000);
  });

  it('keeps same-day movements in the order they were given', () => {
    const sameDay = [
      { date: on(2026, 2, 10), description: 'সকাল', deltaMinor: -1_000_000 },
      { date: on(2026, 2, 10), description: 'বিকাল', deltaMinor: -500_000 },
    ];
    expect(buildStatement(opening, sameDay).rows.map((r) => r.description)).toEqual([
      'সকাল',
      'বিকাল',
    ]);
  });

  it('closes where it opened when nothing happened', () => {
    const statement = buildStatement(opening, []);
    expect(statement.rows).toHaveLength(0);
    expect(statement.closingMinor).toBe(10_000_000);
  });

  it('refuses a fractional poisha loudly rather than drifting', () => {
    // sumMinor throws on a non-integer; a statement that silently absorbed one
    // would be a poisha off the control account with nothing to show why.
    expect(() =>
      buildStatement(opening, [{ date: on(2026, 2, 10), description: 'ভুল', deltaMinor: -0.5 }]),
    ).toThrow(TypeError);
  });
});

describe('presetRange', () => {
  // A Sunday afternoon in March, deliberately not midnight.
  const today = new Date(2026, 2, 15, 13, 45, 30, 123);

  it('covers the whole of today, including a transaction recorded at 11pm', () => {
    const range = presetRange('today', today);
    expect(stamp(range.from)).toBe('2026-03-15 00:00:00.000');
    expect(stamp(range.to)).toBe('2026-03-15 23:59:59.999');
  });

  it('covers the whole of yesterday', () => {
    const range = presetRange('yesterday', today);
    expect(stamp(range.from)).toBe('2026-03-14 00:00:00.000');
    expect(stamp(range.to)).toBe('2026-03-14 23:59:59.999');
  });

  it('rolls yesterday back into the previous month on the 1st', () => {
    const range = presetRange('yesterday', new Date(2026, 2, 1, 9, 0));
    expect(stamp(range.from)).toBe('2026-02-28 00:00:00.000');
  });

  it('makes last7 seven days ending today, not eight and not excluding today', () => {
    // 9th to 15th inclusive is seven days, which is what the chip promises.
    const range = presetRange('last7', today);
    expect(stamp(range.from)).toBe('2026-03-09 00:00:00.000');
    expect(stamp(range.to)).toBe('2026-03-15 23:59:59.999');
  });

  it('covers the whole calendar month, not just month-to-date', () => {
    const range = presetRange('thisMonth', today);
    expect(stamp(range.from)).toBe('2026-03-01 00:00:00.000');
    expect(stamp(range.to)).toBe('2026-03-31 23:59:59.999');
  });

  it('ends thisMonth on the real last day of a 30-day month', () => {
    const range = presetRange('thisMonth', new Date(2026, 3, 20));
    expect(stamp(range.to)).toBe('2026-04-30 23:59:59.999');
  });

  it('covers the whole of last month', () => {
    const range = presetRange('lastMonth', today);
    expect(stamp(range.from)).toBe('2026-02-01 00:00:00.000');
    expect(stamp(range.to)).toBe('2026-02-28 23:59:59.999');
  });

  it('steps lastMonth back across new year', () => {
    const range = presetRange('lastMonth', new Date(2026, 0, 10));
    expect(stamp(range.from)).toBe('2025-12-01 00:00:00.000');
    expect(stamp(range.to)).toBe('2025-12-31 23:59:59.999');
  });

  it('gets the extra day in a leap February', () => {
    const range = presetRange('lastMonth', new Date(2028, 2, 5));
    expect(stamp(range.to)).toBe('2028-02-29 23:59:59.999');
  });

  it('covers January to December for thisYear', () => {
    const range = presetRange('thisYear', today);
    expect(stamp(range.from)).toBe('2026-01-01 00:00:00.000');
    expect(stamp(range.to)).toBe('2026-12-31 23:59:59.999');
  });

  it('always ends a range at the last millisecond of the day', () => {
    const presets = ['today', 'yesterday', 'last7', 'thisMonth', 'lastMonth', 'thisYear'] as const;
    for (const preset of presets) {
      const { from, to } = presetRange(preset, today);
      expect(from.getTime()).toBeLessThan(to.getTime());
      expect(to.getMilliseconds()).toBe(999);
    }
  });

  it('throws on a preset it does not know, instead of showing the wrong month', () => {
    // Presets arrive from a URL, so an unknown one is a real possibility.
    expect(() => presetRange('lastDecade' as unknown as DatePreset, today)).toThrow(TypeError);
  });
});

describe('nextLoanNumber', () => {
  it('starts at L-0001 for a workspace with no loans', () => {
    expect(nextLoanNumber([])).toBe('L-0001');
  });

  it('follows on from the last one', () => {
    expect(nextLoanNumber(['L-0001', 'L-0002'])).toBe('L-0003');
  });

  it('takes the highest, not the count, so a gap is not reused', () => {
    /* Numbering from the count would hand out L-0004 when L-0007 already
     * exists, and the next insert would collide on the unique index. */
    expect(nextLoanNumber(['L-0001', 'L-0007', 'L-0003'])).toBe('L-0008');
  });

  it('does not care what order the list arrives in', () => {
    expect(nextLoanNumber(['L-0007', 'L-0003', 'L-0001'])).toBe('L-0008');
  });

  it('ignores anything that is not a loan number rather than throwing', () => {
    // One malformed imported row must not stop the user recording a loan.
    expect(nextLoanNumber(['L-0001', 'LOAN-2', 'L-', '', 'L-abc', 'L-0004'])).toBe('L-0005');
  });

  it('still issues a number when every entry is malformed', () => {
    expect(nextLoanNumber(['rubbish', '—', 'L'])).toBe('L-0001');
  });

  it('tolerates stray whitespace and lower case from imported data', () => {
    /* Reading ' l-0004 ' as garbage would restart the sequence at L-0001 and
     * collide on the very next insert. */
    expect(nextLoanNumber([' l-0004 '])).toBe('L-0005');
  });

  it('grows past four digits instead of wrapping back into a used number', () => {
    expect(nextLoanNumber(['L-9999'])).toBe('L-10000');
  });

  it('always pads to four digits', () => {
    expect(nextLoanNumber(['L-0042'])).toBe('L-0043');
    expect(nextLoanNumber(['L-99'])).toBe('L-0100');
  });
});

describe('a repaid loan stays repaid', () => {
  /* The defect this guards: interest that keeps accruing after the debt is
   * cleared. A loan settled on Sunday grew a fresh day of interest on Monday,
   * flipped back to ACTIVE, and started asking for money nobody owed. */
  const terms: LoanTerms = {
    principalMinor: 10_000_000, // ৳1,00,000
    interestType: 'PERCENT',
    interestMinor: 0,
    interestRateBps: 1000, // 10%
    loanDate: new Date(2026, 0, 1),
    dueDate: new Date(2026, 11, 31), // still ahead when it is repaid
  };

  const settlementDay = new Date(2026, 5, 1);
  const owedThatDay = totalPayableMinor(terms, settlementDay);

  it('is settled on the day the final payment lands', () => {
    const progress = summariseLoan(
      terms,
      [{ amountMinor: owedThatDay, date: settlementDay }],
      settlementDay,
    );
    expect(progress.outstandingMinor).toBe(0);
    expect(deriveLoanStatus(progress)).toBe('COMPLETED');
  });

  it('does not reopen the next morning', () => {
    const nextDay = new Date(2026, 5, 2);
    const progress = summariseLoan(
      terms,
      [{ amountMinor: owedThatDay, date: settlementDay }],
      nextDay,
    );
    expect(progress.outstandingMinor).toBe(0);
    expect(deriveLoanStatus(progress)).toBe('COMPLETED');
  });

  it('is still settled months later', () => {
    const muchLater = new Date(2026, 10, 20);
    const progress = summariseLoan(
      terms,
      [{ amountMinor: owedThatDay, date: settlementDay }],
      muchLater,
    );
    expect(progress.totalPayableMinor).toBe(owedThatDay);
    expect(progress.outstandingMinor).toBe(0);
    expect(progress.daysOverdue).toBe(0);
  });

  it('keeps accruing while it is only partly repaid', () => {
    const half = Math.trunc(owedThatDay / 2);
    const later = new Date(2026, 7, 1);
    const progress = summariseLoan(terms, [{ amountMinor: half, date: settlementDay }], later);
    // Two more months of interest, so more is owed than on settlement day.
    expect(progress.totalPayableMinor).toBeGreaterThan(owedThatDay);
    expect(progress.outstandingMinor).toBeGreaterThan(0);
  });

  it('falls back to accruing to today when payments carry no dates', () => {
    // An undated payment cannot tell us when the debt was cleared, so the old
    // behaviour stands rather than guessing a settlement day.
    const later = new Date(2026, 7, 1);
    const progress = summariseLoan(terms, [{ amountMinor: owedThatDay }], later);
    expect(progress.totalPayableMinor).toBe(totalPayableMinor(terms, later));
  });

  it('leaves an interest-free loan exactly as it was', () => {
    const free: LoanTerms = { ...terms, interestType: 'NONE', interestRateBps: 0 };
    const progress = summariseLoan(
      free,
      [{ amountMinor: 10_000_000, date: settlementDay }],
      new Date(2026, 10, 20),
    );
    expect(progress.totalPayableMinor).toBe(10_000_000);
    expect(progress.outstandingMinor).toBe(0);
  });
});
