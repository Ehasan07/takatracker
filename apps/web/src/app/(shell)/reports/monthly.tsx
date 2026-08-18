'use client';

/**
 * আয়, খরচ ও সঞ্চয় — the three figures side by side, and what each of them is.
 *
 * ## The question this panel exists to answer
 *
 * "মাসে জানতে চাই আমার সঞ্চয় কত হচ্ছে, খরচ কত হচ্ছে, আয় কত হচ্ছে, প্রত্যেকটা
 * পাশে।" Two of those three were already on this screen. The third was on no
 * screen in the application and could not have been: putting ৳2,000 into a DPS
 * is not spending it — nothing is consumed and nobody is owed — so it is a
 * transfer, it touches no nominal account, and it reaches no income statement.
 * That is correct accounting, and it is exactly why সঞ্চয় has to be asked of the
 * transfers directly. `GET /v1/reports/monthly` does that; this panel prints it.
 *
 * ## The two figures a reader must not confuse, and how they are kept apart
 *
 * **নিট** (on সারসংক্ষেপ, above) is income less spending: what was *not spent*.
 * **সঞ্চয়** (here) is what actually went into a savings account. They are
 * different numbers — money can be left over and still be sitting in a wallet —
 * and only the second one answers the question that was asked.
 *
 * There is therefore exactly **one** savings rate in this product, and it lives
 * here: সঞ্চয় ÷ আয়. The সারসংক্ষেপ panel used to print a second one built from
 * the surplus, under wording ("আয়ের ৪০% রাখা গেছে") that reads as this one and
 * is not; it was removed rather than left to disagree, because two percentages
 * on one screen that answer the same question differently is worse than one
 * that is missing.
 *
 * ## What is disclosed rather than folded in
 *
 * Money that went into land, gold or a car is real money set aside, and it is
 * **not** added to সঞ্চয়. One ৳9,00,000 plot would swamp a ৳2,000 instalment,
 * take the rate to 700% in one month and to nothing in the eleven after it, and
 * make the series useless for the only thing a series is for. It gets its own
 * line, its own word — বিনিয়োগ — and a sentence saying why it is not the same
 * thing. The reasoning is written out in `savingsVehicleOf` in @hishab/core.
 *
 * ## Colour is the third signal
 *
 * Every figure carries its own word and its own sign. The month bars diverge
 * from a shared baseline — money into savings upward, money out downward — so
 * position says which is which before colour does, and the same numbers are
 * printed as a table underneath. Turn the palette off entirely and the panel
 * still reads.
 */

import { useQuery } from '@tanstack/react-query';
import { PiggyBank } from 'lucide-react';
import { formatMinor } from '@hishab/shared';
import { Money } from '@/components/money';
import { t } from '@/lib/t';
import { cn } from '@/lib/utils';
import { useWorkspaceSettings } from '@/lib/workspace-settings';
import { Panel, PanelSkeleton, QueryError } from './parts';
import { fetchMonthly, reportKeys } from './queries';
import { bnNum, shortMonth, type Period } from './range';
import type { MonthlyFlowPointDto, SavingsInstrumentDto } from './types';

/**
 * How many calendar months ride along under the three figures.
 *
 * Six rather than twelve: at 320px a twelve-month chart scrolls inside its own
 * box, which is allowed, and a reader who has to drag a chart sideways to find
 * out whether they are saving more than last year will not do it. Six months is
 * the span somebody can actually hold in their head, and the মাসভিত্তিক আয় ও খরচ
 * panel further down already goes as far back as the range asks.
 */
const TREND_MONTHS = 6;

