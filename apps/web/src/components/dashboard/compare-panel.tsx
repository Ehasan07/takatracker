'use client';

/**
 * This month against last month — the one panel a finance dashboard is expected
 * to have, and the one this screen did not.
 *
 * ## The comparison is like-for-like or it is not made
 *
 * The eighteenth of August is compared with the first eighteen days of July, not
 * with July. Comparing a part of a month against a whole one is how a dashboard
 * reports a 40% fall in spending every month until the 25th and a sudden crisis
 * on the 31st, and it is wrong in a way that looks entirely convincing. Both
 * windows are "the first N days of a month", they are named on the panel in
 * dates, and when February makes them different lengths the panel says so
 * instead of presenting them as equals. See `month.ts`.
 *
 * ## Why it is a table
 *
 * Three figures against three figures is a table — it is what QuickBooks shows,
 * what every set of accounts prints, and what lets somebody read *down* a column
 * for the shape of a month and *across* a row for what changed. A row of chips
 * would have been easier to lay out and would have answered a different, smaller
 * question.
 */

import { useQuery } from '@tanstack/react-query';
import { Money } from '@/components/money';
import { fmtDate, fmtNumber } from '@/lib/format';
import { t } from '@/lib/t';
import { cn } from '@/lib/utils';
import { ChangeNote, DashError, DashPanel, DashSkeleton } from './parts';
import { dashboardKeys, fetchDashboardStatement } from './queries';
import type { MonthComparison } from './month';

export function ComparePanel({ month, className }: { month: MonthComparison; className?: string }) {
  const statement = useQuery({
    queryKey: dashboardKeys.statement(month.current, month.previous),
    queryFn: () => fetchDashboardStatement(month.current, month.previous),
  });

  const scope = `${fmtDate(month.current.from)} — ${fmtDate(month.current.to)}`;
  const comparison = t('dashboard.vsLastMonth', 'গত মাসের একই সময়ে');

  const current = statement.data;
  const previous = statement.data?.comparison;

  /* The three lines of an income statement, each with the direction that counts
     as good news. নিট is the only one that can be negative, so it is the only
     one whose own colour is allowed to follow its sign. */
  const rows =
    current && previous
      ? ([
          [
            t('dashboard.income', 'আয়'),
            current.incomeMinor,
            previous.incomeMinor,
            'up',
            'text-income',
          ],
          [
            t('dashboard.expense', 'খরচ'),
            current.expenseMinor,
            previous.expenseMinor,
            'down',
            'text-expense',
          ],
          [t('dashboard.net', 'নিট'), current.surplusMinor, previous.surplusMinor, 'up', ''],
        ] as const)
      : [];

  return (
    <DashPanel
      className={className}
      testId="dashboard-compare"
      title={t('dashboard.compare.title', 'এই মাস বনাম গত মাস')}
      scope={scope}
    >
      {statement.isError ? (
        <DashError
          message={t('dashboard.compare.failed', 'তুলনার হিসাব আনা যায়নি।')}
          onRetry={() => void statement.refetch()}
        />
      ) : statement.isPending || !previous ? (
        <DashSkeleton rows={3} />
      ) : (
        <>
          <table className="mt-3 w-full text-sm">
            <thead>
              <tr className="text-ink-muted text-xs">
                <th scope="col" className="pb-1 text-left font-normal">
                  <span className="sr-only">{t('dashboard.compare.figure', 'হিসাব')}</span>
                </th>
                <th scope="col" className="pb-1 text-right font-normal">
                  {t('dashboard.compare.thisMonth', 'এই মাস')}
                </th>
                <th scope="col" className="pb-1 text-right font-normal">
                  {t('dashboard.compare.lastMonth', 'গত মাস')}
                </th>
              </tr>
            </thead>
            {rows.map(([label, now, before, goodWhen, tone]) => (
              <tbody key={label} className="border-rule border-t">
                <tr>
                  <th scope="row" className="text-ink py-1.5 text-left font-normal">
                    {label}
                  </th>
                  <td className="py-1.5 text-right">
                    <Money
                      minor={now}
                      colored={tone === ''}
                      signed={tone === ''}
                      decimals={false}
                      className={cn('font-semibold', tone)}
                    />
                  </td>
                  <td className="text-ink-muted py-1.5 text-right">
                    <Money minor={before} signed={tone === ''} decimals={false} />
                  </td>
                </tr>
                <tr>
                  {/* The change spans the width rather than squeezing into a
                      fourth column: at 320px a fourth money column is what
                      pushes a page sideways, and the sentence form carries the
                      word "বেড়েছে" that the arrow and the colour only imply. */}
                  <td colSpan={3} className="pb-2">
                    <ChangeNote
                      currentMinor={now}
                      previousMinor={before}
                      goodWhen={goodWhen}
                      comparison={comparison}
                    />
                  </td>
                </tr>
              </tbody>
            ))}
          </table>

          {/* What the two columns actually cover, said in the case where it is
              not obvious. A reader who does not know the right-hand column stops
              on the 18th will read it as a whole month and conclude the wrong
              thing — which is the entire failure this panel was built to avoid. */}
          <p className="text-ink-muted mt-2 text-xs">
            {month.complete
              ? t('dashboard.compare.wholeMonths', 'মাস শেষ — দুই পাশেই পুরো মাসের হিসাব।')
              : t(
                  'dashboard.compare.sameStretch',
                  'দুই পাশেই মাসের প্রথম {n} দিনের হিসাব, যাতে তুলনাটা সমানে সমানে হয়।',
                ).replace('{n}', fmtNumber(month.current.days))}
          </p>
          {month.unevenDays ? (
            <p className="text-ink-muted mt-1 text-xs">
              {t(
                'dashboard.compare.unevenDays',
                'গত মাস ছোট ছিল — সেখানে {n} দিনের বেশি নেই, তাই ডান পাশে {n} দিনের হিসাব।',
              ).replace(/\{n\}/g, fmtNumber(month.previous.days))}
            </p>
          ) : null}
        </>
      )}
    </DashPanel>
  );
}
