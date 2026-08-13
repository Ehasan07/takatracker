import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_CLASS,
  buildBalanceSheet,
  buildCashFlow,
  buildTrend,
  compareBalanceSheets,
  nextDateKey,
  rollUpToParents,
  shiftMonthKey,
  signedEffectFor,
  topWithRest,
  withShares,
  type AccountBalanceRow,
  type BalanceSheetTotals,
  type CategoryTotal,
} from './reports.js';

/**
 * The fixture below is worked out by hand once, in taka, and every expectation
 * refers back to it. That is what "numbers match a hand-checked fixture set"
 * means — if a query changes shape, these numbers do not move.
 *
 *   নগদ            ৳  1,200.00   asset, liquid
 *   ব্র্যাক ব্যাংক   ৳ 45,000.00   asset, liquid
 *   বিকাশ          ৳  3,300.50   asset, liquid
 *   ডিপিএস         ৳ 60,000.00   asset, not liquid
 *   জমি            ৳500,000.00   asset, not liquid
 *   করিম পাবে      ৳  5,000.00   receivable → asset
 *   ক্রেডিট কার্ড    −৳ 12,400.00   liability, ৳12,400 owed
 *   গাড়ির ঋণ       −৳150,000.00   liability
 *   দোকানের দেনা    −৳  2,500.00   payable → liability
 *   আয় (system)    −৳ 80,000.00   nominal, must be ignored
 *
 *   assets      = 1,200 + 45,000 + 3,300.50 + 60,000 + 500,000 + 5,000
 *               = ৳614,500.50   → 61,450,050 poisha
 *   liabilities = 12,400 + 150,000 + 2,500
 *               = ৳164,900.00   → 16,490,000 poisha
 *   net worth   = ৳449,600.50   → 44,960,050 poisha
 *   liquid      = 1,200 + 45,000 + 3,300.50 = ৳49,500.50 → 4,950,050 poisha
 */
const FIXTURE: AccountBalanceRow[] = [
  { id: 'a1', name: 'নগদ', type: 'CASH', balanceMinor: 120_000 },
  { id: 'a2', name: 'ব্র্যাক ব্যাংক', type: 'BANK', balanceMinor: 4_500_000 },
  { id: 'a3', name: 'বিকাশ', type: 'MOBILE_WALLET', balanceMinor: 330_050 },
  { id: 'a4', name: 'ডিপিএস', type: 'SAVINGS', balanceMinor: 6_000_000 },
  { id: 'a5', name: 'জমি', type: 'ASSET', balanceMinor: 50_000_000 },
  { id: 'a6', name: 'করিম পাবে', type: 'RECEIVABLE', balanceMinor: 500_000 },
  { id: 'l1', name: 'ক্রেডিট কার্ড', type: 'CREDIT_CARD', balanceMinor: -1_240_000 },
  { id: 'l2', name: 'গাড়ির ঋণ', type: 'LIABILITY', balanceMinor: -15_000_000 },
  { id: 'l3', name: 'দোকানের দেনা', type: 'PAYABLE', balanceMinor: -250_000 },
  { id: 's1', name: 'আয়', type: 'EQUITY', balanceMinor: -8_000_000 },
];

describe('balance sheet', () => {
  const sheet = buildBalanceSheet(FIXTURE);

  it('adds up to the hand-checked totals', () => {
    expect(sheet.assetsMinor).toBe(61_450_050);
    expect(sheet.liabilitiesMinor).toBe(16_490_000);
    expect(sheet.netWorthMinor).toBe(44_960_050);
  });

  it('separates what could actually be spent today', () => {
    expect(sheet.liquidMinor).toBe(4_950_050);
  });

  it('reports what is owed as a positive figure and then subtracts it', () => {
    const card = sheet.liabilities.find((l) => l.id === 'l1');
    expect(card?.amountMinor).toBe(1_240_000);
    expect(sheet.assetsMinor - sheet.liabilitiesMinor).toBe(sheet.netWorthMinor);
  });

  it('ignores the hidden nominal accounts, which would double everything', () => {
    expect(ACCOUNT_CLASS.EQUITY).toBe('NOMINAL');
    expect([...sheet.assets, ...sheet.liabilities].some((l) => l.id === 's1')).toBe(false);
  });

  it('shows the breakdown, largest first, never a bare number', () => {
    expect(sheet.assets[0]?.name).toBe('জমি');
    expect(sheet.liabilities[0]?.name).toBe('গাড়ির ঋণ');
    expect(sheet.assets).toHaveLength(6);
    expect(sheet.liabilities).toHaveLength(3);
  });

  it('handles an empty workspace without dividing by anything', () => {
    const empty = buildBalanceSheet([]);
    expect(empty).toMatchObject({ assetsMinor: 0, liabilitiesMinor: 0, netWorthMinor: 0 });
  });

  it('classifies every account type', () => {
    for (const [type, klass] of Object.entries(ACCOUNT_CLASS)) {
      expect(['ASSET', 'LIABILITY', 'NOMINAL'], type).toContain(klass);
    }
  });
});

