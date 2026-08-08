import { isDebitNormal, sumMinor, type AccountType } from '@hishab/shared';

/**
 * Report assembly. The database does the grouping; this decides what the groups
 * *mean* — which account is an asset, what counts as cash, how a trend is
 * filled in — because those are the parts worth testing against numbers a human
 * worked out on paper.
 *
 * Pure functions, integer poisha throughout.
 */

export type BalanceClass = 'ASSET' | 'LIABILITY' | 'NOMINAL';

/**
 * Where each account type sits on a balance sheet.
 *
 * EQUITY is nominal: the three hidden system accounts absorb the other side of
 * every entry, so counting them would double everything.
 */
export const ACCOUNT_CLASS: Record<AccountType, BalanceClass> = {
  CASH: 'ASSET',
  BANK: 'ASSET',
  MOBILE_WALLET: 'ASSET',
  SAVINGS: 'ASSET',
  RECEIVABLE: 'ASSET',
  ASSET: 'ASSET',
  CREDIT_CARD: 'LIABILITY',
  PAYABLE: 'LIABILITY',
  LIABILITY: 'LIABILITY',
  EQUITY: 'NOMINAL',
};

/** Money you could spend today, as opposed to land or a receivable. */
export const LIQUID_TYPES: readonly AccountType[] = ['CASH', 'BANK', 'MOBILE_WALLET'];

export interface AccountBalanceRow {
  id: string;
  name: string;
  type: AccountType;
  /** Signed the way a human reads it: positive means the account holds value. */
  balanceMinor: number;
}

export interface BalanceSheetLine {
  id: string;
  name: string;
  type: AccountType;
  amountMinor: number;
}

export interface BalanceSheet {
  assetsMinor: number;
  liabilitiesMinor: number;
  netWorthMinor: number;
  liquidMinor: number;
  assets: BalanceSheetLine[];
  liabilities: BalanceSheetLine[];
}

/**
 * Net worth = assets − liabilities, always with the breakdown (spec §3.6:
 * never a bare number).
 *
 * A liability's balance is negative when money is owed, because the ledger
 * signs every account the same way. The sheet reports what is owed as a
 * positive figure, which is how anyone reads a balance sheet — and then
 * subtracts it.
 */
export function buildBalanceSheet(rows: readonly AccountBalanceRow[]): BalanceSheet {
  const assets: BalanceSheetLine[] = [];
  const liabilities: BalanceSheetLine[] = [];

  for (const row of rows) {
    const line = { id: row.id, name: row.name, type: row.type, amountMinor: row.balanceMinor };
    switch (ACCOUNT_CLASS[row.type]) {
      case 'ASSET':
        assets.push(line);
        break;
      case 'LIABILITY':
        liabilities.push({ ...line, amountMinor: -row.balanceMinor });
        break;
      default:
        break; // nominal: already reflected in the accounts above
    }
  }

  const assetsMinor = sumMinor(assets.map((a) => a.amountMinor));
  const liabilitiesMinor = sumMinor(liabilities.map((l) => l.amountMinor));
  const liquidMinor = sumMinor(
    rows.filter((r) => LIQUID_TYPES.includes(r.type)).map((r) => r.balanceMinor),
  );

  return {
    assetsMinor,
    liabilitiesMinor,
    netWorthMinor: assetsMinor - liabilitiesMinor,
    liquidMinor,
    assets: assets.sort((a, b) => b.amountMinor - a.amountMinor),
    liabilities: liabilities.sort((a, b) => b.amountMinor - a.amountMinor),
  };
}

/** Signed effect of one entry on its own account, for cash-flow work. */
export function signedEffectFor(
  type: AccountType,
  direction: 'DEBIT' | 'CREDIT',
  amountMinor: number,
): number {
  return (direction === 'DEBIT') === isDebitNormal(type) ? amountMinor : -amountMinor;
}

// --- trend ------------------------------------------------------------------

export interface MonthTotals {
  month: string; // YYYY-MM
  incomeMinor: number;
  expenseMinor: number;
}

export interface TrendPoint extends MonthTotals {
  netMinor: number;
}

export function shiftMonthKey(month: string, delta: number): string {
  const [year, m] = month.split('-').map(Number) as [number, number];
  const zero = year * 12 + (m - 1) + delta;
  return `${String(Math.floor(zero / 12)).padStart(4, '0')}-${String((zero % 12) + 1).padStart(2, '0')}`;
}

/**
 * A contiguous series ending at `endMonth`. Months with no activity are filled
 * with zeros rather than omitted — a chart that silently skips an empty month
 * draws a straight line across it and invents a trend that never happened.
 */
export function buildTrend(
  rows: readonly MonthTotals[],
  endMonth: string,
  months: number,
): TrendPoint[] {
  const byMonth = new Map(rows.map((r) => [r.month, r]));
  const out: TrendPoint[] = [];

  for (let i = months - 1; i >= 0; i -= 1) {
    const month = shiftMonthKey(endMonth, -i);
    const found = byMonth.get(month);
    const incomeMinor = found?.incomeMinor ?? 0;
    const expenseMinor = found?.expenseMinor ?? 0;
    out.push({ month, incomeMinor, expenseMinor, netMinor: incomeMinor - expenseMinor });
  }

  return out;
}

// --- category breakdown ------------------------------------------------------

export interface CategoryTotal {
  categoryId: string | null;
  name: string;
  totalMinor: number;
}

export interface CategoryShare extends CategoryTotal {
  /** Percentage of the period's total, to one decimal, as a number. */
  sharePercent: number;
}

/**
 * Sorted largest first, with each slice's share of the whole. Shares are
 * computed from integer poisha and only become a percentage at the end, so no
 * rounding error creeps into the amounts themselves.
 */
export function withShares(rows: readonly CategoryTotal[]): CategoryShare[] {
  const total = sumMinor(rows.map((r) => r.totalMinor));
  return rows
    .slice()
    .sort((a, b) => b.totalMinor - a.totalMinor)
    .map((row) => ({
      ...row,
      sharePercent: total === 0 ? 0 : Math.floor((row.totalMinor / total) * 1000 + 0.5) / 10,
    }));
}

/** The n largest, with everything else folded into one "অন্যান্য" line. */
export function topWithRest(
  rows: readonly CategoryTotal[],
  n: number,
  restLabel = 'অন্যান্য',
): CategoryTotal[] {
  const sorted = rows.slice().sort((a, b) => b.totalMinor - a.totalMinor);
  if (sorted.length <= n) return sorted;

  const head = sorted.slice(0, n);
  const restTotal = sumMinor(sorted.slice(n).map((r) => r.totalMinor));
  if (restTotal === 0) return head;
  return [...head, { categoryId: null, name: restLabel, totalMinor: restTotal }];
}

// --- cash flow ---------------------------------------------------------------

export interface CashFlowInput {
  openingMinor: number;
  inflowMinor: number;
  outflowMinor: number;
}

export interface CashFlow extends CashFlowInput {
  netMinor: number;
  closingMinor: number;
}

/**
 * Opening plus what came in, minus what went out. The closing figure must equal
 * the account balance at the end of the period; a mismatch means an entry was
 * missed, so this is the report that catches a broken query.
 */
export function buildCashFlow(input: CashFlowInput): CashFlow {
  const netMinor = input.inflowMinor - input.outflowMinor;
  return { ...input, netMinor, closingMinor: input.openingMinor + netMinor };
}
