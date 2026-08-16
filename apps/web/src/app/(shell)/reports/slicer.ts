/**
 * How the money on this screen is cut up, and how that choice survives a
 * reload.
 *
 * The range answers *when*. This answers *along what* — and it is four
 * independent questions, all of them in the URL beside the range for the same
 * reason the range is: a view somebody arranged is a view they should be able
 * to bookmark, reload and paste into a chat.
 *
 *   kind   আয় or খরচ                                  `?kind=INCOME`
 *   by     খাত or উপ-খাত                               `?by=detail`
 *   focus  one parent category, opened up               `?focus=<id>`
 *
 * Only the non-default values are written, so a link produced before any of
 * this existed still means exactly what it meant then, and a link produced now
 * with nothing touched is byte for byte the old one.
 *
 * ## Why there is no ট্যাগ cut here, when there obviously could be
 *
 * `parent` and `detail` are two views of one partition: every taka in the
 * period sits in exactly one bucket and the buckets add up to the period. The
 * only difference is whether a sub-category is folded into its parent or listed
 * on its own line. Either way the ring is honest by construction, and the total
 * in the middle of it is the period's total.
 *
 * Tags are not a partition and no arrangement of them can be made into one. A
 * grocery bill tagged both পারিবারিক and রমজান is ৳৫০০ of family spending *and*
 * ৳৫০০ of Ramadan spending — the API says so, and publishes the double-counted
 * part as `overlapMinor` rather than dividing the bill between the two, because
 * both of the available divisions make two true answers false. A ring of tag
 * slices therefore adds up to more than the money that was spent, and there is
 * no honest number to put in the middle of it: whichever one goes there, either
 * the middle disagrees with the ring or the ring disagrees with the rest of the
 * screen.
 *
 * So tags keep the panel they already have below this one, where the figures
 * are the API's own — each share against a denominator in which every
 * transaction is counted once, and the overlap named in taka. Two different
 * percentages for the same tag on one screen is the one genuinely misleading
 * thing this screen could do, and a second ring would have been it.
 */

import { MAX_SERIES, REST_COLOUR, seriesColour } from '@/components/charts/palette';
import { sharePercent } from '@/components/charts/arc';
import { rangeParams, type ReadableParams, type ReportRange } from './range';
import type { ByCategoryDto, CategoryNode, CategoryRow, Kind } from './types';

export const SLICE_BYS = ['parent', 'detail'] as const;
export type SliceBy = (typeof SLICE_BYS)[number];

/** What the screen shows when nothing in the URL says otherwise. */
export const DEFAULT_BY: SliceBy = 'parent';

export interface Slicing {
  kind: Kind;
  by: SliceBy;
  /** A parent category the ring is opened on. Only ever set in `parent` mode. */
  focus: string | null;
}

export function isSliceBy(value: string): value is SliceBy {
  return (SLICE_BYS as readonly string[]).includes(value);
}

/**
 * What a URL is asking for. Anything unreadable resolves to the default rather
 * than to an error: a query string mangled by a chat app should still open the
 * report.
 */
export function resolveSlicing(params: ReadableParams): Slicing {
  const by = params.get('by') ?? '';
  const resolved: SliceBy = isSliceBy(by) ? by : DEFAULT_BY;
  return {
    kind: params.get('kind') === 'INCOME' ? 'INCOME' : 'EXPENSE',
    by: resolved,
    // A focus is a parent category, and only the parent view has parents in it.
    focus: resolved === 'parent' ? params.get('focus') || null : null,
  };
}

/** The query string that reproduces this view, and only what it has to say. */
export function viewParams(range: ReportRange, slicing: Slicing): URLSearchParams {
  const params = rangeParams(range);
  if (slicing.kind !== 'EXPENSE') params.set('kind', slicing.kind);
  if (slicing.by !== DEFAULT_BY) params.set('by', slicing.by);
  if (slicing.by === 'parent' && slicing.focus) params.set('focus', slicing.focus);
  return params;
}

/* -------------------------------------------------------------------------
 * Rows
 * ---------------------------------------------------------------------- */

/**
 * One line of the legend and one arc of the ring — the same object, so the two
 * cannot disagree about what they are showing.
 */
