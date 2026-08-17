'use client';

/**
 * Every request this screen makes, with the range in the key.
 *
 * The keys all begin `['reports']`, which is the prefix `invalidateAfterImport`
 * and the transaction mutations already invalidate — a range in the key must
 * not put these caches out of that net.
 *
 * Which endpoints take the range, and which do not:
 *
 *   by-category    from, to          — range
 *   by-tag         from, to          — range
 *   cash-flow      from, to          — range
 *   category/:id   from, to          — range
 *   trend          months only       — always ends at the current month; the
 *                                      range is applied by asking for enough
 *                                      months and cutting the answer down
 *   balance-sheet  (nothing)         — point in time, and that point is now
 *   card-statements (nothing)        — point in time, and the point is a day
 *                                      each card picks, not one the reader can
 */

import { api } from '@/lib/api';
import { periodQuery, type Period } from './range';
import type {
  BalanceSheetDto,
  ByCategoryDto,
  ByCategoryFlatDto,
  ByTagDto,
  CardStatementsDto,
  CashFlowDto,
  DrilldownDto,
  IncomeStatementDto,
  Kind,
  NetWorthChangesDto,
  TrendPoint,
} from './types';

export const reportKeys = {
  all: ['reports'] as const,
  byCategory: (kind: Kind, period: Period) =>
    ['reports', 'by-category', kind, period.from, period.to] as const,
  byCategoryFlat: (kind: Kind, period: Period) =>
    ['reports', 'by-category', 'flat', kind, period.from, period.to] as const,
  byTag: (kind: Kind, period: Period) =>
    ['reports', 'by-tag', kind, period.from, period.to] as const,
  trend: (months: number) => ['reports', 'trend', months] as const,
  balanceSheet: () => ['reports', 'balance-sheet'] as const,
  cashFlow: (period: Period) => ['reports', 'cash-flow', period.from, period.to] as const,
  drilldown: (id: string, period: Period) =>
    ['reports', 'drilldown', id, period.from, period.to] as const,
  incomeStatement: (period: Period, compare?: Period) =>
    ['reports', 'income-statement', period.from, period.to, compare?.from, compare?.to] as const,
  netWorthChanges: (period: Period) =>
    ['reports', 'net-worth-changes', period.from, period.to] as const,
  balanceSheetAt: (asOf: string) => ['reports', 'balance-sheet', asOf] as const,
  cardStatements: () => ['reports', 'card-statements'] as const,
};

export function fetchByCategory(kind: Kind, period: Period): Promise<ByCategoryDto> {
  return api<ByCategoryDto>(`/reports/by-category?kind=${kind}&${periodQuery(period)}`);
}

/**
 * The same period with nothing rolled up — `flat=1`, a parameter the endpoint
 * has always taken and nothing on this screen had asked for.
 *
 * No new route was needed for the উপ-খাত view, which is the point of checking
 * what the API already answers before adding to it.
 */
export function fetchByCategoryFlat(kind: Kind, period: Period): Promise<ByCategoryFlatDto> {
  return api<ByCategoryFlatDto>(`/reports/by-category?kind=${kind}&flat=1&${periodQuery(period)}`);
}

export function fetchByTag(kind: Kind, period: Period): Promise<ByTagDto> {
  return api<ByTagDto>(`/reports/by-tag?kind=${kind}&${periodQuery(period)}`);
}

export function fetchTrend(months: number): Promise<TrendPoint[]> {
  return api<TrendPoint[]>(`/reports/trend?months=${months}`);
}

export function fetchBalanceSheet(): Promise<BalanceSheetDto> {
  return api<BalanceSheetDto>('/reports/balance-sheet');
}

export function fetchCashFlow(period: Period): Promise<CashFlowDto> {
  return api<CashFlowDto>(`/reports/cash-flow?${periodQuery(period)}`);
}

export function fetchIncomeStatement(
  period: Period,
  compare?: Period,
): Promise<IncomeStatementDto> {
  const extra = compare ? `&compareFrom=${compare.from}&compareTo=${compare.to}` : '';
  return api<IncomeStatementDto>(`/reports/income-statement?${periodQuery(period)}${extra}`);
}

export function fetchNetWorthChanges(period: Period): Promise<NetWorthChangesDto> {
  return api<NetWorthChangesDto>(`/reports/net-worth-changes?${periodQuery(period)}`);
}

/**
 * What each card's last bill says is owed. No range and no `asOf`: a statement
 * closes on a day the card decides, so there is nothing here for a date picker
 * to change — the response carries the day every figure on it is true for.
 */
export function fetchCardStatements(): Promise<CardStatementsDto> {
  return api<CardStatementsDto>('/reports/card-statements');
}

/** The sheet as at one day, which is what a statement for a period needs. */
export function fetchBalanceSheetAt(asOf: string): Promise<BalanceSheetDto> {
  return api<BalanceSheetDto>(`/reports/balance-sheet?asOf=${asOf}`);
}

export function fetchDrilldown(id: string, period: Period): Promise<DrilldownDto> {
  return api<DrilldownDto>(`/reports/category/${id}?${periodQuery(period)}`);
}
