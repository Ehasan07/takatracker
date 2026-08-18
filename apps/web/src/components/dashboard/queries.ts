'use client';

/**
 * The two requests the dashboard's analysis panels make, and the shapes they
 * come back in.
 *
 * ## Two, for four panels
 *
 * Nothing here is a new endpoint. `GET /reports/income-statement` already takes
 * a second window under `compareFrom`/`compareTo` and answers both in one round
 * trip — totals *and* the category tree for each — which is the comparison
 * table, the month's pace and the biggest movers between them. `GET
 * /reports/trend` already returns whole calendar months ending at this one,
 * which is the six-month picture and, as its second-to-last point, all of last
 * month.
 *
 * That mattered enough to check before writing anything: the alternative was
 * four fetches on the app's first screen, two of which the server already
 * answers together.
 *
 * ## Why the keys start with `reports`
 *
 * `invalidateAfterWrite` marks `['reports']` stale after every transaction, and
 * these figures are derived from entries like everything else under that
 * prefix. A key of its own would have left the dashboard showing last month's
 * comparison until a reload.
 *
 * ## Why the types are declared here and not imported
 *
 * `app/(shell)/reports/types.ts` describes the same responses. These are a
 * deliberate, narrow copy of the fields this screen reads: the reports screen
 * owns that file and is free to reshape it around its own panels, and a
 * dashboard that broke because a report changed a field it does not render
 * would be a coupling nobody asked for.
 */

import { api } from '@/lib/api';
import type { DayWindow } from './month';

/** One node of the category tree — parents, with children already rolled in. */
export interface CategoryNodeDto {
  categoryId: string | null;
  name: string;
  totalMinor: number;
  /** The parent's own spending plus every child's. This is the figure to compare. */
  rolledUpMinor: number;
}

export interface StatementFiguresDto {
  incomeMinor: number;
  expenseMinor: number;
  surplusMinor: number;
  income: CategoryNodeDto[];
  expenses: CategoryNodeDto[];
}

export interface IncomeStatementDto extends StatementFiguresDto {
  from: string;
  to: string;
  comparison?: StatementFiguresDto & { from: string; to: string };
}

/** `GET /reports/trend` — whole calendar months, oldest first, ending at this one. */
export interface TrendPointDto {
  /** `YYYY-MM`. */
  month: string;
  incomeMinor: number;
  expenseMinor: number;
  netMinor: number;
}

/**
 * How many months the trend shows.
 *
 * Six rather than twelve: `FlowBars` gives a six-month series 60px columns and
 * a twelve-month one 44px, and twelve 44px columns is 528px — wider than the
 * panel on a 1280px two-column layout, so it would arrive scrolling sideways
 * inside its own box on the screen it was added to fill. Six months is also
 * about as far back as "is this month normal?" is actually asking.
 */
export const TREND_MONTHS = 6;

export const dashboardKeys = {
  statement: (current: DayWindow, previous: DayWindow) =>
    [
      'reports',
      'dashboard',
      'statement',
      current.from,
      current.to,
      previous.from,
      previous.to,
    ] as const,
  trend: (months: number) => ['reports', 'trend', months] as const,
};

export function fetchDashboardStatement(
  current: DayWindow,
  previous: DayWindow,
): Promise<IncomeStatementDto> {
  const params = new URLSearchParams({
    from: current.from,
    to: current.to,
    compareFrom: previous.from,
    compareTo: previous.to,
  });
  return api<IncomeStatementDto>(`/reports/income-statement?${params.toString()}`);
}

export function fetchTrend(months: number): Promise<TrendPointDto[]> {
  return api<TrendPointDto[]>(`/reports/trend?months=${months}`);
}
