/**
 * The geometry behind a donut, kept apart from the component that draws it so
 * it can be checked without a browser.
 *
 * ## The one trick worth knowing
 *
 * A circle of radius 50/π has a circumference of exactly 100, so
 * `stroke-dasharray` and `stroke-dashoffset` on it are *already* percentages.
 * That is the whole reason a donut here is a stack of `<circle>` elements and
 * not a stack of hand-computed `<path>` arcs: no trigonometry, no accumulated
 * floating-point drift around the ring, and a dash length that a person reading
 * the DOM can check against the legend beside it.
 *
 * ## Money never becomes a pixel
 *
 * Everything in `values` is integer poisha and stays integer poisha. The
 * division below produces a *fraction of a ring* and a *percentage for a
 * label* — neither ever goes back into an amount, and no amount is ever
 * reconstructed from one. `Math.floor(x + 0.5)` rather than `Math.round` is the
 * repo-wide convention for the half-up step, copied from `withShares` in
 * @hishab/core so the chart and the API round a share the same way.
 */

/** The exact radius at which a circle's circumference is 100 user units. */
export const RING_RADIUS = 50 / Math.PI;

export interface Arc {
  /** Drawn length, as a percentage of the ring. */
  dash: number;
  /** Distance from twelve o'clock to the start of the arc, clockwise. */
  offset: number;
  /** The slice's share of the total, to one decimal place, for the label. */
  percent: number;
}

/**
 * The gap between neighbouring slices, in percent of the ring.
 *
 * A hair over half a degree. It is what stops two touching arcs reading as one
 * long one, which is the failure the colour palette cannot fix on its own — and
 * it is subtracted from the *dash* rather than added to the *offset*, so the
 * slices still start exactly where their running total says they do.
 */
const DEFAULT_GAP = 0.8;

/**
 * One arc per value, in the order given.
 *
 * The caller sorts; this does not. Slice colour is assigned by position, and
 * the palette's colour-blindness guarantee is about *neighbours*, so re-sorting
 * here would quietly break a promise made two files away.
 *
 * A slice narrower than two gaps keeps its full length. Shaving a gap off a
 * 0.3% slice would leave nothing on screen at all, and a slice that is drawn
 * shorter than it is is worse than two slices that touch.
 */
export function ringArcs(values: readonly number[], gap = DEFAULT_GAP): Arc[] {
  const total = values.reduce((sum, value) => sum + Math.max(0, value), 0);
  if (total <= 0) return values.map(() => ({ dash: 0, offset: 0, percent: 0 }));

  const drawn = values.filter((value) => value > 0).length;

  let offset = 0;
  return values.map((value) => {
    const length = (Math.max(0, value) / total) * 100;
    const arc: Arc = {
      // A lone slice is a whole ring: a notch in it would look like missing data.
      dash: drawn > 1 && length > gap * 2 ? length - gap : length,
      offset,
      percent: sharePercent(value, total),
    };
    offset += length;
    return arc;
  });
}

/**
 * A part's share of a whole, to one decimal place.
 *
 * Both arguments are integer poisha; the answer is a label. Zero rather than a
 * `NaN` on an empty period, because "০%" is a true statement about a month
 * with nothing in it and `NaN%` is a bug report.
 */
export function sharePercent(partMinor: number, totalMinor: number): number {
  if (totalMinor <= 0) return 0;
  return Math.floor((partMinor / totalMinor) * 1000 + 0.5) / 10;
}
