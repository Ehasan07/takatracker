'use client';

/**
 * Where the month is going, while there is still month left to change it.
 *
 * ## The question
 *
 * A month's totals are only useful on the 1st of the next one. Halfway through,
 * the thing worth knowing is whether this month is on course to be better or
 * worse than the last — and that is not a number anybody can read off "খরচ
 * ৳32,000", because it depends entirely on whether that ৳32,000 is eight days'
 * worth or twenty-six.
 *
 * ## Two bars on one scale
 *
 * How much of the month has gone, and how much of *last month's whole spending*
 * has gone. Both are percentages of their own whole, so they share a 0–100 axis
 * and the answer is the gap between them: the money bar ahead of the calendar
 * bar means this month is running hot. That comparison is carried by length and
 * position rather than by hue, and the sentence underneath says which it is in
 * words, because a bar chart nobody can read the colours of still has to work.
 *
 * ## What it refuses to say
 *
 * A month that spent nothing last month has no percentage to be a share of —
 * "০%" and "∞%" are both false, so the panel says there is nothing to compare
 * against and shows what has been spent. And it makes no projection from the
 * first four days of a month: a rate from four days is noise, and printing it in
 * the same type as the exact figures would be the least trustworthy number on
 * the screen dressed as one of the most.
 */

import { useQuery } from '@tanstack/react-query';
import { Money } from '@/components/money';
import { fmtNumber } from '@/lib/format';
import { t } from '@/lib/t';
import { cn } from '@/lib/utils';
import { DashError, DashPanel, DashSkeleton } from './parts';
import { TREND_MONTHS, dashboardKeys, fetchDashboardStatement, fetchTrend } from './queries';
import { pace, type MonthComparison } from './month';

/** Percentages are pixels here, never money. A bar cannot run past its track. */
const clamp = (percent: number): number => Math.max(0, Math.min(100, percent));

/** Whole percent for a label — one decimal place is precision nobody needs here. */
const asPercent = (value: number): string => fmtNumber(Math.floor(value + 0.5));

/**
 * The gap at which the two bars are worth calling different.
 *
 * Five points of a month is about a day and a half. Under that, "faster" and
 * "slower" are both overstating what the arithmetic knows, so the verdict is
 * "about the same" — which is a real answer, not a hedge.
 */
const SAME_PACE_POINTS = 5;

