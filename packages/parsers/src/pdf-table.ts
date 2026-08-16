/**
 * Turning the scattered text runs of a PDF back into a table.
 *
 * A PDF does not contain rows and columns. It contains instructions of the form
 * "draw `1,250.50` at x=412, y=690", in whatever order the generator felt like
 * emitting them, and the fact that a human sees a table is entirely an accident
 * of where the ink landed. Extracting the text is the easy half and belongs to
 * a real PDF library; putting it back into a grid is the half nobody else can
 * do for us, because it depends on knowing that what we are looking at is a
 * bank statement and not a poem.
 *
 * This module is deliberately free of any PDF dependency: it takes positioned
 * text and returns a grid of strings, so the whole of the hard reasoning below
 * can be unit-tested with three lines of literal input.
 *
 * ## Rows: grouped by baseline
 *
 * Everything printed at the same height is one row. Simple, and it holds for
 * every machine-generated statement, because that is how the generator laid it
 * out in the first place.
 *
 * ## Columns: found in the gaps, across the whole document at once
 *
 * The tempting approach is to split each line wherever there is a wide gap.
 * It fails immediately: `ATM WITHDRAWAL DHAKA` has gaps between its words, and
 * a row whose description happens to be one word has no gaps at all, so every
 * line ends up with a different number of columns and the mapping — which is
 * "column 3 is the date" — cannot mean anything.
 *
 * So the columns are found *once, from every row together*. A vertical strip of
 * the page that no row ever prints into is a gutter between two columns; a
 * strip that some row prints into is inside a column. Word gaps inside a
 * description do not survive this, because the next row's description has its
 * word gaps in different places and between them they fill the strip. Column
 * boundaries do survive, because a table's whole purpose is that they line up.
 *
 * It also handles right-aligned amount columns for free, which the
 * split-on-gaps approach cannot: the left edges of `50,000.00` and `60.00` are
 * nowhere near each other, but the empty strip to the left of the widest of
 * them is still empty.
 *
 * ## Where it gives up
 *
 * A statement whose description column is wide enough to run under the amount
 * heading on *every* row has no gutter there and the two columns merge into
 * one. That is reported honestly by there simply being fewer columns; the user
 * sees the preview, sees the amount stuck on the end of the description, and
 * can say so. It is not corrected by guessing, because the guess would be
 * "split this row at the last number", and the day that fires on a description
 * containing an invoice number it puts the wrong amount in somebody's books.
 */

export interface PositionedText {
  text: string;
  /** Left edge, in points, with x increasing rightwards. */
  x: number;
  /** Baseline, in points, with y increasing **downwards** (viewport order). */
  y: number;
  /** Advance width of `text`, in points. */
  width: number;
  /** Line height in points, when the extractor knows it. Used only for tolerance. */
  height?: number;
}

export interface TableOptions {
  /**
   * How far apart two baselines can be and still be the same row. Default 3pt,
   * which is under half a line at any statement's type size and comfortably
   * over the sub-point wobble a generator introduces within one line.
   */
  lineTolerance?: number;
  /** How wide an empty vertical strip has to be to count as a gutter. Default 5pt. */
  minGutter?: number;
}

const DEFAULT_LINE_TOLERANCE = 3;

/**
 * 5pt. A space at 10pt Helvetica is about 2.8pt and at 12pt about 3.3pt, so
 * this is wide enough that a single word gap never reads as a column boundary
 * even in the pathological case of a one-row table.
 */
const DEFAULT_MIN_GUTTER = 5;

/** Below this many rows the gaps carry no evidence, so no columns are inferred. */
const MIN_ROWS_FOR_GUTTERS = 3;