describe('day after', () => {
  it('crosses a month, a year and a leap day without a special case', () => {
    expect(nextDateKey('2026-06-15')).toBe('2026-06-16');
    expect(nextDateKey('2026-06-30')).toBe('2026-07-01');
    expect(nextDateKey('2026-12-31')).toBe('2027-01-01');
    expect(nextDateKey('2024-02-28')).toBe('2024-02-29');
    expect(nextDateKey('2026-02-28')).toBe('2026-03-01');
  });

  it('refuses anything that is not a ledger date', () => {
    expect(() => nextDateKey('15-06-2026')).toThrow(TypeError);
    expect(() => nextDateKey('2026-6-5')).toThrow(TypeError);
  });
});

describe('balance sheet comparison', () => {
  /**
   * জুন থেকে আগস্ট, worked out by hand:
   *
   *   জুন    assets ৳500,000  liabilities ৳100,000  net ৳400,000  liquid ৳50,000
   *   আগস্ট  assets ৳520,000  liabilities ৳ 88,000  net ৳432,000  liquid ৳62,000
   *
   *   net worth up ৳32,000 → 3,200,000 poisha, +8.0% of ৳400,000
   *   liabilities down ৳12,000 → −1,200,000 poisha
   */
  const june: BalanceSheetTotals = {
    assetsMinor: 50_000_000,
    liabilitiesMinor: 10_000_000,
    netWorthMinor: 40_000_000,
    liquidMinor: 5_000_000,
  };
  const august: BalanceSheetTotals = {
    assetsMinor: 52_000_000,
    liabilitiesMinor: 8_800_000,
    netWorthMinor: 43_200_000,
    liquidMinor: 6_200_000,
  };

  it('reports the earlier figures alongside the movement', () => {
    const cmp = compareBalanceSheets(august, june);
    expect(cmp.netWorthMinor).toBe(40_000_000);
    expect(cmp.changeMinor.netWorthMinor).toBe(3_200_000);
    expect(cmp.changeMinor.liquidMinor).toBe(1_200_000);
    expect(cmp.netWorthChangePercent).toBe(8);
  });

  it('makes paying a debt down read as a fall in liabilities', () => {
    // A negative here is good news, and the screen has to be able to say so.
    expect(compareBalanceSheets(august, june).changeMinor.liabilitiesMinor).toBe(-1_200_000);
  });

  it('does not invent a percentage out of nothing', () => {
    const nothing: BalanceSheetTotals = {
      assetsMinor: 0,
      liabilitiesMinor: 0,
      netWorthMinor: 0,
      liquidMinor: 0,
    };
    // Growth from zero has no percentage; a fabricated 100% would be a lie on
    // somebody's first month.
    expect(compareBalanceSheets(august, nothing).netWorthChangePercent).toBeNull();
  });

  it('calls climbing out of debt a rise, not a fall', () => {
    const inDebt: BalanceSheetTotals = { ...june, netWorthMinor: -1_000_000 };
    const halfway: BalanceSheetTotals = { ...august, netWorthMinor: -500_000 };
    const cmp = compareBalanceSheets(halfway, inDebt);
    expect(cmp.changeMinor.netWorthMinor).toBe(500_000);
    // Dividing by the signed −৳10,000 would print −50% for an improvement.
    expect(cmp.netWorthChangePercent).toBe(50);
  });

  it('takes a whole sheet, so the comparison cannot re-sum it differently', () => {
    const sheet = buildBalanceSheet(FIXTURE);
    const cmp = compareBalanceSheets(sheet, buildBalanceSheet([]));
    expect(cmp.changeMinor.netWorthMinor).toBe(sheet.netWorthMinor);
    expect(cmp.netWorthChangePercent).toBeNull();
  });
});

describe('signed effect', () => {
  it('is positive when a debit-normal account is debited', () => {
    expect(signedEffectFor('CASH', 'DEBIT', 500)).toBe(500);
    expect(signedEffectFor('CASH', 'CREDIT', 500)).toBe(-500);
  });

  it('does not flip for a credit-normal account', () => {
    // Debits add and credits subtract whatever the account is, so a debt is
    // negative. See `signedEffect` in ledger.ts for why.
    expect(signedEffectFor('CREDIT_CARD', 'CREDIT', 500)).toBe(-500);
    expect(signedEffectFor('CREDIT_CARD', 'DEBIT', 500)).toBe(500);
  });
});