export function PacePanel({ month, className }: { month: MonthComparison; className?: string }) {
  const statement = useQuery({
    queryKey: dashboardKeys.statement(month.current, month.previous),
    queryFn: () => fetchDashboardStatement(month.current, month.previous),
  });
  /* The same request the trend panel makes, under the same key — one fetch,
     and the two panels cannot be a moment apart from each other. */
  const trend = useQuery({
    queryKey: dashboardKeys.trend(TREND_MONTHS),
    queryFn: () => fetchTrend(TREND_MONTHS),
  });

  const spentMinor = statement.data?.expenseMinor ?? 0;
  const lastMonthFull =
    trend.data?.find((point) => point.month === month.previousMonth)?.expenseMinor ?? 0;

  const measured = pace(month, spentMinor, lastMonthFull);
  const failed = statement.isError || trend.isError;
  const loading = statement.isPending || trend.isPending;

  const bars: readonly (readonly [string, number, string, string | null])[] = [
    [
      t('dashboard.pace.monthGone', 'মাস পেরিয়েছে'),
      measured.elapsedPercent,
      'bg-ink-muted',
      t('dashboard.pace.days', '{n} / {m} দিন')
        .replace('{n}', fmtNumber(month.current.days))
        .replace('{m}', fmtNumber(month.daysInMonth)),
    ],
    [
      t('dashboard.pace.spentOfLast', 'গত মাসের খরচের'),
      measured.spentPercent ?? 0,
      'bg-expense',
      null,
    ],
  ];

  return (
    <DashPanel
      className={className}
      testId="dashboard-pace"
      title={t('dashboard.pace.title', 'মাসের গতি')}
      scope={t('dashboard.pace.scope', 'এ পর্যন্ত খরচ, গত মাসের পুরো খরচের সঙ্গে মিলিয়ে')}
    >
      {failed ? (
        <DashError
          message={t('dashboard.pace.failed', 'মাসের গতি আনা যায়নি।')}
          onRetry={() => {
            void statement.refetch();
            void trend.refetch();
          }}
        />
      ) : loading ? (
        <DashSkeleton rows={2} />
      ) : (
        <>
          <p className="mt-2 flex items-baseline justify-between gap-3">
            <span className="text-ink-muted text-xs">
              {t('dashboard.pace.spentSoFar', 'এ পর্যন্ত খরচ')}
            </span>
            <Money minor={spentMinor} className="text-expense text-xl font-bold" decimals={false} />
          </p>

          {measured.spentPercent === null ? (
            /* No base, so no bars: one bar alone on a two-bar scale invites the
               eye to compare it with the empty track beside it, which is a
               comparison with nothing. */
            <p className="text-ink-muted mt-3 text-sm">
              {t('dashboard.pace.noBase', 'গত মাসে কোনো খরচ ছিল না, তাই গতির তুলনা করা যাচ্ছে না।')}
            </p>
          ) : (
            <>
              <div className="mt-3 flex flex-col gap-2">
                {bars.map(([label, percent, fill, note]) => (
                  <div key={label}>
                    <p className="flex items-baseline justify-between gap-2 text-xs">
                      <span className="text-ink-muted min-w-0 truncate">
                        {label}
                        {note ? ` · ${note}` : ''}
                      </span>
                      <span className="text-ink shrink-0 font-medium">{asPercent(percent)}%</span>
                    </p>
                    <div className="bg-greenbar mt-1 h-2 w-full overflow-hidden rounded-full">
                      <div
                        className={cn('h-2 rounded-full motion-safe:transition-all', fill)}
                        style={{ width: `${clamp(percent)}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>

              {/* The answer, in a sentence, for the reader who does not want to
                  measure two bars against each other by eye. */}
              <p className="text-ink mt-3 text-sm">
                {verdict(measured.elapsedPercent, measured.spentPercent)}
              </p>
              <p className="text-ink-muted mt-1 flex items-baseline justify-between gap-3 text-xs">
                <span>{t('dashboard.pace.lastMonthWhole', 'গত মাসে পুরো মাসে খরচ')}</span>
                <Money minor={lastMonthFull} className="shrink-0" decimals={false} />
              </p>
            </>
          )}

          {/* An estimate, labelled as one, and absent when it would be a guess
              dressed up as arithmetic. */}
          <p className="text-ink-muted border-rule mt-3 border-t pt-2 text-xs">
            {measured.projectedMinor === null ? (
              month.complete ? (
                t('dashboard.pace.monthOver', 'মাস শেষ — উপরের সংখ্যাটাই পুরো মাসের খরচ।')
              ) : (
                t('dashboard.pace.tooEarly', 'মাস সবে শুরু — অনুমান করার মতো যথেষ্ট দিন যায়নি।')
              )
            ) : (
              <>
                {t('dashboard.pace.projection', 'এই গতি চললে মাস শেষে প্রায়')}{' '}
                <Money minor={measured.projectedMinor} className="text-ink" decimals={false} />{' '}
                {t('dashboard.pace.estimate', '— এটি হিসাব নয়, অনুমান।')}
              </>
            )}
          </p>
        </>
      )}
    </DashPanel>
  );
}

function verdict(elapsedPercent: number, spentPercent: number): string {
  const gap = spentPercent - elapsedPercent;
  if (gap > SAME_PACE_POINTS) {
    return t('dashboard.pace.faster', 'গত মাসের চেয়ে দ্রুত খরচ হচ্ছে।');
  }
  if (gap < -SAME_PACE_POINTS) {
    return t('dashboard.pace.slower', 'গত মাসের চেয়ে ধীরে খরচ হচ্ছে।');
  }
  return t('dashboard.pace.same', 'গত মাসের প্রায় একই গতিতে খরচ হচ্ছে।');
}