export function MonthlyPanel({ period, rangeText }: { period: Period; rangeText: string }) {
  const monthly = useQuery({
    queryKey: reportKeys.monthly(period, TREND_MONTHS),
    queryFn: () => fetchMonthly(period, TREND_MONTHS),
  });

  return (
    <Panel
      title={t('reports.monthly.title', 'আয়, খরচ ও সঞ্চয়')}
      scope={rangeText}
      testId="monthly"
    >
      {monthly.isError ? (
        <QueryError
          message={t('reports.monthly.failed', 'সঞ্চয়ের হিসাব আনা যায়নি।')}
          onRetry={() => void monthly.refetch()}
        />
      ) : monthly.isPending ? (
        <PanelSkeleton rows={4} />
      ) : (
        <>
          {/* The three, side by side from a phone up. সঞ্চয় carries the sign
              colour because it is the only one of the three that can go either
              way — a month somebody broke a DPS is a negative সঞ্চয় and the
              screen must not print it as an achievement. */}
          <dl className="divide-rule mt-3 grid grid-cols-1 divide-y sm:grid-cols-3 sm:divide-x sm:divide-y-0">
            {(
              [
                [
                  'monthly-income',
                  t('dashboard.income', 'আয়'),
                  monthly.data.incomeMinor,
                  false,
                  'text-income',
                ],
                [
                  'monthly-expense',
                  t('dashboard.expense', 'খরচ'),
                  monthly.data.expenseMinor,
                  false,
                  'text-expense',
                ],
                [
                  'monthly-saved',
                  t('reports.monthly.saved', 'সঞ্চয়'),
                  monthly.data.savedMinor,
                  true,
                  '',
                ],
              ] as const
            ).map(([testId, label, amount, colored, tone], i) => (
              <div
                key={testId}
                data-testid={testId}
                className={cn('min-w-0 py-2', i > 0 && 'sm:pl-4')}
              >
                <dt className="text-ink-muted text-xs">{label}</dt>
                <dd>
                  <Money
                    minor={amount}
                    colored={colored}
                    className={cn('block text-lg font-semibold', tone)}
                    decimals={false}
                  />
                </dd>
              </div>
            ))}
          </dl>

          <SavingsRate
            savingsRateBps={monthly.data.savingsRateBps}
            savedMinor={monthly.data.savedMinor}
            surplusMinor={monthly.data.surplusMinor}
          />

          <Instruments rows={monthly.data.savings} totalMinor={monthly.data.savedMinor} />

          {monthly.data.investedMinor !== 0 ? (
            <Invested minor={monthly.data.investedMinor} rows={monthly.data.investments} />
          ) : null}

          <SavedByMonth points={monthly.data.months} />

          {/* The sentence that stops the whole panel being read as a mistake.
              Somebody who has just seen ৳6,000 of সঞ্চয় that appears nowhere in
              খরচ deserves to be told why, rather than concluding the books lost
              it. */}
          <p className="text-ink-muted border-rule mt-4 border-t pt-3 text-xs">
            {t(
              'reports.monthly.footnote',
              'ডিপিএস বা সঞ্চয়ে টাকা রাখা খরচ নয় — এক সম্পদ থেকে আরেক সম্পদে যাওয়া মাত্র। তাই ওই টাকা খরচের হিসাবে নেই, আর এখানে আলাদা করে দেখানো হলো।',
            )}
          </p>
        </>
      )}
    </Panel>
  );
}

/**
 * সঞ্চয়ের হার — the one savings rate in this product.
 *
 * Defined here so nobody has to guess: **what went into savings, divided by
 * what came in**. Not what was left over after spending, which is the সারসংক্ষেপ
 * panel's নিট and a larger number in almost every month.
 *
 * A dash and a reason when there was no income, rather than 0%: a period with
 * nothing coming in is not a period with a nought-percent savings rate, it is
 * one the question cannot be asked of. A negative rate is real and is printed
 * as one, with the word for it, because the month somebody had to break into
 * their savings is the month this figure most needs to be honest.
 */