/**
 * Which lines get a vote on where the columns are.
 *
 * Not all of them. A statement opens with a letterhead — the bank's name, a
 * branch address, "Statement for July 2026" — and each of those is one long run
 * of text starting at the left margin and finishing somewhere in the middle of
 * the table. Three of them are enough to ink over the gutter between the date
 * column and the description column, and then those two columns merge and every
 * row of the file fails to parse a date. That is not a hypothetical; it is what
 * the first real statement did.
 *
 * The discriminator is the number of separate runs on the line. A row of a
 * table has one per cell; a line of prose has one, or a handful of words. So
 * lines with at least the median number of runs are the ones that vote, which
 * on any statement means the table and not the letterhead — and on a document
 * whose rows are uniform means all of them, because the median is then the row.
 *
 * Every line is still placed into the resulting columns. The letterhead is not
 * discarded, it just does not get to decide where the columns are.
 */
function votingLines(lines: readonly Line[]): readonly Line[] {
  const counts = lines.map((line) => line.items.length).sort((a, b) => a - b);
  const median = counts[Math.floor(counts.length / 2)] ?? 1;
  const voters = lines.filter((line) => line.items.length >= median);
  return voters.length >= MIN_ROWS_FOR_GUTTERS ? voters : lines;
}

interface Line {
  y: number;
  items: PositionedText[];
}

function isBlank(text: string): boolean {
  return text.trim() === '';
}

/**
 * Text runs grouped into lines by baseline, in reading order.
 *
 * Exported because "did the extractor even find any lines" is a question the
 * caller has to answer before it can say anything useful about a scanned page.
 */
export function linesFromTextItems(
  items: readonly PositionedText[],
  options: TableOptions = {},
): Line[] {
  const tolerance = options.lineTolerance ?? DEFAULT_LINE_TOLERANCE;

  /* Whitespace-only runs are dropped rather than kept as thin items. Some
     extractors emit a synthetic space for every gap they see, and keeping them
     would paint over exactly the empty strips the column finder is looking
     for — the runs are inserted *because* there is a gap there. */
  const real = items.filter((item) => !isBlank(item.text));
  const sorted = [...real].sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y));

  const lines: Line[] = [];
  for (const item of sorted) {
    const current = lines[lines.length - 1];
    if (current && Math.abs(item.y - current.y) <= tolerance) {
      current.items.push(item);
      continue;
    }
    lines.push({ y: item.y, items: [item] });
  }

  for (const line of lines) line.items.sort((a, b) => a.x - b.x);
  return lines;
}

interface Band {
  from: number;
  to: number;
}

/**
 * The column bands, as `[from, to)` ranges in points.
 *
 * `maxOverlapRows` is how many rows are allowed to print into a strip and have
 * it still count as a gutter. Zero is the honest first answer; the caller
 * retries with a small tolerance only when zero found no table at all, because
 * a real statement often has one summary line ruled across the full width.
 */
function bandsFrom(lines: readonly Line[], minGutter: number, maxOverlapRows: number): Band[] {
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  for (const line of lines) {
    for (const item of line.items) {
      if (item.x < left) left = item.x;
      const end = item.x + Math.max(item.width, 0);
      if (end > right) right = end;
    }
  }
  if (!Number.isFinite(left) || right <= left) return [];

  const origin = Math.floor(left);
  const width = Math.ceil(right) - origin;
  if (width <= 0) return [];

  /* One counter per point of page width: how many *rows* print into it. Rows,
     not runs — a row with three words in one column must count once, or a
     three-column table on a busy page would never show a gutter. */
  const coverage = new Int32Array(width);
  const touched = new Uint8Array(width);

  for (const line of lines) {
    touched.fill(0);
    for (const item of line.items) {
      const from = Math.max(0, Math.floor(item.x) - origin);
      const to = Math.min(width, Math.ceil(item.x + Math.max(item.width, 0)) - origin);
      for (let at = from; at < to; at += 1) touched[at] = 1;
    }
    for (let at = 0; at < width; at += 1) {
      if (touched[at] === 1) coverage[at] = (coverage[at] as number) + 1;
    }
  }

  const bands: Band[] = [];
  let start: number | null = null;
  let gap = 0;

  const close = (end: number): void => {
    if (start !== null) bands.push({ from: origin + start, to: origin + end });
    start = null;
  };

  for (let at = 0; at < width; at += 1) {
    const inked = (coverage[at] as number) > maxOverlapRows;
    if (inked) {
      if (start === null) start = at;
      gap = 0;
      continue;
    }
    if (start === null) continue;
    gap += 1;
    if (gap >= minGutter) {
      close(at - gap + 1);
      gap = 0;
    }
  }
  close(width);

  return bands;
}

