/**
 * The reports date range: what it is, how it survives a reload, and what "the
 * previous equivalent period" means for each preset.
 *
 * Nothing in here invents date arithmetic. `presetRange` in `@hishab/core` is
 * the single definition of "গত মাস" in this product — the loan statement chips
 * already run on it — and a second implementation here would disagree with it
 * on the 1st of a month, which is exactly the day somebody opens last month's
 * report. The two presets core does not name (`lastYear`, and the previous
 * period of any preset) are still asked of core, by handing it an anchor date
 * inside the period wanted rather than by re-deriving the rule.
 *
 * Dates on the wire are `YYYY-MM-DD` and both ends are **inclusive**: the API's
 * `ReportsService.range` turns `to` into a half-open upper bound itself, so a
 * transaction recorded on the last day of the range is inside it.
 */

import { presetRange, type DatePreset } from '@hishab/core';

export type NamedPreset = DatePreset | 'lastYear';
export type ReportPreset = NamedPreset | 'custom';

export interface Period {
  /** YYYY-MM-DD, inclusive. */
  from: string;
  /** YYYY-MM-DD, inclusive. */
  to: string;
}

export interface ReportRange extends Period {
  preset: ReportPreset;
}

/** The chips, in the order they are read. `custom` is the eighth and opens two dates. */
export const PRESETS: readonly (readonly [NamedPreset, string])[] = [
  ['today', 'আজ'],
  ['yesterday', 'গতকাল'],
  ['last7', 'গত ৭ দিন'],
  ['thisMonth', 'এই মাস'],
  ['lastMonth', 'গত মাস'],
  ['thisYear', 'এই বছর'],
  ['lastYear', 'গত বছর'],
];

/** What the API assumes when it is sent nothing, so an untouched screen is unchanged. */
export const DEFAULT_PRESET: NamedPreset = 'thisMonth';

/** `ReportsController.trend` clamps `months` to this. */
export const MAX_TREND_MONTHS = 36;

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A `Date`'s own calendar fields as `YYYY-MM-DD`.
 *
 * Deliberately not `toLocalDateString`, which projects into Asia/Dhaka: the
 * dates here come out of `presetRange`, which is built from local calendar
 * components, and projecting one of those through a second timezone would move
 * "আজ" by a day for anybody not sitting in Dhaka. This is formatting, not
 * arithmetic — the arithmetic stays in core.
 */