function SavingsRate({
  savingsRateBps,
  savedMinor,
  surplusMinor,
}: {
  savingsRateBps: number | null;
  savedMinor: number;
  surplusMinor: number;
}) {
  const percent = savingsRateBps === null ? '—' : `${bnNum((savingsRateBps / 100).toFixed(1))}%`;

  return (
    <div data-testid="monthly-rate" className="border-rule mt-3 border-t pt-3">
      <p className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-ink-muted text-xs">{t('reports.monthly.rate', 'সঞ্চয়ের হার')}</span>
        <span
          className={cn(
            'text-lg font-semibold',
            savingsRateBps === null
              ? 'text-ink-muted'
              : savingsRateBps < 0
                ? 'text-expense'
                : 'text-income',
          )}
        >
          {percent}
        </span>
      </p>
      <p className="text-ink-muted mt-1 text-xs">
        {savingsRateBps === null
          ? t('reports.monthly.rateNoIncome', 'এই সময়ে কোনো আয় নেই, তাই হার বের করা যায় না।')
          : savedMinor < 0
            ? t(
                'reports.monthly.rateNegative',
                'এই সময়ে সঞ্চয়ে যা গেছে তার চেয়ে বেশি ভাঙানো হয়েছে।',
              )
            : t(
                'reports.monthly.rateHint',
                'আয়ের কত অংশ সঞ্চয়ে গেছে। খরচের পর যা বেঁচেছে তা নয় — বেঁচে যাওয়া টাকা হাতেও থেকে যেতে পারে।',
              )}
      </p>
      {/* Named beside it, so the two are never mistaken for each other. The
          surplus is on সারসংক্ষেপ as নিট; here it is the thing সঞ্চয় is *not*. */}
      <p className="text-ink-muted mt-1 text-xs">
        {t('reports.monthly.surplus', 'খরচের পর বেঁচেছে')}{' '}
        <Money minor={surplusMinor} className="text-ink" decimals={false} signed />
      </p>
    </div>
  );
}

/**
 * Where the সঞ্চয় actually went, one row per instrument.
 *
 * The rows add up to the heading above them — that is enforced on the server,
 * in `buildSavingsFlow`, and nothing here re-adds anything. Two DPS accounts
 * that swapped ৳50,000 between them appear as +৳50,000 and −৳50,000 and
 * contribute nothing to the total, which is the truth about that month: one
 * gained, the other lost, and the household saved nothing new.
 *
 * জমা and ফেরত are printed separately from নিট because "৳2,000 in and ৳500 out"
 * and "৳1,500 net" are different sentences, and only the first one tells
 * somebody they took money back out.
 */
function Instruments({
  rows,
  totalMinor,
}: {
  rows: readonly SavingsInstrumentDto[];
  totalMinor: number;
}) {
  return (
    <div data-testid="monthly-instruments" className="border-rule mt-3 border-t pt-3">
      <h3 className="text-ink text-xs font-semibold">
        <PiggyBank className="text-ink-muted mr-1.5 inline h-4 w-4 align-text-bottom" aria-hidden />
        {t('reports.monthly.where', 'কোথায় জমা হয়েছে')}
      </h3>

      {rows.length === 0 ? (
        <p className="text-ink-muted mt-2 text-xs">
          {t('reports.monthly.noSavings', 'এই সময়ে সঞ্চয়ে কোনো টাকা যায়নি।')}
        </p>
      ) : (
        <ul className="divide-rule mt-1 divide-y">
          {rows.map((row) => (
            <li key={row.accountId} className="py-1.5">
              <p className="flex items-baseline justify-between gap-3 text-sm">
                <span className="text-ink min-w-0 truncate">{row.name}</span>
                <Money
                  minor={row.netMinor}
                  className="shrink-0 font-medium"
                  decimals={false}
                  signed
                />
              </p>
              {/* Only when something came back out. A row of "ফেরত ৳0" on every
                  instrument every month is noise that hides the one month it
                  matters. */}
              {row.outMinor > 0 ? (
                <p className="text-ink-muted mt-0.5 flex flex-wrap gap-x-3 text-xs">
                  <span>
                    {t('reports.monthly.putIn', 'জমা')}{' '}
                    <Money minor={row.inMinor} decimals={false} />
                  </span>
                  <span>
                    {t('reports.monthly.tookOut', 'ফেরত নেওয়া')}{' '}
                    <Money minor={row.outMinor} decimals={false} />
                  </span>
                </p>
              ) : null}
              {/* The account behind the plan, when the two are named differently
                  — so a reader can find the row in their khata. */}
              {row.accountName !== row.name ? (
                <p className="text-ink-muted mt-0.5 truncate text-xs">{row.accountName}</p>
              ) : null}
            </li>
          ))}
          <li className="flex items-baseline justify-between gap-3 py-1.5 text-sm">
            {/* Its own key rather than `reports.total`, whose English is the
                lowercase "total" of a sentence and not the label of a row. */}
            <span className="text-ink font-semibold">{t('reports.monthly.total', 'মোট')}</span>
            {/* Deliberately unsigned, so it prints character for character the
                same as the সঞ্চয় figure at the top of the panel. The rows adding
                up to the heading is the property this list exists to show, and
                a "+" on one of the two would make a reader check twice. */}
            <Money minor={totalMinor} className="shrink-0 font-semibold" decimals={false} />
          </li>
        </ul>
      )}
    </div>
  );
}

