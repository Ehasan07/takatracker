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
 */

import { api } from '@/lib/api';
import { periodQuery, type Period } from './range';
import type {
  BalanceSheetDto,
  ByCategoryDto,
  ByTagDto,
  CashFlowDto,
  DrilldownDto,
  Kind,
  TrendPoint,
} from './types';

export const reportKeys = {
  all: ['reports'] as const,
  byCategory: (kind: Kind, period: Period) =>
    ['reports', 'by-category', kind, period.from, period.to] as const,
  byTag: (kind: Kind, period: Period) =>
    ['reports', 'by-tag', kind, period.from, period.to] as const,
  trend: (months: number) => ['reports', 'trend', months] as const,
  balanceSheet: () => ['reports', 'balance-sheet'] as const,
  cashFlow: (period: Period) => ['reports', 'cash-flow', period.from, period.to] as const,
  drilldown: (id: string, period: Period) =>
    ['reports', 'drilldown', id, period.from, period.to] as const,
};

export function fetchByCategory(kind: Kind, period: Period): Promise<ByCategoryDto> {
  return api<ByCategoryDto>(`/reports/by-category?kind=${kind}&${periodQuery(period)}`);
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

export function fetchDrilldown(id: string, period: Period): Promise<DrilldownDto> {
  return api<DrilldownDto>(`/reports/category/${id}?${periodQuery(period)}`);
}