describe('month keys', () => {
  it('walks forwards and backwards across a year boundary', () => {
    expect(shiftMonthKey('2026-08', -1)).toBe('2026-07');
    expect(shiftMonthKey('2026-01', -1)).toBe('2025-12');
    expect(shiftMonthKey('2026-12', 1)).toBe('2027-01');
    expect(shiftMonthKey('2026-08', -12)).toBe('2025-08');
  });
});

describe('trend', () => {
  const rows = [
    { month: '2026-06', incomeMinor: 5_000_000, expenseMinor: 3_200_000 },
    // July deliberately missing — the user was away and recorded nothing.
    { month: '2026-08', incomeMinor: 5_500_000, expenseMinor: 6_100_000 },
  ];

  it('fills a quiet month with zeros rather than skipping it', () => {
    const series = buildTrend(rows, '2026-08', 3);
    expect(series.map((p) => p.month)).toEqual(['2026-06', '2026-07', '2026-08']);
    // Omitting July would make the chart draw a straight line across it and
    // invent a trend that never happened.
    expect(series[1]).toEqual({
      month: '2026-07',
      incomeMinor: 0,
      expenseMinor: 0,
      netMinor: 0,
    });
  });

  it('computes net per month', () => {
    const series = buildTrend(rows, '2026-08', 3);
    expect(series[0]?.netMinor).toBe(1_800_000);
    expect(series[2]?.netMinor).toBe(-600_000);
  });

  it('returns exactly the number of months asked for', () => {
    expect(buildTrend(rows, '2026-08', 12)).toHaveLength(12);
    expect(buildTrend([], '2026-08', 6)).toHaveLength(6);
  });
});

describe('category shares', () => {
  const rows: CategoryTotal[] = [
    { categoryId: 'c1', name: 'খাবার ও বাজার', totalMinor: 2_500_000 },
    { categoryId: 'c2', name: 'বাসা ভাড়া', totalMinor: 1_800_000 },
    { categoryId: 'c3', name: 'যাতায়াত', totalMinor: 700_000 },
  ];

  it('sorts largest first and shares sum to the whole', () => {
    const shares = withShares(rows);
    expect(shares[0]?.name).toBe('খাবার ও বাজার');
    // 25,000 / 50,000 = 50%, 18,000 = 36%, 7,000 = 14%
    expect(shares.map((s) => s.sharePercent)).toEqual([50, 36, 14]);
  });

  it('does not divide by zero on an empty period', () => {
    expect(withShares([{ categoryId: 'c1', name: 'x', totalMinor: 0 }])[0]?.sharePercent).toBe(0);
  });
});

describe('top with rest', () => {
  const rows: CategoryTotal[] = [
    { categoryId: 'a', name: 'A', totalMinor: 500 },
    { categoryId: 'b', name: 'B', totalMinor: 400 },
    { categoryId: 'c', name: 'C', totalMinor: 300 },
    { categoryId: 'd', name: 'D', totalMinor: 200 },
    { categoryId: 'e', name: 'E', totalMinor: 100 },
  ];

  it('folds the tail into one line and loses nothing', () => {
    const top = topWithRest(rows, 3);
    expect(top).toHaveLength(4);
    expect(top[3]).toEqual({ categoryId: null, name: 'অন্যান্য', totalMinor: 300 });
    expect(top.reduce((s, r) => s + r.totalMinor, 0)).toBe(1500);
  });

  it('leaves a short list alone', () => {
    expect(topWithRest(rows, 10)).toHaveLength(5);
  });
});

describe('cash flow', () => {
  it('closes where the balance should end up', () => {
    const flow = buildCashFlow({
      openingMinor: 1_000_000,
      inflowMinor: 5_000_000,
      outflowMinor: 3_250_000,
    });
    expect(flow.netMinor).toBe(1_750_000);
    // This is the figure that must equal the account's closing balance; a
    // mismatch means the query missed an entry.
    expect(flow.closingMinor).toBe(2_750_000);
  });

  it('handles a month that spent more than it earned', () => {
    const flow = buildCashFlow({ openingMinor: 100, inflowMinor: 0, outflowMinor: 500 });
    expect(flow.closingMinor).toBe(-400);
  });
});

