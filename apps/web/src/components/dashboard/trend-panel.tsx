'use client';

/**
 * Six months of money in and money out, so "is this month bad?" has something to
 * be bad compared to.
 *
 * One month against one month says which of two was worse. Six says whether
 * either was unusual — an August that looks alarming beside July is often the
 * fourth August in a row that looks like that, and a household that can see the
 * shape stops treating a normal month as an emergency.
 *
 * The chart is `components/charts/flow-bars.tsx`, unchanged: bars that diverge
 * from a shared baseline so the income/expense distinction is carried by
 * *direction* and not by the red/green pair one man in twelve cannot separate.
 * It already ships its own legend, its own `aria-label` with every figure in it,
 * and the same numbers as a table underneath. Nothing here re-draws any of that.
 */

import { useQuery } from '@tanstack/react-query';
import { FlowBars } from '@/components/charts/flow-bars';
import { fmtNumber } from '@/lib/format';
import { t } from '@/lib/t';
import { DashError, DashPanel, DashSkeleton } from './parts';
import { TREND_MONTHS, dashboardKeys, fetchTrend } from './queries';
import type { MonthComparison } from './month';

/**
 * Month names short enough for a 44px column.
 *
 * The same catalogue keys the reports screen's chart uses, deliberately: two
 * charts in one product that spell আগস্ট differently under their bars is the
 * sort of detail that makes an app feel assembled rather than built. Resolved
 * once at module load, which is safe because a language change reloads the page
 * — see `lib/t.ts`.
 */
const SHORT_MONTHS: readonly string[] = [
  t('reports.month.1', 'জানু'),
  t('reports.month.2', 'ফেব্রু'),
  t('reports.month.3', 'মার্চ'),
  t('reports.month.4', 'এপ্রি'),
  t('reports.month.5', 'মে'),
  t('reports.month.6', 'জুন'),
  t('reports.month.7', 'জুলা'),
  t('reports.month.8', 'আগ'),
  t('reports.month.9', 'সেপ্ট'),
  t('reports.month.10', 'অক্টো'),
  t('reports.month.11', 'নভে'),
  t('reports.month.12', 'ডিসে'),
];

const shortMonth = (key: string): string => SHORT_MONTHS[Number(key.slice(5, 7)) - 1] ?? key;

export function TrendPanel({ month, className }: { month: MonthComparison; className?: string }) {
  const trend = useQuery({
    queryKey: dashboardKeys.trend(TREND_MONTHS),
    queryFn: () => fetchTrend(TREND_MONTHS),
  });

  const points = trend.data ?? [];

  return (
    <DashPanel
      className={className}
      testId="dashboard-trend"
      title={t('dashboard.trend.title', 'মাসভিত্তিক আয় ও খরচ')}
      scope={t('dashboard.trend.scope', 'শেষ {n} মাস').replace('{n}', fmtNumber(TREND_MONTHS))}
    >
      {trend.isError ? (
        <DashError
          message={t('dashboard.trend.failed', 'মাসভিত্তিক হিসাব আনা যায়নি।')}
          onRetry={() => void trend.refetch()}
        />
      ) : trend.isPending ? (
        <DashSkeleton rows={3} />
      ) : points.length === 0 ? (
        <p className="text-ink-muted mt-3 text-sm">
          {t('dashboard.trend.empty', 'দেখানোর মতো কোনো মাস নেই।')}
        </p>
      ) : (
        <>
          <FlowBars
            className="mt-3"
            title={t('dashboard.trend.title', 'মাসভিত্তিক আয় ও খরচ')}
            incomeLabel={t('dashboard.income', 'আয়')}
            expenseLabel={t('dashboard.expense', 'খরচ')}
            points={points.map((point) => ({
              key: point.month,
              label: shortMonth(point.month),
              incomeMinor: point.incomeMinor,
              expenseMinor: point.expenseMinor,
            }))}
          />
          {/* The last column is a month that has not finished. Without this line
              every reader draws the same wrong conclusion on the 5th — that
              income has collapsed — from a bar that is simply five days long. */}
          {!month.complete && points.at(-1)?.month === month.currentMonth ? (
            <p className="text-ink-muted mt-2 text-xs">
              {t(
                'dashboard.trend.partial',
                'শেষ কলামটি চলতি মাস — মাস এখনও শেষ হয়নি, তাই এটি ছোট দেখাবে।',
              )}
            </p>
          ) : null}
        </>
      )}
    </DashPanel>
  );
}