function bandOf(bands: readonly Band[], centre: number): number {
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index] as Band;
    if (centre >= band.from && centre < band.to) return index;
  }
  /* In a gutter. Only reachable on the tolerant second pass, where a band was
     allowed to have a few rows printing across it — the nearest column is the
     right answer and is what the eye would say too. */
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index] as Band;
    const distance =
      centre < band.from ? band.from - centre : centre >= band.to ? centre - band.to : 0;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }
  return best;
}

function gridFrom(lines: readonly Line[], bands: readonly Band[]): string[][] {
  return lines.map((line) => {
    const cells: string[] = Array.from({ length: bands.length }, () => '');
    for (const item of line.items) {
      const centre = item.x + Math.max(item.width, 0) / 2;
      const column = bandOf(bands, centre);
      const existing = cells[column] as string;
      cells[column] = existing === '' ? item.text.trim() : `${existing} ${item.text.trim()}`;
    }
    return cells;
  });
}

/**
 * Positioned text into a rectangular grid of strings.
 *
 * Give it every run from every page at once, with each page's `y` offset so the
 * pages stack. That is on purpose: the columns of page two are the columns of
 * page one, and finding them separately is how a three-page statement ends up
 * with three incompatible mappings.
 */
export function gridFromTextItems(
  items: readonly PositionedText[],
  options: TableOptions = {},
): string[][] {
  const minGutter = options.minGutter ?? DEFAULT_MIN_GUTTER;
  const lines = linesFromTextItems(items, options);
  if (lines.length === 0) return [];

  if (lines.length < MIN_ROWS_FOR_GUTTERS) {
    // Too little evidence to say where a column ends. One cell per run, in order.
    return lines.map((line) => line.items.map((item) => item.text.trim()));
  }

  const voters = votingLines(lines);
  let bands = bandsFrom(voters, minGutter, 0);

  /* A second, tolerant pass, used only when the strict one did not find a table
     shape. One line ruled across the page — "Total for July", a footer, an
     address in the letterhead — inks over every gutter at once, and losing the
     whole table to it would be absurd.

     Three is the threshold because a bank statement has at least a date, a
     description and an amount; anything less than that is not a table we
     managed to read. Deciding it that way round matters: the tolerant pass can
     only ever *add* boundaries, so running it by default would eventually split
     a description column on the handful of rows that happen to be short. */
  if (bands.length < 3) {
    bands = bandsFrom(voters, minGutter, Math.max(1, Math.floor(voters.length * 0.05)));
  }
  if (bands.length === 0) return [];

  return gridFrom(lines, bands);
}

/**
 * Drop the repeated heading rows that every page after the first carries.
 *
 * A statement's header appears once per page, and once the pages are stacked
 * those repeats sit in the middle of the data where they parse as neither a
 * date nor an amount and turn into "row 41 could not be read". They are not
 * errors, they are furniture, and the user should not be asked about them.
 *
 * Only a row that is *identical* to the heading is removed, cell for cell after
 * trimming and case-folding. Anything less strict starts eating rows.
 */
export function dropRepeatedHeaders(grid: readonly (readonly string[])[]): string[][] {
  if (grid.length === 0) return [];

  const fingerprint = (row: readonly string[]): string =>
    row.map((cell) => cell.trim().toLowerCase()).join('');

  const header = fingerprint(grid[0] as readonly string[]);
  return grid.filter((row, index) => index === 0 || fingerprint(row) !== header) as string[][];
}
