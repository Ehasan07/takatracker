'use client';

/**
 * The reports screen.
 *
 * One date range at the top drives everything below it, and the range lives in
 * the URL so a view can be reloaded, bookmarked and pasted into a chat. With no
 * query string at all it resolves to the current month, which is what the API
 * assumes when it is sent nothing — so somebody who never touches the control
 * sees exactly what this screen showed before it had one.
 *
 * Two kinds of number live here and they must never be confused:
 *
 *   **Range** — সারসংক্ষেপ, খাতভিত্তিক হিসাব, নগদ প্রবাহ, and the drill-down.
 *     These answer "between these two dates" and every one of them sends
 *     `from` and `to`.
 *
 *   **As of** — নিট সম্পদ and সম্পদ ও দায়. A balance sheet is a photograph, not
 *     a film: `GET /v1/reports/balance-sheet` takes no arguments and reports
 *     the position *now*. Pretending the range applied to it would produce a
 *     net worth that looks like last March's and is today's. So it is labelled
 *     with the day it is true for and left alone.
 *
 * The trend chart is the awkward one. `GET /v1/reports/trend` takes `months`
 * and nothing else, always ending at the current calendar month, so the range
 * cannot be handed to it; instead it is asked for enough months to reach the
 * start of the range and the answer is cut down to the months the range covers.
 * Its bars are therefore whole calendar months — said so on screen whenever the
 * range does not line up with month boundaries, because a half-month range
 * showing a full month's bar is the sort of number that looks right and is not.
 */

import { useQuery } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import dynamic from 'next/dynamic';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';
import { formatMinor } from '@hishab/shared';
import { Money } from '@/components/money';
import { Skeleton, SkeletonCard } from '@/components/skeleton';
import { Select } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { t } from '@/lib/t';
import { Delta, Panel, PanelSkeleton, QueryError } from './parts';
import {
  fetchBalanceSheet,
  fetchByCategory,
  fetchCashFlow,
  fetchDrilldown,
  fetchTrend,
  reportKeys,
} from './queries';
import { RangeBar } from './range-bar';
import { QuantityPanel } from './quantity-panel';
import { TagPanel } from './tag-panel';
import {
  MAX_TREND_MONTHS,
  bnDate,
  bnNum,
  comparisonLabel,
  isoOf,
  periodLabel,
  previousPeriod,
  rangeParams,
  resolveRange,
  trendWindow,
  withinWindow,
  type ReportRange,
} from './range';
import type { Kind } from './types';

/* Categorical colours from the ledger palette, ordered so neighbouring slices
   stay distinguishable in both themes and for the most common colour-vision
   deficiencies. */
const SLICE_COLOURS = ['#1F6F4A', '#8E6C18', '#A8342A', '#4C7BA6', '#6B5B95', '#2E8B75'];

/* Recharts is bigger than the rest of this page put together, so it loads
   after the numbers do. The cards above the fold render immediately. */
const chartLoading = () => <Skeleton className="h-full w-full" />;

const TrendChart = dynamic(() => import('@/components/report-charts').then((m) => m.TrendChart), {
  ssr: false,
  loading: chartLoading,
});
const CategoryPie = dynamic(() => import('@/components/report-charts').then((m) => m.CategoryPie), {
  ssr: false,
  loading: chartLoading,
});

