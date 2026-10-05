'use client';

/**
 * The centre of the reports screen: one ring, and the controls that decide what
 * goes into it.
 *
 * ## What replaced what
 *
 * There was a pie here before and it was decoration. It showed the top six
 * parent categories, it could not be changed, tapped or drilled into, and the
 * list beside it was the only usable part. What this answers that it could not:
 *
 *   - *what did I actually spend on?* — উপ-খাত lists every category on its own
 *     line, which is where three sub-categories of one parent stop hiding
 *     inside it and turn out to be the three biggest things in the month
 *   - *what is inside this one?* — tapping a parent opens the ring on its
 *     children, rather than replacing the picture with a list of transactions
 *   - and every one of those choices, plus আয়/খরচ, is in the URL beside the
 *     date range, so an arrangement somebody made can be reloaded and sent on
 *
 * ## The one thing a donut must not do
 *
 * Print a number in the middle that is not the sum of the ring around it. It is
 * the easiest chart in the world to lie with and that is always the lie —
 * usually because the ring dropped a bucket, folded a tail away without
 * counting it, or was handed a total from a different query. `<Donut>` adds the
 * slices up itself and prints the answer, so this panel cannot pass it a
 * mismatched figure even by accident. `slicer.ts` explains why that rule is
 * also the reason there is no ট্যাগ option in the cut control.
 */

import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, ListFilter } from '@/components/icons';
import * as React from 'react';
import { Donut, type DonutSlice } from '@/components/charts/donut';
import { Money } from '@/components/money';
import { t } from '@/lib/t';
import { cn } from '@/lib/utils';
import { Panel, PanelSkeleton, QueryError, Segmented } from './parts';
import { fetchByCategory, fetchByCategoryFlat, reportKeys } from './queries';
import { bnNum, type Period } from './range';
import {
  childSeeds,
  flatSeeds,
  focusedNode,
  parentSeeds,
  toSlices,
  type SliceBy,
  type SliceRow,
  type Slicing,
} from './slicer';

const BY_OPTIONS: readonly (readonly [SliceBy, string])[] = [
  ['parent', t('reports.breakdown.by.parent', 'খাত')],
  ['detail', t('reports.breakdown.by.detail', 'উপ-খাত')],
];

const KIND_OPTIONS = [
  ['EXPENSE', t('entry.tab.expense', 'খরচ')],
  ['INCOME', t('entry.tab.income', 'আয়')],
] as const;