/**
 * বিনিয়োগ — money that went into land, gold, a car or shares.
 *
 * Beside সঞ্চয় and never inside it. Both are money set aside and they behave
 * nothing alike: an instalment is a fixed amount repeated every month, and a
 * plot of land is a lump nobody buys twice. Adding them would make the savings
 * rate a number that means one thing in the month somebody bought land and
 * another in every other month, which is to say it would mean nothing.
 *
 * Absent entirely when nothing was bought. A household that owns no land should
 * not read a line telling it so every time it opens the reports screen.
 */
function Invested({ minor, rows }: { minor: number; rows: readonly SavingsInstrumentDto[] }) {
  return (
    <div data-testid="monthly-invested" className="border-rule mt-3 border-t pt-3">
      <p className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-ink text-xs font-semibold">
          {t('reports.monthly.invested', 'জমি, স্বর্ণ বা গাড়িতে গেছে')}
        </span>
        <Money minor={minor} className="font-semibold" decimals={false} signed />
      </p>
      {rows.length > 0 ? (
        <ul className="text-ink-muted mt-1 space-y-0.5 text-xs">
          {rows.map((row) => (
            <li key={row.accountId} className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate">{row.name}</span>
              <Money minor={row.netMinor} decimals={false} signed />
            </li>
          ))}
        </ul>
      ) : null}
      <p className="text-ink-muted mt-1 text-xs">
        {t(
          'reports.monthly.investedHint',
          'এটাও টাকা সরিয়ে রাখা, তবে সঞ্চয়ের সঙ্গে যোগ করা হয়নি — এক মাসের জমি কেনা বাকি এগারো মাসের ডিপিএসকে ঢেকে দিত।',
        )}
      </p>
    </div>
  );
}

/* The month chart, in user units, which are CSS pixels here. The same
   construction `components/charts/flow-bars.tsx` uses and for the same reason:
   an `<svg>` stretched to its container scales its own text with it, so a slot
   is a fixed width, the viewBox matches it one to one, and a chart too wide for
   the panel scrolls inside its own box rather than moving the page. */
const ARM = 34;
const TOP = 8;
const BASELINE = TOP + ARM;
const LABEL_Y = BASELINE + ARM + 13;
const CHART_HEIGHT = LABEL_Y + 4;
const SLOT = 48;
const BAR = 20;

/**
 * সঞ্চয় month by month, as bars that grow away from a shared line.
 *
 * Upward is money going into savings and downward is money coming back out,
 * which is the one distinction this chart exists to make: a year of steady
 * instalments and a year that put ৳50,000 in and took ৳50,000 out are the same
 * total and completely different lives. Position carries that before colour
 * does, and the table underneath carries it a third time in numbers — with আয়
 * and খরচ beside it, which is the "প্রত্যেকটা পাশে" the whole panel is for.
 *
 * One scale for both arms, so a bar above the line and a bar below it of the
 * same length are the same amount of money.
 */
