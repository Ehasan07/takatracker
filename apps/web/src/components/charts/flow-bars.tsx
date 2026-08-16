'use client';

/**
 * Money in and money out, month by month, as bars that grow away from a shared
 * line — income upward, spending downward.
 *
 * ## Why diverging rather than two bars side by side
 *
 * Green beside red is the pairing this app has to be most careful with: red and
 * green are the two colours about one man in twelve cannot separate, and a pair
 * of adjacent bars distinguished only by that is a chart he cannot read. Sending
 * them in opposite directions from one baseline moves the whole signal into
 * *position*, which nobody's eyes fail at. The colours then say the same thing a
 * second time rather than saying it alone, and the legend says it a third.
 *
 * ## Why the picture is a fixed number of pixels wide
 *
 * An `<svg>` stretched to its container scales its own text with it, so the
 * month labels come out forty pixels tall on a three-month chart and six pixels
 * tall on a two-year one — the same chart, unreadable at both ends. So a slot is
 * a fixed width in CSS pixels, the viewBox matches it one to one, and a chart
 * too wide for the panel scrolls inside its own box. That is also what a native
 * app does with a long series, and the page itself never moves sideways.
 */

import { formatMinor } from '@hishab/shared';
import { Money } from '@/components/money';
import { t } from '@/lib/t';
import { useWorkspaceSettings } from '@/lib/workspace-settings';

export interface FlowPoint {
  key: string;
  /** Short enough for a 44px column — "আগ", "Aug". */
  label: string;
  incomeMinor: number;
  expenseMinor: number;
}

/* The plot, in user units, which are CSS pixels here. */
const ARM = 46;
const TOP = 8;
const BASELINE = TOP + ARM;
const LABEL_Y = BASELINE + ARM + 14;
const HEIGHT = LABEL_Y + 4;

/**
 * A column's width.
 *
 * Widened for a short series rather than left at 44px, because three lonely
 * bars floating in the middle of a panel reads as a rendering fault. Narrowed
 * to 44px — a thumb — once there are enough of them that the chart scrolls.
 */
function slotWidth(count: number): number {
  if (count <= 3) return 84;
  if (count <= 6) return 60;
  return 44;
}

/**
 * A bar with only its far end rounded.
 *
 * `rx` on a `<rect>` rounds all four corners, which lifts a bar off its own
 * baseline and makes a small one look like a floating pill. The data-end is the
 * end that carries the value, so it is the end that gets the radius.
 */
function barPath(x: number, width: number, length: number, up: boolean): string {
  const r = Math.min(4, width / 2, Math.max(0, length));
  const end = up ? BASELINE - length : BASELINE + length;
  const dir = up ? 1 : -1;
  return [
    `M ${x} ${BASELINE}`,
    `L ${x} ${end + r * dir}`,
    `Q ${x} ${end} ${x + r} ${end}`,
    `L ${x + width - r} ${end}`,
    `Q ${x + width} ${end} ${x + width} ${end + r * dir}`,
    `L ${x + width} ${BASELINE}`,
    'Z',
  ].join(' ');
}

export function FlowBars({
  points,
  title,
  incomeLabel,
  expenseLabel,
  className,
}: {
  points: readonly FlowPoint[];
  /** Names the chart for a screen reader. */
  title: string;
  incomeLabel: string;
  expenseLabel: string;
  className?: string;
}) {
  const { currency } = useWorkspaceSettings();
  const money = (minor: number): string => formatMinor(minor, { currency, decimals: false });

  const slot = slotWidth(points.length);
  const width = Math.max(slot, points.length * slot);
  /* A little under half the column, so neighbouring pairs never touch, and
     capped so a two-month chart is a pair of bars rather than a pair of
     billboards. */
  const barWidth = Math.min(34, slot * 0.46);

  /* One scale for both arms, so a bar above the line and a bar below it of the
     same length are the same amount of money. Two scales would make a month
     that spent twice what it earned look balanced. */
  const peak = points.reduce(
    (largest, point) => Math.max(largest, point.incomeMinor, point.expenseMinor),
    0,
  );
  const arm = (minor: number): number => (peak <= 0 ? 0 : (Math.max(0, minor) / peak) * ARM);

  const description = [
    `${title}.`,
    ...points.map(
      (point) =>
        `${point.label}: ${incomeLabel} ${money(point.incomeMinor)}, ` +
        `${expenseLabel} ${money(point.expenseMinor)}`,
    ),
  ].join(' ');

  return (
    <div className={className}>
      {/* Legend first, because it is what makes the picture below it readable —
          and it says up/down as well as the colour. */}
      <ul className="text-ink-muted mb-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="bg-income h-2 w-3 rounded-sm" />
          {incomeLabel} ↑
        </li>
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="bg-expense h-2 w-3 rounded-sm" />
          {expenseLabel} ↓
        </li>
      </ul>

      {/* The chart scrolls inside this box; the page never does. */}
      <div className="-mx-1 flex justify-center overflow-x-auto px-1">
        <svg
          width={width}
          height={HEIGHT}
          viewBox={`0 0 ${width} ${HEIGHT}`}
          role="img"
          aria-label={description}
          focusable="false"
          className="shrink-0"
        >
          {points.map((point, i) => {
            const x = i * slot + (slot - barWidth) / 2;
            return (
              <g key={point.key}>
                <path
                  d={barPath(x, barWidth, arm(point.incomeMinor), true)}
                  fill="var(--hishab-income)"
                  className="motion-safe:transition-all motion-safe:duration-500"
                />
                <path
                  d={barPath(x, barWidth, arm(point.expenseMinor), false)}
                  fill="var(--hishab-expense)"
                  className="motion-safe:transition-all motion-safe:duration-500"
                />
                <text
                  x={i * slot + slot / 2}
                  y={LABEL_Y}
                  textAnchor="middle"
                  fontSize={11}
                  fill="var(--hishab-ink-muted)"
                >
                  {point.label}
                </text>
              </g>
            );
          })}
          {/* Drawn last so it sits over the square ends of both arms. */}
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

      {/* The same data as text. Folded away rather than absent: a picture is
          not a figure, and somebody will want to read the number off. */}
      <details className="mt-2">
        <summary className="press text-ink-muted hover:text-ink flex min-h-11 cursor-pointer items-center text-xs md:min-h-9">
          {t('reports.chart.asNumbers', 'সংখ্যায় দেখুন')}
        </summary>
        <table className="mt-1 w-full text-xs">
          <thead>
            <tr className="text-ink-muted text-left">
              <th scope="col" className="font-normal">
                {t('reports.chart.period', 'সময়')}
              </th>
              <th scope="col" className="text-right font-normal">
                {incomeLabel}
              </th>
              <th scope="col" className="text-right font-normal">
                {expenseLabel}
              </th>
            </tr>
          </thead>
          <tbody className="divide-rule divide-y">
            {points.map((point) => (
              <tr key={point.key}>
                <th scope="row" className="text-ink py-1 text-left font-normal">
                  {point.label}
                </th>
                <td className="py-1 text-right">
                  <Money minor={point.incomeMinor} decimals={false} className="text-income" />
                </td>
                <td className="py-1 text-right">
                  <Money minor={point.expenseMinor} decimals={false} className="text-expense" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