export function BreakdownPanel({
  period,
  rangeText,
  slicing,
  onSlicing,
  onOpenCategory,
}: {
  period: Period;
  /** The same period label every other panel prints, so they cannot disagree. */
  rangeText: string;
  slicing: Slicing;
  onSlicing: (next: Slicing) => void;
  /** Opens the transaction list for one category, in the sheet the screen owns. */
  onOpenCategory: (categoryId: string) => void;
}) {
  const { kind, by, focus } = slicing;

  /* Two queries, one of them live at a time. React Query keeps the other
     cached, so flipping back to a cut already fetched is instant — which is the
     whole reason these are two buttons and not two screens. `by-category` is
     fetched in both modes because the drill-down needs the parent tree even
     while the flat list is on screen. */
  const parents = useQuery({
    queryKey: reportKeys.byCategory(kind, period),
    queryFn: () => fetchByCategory(kind, period),
  });
  const flat = useQuery({
    queryKey: reportKeys.byCategoryFlat(kind, period),
    queryFn: () => fetchByCategoryFlat(kind, period),
    enabled: by === 'detail',
  });

  const active = by === 'detail' ? flat : parents;
  const node = focusedNode(parents.data, focus);

  const rows: SliceRow[] = React.useMemo(() => {
    const rest = t('reports.breakdown.rest', 'অন্যান্য');
    if (by === 'detail') return flat.data ? toSlices(flatSeeds(flat.data.rows), rest) : [];
    if (node) {
      return toSlices(childSeeds(node, t('reports.breakdown.direct', 'সরাসরি {name}')), rest);
    }
    return parents.data ? toSlices(parentSeeds(parents.data), rest) : [];
  }, [by, flat.data, node, parents.data]);

  const kindWord = kind === 'INCOME' ? KIND_OPTIONS[1][1] : KIND_OPTIONS[0][1];
  const title =
    kind === 'INCOME'
      ? t('reports.breakdown.income', 'আয় কোথা থেকে এলো')
      : t('reports.breakdown.expense', 'খরচ কোথায় গেল');

  /* What the number in the middle *is*. Inside a focused parent the ring is
     that parent's money, not the period's, and saying otherwise would put a
     figure in the middle that disagrees with the summary two panels up. */
  const centreLabel = node
    ? node.name
    : kind === 'INCOME'
      ? t('reports.breakdown.centreIncome', 'মোট আয়')
      : t('reports.breakdown.centreExpense', 'মোট খরচ');

  const slices: DonutSlice[] = rows.map((row) => ({
    key: row.key,
    label: row.name,
    minor: row.minor,
    colour: row.colour,
  }));

  /* Tapping an arc does whatever tapping its legend row does. The arcs are not
     the accessible control — see `<Donut>` — so this must never be the only way
     to reach a slice, and it is not. */
  const onSlice = (key: string): void => {
    const row = rows.find((candidate) => candidate.key === key);
    if (!row) return;
    if (row.drillable && row.categoryId) onSlicing({ ...slicing, focus: row.categoryId });
    else if (row.categoryId) onOpenCategory(row.categoryId);
  };

  return (
    <Panel
      title={title}
      scope={`${rangeText} · ${kindWord}`}
      className="lg:col-span-2"
      testId="breakdown"
    >
      {/* Both controls in the body rather than in the header: at 320px a header
          holding two of them beside a two-line title has nowhere to put them. */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Segmented
          label={t('reports.breakdown.kindLabel', 'আয় দেখবেন না খরচ')}
          value={kind}
          options={KIND_OPTIONS}
          onChange={(next) => onSlicing({ ...slicing, kind: next, focus: null })}
        />
        <Segmented
          label={t('reports.breakdown.byLabel', 'কীভাবে ভাগ করে দেখবেন')}
          value={by}
          options={BY_OPTIONS}
          onChange={(next) => onSlicing({ ...slicing, by: next, focus: null })}
        />
      </div>

      {active.isError ? (
        <QueryError
          message={t('reports.breakdown.failed', 'ভাগ করা হিসাব আনা যায়নি।')}
          onRetry={() => void active.refetch()}
        />
      ) : active.isPending ? (
        <PanelSkeleton rows={5} />
      ) : (
        <>
          {node ? (
            <FocusBar
              name={node.name}
              onClear={() => onSlicing({ ...slicing, focus: null })}
              onOpen={node.categoryId ? () => onOpenCategory(node.categoryId!) : undefined}
            />
          ) : null}

          {rows.length === 0 ? (
            <p className="text-ink-muted mt-4 text-sm">
              {t('reports.emptyPeriod', 'এই সময়ে কিছু নেই।')}
            </p>
          ) : (
            <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-start">
              <div className="w-full sm:w-52 sm:shrink-0">
                <Donut slices={slices} centreLabel={centreLabel} title={title} onSelect={onSlice} />
              </div>

              {/* The legend is the interface, not a key to the picture: every
                  slice is here with its name, its share and its amount, and
                  every one of them is the thing you tap. Colour is the last of
                  four signals on a row rather than the only one. */}
              <ul className="min-w-0 flex-1" data-testid="breakdown-legend">
                {rows.map((row) => (
                  <LegendRow
                    key={row.key}
                    row={row}
                    onDrill={
                      row.drillable && row.categoryId
                        ? () => onSlicing({ ...slicing, focus: row.categoryId! })
                        : undefined
                    }
                    onOpen={row.categoryId ? () => onOpenCategory(row.categoryId!) : undefined}
                  />
                ))}
              </ul>
            </div>
          )}

          <p className="text-ink-muted mt-3 text-xs">
            {by === 'detail'
              ? t(
                  'reports.breakdown.detailHint',
                  'প্রতিটি খাত ও উপ-খাত আলাদা সারিতে — কিছুই যোগ করে দেখানো হয়নি।',
                )
              : t(
                  'reports.breakdown.parentHint',
                  'উপ-খাতের টাকা তার মূল খাতের সঙ্গেই ধরা হয়েছে। কোনো খাতে চাপ দিলে তার ভেতরটা দেখা যাবে।',
                )}
          </p>
        </>
      )}
    </Panel>
  );
}

/** Where the ring is, and the two ways out of it. */
function FocusBar({
  name,
  onClear,
  onOpen,
}: {
  name: string;
  onClear: () => void;
  onOpen?: () => void;
}) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={onClear}
        className="press border-rule text-ink hover:bg-greenbar flex min-h-11 items-center gap-1 rounded-full border px-3 text-sm md:min-h-9"
      >
        <ChevronLeft className="h-4 w-4" aria-hidden />
        {t('reports.breakdown.allCategories', 'সব খাত')}
      </button>
      <span className="text-ink min-w-0 flex-1 truncate text-sm font-medium">{name}</span>
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          className="press text-income hover:bg-greenbar flex min-h-11 shrink-0 items-center gap-1 rounded-xl px-2 text-xs font-medium md:min-h-9"
        >
          <ListFilter className="h-3.5 w-3.5" aria-hidden />
          {t('reports.breakdown.allEntries', 'সব লেনদেন')}
        </button>
      ) : null}
    </div>
  );
}