export interface SliceRow {
  key: string;
  name: string;
  /** A second line: the parent a sub-category sits under, how many entries. */
  hint?: string;
  /** Integer poisha. */
  minor: number;
  /** Share of the ring, to one decimal place. */
  percent: number;
  colour: string;
  /** Set when there are transactions behind this row to list. */
  categoryId?: string | null;
  /** This row is a parent with children the ring can be opened on. */
  drillable?: boolean;
  /** This row is the folded-up tail, not a category. */
  rest?: boolean;
}

/** What goes in, before the tail is folded and the colours are handed out. */
export type RowSeed = Omit<SliceRow, 'colour' | 'percent' | 'rest'>;

/**
 * The rows a ring may show, largest first, with everything past the seventh
 * folded into one.
 *
 * ## Why the tail is folded rather than scrolled
 *
 * There are exactly seven categorical colours, and there is no eighth — see
 * `palette.ts`. A ring with thirty slices is also unreadable at any width, and
 * on a phone the twenty smallest are a single fuzzy band. Folding is the honest
 * version of what a reader does anyway; what would not be honest is dropping
 * the tail, so অন্যান্য carries its real total and its real share, and the
 * grey it is drawn in is the one colour on the ring that is deliberately not a
 * category's.
 *
 * ## Why shares come from the total and not from the ring
 *
 * `sharePercent` divides by the sum of everything handed in, before folding.
 * That is the same number the API's own `withShares` would produce, and it is
 * what makes the folded row's share equal to the sum of the shares it replaced.
 */
export function toSlices(seeds: readonly RowSeed[], restLabel: string): SliceRow[] {
  const positive = seeds.filter((seed) => seed.minor > 0);
  const total = positive.reduce((sum, seed) => sum + seed.minor, 0);
  const sorted = positive.slice().sort((a, b) => b.minor - a.minor);

  const head = sorted.slice(0, MAX_SERIES).map((seed, i) => ({
    ...seed,
    percent: sharePercent(seed.minor, total),
    colour: seriesColour(i),
  }));

  const tail = sorted.slice(MAX_SERIES);
  if (tail.length === 0) return head;

  const restMinor = tail.reduce((sum, seed) => sum + seed.minor, 0);
  return [
    ...head,
    {
      key: '__rest',
      name: restLabel,
      hint: undefined,
      minor: restMinor,
      percent: sharePercent(restMinor, total),
      colour: REST_COLOUR,
      rest: true,
    },
  ];
}

/** Top-level categories, each carrying what was filed under its children. */
export function parentSeeds(data: ByCategoryDto): RowSeed[] {
  return data.nodes.map((node) => ({
    key: node.categoryId ?? `__unfiled:${node.name}`,
    name: node.name,
    minor: node.rolledUpMinor,
    categoryId: node.categoryId,
    drillable: node.children.length > 0,
  }));
}

/**
 * One parent opened up: its children, plus the money spent on the parent itself.
 *
 * That last row is the one an obvious implementation loses. A transaction may
 * sit on either level, so a parent with ৳৪,০০০ rolled up and ৳৩,০০০ across its
 * children has ৳১,০০০ of its own — and a ring of only the children would show
 * ৳৩,০০০ in the middle while the row that was tapped said ৳৪,০০০.
 */
export function childSeeds(node: CategoryNode, directLabel: string): RowSeed[] {
  const children: RowSeed[] = node.children.map((child) => ({
    key: child.categoryId ?? `${node.categoryId}:${child.name}`,
    name: child.name,
    minor: child.totalMinor,
    categoryId: child.categoryId,
  }));

  if (node.totalMinor <= 0) return children;
  return [
    ...children,
    {
      key: `__direct:${node.categoryId ?? node.name}`,
      name: directLabel.replace('{name}', node.name),
      minor: node.totalMinor,
      /* Deliberately no `categoryId`: drilling here would list the children's
         transactions too, which is exactly the money this row excludes. */
      categoryId: null,
    },
  ];
}

/** Every category on its own line, parents and children together. */
export function flatSeeds(rows: readonly CategoryRow[]): RowSeed[] {
  return rows.map((row) => ({
    key: row.categoryId ?? `__unfiled:${row.name}`,
    name: row.name,
    hint: row.parentName,
    minor: row.totalMinor,
    categoryId: row.categoryId,
  }));
}

/** The parent a `focus` names, or null when this period has nothing under it. */
export function focusedNode(data: ByCategoryDto | undefined, focus: string | null) {
  if (!data || !focus) return null;
  return data.nodes.find((node) => node.categoryId === focus) ?? null;
}