export function isoOf(date: Date): string {
  const y = String(date.getFullYear()).padStart(4, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** The inverse: local midnight of a `YYYY-MM-DD`, ready to hand back to core. */
function localMidnight(iso: string): Date {
  const m = ISO.exec(iso);
  if (!m) throw new TypeError(`Expected YYYY-MM-DD, got ${JSON.stringify(iso)}`);
  const [, y, mo, d] = m;
  return new Date(Number(y), Number(mo) - 1, Number(d), 0, 0, 0, 0);
}

export function isIsoDate(value: string): boolean {
  return ISO.test(value);
}

export function isNamedPreset(value: string): value is NamedPreset {
  return PRESETS.some(([key]) => key === value);
}

/**
 * A named preset as inclusive ISO bounds.
 *
 * `lastYear` is core's `thisYear` asked about a day in the previous year — the
 * rule, not a copy of it.
 */
export function periodForPreset(preset: NamedPreset, today: Date): Period {
  const anchor = preset === 'lastYear' ? new Date(today.getFullYear() - 1, 0, 1) : today;
  const core = presetRange(preset === 'lastYear' ? 'thisYear' : preset, anchor);
  return { from: isoOf(core.from), to: isoOf(core.to) };
}

export function rangeForPreset(preset: NamedPreset, today: Date): ReportRange {
  return { preset, ...periodForPreset(preset, today) };
}

/* -------------------------------------------------------------------------
 * The URL is the state
 * ---------------------------------------------------------------------- */

/** Only what `useSearchParams()` and `URLSearchParams` both provide. */
export interface ReadableParams {
  get(name: string): string | null;
}

/**
 * The range a URL is asking for, with the current month as the answer to
 * anything unreadable — a report that refuses to render because a query string
 * was mangled in a chat app is worse than a report of the default period.
 */
export function resolveRange(params: ReadableParams, today: Date): ReportRange {
  const preset = params.get('preset') ?? '';
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const bothDates = isIsoDate(from) && isIsoDate(to);

  // A link carrying only two dates is a custom range even without the marker.
  if ((preset === 'custom' || preset === '') && bothDates) {
    // Reversed bounds are a shared link somebody hand-edited; read them the way
    // round that has days in it rather than showing an empty report.
    return from <= to ? { preset: 'custom', from, to } : { preset: 'custom', from: to, to: from };
  }
  if (isNamedPreset(preset)) return rangeForPreset(preset, today);
  return rangeForPreset(DEFAULT_PRESET, today);
}

/** The query string that reproduces this view. Custom ranges carry their dates. */
export function rangeParams(range: ReportRange): URLSearchParams {
  const params = new URLSearchParams();
  params.set('preset', range.preset);
  if (range.preset === 'custom') {
    params.set('from', range.from);
    params.set('to', range.to);
  }
  return params;
}

/** `?from=…&to=…` for the API, which takes explicit dates and no preset. */
export function periodQuery(period: Period): string {
  return new URLSearchParams({ from: period.from, to: period.to }).toString();
}

/* -------------------------------------------------------------------------
 * The previous equivalent period
 * ---------------------------------------------------------------------- */

/** Days from `from` to `to` inclusive, counted on UTC copies so no offset applies. */
export function inclusiveDays(period: Period): number {
  const at = (iso: string): number => {
    const d = localMidnight(iso);
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  };
  return Math.trunc((at(period.to) - at(period.from)) / 86_400_000) + 1;
}

/** Calendar-component shift, the way core's own `dayStart` does it — DST cannot bite. */
function shiftDays(iso: string, days: number): string {
  const d = localMidnight(iso);
  return isoOf(new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, 0, 0, 0, 0));
}

/**
 * The period a comparison is against.
 *
 * Calendar presets get the calendar answer — the month before a 31-day month is
 * whatever length February is, not 31 days earlier — and everything else gets
 * the same number of days ending the day before this period starts.
 */
export function previousPeriod(range: ReportRange, today: Date): Period {
  switch (range.preset) {
    case 'thisMonth':
      return periodForPreset('lastMonth', today);
    case 'lastMonth': {
      // core's 'lastMonth' asked about a day inside last month: the one before it.
      const core = presetRange('lastMonth', localMidnight(range.from));
      return { from: isoOf(core.from), to: isoOf(core.to) };
    }
    case 'thisYear':
      return periodForPreset('lastYear', today);
    case 'lastYear': {
      const core = presetRange('thisYear', new Date(Number(range.from.slice(0, 4)) - 1, 0, 1));
      return { from: isoOf(core.from), to: isoOf(core.to) };
    }
    default: {
      const days = inclusiveDays(range);
      return { from: shiftDays(range.from, -days), to: shiftDays(range.from, -1) };
    }
  }
}

/* -------------------------------------------------------------------------
 * The trend chart's window
 *
 * `GET /v1/reports/trend` takes `months` and nothing else: it always ends at
 * the current calendar month and walks backwards. So the range cannot be sent
 * to it — it has to be asked for enough months to reach the start of the range
 * and then cut down to the months the range actually covers.
 * ---------------------------------------------------------------------- */

export interface TrendWindow {
  /** What to ask the endpoint for. */
  months: number;
  /** Inclusive `YYYY-MM` bounds to keep out of the answer. */
  firstMonth: string;
  lastMonth: string;
  /** The range reaches further back than the endpoint will go. */
  truncated: boolean;
  /** The range is not whole calendar months, so these bars overstate it. */
  partialMonths: boolean;
}

const monthIndex = (key: string): number => Number(key.slice(0, 4)) * 12 + Number(key.slice(5, 7));

export function trendWindow(range: ReportRange, today: Date): TrendWindow {
  const firstMonth = range.from.slice(0, 7);
  const lastMonth = range.to.slice(0, 7);
  const needed = monthIndex(isoOf(today).slice(0, 7)) - monthIndex(firstMonth) + 1;

  // Whole months, judged by core: is `from` the first day of its month and `to`
  // the last day of its?
  const startsMonth =
    isoOf(presetRange('thisMonth', localMidnight(range.from)).from) === range.from;
  const endsMonth = isoOf(presetRange('thisMonth', localMidnight(range.to)).to) === range.to;

  return {
    months: Math.min(MAX_TREND_MONTHS, Math.max(1, needed)),
    firstMonth,
    lastMonth,
    truncated: needed > MAX_TREND_MONTHS,
    partialMonths: !startsMonth || !endsMonth,
  };
}

/** `YYYY-MM` sorts lexically, so the bounds compare as strings. */
export function withinWindow<T extends { month: string }>(
  points: readonly T[],
  window: TrendWindow,
): T[] {
  return points.filter((p) => p.month >= window.firstMonth && p.month <= window.lastMonth);
}

/* -------------------------------------------------------------------------
 * Bengali labels
 * ---------------------------------------------------------------------- */

/* One implementation, in `lib/format.ts`, which follows the workspace's
   language. There were ten near-identical copies of these across the app and
   every one of them hardcoded Bengali digits. The old names are re-exported so
   the call sites in this folder stay as they are. */
import { fmtDate as bnDate, fmtNumber as bnNum } from '@/lib/format';
import { t } from '@/lib/t';

export { bnDate, bnNum };

/**
 * Month names short enough for a 44px column on a chart.
 *
 * `fmtDate` and friends all spell a month out in full and put a year beside it
 * — "আগস্ট ২০২৬" — which is right in a ledger row and four times too wide under
 * a bar. Resolved once at module load rather than per render, the way
 * `nav-model.ts` and the label tables do: `t()` reads a module variable that is
 * seeded synchronously before the first component renders, and a language
 * change reloads the page.
 */
const SHORT_MONTHS: readonly string[] = [
  t('reports.month.1', 'জানু'),
  t('reports.month.2', 'ফেব্রু'),
  t('reports.month.3', 'মার্চ'),
  t('reports.month.4', 'এপ্রি'),
  t('reports.month.5', 'মে'),
  t('reports.month.6', 'জুন'),
  t('reports.month.7', 'জুলা'),
  t('reports.month.8', 'আগ'),
  t('reports.month.9', 'সেপ্ট'),
  t('reports.month.10', 'অক্টো'),
  t('reports.month.11', 'নভে'),
  t('reports.month.12', 'ডিসে'),
];

/**
 * `2026-08` as "আগ". The year is dropped on purpose: a trend chart's columns
 * are consecutive, so only the January boundary is ambiguous — and the panel's
 * own date range, printed above it, resolves that.
 */
export function shortMonth(key: string): string {
  return SHORT_MONTHS[Number(key.slice(5, 7)) - 1] ?? key;
}

export function rangeLabel(range: ReportRange): string {
  if (range.preset === 'custom') return `${bnDate(range.from)} — ${bnDate(range.to)}`;
  return PRESETS.find(([key]) => key === range.preset)?.[1] ?? 'এই মাস';
}

/** The exact days, spelled out under the chips so a preset is never ambiguous. */
export function periodLabel(period: Period): string {
  return period.from === period.to
    ? bnDate(period.from)
    : `${bnDate(period.from)} — ${bnDate(period.to)}`;
}

const COMPARISON_LABEL: Record<ReportPreset, string> = {
  today: 'গতকালের তুলনায়',
  yesterday: 'তার আগের দিনের তুলনায়',
  last7: 'আগের ৭ দিনের তুলনায়',
  thisMonth: 'গত মাসের তুলনায়',
  lastMonth: 'তার আগের মাসের তুলনায়',
  thisYear: 'গত বছরের তুলনায়',
  lastYear: 'তার আগের বছরের তুলনায়',
  custom: 'আগের সমান সময়ের তুলনায়',
};

export function comparisonLabel(range: ReportRange): string {
  return COMPARISON_LABEL[range.preset];
}
