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
 *
 * ## Why there is no charting library on this page any more
 *
 * There was one, and it was the largest thing this route downloaded — larger
 * than the rest of the page put together, which is why it had to be lazily
 * imported behind a skeleton, which is why the two charts arrived a beat after
 * the numbers did on every visit. What it was drawing was a ring and some
 * rectangles. Both are now a few dozen lines of `<svg>` in
 * `components/charts/`, they render in the first paint with everything else,
 * and they are the app's own shapes rather than a library's: the ring adds its
 * own slices up, the bars diverge from a shared baseline so that position and
 * not only colour says which is income, and each carries its figures in its
 * `aria-label` and again as text underneath.
 */

import { useQuery } from '@tanstack/react-query';
import { FileText } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';
import { formatMinor } from '@hishab/shared';
import { FlowBars } from '@/components/charts/flow-bars';
import { Money } from '@/components/money';
import { Skeleton, SkeletonCard } from '@/components/skeleton';
import { Sheet } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { t } from '@/lib/t';
import { BreakdownPanel } from './breakdown';
import { Delta, Panel, PanelSkeleton, QueryError } from './parts';
import {
  fetchBalanceSheet,
  fetchByCategory,
  fetchCashFlow,
  fetchDrilldown,
  fetchTrend,
  reportKeys,
} from './queries';
import Link from 'next/link';
import { RangeBar } from './range-bar';
import { CardStatementsPanel, PositionPanel } from './position';
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
  resolveRange,
  shortMonth,
  trendWindow,
  withinWindow,
  type ReportRange,
} from './range';
import { resolveSlicing, viewParams, type Slicing } from './slicer';

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
  /* Everything the reader has arranged, read back out of the URL: which side of
     the books, how the ring is cut, and which category it is opened on. */
  const slicing = React.useMemo(() => resolveSlicing(params), [params]);
  const kind = slicing.kind;

  const [drilldownId, setDrilldownId] = React.useState<string | null>(null);

  /* `replace`, not `push`: flipping between চিপ should not fill the back stack
     with periods the user has to tap through to leave the screen. */
  const navigate = React.useCallback(
    (next: ReportRange, nextSlicing: Slicing) => {
      router.replace(`${pathname}?${viewParams(next, nextSlicing).toString()}`, { scroll: false });
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

  const rangeText = periodLabel(range);
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
      <header className="flex items-baseline justify-between gap-2">
        <h1 className="text-ink hidden text-2xl font-semibold md:block">
          {t('nav.reports', 'রিপোর্ট')}
        </h1>
        {/* These screens answer "where did the money go"; the statements answer
            "what is my position". Different questions, both wanted, so the one
            is a link from the other rather than a replacement for it. */}
        <Link
          href="/reports/statements"
          className="press border-rule text-ink hover:bg-greenbar ml-auto flex min-h-11 items-center gap-1.5 rounded-md border px-3 text-sm"
        >
          <FileText className="h-4 w-4" aria-hidden />
          {t('statements.title', 'আর্থিক বিবৃতি')}
        </Link>
      </header>

      <RangeBar range={range} onChange={(next) => navigate(next, slicing)} today={today} />

      {/* The ring, and the controls that decide what goes into it. First on the
          screen because it is the answer to the question people open a reports
          screen holding — "where did it all go" — and because everything below
          it is a different, narrower question about the same period. */}
      <BreakdownPanel
        period={range}
        rangeText={rangeText}
        slicing={slicing}
        onSlicing={(next) => navigate(range, next)}
        onOpenCategory={setDrilldownId}
      />

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
          <>
            <InOut incomeMinor={incomeMinor} expenseMinor={expenseMinor} />
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
          </>
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

      {/* The same three totals again, each opened up into what it is made of.
          Directly under নিট সম্পদ because it is the same photograph at a closer
          focus — and because a reader who has just been shown "দায় ৳1,62,400"
          asks "of what?" before they ask anything about last month's spending.
          It shares the balance-sheet query with the panel above, so the two are
          one fetch and cannot be a moment apart. */}
      <PositionPanel asOfText={asOfText} />

      {/* And the one liability that has a bill with a date on it. Nothing at
          all when the workspace has no cards. */}
      <CardStatementsPanel asOfText={asOfText} />

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
              <FlowBars
                className="mt-3"
                title={t('reports.trend', 'মাসভিত্তিক আয় ও খরচ')}
                incomeLabel={t('dashboard.income', 'আয়')}
                expenseLabel={t('dashboard.expense', 'খরচ')}
                points={trendPoints.map((point) => ({
                  key: point.month,
                  label: shortMonth(point.month),
                  incomeMinor: point.incomeMinor,
                  expenseMinor: point.expenseMinor,
                }))}
              />
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

        {/* After the money panels, because it answers a different question and
            reading it as though it were taka would be the one mistake here. */}
        <QuantityPanel period={range} />

        {/* The same money, cut by who it was for rather than what it went on.
            Deliberately its own panel and not a third option in the ring's cut
            control: tags do not partition the money — one transaction can carry
            three of them — so a ring of tag slices adds up to more than the
            period cost and there is no honest total to put in the middle of it.
            The reasoning is written out in `slicer.ts`. Its আয়/খরচ follows the
            ring's, because there is one `kind` in the URL and two panels
            reading it is one setting, not two that can disagree. */}
        <TagPanel kind={kind} period={range} rangeText={rangeText} />

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

/**
 * What came in against what went out, as two bars on one scale.
 *
 * The three figures underneath were already here and they are the precise
 * answer; this is the one a person gets from across the room. Both bars are
 * measured against the larger of the two, which is the only scaling under which
 * "the red one is longer" means what it looks like it means — two bars each
 * filling their own track would show a month that spent twice its income as two
 * equal lines.
 *
 * Every bar carries its word and its amount beside it, so the colour is the
 * third signal rather than the first. The widths are percentages of a container
 * — a screenful of pixels, never money — and the amounts they are derived from
 * stay integer poisha and are printed by `<Money>` from those integers.
 */
function InOut({ incomeMinor, expenseMinor }: { incomeMinor: number; expenseMinor: number }) {
  const peak = Math.max(incomeMinor, expenseMinor);
  const width = (minor: number): string =>
    peak <= 0 ? '0%' : `${Math.max(0, (minor / peak) * 100)}%`;

  /* Kept in basis points until the last moment, the way the API's own
     `savingsRateBps` is: a whole percent is what gets read, and dividing at the
     end means the number on screen is derived from the integers above it. */
  const savedBps =
    incomeMinor > 0 ? Math.trunc(((incomeMinor - expenseMinor) * 10_000) / incomeMinor) : 0;

  return (
    <div className="mt-3 flex flex-col gap-2">
      {(
        [
          [t('dashboard.income', 'আয়'), incomeMinor, 'bg-income', 'text-income'],
          [t('dashboard.expense', 'খরচ'), expenseMinor, 'bg-expense', 'text-expense'],
        ] as const
      ).map(([label, minor, fill, tone]) => (
        <div key={label}>
          <p className="flex items-baseline justify-between gap-3 text-xs">
            <span className="text-ink-muted">{label}</span>
            <Money minor={minor} className={cn('shrink-0', tone)} decimals={false} />
          </p>
          <div className="bg-greenbar mt-1 h-2 w-full overflow-hidden rounded-full">
            <div
              className={cn('h-2 rounded-full motion-safe:transition-all', fill)}
              style={{ width: width(minor) }}
            />
          </div>
        </div>
      ))}
      {incomeMinor > 0 ? (
        <p className="text-ink-muted text-xs">
          {t('reports.savingsRate', 'আয়ের {n}% রাখা গেছে').replace(
            '{n}',
            bnNum(Math.trunc(savedBps / 100)),
          )}
        </p>
      ) : null}
    </div>
  );
}