function LegendRow({
  row,
  onDrill,
  onOpen,
}: {
  row: SliceRow;
  onDrill?: () => void;
  onOpen?: () => void;
}) {
  const body = (
    <>
      <span
        aria-hidden
        className="h-2.5 w-2.5 shrink-0 rounded-full"
        style={{ background: row.colour }}
      />
      <span className="min-w-0 flex-1">
        <span className={cn('text-ink block truncate text-sm', row.rest && 'italic')}>
          {row.name}
        </span>
        {row.hint ? (
          <span className="text-ink-muted block truncate text-xs">{row.hint}</span>
        ) : null}
      </span>
      <span className="text-ink-muted shrink-0 text-xs tabular-nums">
        {bnNum(row.percent.toFixed(1))}%
      </span>
      <Money minor={row.minor} className="shrink-0 text-sm" decimals={false} />
    </>
  );

  const action = onDrill ?? onOpen;

  /* অন্যান্য and সরাসরি X are real rows with nowhere honest to go: the first is
     several categories at once, the second is deliberately *not* the category's
     rolled-up total. A tap that led somewhere approximate would be worse than
     no tap at all. */
  if (!action) {
    return (
      <li>
        <div className="flex min-h-11 items-center gap-2 px-1">{body}</div>
      </li>
    );
  }

  return (
    <li>
      <button
        type="button"
        onClick={action}
        /* `— উপ-খাত` is the wording the old chevron carried and the e2e suite
           still asks for by name. It is also the better label: it says what the
           tap does rather than repeating the row. */
        aria-label={
          onDrill
            ? t('reports.breakdown.openSub', '{name} — উপ-খাত').replace('{name}', row.name)
            : t('reports.breakdown.openEntries', '{name} — লেনদেনগুলো').replace('{name}', row.name)
        }
        className="press hover:bg-greenbar flex min-h-11 w-full items-center gap-2 rounded-xl px-1 text-left"
      >
        {body}
        <ChevronRight className="text-ink-muted h-4 w-4 shrink-0" aria-hidden />
      </button>
    </li>
  );
}
