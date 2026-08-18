'use client';

/**
 * This month's spending, cut into the খাত it went to.
 *
 * ## What this replaced, and why
 *
 * Five bars, all of them the same brass, each scaled against the largest. The
 * bars answered "which is biggest" and nothing else: they could not say whether
 * the biggest was a third of the month or a twentieth, and a reader could not
 * tell from them how much of the month the five together accounted for. A ring
 * answers both by construction — every slice is a share of the same whole, and
 * the whole is the month.
 *
 * ## The chart is `components/charts/donut.tsx`
 *
 * Which adds its own slices up and prints the answer in the middle, so the
 * headline in the centre cannot disagree with the ring around it — see that
 * file. The colours are the searched palette in `charts/palette.ts`, assigned by
 * position in the sorted list, which is the condition its colour-vision
 * guarantee is stated under. The legend beneath carries every name, amount and
 * share as text, so the ring is a picture of a list rather than the only place
 * the information exists.
 *
 * ## Why the tail is folded
 *
 * There is no eighth colour, on purpose. A workspace with twenty খাত gets the
 * seven largest and one grey অন্যান্য, which is a slice that is honest about
 * being a remainder rather than a category competing with the real ones.
 */

import { Donut } from '@/components/charts/donut';
import { sharePercent } from '@/components/charts/arc';
import { MAX_SERIES, REST_COLOUR, seriesColour } from '@/components/charts/palette';
import { Money } from '@/components/money';
import { fmtNumber } from '@/lib/format';
import { t } from '@/lib/t';

export interface SpendRow {
  categoryId: string | null;
  name: string;
  totalMinor: number;
}

interface Slice {
  key: string;
  label: string;
  minor: number;
  colour: string;
}

/**
 * The rows a ring can carry: the largest few as themselves, the rest as one.
 *
 * Exported for its own test. Negative and zero rows are dropped rather than
 * drawn — a ring has no way to show a negative share, and a zero slice is a
 * legend entry with nothing behind it.
 */
export function toSlices(rows: readonly SpendRow[], restLabel: string): Slice[] {
  const ranked = rows
    .filter((row) => row.totalMinor > 0)
    .sort((a, b) => b.totalMinor - a.totalMinor);
  if (ranked.length <= MAX_SERIES) {
    return ranked.map((row, i) => ({
      key: row.categoryId ?? ' unfiled',
      label: row.name,
      minor: row.totalMinor,
      colour: seriesColour(i),
    }));
  }

  const head = ranked.slice(0, MAX_SERIES);
  const restMinor = ranked.slice(MAX_SERIES).reduce((sum, row) => sum + row.totalMinor, 0);
  return [
    ...head.map((row, i) => ({
      key: row.categoryId ?? ' unfiled',
      label: row.name,
      minor: row.totalMinor,
      colour: seriesColour(i),
    })),
    { key: ' rest', label: restLabel, minor: restMinor, colour: REST_COLOUR },
  ];
}

export function SpendSplit({ rows }: { rows: readonly SpendRow[] }) {
  const slices = toSlices(rows, t('dashboard.split.rest', 'অন্যান্য'));
  const total = slices.reduce((sum, slice) => sum + slice.minor, 0);

  if (slices.length === 0) {
    return (
      <p className="text-ink-muted mt-2 text-sm">
        {t('dashboard.noSpendYet', 'এই মাসে এখনও কোনো খরচ নেই।')}
      </p>
    );
  }

  return (
    <>
      <Donut
        className="mt-3"
        slices={slices}
        centreLabel={t('dashboard.split.total', 'মোট খরচ')}
        title={t('dashboard.split.title', 'খরচের ভাগ, খাত অনুযায়ী')}
      />
      {/* The real interface. Every figure the arcs encode, in order, as text —
          which is what makes the ring safe for a reader who cannot separate two
          of its colours, or is reading it in a theme that has none. */}
      <ul className="divide-rule mt-3 divide-y">
        {slices.map((slice) => (
          <li key={slice.key} className="flex items-center justify-between gap-2 py-1.5">
            <span className="flex min-w-0 items-center gap-2">
              <span
                aria-hidden
                className="h-2.5 w-2.5 shrink-0 rounded-sm"
                style={{ background: slice.colour }}
              />
              <span className="text-ink min-w-0 truncate text-sm">{slice.label}</span>
            </span>
            <span className="flex shrink-0 items-baseline gap-2">
              <Money minor={slice.minor} className="text-sm" decimals={false} />
              <span className="text-ink-muted w-11 text-right text-xs">
                {fmtNumber(sharePercent(slice.minor, total).toFixed(1))}%
              </span>
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}