export function ReportsView() {
  /* "আজ" is a different day on the server than in the browser, and a range
     computed during the server render would hydrate into a different one. It is
     taken once, after mount — the same reason the loan statement stamps its
     print date in an effect. */
  const [today, setToday] = React.useState<Date | null>(null);
  React.useEffect(() => setToday((current) => current ?? new Date()), []);

  if (!today) {
    return (
      <div className="mx-auto grid w-full max-w-5xl grid-cols-1 gap-3 md:grid-cols-2">
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  return <ReportsBody today={today} />;
}

function ReportsBody({ today }: { today: Date }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const range = React.useMemo(() => resolveRange(params, today), [params, today]);
  const previous = React.useMemo(() => previousPeriod(range, today), [range, today]);
  const trendBounds = React.useMemo(() => trendWindow(range, today), [range, today]);
  const kind: Kind = params.get('kind') === 'INCOME' ? 'INCOME' : 'EXPENSE';

  const [expanded, setExpanded] = React.useState<string | null>(null);
  const [drilldownId, setDrilldownId] = React.useState<string | null>(null);

  /* `replace`, not `push`: flipping between চিপ should not fill the back stack
     with periods the user has to tap through to leave the screen. */
  const navigate = React.useCallback(
    (next: ReportRange, nextKind: Kind) => {
      const search = rangeParams(next);
      if (nextKind !== 'EXPENSE') search.set('kind', nextKind);
      router.replace(`${pathname}?${search.toString()}`, { scroll: false });
    },
    [pathname, router],
  );

  const expense = useQuery({
    queryKey: reportKeys.byCategory('EXPENSE', range),
    queryFn: () => fetchByCategory('EXPENSE', range),
  });
  const income = useQuery({
    queryKey: reportKeys.byCategory('INCOME', range),
    queryFn: () => fetchByCategory('INCOME', range),
  });
  /* The comparison needs no new endpoint: `by-category` takes any two dates,
     so the previous equivalent period is the same call asked again. */
  const prevExpense = useQuery({
    queryKey: reportKeys.byCategory('EXPENSE', previous),
    queryFn: () => fetchByCategory('EXPENSE', previous),
  });
  const prevIncome = useQuery({
    queryKey: reportKeys.byCategory('INCOME', previous),
    queryFn: () => fetchByCategory('INCOME', previous),
  });
  const trend = useQuery({
    queryKey: reportKeys.trend(trendBounds.months),
    queryFn: () => fetchTrend(trendBounds.months),
  });
  const sheet = useQuery({
    queryKey: reportKeys.balanceSheet(),
    queryFn: fetchBalanceSheet,
  });
  const cashFlow = useQuery({
    queryKey: reportKeys.cashFlow(range),
    queryFn: () => fetchCashFlow(range),
  });
  const drilldown = useQuery({
    queryKey: reportKeys.drilldown(drilldownId ?? '', range),
    queryFn: () => fetchDrilldown(drilldownId ?? '', range),
    enabled: drilldownId !== null,
  });

  const byCategory = kind === 'EXPENSE' ? expense : income;
  const rangeText = periodLabel(range);

  /* One `kind` in the URL, a handle on each panel that answers by it. Distinct
     accessible names, because two controls called the same thing on one screen
     is a control nobody can refer to. */
  const kindSelect = (label: string): React.ReactNode => (
    <Select
      aria-label={label}
      value={kind}
      onChange={(e) => navigate(range, e.target.value === 'INCOME' ? 'INCOME' : 'EXPENSE')}
      className="w-auto"
    >
      <option value="EXPENSE">{t('entry.tab.expense', 'খরচ')}</option>
      <option value="INCOME">{t('entry.tab.income', 'আয়')}</option>
    </Select>
  );
  const asOfText = `${t('reports.asOf', 'আজকের হিসাবে')} · ${bnDate(isoOf(today))}`;
  const comparison = comparisonLabel(range);

  const summaryLoading = income.isPending || expense.isPending;
  const summaryError = income.isError || expense.isError;
  const comparisonReady = prevIncome.isSuccess && prevExpense.isSuccess;
  const incomeMinor = income.data?.total ?? 0;
  const expenseMinor = expense.data?.total ?? 0;
  const prevIncomeMinor = prevIncome.data?.total ?? 0;
  const prevExpenseMinor = prevExpense.data?.total ?? 0;

  const trendPoints = withinWindow(trend.data ?? [], trendBounds);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 xl:max-w-6xl">
      <header className="hidden items-baseline justify-between gap-2 md:flex">
        <h1 className="text-ink text-2xl font-semibold">{t('nav.reports', 'রিপোর্ট')}</h1>
      </header>

      <RangeBar range={range} onChange={(next) => navigate(next, kind)} today={today} />

      {/* Income, spending and the difference for the chosen period, each against
          the previous equivalent one. */}
      <Panel title={t('reports.summary', 'সারসংক্ষেপ')} scope={rangeText}>
        {summaryError ? (
          <QueryError
            message={t('reports.summaryFailed', 'সারসংক্ষেপ আনা যায়নি।')}
            onRetry={() => {
              void income.refetch();
              void expense.refetch();
            }}
          />
        ) : summaryLoading ? (
          <PanelSkeleton rows={2} />
        ) : (
          <dl className="divide-rule mt-3 grid grid-cols-1 divide-y sm:grid-cols-3 sm:divide-x sm:divide-y-0">
            {(
              [
                [t('dashboard.income', 'আয়'), incomeMinor, prevIncomeMinor, 'up', 'text-income'],
                [
                  t('dashboard.expense', 'খরচ'),
                  expenseMinor,
                  prevExpenseMinor,
                  'down',
                  'text-expense',
                ],
                [
                  t('dashboard.net', 'নিট'),
                  incomeMinor - expenseMinor,
                  prevIncomeMinor - prevExpenseMinor,
                  'up',
                  '',
                ],
              ] as const
            ).map(([label, amount, prior, goodWhen, tone], i) => (
              <div key={label} className={cn('min-w-0 py-2', i > 0 && 'sm:pl-4')}>
                <dt className="text-ink-muted text-xs">{label}</dt>
                <dd>
                  {/* নিট can go either way, so it carries the sign colour;
                      আয় and খরচ are magnitudes and keep their fixed tone. */}
                  <Money
                    minor={amount}
                    colored={tone === ''}
                    className={cn('block text-lg font-semibold', tone)}
                    decimals={false}
                  />
                  {comparisonReady ? (
                    <Delta
                      currentMinor={amount}
                      previousMinor={prior}
                      goodWhen={goodWhen}
                      comparison={comparison}
                    />
                  ) : prevIncome.isError || prevExpense.isError ? (
                    <p className="text-ink-muted mt-1 text-xs">
                      {t('reports.comparisonFailed', 'তুলনার হিসাব আনা যায়নি')}
                    </p>
                  ) : (
                    <Skeleton className="mt-1 h-3 w-28" />
                  )}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </Panel>

      {/* Net worth: the number people open a finance app to see — and the first
          one on this screen that the range does not touch. */}
      <Panel title={t('reports.netWorth', 'নিট সম্পদ')} scope={asOfText}>
        {sheet.isError ? (
          <QueryError
            message={t('reports.netWorthFailed', 'নিট সম্পদ আনা যায়নি।')}
            onRetry={() => void sheet.refetch()}
          />
        ) : sheet.isPending ? (
          <PanelSkeleton rows={1} />
        ) : (
          <>
            <Money minor={sheet.data.netWorthMinor} colored className="text-2xl font-semibold" />
            <dl className="border-rule mt-3 grid grid-cols-3 gap-2 border-t pt-3 text-xs">
              {(
                [
                  [t('reports.assets', 'সম্পদ'), sheet.data.assetsMinor, 'text-income'],
                  [t('reports.liabilities', 'দায়'), sheet.data.liabilitiesMinor, 'text-expense'],
                  [t('reports.liquid', 'হাতে নগদ'), sheet.data.liquidMinor, ''],
                ] as const
              ).map(([label, amount, tone]) => (
                <div key={label} className="min-w-0">
                  <dt className="text-ink-muted">{label}</dt>
                  <dd>
                    <Money minor={amount} className={cn('block', tone)} decimals={false} />
                  </dd>
                </div>
              ))}
            </dl>
            <p className="text-ink-muted mt-2 text-xs">
              এটি নির্দিষ্ট মুহূর্তের হিসাব — উপরের সময়সীমা এতে খাটে না।
            </p>
          </>
        )}
      </Panel>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {/* Trend */}
        <Panel title={t('reports.trend', 'মাসভিত্তিক আয় ও খরচ')} scope={rangeText}>
          {trend.isError ? (
            <QueryError
              message={t('reports.trendFailed', 'মাসভিত্তিক হিসাব আনা যায়নি।')}
              onRetry={() => void trend.refetch()}
            />
          ) : trend.isPending ? (
            <PanelSkeleton rows={3} />
          ) : trendPoints.length === 0 ? (
            <p className="text-ink-muted mt-3 text-sm">
              {trendBounds.truncated
                ? t(
                    'reports.trendTooFar',
                    'এই চিত্র সর্বোচ্চ {n} মাস পিছিয়ে যেতে পারে, তাই এই সময়ের মাসগুলো দেখানো যাচ্ছে না।',
                  ).replace('{n}', bnNum(MAX_TREND_MONTHS))
                : t('reports.trendEmpty', 'এই সময়ের কোনো মাস দেখানো যাচ্ছে না।')}
            </p>
          ) : (
            <>
              {/* A wide chart scrolls inside its own box; the page never does. */}
              <div className="-mx-1 mt-3 overflow-x-auto px-1">
                <div
                  className="h-56"
                  style={
                    trendPoints.length > 6
                      ? { minWidth: `${trendPoints.length * 44}px` }
                      : undefined
                  }
                >
                  <TrendChart data={trendPoints} />
                </div>
              </div>
              <p className="text-ink-muted mt-2 text-xs">
                {t('reports.monthCount', '{n}টি মাস').replace('{n}', bnNum(trendPoints.length))}
                {trendBounds.partialMonths
                  ? ` · ${t('reports.wholeMonths', 'এই চিত্র পূর্ণ মাস দেখায়, নির্বাচিত সময়ের অংশবিশেষ নয়')}`
                  : ''}
                {trendBounds.truncated
                  ? ` · ${t('reports.trendLimit', '{n} মাসের বেশি পুরোনো মাস পাওয়া যায় না').replace('{n}', bnNum(MAX_TREND_MONTHS))}`
                  : ''}
              </p>
            </>
          )}
        </Panel>

        {/* Category split */}
        <Panel
          title={t('reports.byCategory', 'খাতভিত্তিক হিসাব')}
          scope={rangeText}
          action={kindSelect(t('reports.byCategoryKind', 'খাতভিত্তিক হিসাবে আয় না খরচ'))}
        >
          {byCategory.isError ? (
            <QueryError
              message={t('reports.byCategoryFailed', 'খাতভিত্তিক হিসাব আনা যায়নি।')}
              onRetry={() => void byCategory.refetch()}
            />
          ) : byCategory.isPending ? (
            <PanelSkeleton rows={4} />
          ) : byCategory.data.nodes.length === 0 ? (
            <p className="text-ink-muted mt-3 text-sm">
              {t('reports.emptyPeriod', 'এই সময়ে কিছু নেই।')}
            </p>
          ) : (
            <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="h-40 w-full sm:w-40 sm:shrink-0">
                <CategoryPie
                  colours={SLICE_COLOURS}
                  data={byCategory.data.nodes.slice(0, 6).map((n) => ({
                    name: n.name,
                    value: n.rolledUpMinor,
                  }))}
                />
              </div>

              {/* The legend is the real interface: colour is never the only signal. */}
              <ul className="min-w-0 flex-1">
                {byCategory.data.nodes.map((node, i) => {
                  const total = byCategory.data.total;
                  const share =
                    total === 0 ? 0 : Math.floor((node.rolledUpMinor / total) * 1000 + 0.5) / 10;
                  const isOpen = expanded === node.categoryId;
                  const hasChildren = node.children.length > 0;

                  return (
                    <li key={node.categoryId ?? node.name}>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          disabled={!node.categoryId}
                          onClick={() => node.categoryId && setDrilldownId(node.categoryId)}
                          className="press hover:bg-greenbar flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-md px-1 text-left disabled:cursor-default"
                        >
                          <span
                            aria-hidden
                            className="h-2.5 w-2.5 shrink-0 rounded-full"
                            style={{ background: SLICE_COLOURS[i % SLICE_COLOURS.length] }}
                          />
                          <span className="text-ink min-w-0 flex-1 truncate text-sm">
                            {node.name}
                          </span>
                          <span className="text-ink-muted shrink-0 text-xs">
                            {bnNum(String(share))}%
                          </span>
                          <Money
                            minor={node.rolledUpMinor}
                            className="shrink-0 text-sm"
                            decimals={false}
                          />
                        </button>

                        {hasChildren ? (
                          <button
                            type="button"
                            aria-expanded={isOpen}
                            aria-label={`${node.name} — উপ-খাত`}
                            onClick={() => setExpanded(isOpen ? null : node.categoryId)}
                            className="press touch-target text-ink-muted hover:bg-greenbar flex shrink-0 items-center justify-center rounded-md"
                          >
                            <ChevronDown
                              className={cn('h-4 w-4 transition-transform', isOpen && 'rotate-180')}
                              aria-hidden
                            />
                          </button>
                        ) : (
                          <span className="w-11 shrink-0" aria-hidden />
                        )}
                      </div>

                      {isOpen ? (
                        <ul className="border-rule mb-1 ml-4 border-l pl-2">
                          {/* Money spent on the parent itself, not on any child. */}
                          {node.totalMinor > 0 ? (
                            <li className="flex items-center justify-between gap-2 py-1">
                              <span className="text-ink-muted min-w-0 truncate text-xs">
                                সরাসরি {node.name}
                              </span>
                              <Money
                                minor={node.totalMinor}
                                className="shrink-0 text-xs"
                                decimals={false}
                              />
                            </li>
                          ) : null}
                          {node.children.map((child) => (
                            <li key={child.categoryId}>
                              <button
                                type="button"
                                onClick={() => child.categoryId && setDrilldownId(child.categoryId)}
                                className="press hover:bg-greenbar flex min-h-9 w-full items-center justify-between gap-2 rounded-md px-1 text-left"
                              >
                                <span className="text-ink min-w-0 truncate text-xs">
                                  {child.name}
                                </span>
                                <Money
                                  minor={child.totalMinor}
                                  className="shrink-0 text-xs"
                                  decimals={false}
                                />
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </Panel>

        {/* The same money, cut by who it was for rather than what it went on.
            Directly after the category split, because the pair of them is the
            only place the difference between the two is visible at all. */}
        {/* After the money panels, because it answers a different question and
            reading it as though it were taka would be the one mistake here. */}
        <QuantityPanel period={range} />

        <TagPanel
          kind={kind}
          period={range}
          rangeText={rangeText}
          action={kindSelect(t('reports.byTagKind', 'ট্যাগভিত্তিক হিসাবে আয় না খরচ'))}
        />

        {/* Cash flow */}
        <Panel title={t('reports.cashFlow', 'নগদ প্রবাহ')} scope={rangeText}>
          {cashFlow.isError ? (
            <QueryError
              message={t('reports.cashFlowFailed', 'নগদ প্রবাহ আনা যায়নি।')}
              onRetry={() => void cashFlow.refetch()}
            />
          ) : cashFlow.isPending ? (
            <PanelSkeleton rows={4} />
          ) : (
            <>
              <dl className="divide-rule mt-2 divide-y text-sm">
                {(
                  [
                    [t('reports.opening', 'শুরুর জের'), cashFlow.data.openingMinor, ''],
                    [t('reports.inflow', 'এসেছে'), cashFlow.data.inflowMinor, 'text-income'],
                    [t('reports.outflow', 'গেছে'), -cashFlow.data.outflowMinor, 'text-expense'],
                    [
                      t('reports.closing', 'শেষের জের'),
                      cashFlow.data.closingMinor,
                      'font-semibold',
                    ],
                  ] as const
                ).map(([label, amount, tone]) => (
                  <div key={label} className="flex items-center justify-between gap-3 py-1.5">
                    <dt className="text-ink">{label}</dt>
                    <dd>
                      <Money minor={amount} className={tone || undefined} />
                    </dd>
                  </div>
                ))}
              </dl>
              <p className="text-ink-muted mt-2 text-xs">
                {t(
                  'reports.cashFlowHint',
                  'শুরুর জের নির্বাচিত সময়ের আগের অবস্থা; শেষের জের সময়ের শেষে।',
                )}
              </p>
              {cashFlow.data.accounts.length ? (
                <p className="text-ink-muted mt-1 text-xs">
                  {t('reports.accountsCounted', 'হিসাবের অ্যাকাউন্ট')}:{' '}
                  {cashFlow.data.accounts.join(', ')}
                </p>
              ) : null}
            </>
          )}
        </Panel>

        {/* Balance sheet — the second panel the range does not touch. */}
        <Panel title={t('reports.balanceSheet', 'সম্পদ ও দায়')} scope={asOfText}>
          {sheet.isError ? (
            <QueryError
              message={t('reports.balanceSheetFailed', 'সম্পদ ও দায় আনা যায়নি।')}
              onRetry={() => void sheet.refetch()}
            />
          ) : sheet.isPending ? (
            <PanelSkeleton rows={4} />
          ) : (
            <div className="mt-2 grid grid-cols-1 gap-4 sm:grid-cols-2">
              {(
                [
                  [t('reports.assets', 'সম্পদ'), sheet.data.assets],
                  [t('reports.liabilities', 'দায়'), sheet.data.liabilities],
                ] as const
              ).map(([title, lines]) => (
                <div key={title}>
                  <h3 className="text-ink text-xs font-semibold">{title}</h3>
                  <ul className="divide-rule mt-1 divide-y">
                    {lines.length === 0 ? (
                      <li className="text-ink-muted py-1.5 text-xs">
                        {t('reports.none', 'কিছু নেই')}
                      </li>
                    ) : (
                      lines.map((line) => (
                        <li
                          key={line.id}
                          className="flex items-center justify-between gap-2 py-1.5"
                        >
                          <span className="text-ink min-w-0 truncate text-sm">{line.name}</span>
                          <Money
                            minor={line.amountMinor}
                            className="shrink-0 text-sm"
                            decimals={false}
                          />
                        </li>
                      ))
                    )}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>

      <Sheet
        open={drilldownId !== null}
        onOpenChange={(open) => !open && setDrilldownId(null)}
        title={drilldown.data?.category.name ?? t('reports.detail', 'বিস্তারিত')}
        description={
          drilldown.data
            ? `${rangeText} · ${t('reports.total', 'মোট')} ${formatMinor(drilldown.data.totalMinor)}`
            : rangeText
        }
      >
        {drilldown.isError ? (
          <QueryError
            message={t('reports.detailFailed', 'বিস্তারিত আনা যায়নি।')}
            onRetry={() => void drilldown.refetch()}
          />
        ) : drilldown.isPending ? (
          <div className="space-y-2" aria-hidden>
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : drilldown.data.items.length === 0 ? (
          <p className="text-ink-muted py-2 text-sm">
            {t('reports.emptyPeriod', 'এই সময়ে কিছু নেই।')}
          </p>
        ) : (
          <ul className="divide-rule divide-y">
            {drilldown.data.items.map((item) => (
              <li key={item.transactionId} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="text-ink truncate text-sm">
                    {item.description || t('entry.transaction', 'লেনদেন')}
                  </p>
                  <p className="text-ink-muted text-xs">{bnDate(item.date)}</p>
                </div>
                <Money minor={item.amountMinor} className="shrink-0 text-sm" />
              </li>
            ))}
          </ul>
        )}
      </Sheet>
    </div>
  );
}