describe('sub-category roll-up', () => {
  /**
   * যাতায়াত ৳500 of its own, with two children:
   *   ├ রিকশা   ৳300
   *   └ বাস     ৳200
   * খাবার ও বাজার has no spending of its own, only:
   *   └ সবজি    ৳900
   *
   * যাতায়াত rolls up to ৳1,000; খাবার rolls up to ৳900 and must still appear.
   */
  const parentOf = new Map<string, string | null>([
    ['transport', null],
    ['rickshaw', 'transport'],
    ['bus', 'transport'],
    ['food', null],
    ['veg', 'food'],
  ]);

  const rows = [
    { categoryId: 'transport', name: 'যাতায়াত', totalMinor: 50_000 },
    { categoryId: 'rickshaw', name: 'রিকশা', totalMinor: 30_000, parentName: 'যাতায়াত' },
    { categoryId: 'bus', name: 'বাস', totalMinor: 20_000, parentName: 'যাতায়াত' },
    { categoryId: 'veg', name: 'সবজি', totalMinor: 90_000, parentName: 'খাবার ও বাজার' },
  ];

  it('adds the children into the parent but keeps its own total separate', () => {
    const nodes = rollUpToParents(rows, parentOf);
    const transport = nodes.find((n) => n.categoryId === 'transport')!;
    expect(transport.totalMinor).toBe(50_000); // spent directly on "যাতায়াত"
    expect(transport.rolledUpMinor).toBe(100_000); // with রিকশা and বাস
    expect(transport.children.map((c) => c.name)).toEqual(['রিকশা', 'বাস']);
  });

  it('still shows a parent that has no spending of its own', () => {
    const nodes = rollUpToParents(rows, parentOf);
    const food = nodes.find((n) => n.categoryId === 'food')!;
    // Dropping it would make ৳900 vanish from the report.
    expect(food.name).toBe('খাবার ও বাজার');
    expect(food.totalMinor).toBe(0);
    expect(food.rolledUpMinor).toBe(90_000);
  });

  it('sorts by the rolled-up figure, which is what the reader compares', () => {
    const nodes = rollUpToParents(rows, parentOf);
    expect(nodes.map((n) => n.categoryId)).toEqual(['transport', 'food']);
  });

  it('loses nothing', () => {
    const nodes = rollUpToParents(rows, parentOf);
    expect(nodes.reduce((s, n) => s + n.rolledUpMinor, 0)).toBe(190_000);
  });

  it('keeps uncategorised money visible', () => {
    const nodes = rollUpToParents(
      [...rows, { categoryId: null, name: 'অশ্রেণিবদ্ধ', totalMinor: 10_000 }],
      parentOf,
    );
    expect(nodes.some((n) => n.categoryId === null)).toBe(true);
    expect(nodes.reduce((s, n) => s + n.rolledUpMinor, 0)).toBe(200_000);
  });
});

describe('current and non-current (IAS 1.60)', () => {
  const rows: AccountBalanceRow[] = [
    { id: 'c1', name: 'নগদ', type: 'CASH', balanceMinor: 100_000 },
    { id: 'b1', name: 'ব্যাংক', type: 'BANK', balanceMinor: 900_000 },
    { id: 'r1', name: 'ঋণ পাওনা', type: 'RECEIVABLE', balanceMinor: 500_000 },
    { id: 'd1', name: 'ডিপিএস', type: 'SAVINGS', balanceMinor: 2_000_000 },
    { id: 'l1', name: 'জমি', type: 'ASSET', balanceMinor: 50_000_000 },
    { id: 'cc', name: 'ক্রেডিট কার্ড', type: 'CREDIT_CARD', balanceMinor: -300_000 },
    { id: 'ln', name: 'গাড়ির ঋণ', type: 'LIABILITY', balanceMinor: -1_500_000 },
  ];

  it('puts what turns into cash within a year on the current side', () => {
    const sheet = buildBalanceSheet(rows);
    // নগদ + ব্যাংক + পাওনা
    expect(sheet.currentAssetsMinor).toBe(1_500_000);
    // ডিপিএস + জমি
    expect(sheet.nonCurrentAssetsMinor).toBe(52_000_000);
    expect(sheet.currentAssetsMinor + sheet.nonCurrentAssetsMinor).toBe(sheet.assetsMinor);
  });

  it('does the same on the liabilities side', () => {
    const sheet = buildBalanceSheet(rows);
    expect(sheet.currentLiabilitiesMinor).toBe(300_000);
    expect(sheet.nonCurrentLiabilitiesMinor).toBe(1_500_000);
    expect(sheet.currentLiabilitiesMinor + sheet.nonCurrentLiabilitiesMinor).toBe(
      sheet.liabilitiesMinor,
    );
  });

  it('reports working capital, which is the number a lender reads first', () => {
    const sheet = buildBalanceSheet(rows);
    expect(sheet.workingCapitalMinor).toBe(1_200_000);
  });

  it('separates a DPS from a bank balance, which is the point', () => {
    /* Both are "savings" in ordinary speech and only one of them can pay this
       month's rent. Counting a term deposit as current is how a statement tells
       somebody they are liquid when they are not. */
    const sheet = buildBalanceSheet(rows);
    expect(sheet.currentAssetsMinor).toBeLessThan(sheet.nonCurrentAssetsMinor);
  });
});
