'use client';

/**
 * A donut with the total in the middle: seven `<circle>` elements, no library.
 *
 * ## Why it is drawn by hand
 *
 * A charting library for one ring is a hundred kilobytes to do arithmetic that
 * fits in `arc.ts`. Everything here is one `<svg>`, and the shape of it is
 * `stroke-dasharray` on circles of radius 50/π — where the dash length *is* the
 * percentage. See `arc.ts` for that trick and for why money never becomes a
 * pixel on the way.
 *
 * ## The centre is not a caption
 *
 * `<Donut>` adds the slices up itself and prints the answer. The caller passes
 * a *label* for that number, never the number. It is the one structural defence
 * against the commonest lie a donut tells — a headline figure that is not the
 * sum of the ring beneath it, because the ring dropped a bucket, double-counted
 * one, or was handed a total from a different query. Here it cannot happen: if
 * a slice is missing from the ring it is missing from the middle too, and the
 * two disagree with the rest of the screen together rather than one of them
 * quietly agreeing.
 *
 * ## Colour is never the signal
 *
 * The `<svg>` is `role="img"` with an `aria-label` that reads out every slice
 * with its amount and its share, so a screen reader gets the chart rather than
 * "graphic". Sighted readers get the same figures in the legend the caller
 * renders underneath — that list is the real interface, and the arcs are a
 * picture of it. Tapping an arc is a convenience on top; every one of them has
 * a keyboard-reachable twin in the list, which is why a `role="img"` is allowed
 * to carry a click handler here.
 */

import * as React from 'react';
import { formatMinor } from '@hishab/shared';
import { Money } from '@/components/money';
import { fmtNumber } from '@/lib/format';
import { t } from '@/lib/t';
import { cn } from '@/lib/utils';
import { useWorkspaceSettings } from '@/lib/workspace-settings';
import { RING_RADIUS, ringArcs } from './arc';

export interface DonutSlice {
  /** Stable across re-sorts — this is what `activeKey` and `onSelect` speak in. */
  key: string;
  label: string;
  /** Integer poisha. Negative values are treated as absent, not as a reversed arc. */
  minor: number;
  colour: string;
}

/* A 40×40 box: the ring sits at radius 50/π ≈ 15.92 around its centre, and the
   stroke's outer edge lands at 15.92 + 2.6 ≈ 18.5, leaving a hair of margin so
   nothing is clipped at the corners of the viewBox. */
const BOX = 40;
const CENTRE = BOX / 2;
const STROKE = 5.2;
const ACTIVE_STROKE = 6.6;

export function Donut({
  slices,
  centreLabel,
  title,
  activeKey,
  onSelect,
  className,
}: {
  slices: readonly DonutSlice[];
  /** What the number in the middle *is*. The number itself is computed here. */
  centreLabel: string;
  /** Names the chart for a screen reader — "খরচের ভাগ, খাত অনুযায়ী". */
  title: string;
  activeKey?: string | null;
  onSelect?: (key: string) => void;
  className?: string;
}) {
  const { currency } = useWorkspaceSettings();
  const arcs = ringArcs(slices.map((slice) => slice.minor));
  const total = slices.reduce((sum, slice) => sum + Math.max(0, slice.minor), 0);

  const money = (minor: number): string => formatMinor(minor, { currency, decimals: false });

  /* Every figure on the ring, in the order the ring draws them. A label that
     said only "pie chart" would be the chart withheld from the one reader who
     cannot see it. */
  const description = [
    `${title} — ${centreLabel} ${money(total)}.`,
    ...slices.map(
      (slice, i) => `${slice.label}: ${money(slice.minor)}, ${fmtNumber(arcs[i]!.percent)}%`,
    ),
  ].join(' ');

  return (
    <div className={cn('relative mx-auto aspect-square w-full max-w-[13.5rem]', className)}>
      <svg
        viewBox={`0 0 ${BOX} ${BOX}`}
        role="img"
        aria-label={description}
        focusable="false"
        className="h-full w-full"
      >
        {/* The ring's own bed, so an empty period is a shape rather than a hole. */}
        <circle
          cx={CENTRE}
          cy={CENTRE}
          r={RING_RADIUS}
          fill="none"
          stroke="var(--hishab-rule)"
          strokeWidth={STROKE}
        />
        {/* Twelve o'clock, clockwise, because that is where a reader starts. */}
        <g transform={`rotate(-90 ${CENTRE} ${CENTRE})`}>
          {slices.map((slice, i) => {
            const arc = arcs[i]!;
            if (arc.dash <= 0) return null;
            const active = activeKey === slice.key;
            return (
              <circle
                key={slice.key}
                cx={CENTRE}
                cy={CENTRE}
                r={RING_RADIUS}
                fill="none"
                stroke={slice.colour}
                strokeWidth={active ? ACTIVE_STROKE : STROKE}
                strokeDasharray={`${arc.dash} ${100 - arc.dash}`}
                strokeDashoffset={-arc.offset}
                strokeLinecap="butt"
                data-slice={slice.key}
                onClick={onSelect ? () => onSelect(slice.key) : undefined}
                className={cn(
                  'motion-safe:transition-all motion-safe:duration-500',
                  onSelect && 'cursor-pointer',
                )}
              />
            );
          })}
        </g>
      </svg>

      {/* HTML rather than `<text>`: the middle of a donut is the one number on
          the screen a person reads first, and it has to be set in the same
          face, grouped the same way and coloured by the same tokens as every
          other amount in the app — which is what `<Money>` is for. SVG text
          would be a second, slightly different money renderer. */}
      <div className="pointer-events-none absolute inset-[19%] flex flex-col items-center justify-center text-center">
        <span className="text-ink-muted w-full truncate text-xs">{centreLabel}</span>
        <Money minor={total} decimals={false} className="text-ink text-lg font-semibold" />
        <span className="text-ink-muted text-[0.65rem]">
          {t('reports.chart.sliceCount', '{n}টি ভাগ').replace(
            '{n}',
            fmtNumber(slices.filter((slice) => slice.minor > 0).length),
          )}
        </span>
      </div>
    </div>
  );
}