function SavedByMonth({ points }: { points: readonly MonthlyFlowPointDto[] }) {
  const { currency } = useWorkspaceSettings();
  if (points.length === 0) return null;

  const width = Math.max(SLOT, points.length * SLOT);
  const peak = points.reduce((largest, point) => Math.max(largest, Math.abs(point.savedMinor)), 0);
  const arm = (minor: number): number => (peak <= 0 ? 0 : (Math.abs(minor) / peak) * ARM);

  const inLabel = t('reports.monthly.intoSavings', 'সঞ্চয়ে গেছে');
  const outLabel = t('reports.monthly.outOfSavings', 'সঞ্চয় থেকে এসেছে');

  return (
    <div data-testid="monthly-trend" className="border-rule mt-3 border-t pt-3">
      <h3 className="text-ink text-xs font-semibold">
        {t('reports.monthly.byMonth', 'মাসে মাসে')}
      </h3>

      <ul className="text-ink-muted mb-1 mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="bg-income h-2 w-3 rounded-sm" />
          {inLabel} ↑
        </li>
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="bg-expense h-2 w-3 rounded-sm" />
          {outLabel} ↓
        </li>
      </ul>

      {/* The chart scrolls inside this box; the page never does. */}
      <div className="-mx-1 flex justify-center overflow-x-auto px-1">
        <svg
          width={width}
          height={CHART_HEIGHT}
          viewBox={`0 0 ${width} ${CHART_HEIGHT}`}
          role="img"
          aria-label={points
            .map(
              (point) =>
                `${shortMonth(point.month)}: ${point.savedMinor < 0 ? outLabel : inLabel} ` +
                /* Printed by the same formatter the figures above use, from the
                   integer poisha — never a division done here. */
                formatMinor(point.savedMinor, { currency, decimals: false, signed: true }),
            )
            .join(', ')}
          focusable="false"
          className="shrink-0"
        >
          {points.map((point, i) => {
            const length = arm(point.savedMinor);
            const up = point.savedMinor >= 0;
            return (
              <g key={point.month}>
                <rect
                  x={i * SLOT + (SLOT - BAR) / 2}
                  y={up ? BASELINE - length : BASELINE}
                  width={BAR}
                  height={Math.max(length, point.savedMinor === 0 ? 0 : 1)}
                  rx={2}
                  fill={up ? 'var(--hishab-income)' : 'var(--hishab-expense)'}
                  className="motion-safe:transition-all motion-safe:duration-500"
                />
                <text
                  x={i * SLOT + SLOT / 2}
                  y={LABEL_Y}
                  textAnchor="middle"
                  fontSize={11}
                  fill="var(--hishab-ink-muted)"
                >
                  {shortMonth(point.month)}
                </text>
              </g>
            );
          })}
          <line
            x1={0}
            y1={BASELINE}
            x2={width}
            y2={BASELINE}
            stroke="var(--hishab-rule)"
            strokeWidth={1}
          />
        </svg>
      </div>

      {/* The three figures per month, in numbers, which is what was actually
          asked for. The table scrolls inside its own box on a narrow phone. */}
      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[248px] text-xs">
          <thead>
            <tr className="text-ink-muted text-left">
              <th scope="col" className="font-normal">
                {t('reports.chart.period', 'সময়')}
              </th>
              <th scope="col" className="text-right font-normal">
                {t('dashboard.income', 'আয়')}
              </th>
              <th scope="col" className="text-right font-normal">
                {t('dashboard.expense', 'খরচ')}
              </th>
              <th scope="col" className="text-right font-normal">
                {t('reports.monthly.saved', 'সঞ্চয়')}
              </th>
            </tr>
          </thead>
          <tbody className="divide-rule divide-y">
            {points.map((point) => (
              <tr key={point.month}>
                <th scope="row" className="text-ink py-1 text-left font-normal">
                  {shortMonth(point.month)}
                </th>
                <td className="py-1 text-right">
                  <Money minor={point.incomeMinor} decimals={false} className="text-income" />
                </td>
                <td className="py-1 text-right">
                  <Money minor={point.expenseMinor} decimals={false} className="text-expense" />
                </td>
                <td className="py-1 text-right">
                  <Money minor={point.savedMinor} decimals={false} colored signed />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
