'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronDown,
  Paperclip,
  Pencil,
  RotateCw,
  Search,
  SlidersHorizontal,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';
import { addDays, startOfMonth, toLocalDateString } from '@hishab/shared';
import { AttachmentPicker } from '@/components/attachment-picker';
import {
  AttachmentBadge,
  AttachmentViewer,
  type UploadedAttachment,
} from '@/components/attachment-viewer';
import { Money } from '@/components/money';
import { QuickAddSheet } from '@/components/quick-add-sheet';
import { SkeletonRows } from '@/components/skeleton';
import { SwipeRow } from '@/components/swipe-row';
import { UndoToast } from '@/components/undo-toast';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { useCoarsePointer, useMediaQuery } from '@/hooks/use-device';
import {
  api,
  ApiError,
  endpoints,
  type AccountDto,
  type CategoryDto,
  type TransactionDto,
} from '@/lib/api';
import { useDisplayName } from '@/lib/display-name';
import { t } from '@/lib/t';
import { fmtDate, fmtNumber } from '@/lib/format';
import { haptic } from '@/lib/haptics';
import { cn } from '@/lib/utils';
import { TagDot } from '../tags/parts';
import { fetchTags, tagKeys } from '../tags/queries';
import { type TagDto } from '../tags/types';

/**
 * The khata.
 *
 * Two things here are worth knowing before changing anything:
 *
 *  1. **The list is paginated by cursor, not by a bigger limit.** The API caps
 *     `limit` at 100 and answers with a `nextCursor`, so a user with four
 *     hundred transactions reaches all of them by asking for more — never by us
 *     raising a number until it breaks. t('txn.loadMore', 'আরও দেখুন') rather than infinite
 *     scroll on purpose: this is a list people scan for one particular row, and
 *     a scrollbar that keeps shrinking under the thumb makes that harder, not
 *     easier. The button also tells them there *is* more.
 *
 *  2. **The filters live in the URL.** A filtered khata can be reloaded,
 *     bookmarked and sent to somebody else. `useSearchParams` is therefore the
 *     single source of truth; component state exists only for the one control
 *     that has to lag behind it, the debounced search box. Written with
 *     `router.replace` rather than `push`: a debounced search box on `push`
 *     buries the previous screen under one history entry per committed word,
 *     and on a phone "back" is a system gesture people expect to leave the
 *     khata, not to retype their search backwards.
 */

/** The API's own default. One page is one screenful of scrolling on a phone. */
const PAGE_SIZE = 50;

const bn = (value: number | string): string => fmtNumber(String(value));

/** Types the simple transaction body can express, and therefore can be edited. */
const SIMPLE_TYPES = new Set(['INCOME', 'EXPENSE', 'TRANSFER', 'ADJUSTMENT', 'OPENING_BALANCE']);

const TYPE_LABEL: Record<string, string> = {
  INCOME: 'আয়',
  EXPENSE: 'খরচ',
  TRANSFER: 'ট্রান্সফার',
  ADJUSTMENT: 'সমন্বয়',
  OPENING_BALANCE: 'প্রারম্ভিক জের',
  LOAN_GIVEN: 'ধার দিয়েছি',
  LOAN_REPAID: 'ধার ফেরত পেয়েছি',
  BORROWED: 'ধার নিয়েছি',
  BORROW_REPAID: 'ধার শোধ করেছি',
  SAVINGS_DEPOSIT: 'সঞ্চয়ে জমা',
  SAVINGS_WITHDRAWAL: 'সঞ্চয় থেকে তোলা',
  PREMIUM_PAID: 'বিমার প্রিমিয়াম',
};

const SOURCE_LABEL: Record<string, string> = {
  MANUAL: 'হাতে লেখা',
  SMS: 'এসএমএস',
  EMAIL: 'ইমেইল',
  WEBHOOK: 'ওয়েবহুক',
  OCR: 'ছবি থেকে',
  IMPORT: 'ফাইল থেকে',
  RECURRING: 'নিয়মিত',
};

/**
 * `attachmentIds` is on the Prisma `Transaction` model and on every other
 * module's DTO, but the transaction API neither accepts it on the simple create
 * or update body (`simpleTransactionSchema`) nor returns it from `present()`.
 * Reading it optionally costs nothing and means receipts light up on this
 * screen the moment those two lines land, with no change here.
 *
 * `tags` is the same intersection for the opposite reason: the API *does*
 * return it on every transaction, but `TransactionDto` in `@/lib/api` has not
 * caught up and that file belongs to another change. Optional, so a payload
 * replayed from the offline queue that predates tagging still types.
 */
type LedgerTxn = TransactionDto;

/**
 * Still a function rather than a field read.
 *
 * A payload replayed from the offline queue can predate either field, and at
 * runtime that is `undefined` however the type reads. One `?? []` here beats
 * the same guard at four call sites.
 */
const attachmentsOf = (txn: LedgerTxn): string[] => txn.attachmentIds ?? [];

const labelOf = (txn: TransactionDto): string =>
  txn.description || txn.categoryName || t('entry.transaction', 'লেনদেন');

/* The two label tables above keep their Bengali beside the key and are looked
   up through `t` at render, rather than being translated where they are
   declared: a module-level constant is evaluated before a workspace's own
   wording override has been fetched. */
const typeLabel = (type: string): string =>
  TYPE_LABEL[type] ? t(`txn.type.${type}`, TYPE_LABEL[type]) : type;

const sourceLabel = (source: string): string =>
  SOURCE_LABEL[source] ? t(`txn.source.${source}`, SOURCE_LABEL[source]) : source;

// --- filter state ----------------------------------------------------------

/**
 * Every name here is a real `transactionQuerySchema` parameter, spelled the way
 * the server spells it, so the URL and the request are the same vocabulary.
 *
 * `minAmount`/`maxAmount` are still absent, but no longer for the reason
 * originally written here: the schema has since gained `z.coerce` on both, so
 * they would work. Adding the two controls is a change of its own.
 *
 * `tagId` is here rather than in component state for the same reason as the
 * rest — t('txn.searchHint', 'পারিবারিক, last month') has to survive a reload and be sendable to
 * somebody else — and because the by-tag report links straight into it.
 */
const FILTER_KEYS = [
  'q',
  'from',
  'to',
  'accountId',
  'categoryId',
  'tagId',
  'type',
  'source',
  'personId',
] as const;

type FilterKey = (typeof FILTER_KEYS)[number];
type FilterState = Record<FilterKey, string>;

/** Filters other than the free-text search, which has its own affordance. */
const CHIP_KEYS: readonly FilterKey[] = [
  'from',
  'to',
  'accountId',
  'categoryId',
  'tagId',
  'type',
  'source',
  'personId',
];

interface LoanPersonRow {
  personId: string;
  personName: string;
}

export default function TransactionsPage() {
  /* `useSearchParams` suspends during prerender; the house pattern is a
     boundary around the part that reads it (see app/login/page.tsx). */
  return (
    <React.Suspense
      fallback={
        <div className="rounded-card border-rule bg-surface mx-auto w-full max-w-5xl overflow-hidden border">
          <SkeletonRows rows={6} />
        </div>
      }
    >
      <TransactionsScreen />
    </React.Suspense>
  );
}

function TransactionsScreen() {
  const queryClient = useQueryClient();
  const coarse = useCoarsePointer();
  /* 1024px, not the 768px `useIsDesktop` breakpoint: the detail *pane* is
   * `lg:block`, so a tablet at 800px has no pane and still needs the sheet. */
  const hasDetailPane = useMediaQuery('(min-width: 1024px)');

  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const search = params.toString();

  const filters = React.useMemo(() => {
    const sp = new URLSearchParams(search);
    const out = {} as FilterState;
    for (const key of FILTER_KEYS) out[key] = sp.get(key) ?? '';
    return out;
  }, [search]);

  const setFilters = React.useCallback(
    (patch: Partial<FilterState>): void => {
      const next = new URLSearchParams(search);
      for (const [key, value] of Object.entries(patch)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      const qs = next.toString();
      // A no-op replace still pushes a render through the router; skip it.
      if (qs === search) return;
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [pathname, router, search],
  );

  const activeCount = CHIP_KEYS.filter((key) => filters[key]).length + (filters.q ? 1 : 0);

  const [editing, setEditing] = React.useState<LedgerTxn | null>(null);
  const [receiptsFor, setReceiptsFor] = React.useState<LedgerTxn | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [detailOpen, setDetailOpen] = React.useState(false);
  const [panelOpen, setPanelOpen] = React.useState(false);

  const accounts = useQuery({ queryKey: ['accounts'], queryFn: endpoints.accounts });
  const categories = useQuery({ queryKey: ['categories'], queryFn: endpoints.categories });
  /* Names for the chips a row carries and for the tag filter. Unfiltered and
     shared with the tag screen's own cache, so opening the khata after /tags
     costs nothing. */
  const tags = useQuery({ queryKey: tagKeys.list(''), queryFn: () => fetchTags('') });

  const apiFilters = React.useMemo(() => {
    const out: Record<string, string> = {};
    for (const key of FILTER_KEYS) if (filters[key]) out[key] = filters[key];
    return out;
  }, [filters]);

  /**
   * One page per request, chained by the cursor the API already returns.
   *
   * The key stays under the `transactions` namespace so the blanket
   * `invalidateQueries()` after a write — and loans' narrower
   * `invalidateQueries({ queryKey: ['transactions'] })` — still reach it.
   * React Query refetches every loaded page on invalidation, so the running
   * balances stay consistent with the accounts screen after an edit.
   */
  const transactions = useInfiniteQuery({
    queryKey: ['transactions', 'list', apiFilters],
    queryFn: ({ pageParam }) =>
      endpoints.transactions({ ...apiFilters, limit: PAGE_SIZE, cursor: pageParam }),
    initialPageParam: '',
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  /* Deleting is soft, so it can be undone. The toast holds the id until the
   * window closes. */
  const [undoable, setUndoable] = React.useState<{ id: string; label: string } | null>(null);

  const remove = useMutation({
    mutationFn: (txn: TransactionDto) =>
      api(`/transactions/${txn.id}`, { method: 'DELETE', queueWhenOffline: true }),
    onSuccess: (_data, txn) => setUndoable({ id: txn.id, label: labelOf(txn) }),
    onSettled: () => queryClient.invalidateQueries(),
  });

  const restore = useMutation({
    mutationFn: (id: string) => api(`/transactions/${id}/restore`, { method: 'POST', body: {} }),
    onSettled: () => queryClient.invalidateQueries(),
  });

  const items: LedgerTxn[] = React.useMemo(
    () => transactions.data?.pages.flatMap((page) => page.items) ?? [],
    [transactions.data],
  );

  /* Group by day so the ledger reads like a paper khata. Built over the pages
   * flattened together, and the API orders by date descending, so a day split
   * across a page boundary still lands in one section rather than two. */
  const groups = React.useMemo(() => {
    const map = new Map<string, LedgerTxn[]>();
    for (const item of items) {
      const bucket = map.get(item.date);
      if (bucket) bucket.push(item);
      else map.set(item.date, [item]);
    }
    return [...map.entries()];
  }, [items]);

  const detail = items.find((t) => t.id === selected) ?? null;

  /* The detail sheet and the receipt sheet hold a snapshot of the row; after a
   * refetch that snapshot is stale, so re-read it from the live list. */
  const liveReceiptsFor = receiptsFor
    ? (items.find((t) => t.id === receiptsFor.id) ?? receiptsFor)
    : null;

  const openRow = (txn: LedgerTxn): void => {
    setSelected(txn.id);
    if (!hasDetailPane) setDetailOpen(true);
  };

  /* Rotating a tablet into the pane's breakpoint would otherwise leave a sheet
   * open over the same content it is now duplicating. */
  React.useEffect(() => {
    if (hasDetailPane) setDetailOpen(false);
  }, [hasDetailPane]);

  const rowActions = (txn: LedgerTxn) => (
    <div className="flex shrink-0 items-center">
      <button
        type="button"
        aria-label={t('common.edit', 'সম্পাদনা')}
        onClick={() => {
          // These actions also live inside the detail sheet; stacking the edit
          // sheet on top of it would trap a phone user two layers deep.
          setDetailOpen(false);
          setEditing(txn);
        }}
        className="press touch-target text-ink-muted hover:bg-greenbar flex items-center justify-center rounded-md"
      >
        <Pencil className="h-4 w-4" aria-hidden />
      </button>
      <button
        type="button"
        aria-label={t('common.delete', 'মুছুন')}
        onClick={() => remove.mutate(txn)}
        className="press touch-target text-expense hover:bg-greenbar flex items-center justify-center rounded-md"
      >
        <Trash2 className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );

  const unfiltered = activeCount === 0;
  const shown = items.length;

  /**
   * `?tagId=` answers 404 for a tag this workspace does not have, rather than an
   * empty page — which is the right call, and puts a dead id in a bookmarked
   * URL one refetch away from a bare "could not load the ledger". A tag that was
   * merged or deleted while somebody was filtered by it is the ordinary way to
   * get here, so it is named and the fix is one tap.
   */
  const deadTagFilter =
    filters.tagId !== '' &&
    transactions.error instanceof ApiError &&
    transactions.error.status === 404;

  /**
   * One tag row, and the tap that filters the khata by it.
   *
   * Chips are on their own line rather than inside the row's button: a button
   * inside a button is invalid, and the alternative — plain text — would show
   * the tags while making the obvious gesture do nothing. Only tagged rows pay
   * the extra line.
   */
  const tagChips = (txn: LedgerTxn): React.ReactNode => {
    if (!txn.tags || txn.tags.length === 0) return null;
    return (
      <div className="flex flex-wrap gap-1 px-3 pb-2">
        {txn.tags.map((tag) => {
          const on = filters.tagId === tag.id;
          return (
            <button
              key={tag.id}
              type="button"
              aria-pressed={on}
              aria-label={
                on
                  ? `${tag.name} — ${t('txn.unfilterTag', 'ট্যাগের ছাঁকনি সরান')}`
                  : `${tag.name} — ${t('txn.filterByTag', 'ট্যাগ দিয়ে ছাঁকুন')}`
              }
              onClick={() => {
                haptic('tap');
                setFilters({ tagId: on ? '' : tag.id });
              }}
              className={cn(
                'press flex min-h-11 items-center gap-1.5 rounded-full border px-2.5 text-xs md:min-h-8',
                on
                  ? 'border-income bg-income/15 text-ink font-medium'
                  : 'border-rule bg-surface text-ink-muted hover:bg-greenbar',
              )}
            >
              <TagDot color={tag.color} className="h-2 w-2" />
              <span className="max-w-32 truncate">{tag.name}</span>
            </button>
          );
        })}
      </div>
    );
  };

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 xl:max-w-6xl">
      {/* The phone gets its title from the shell's navigation bar. */}
      <header className="hidden items-baseline justify-between gap-2 md:flex">
        <h1 className="text-ink text-2xl font-semibold">{t('nav.transactions', 'খাতা')}</h1>
        <p className="text-ink-muted text-sm">
          {transactions.hasNextPage
            ? t('txn.showingN', '{n} টি দেখানো হচ্ছে').replace('{n}', bn(shown))
            : t('txn.countN', '{n} টি লেনদেন').replace('{n}', bn(shown))}
        </p>
      </header>

      <FilterBar
        filters={filters}
        setFilters={setFilters}
        accounts={accounts.data ?? []}
        categories={categories.data ?? []}
        tags={tags.data ?? []}
        activeCount={activeCount}
        panelOpen={panelOpen}
        onPanelToggle={() => setPanelOpen((open) => !open)}
      />

      {deadTagFilter ? (
        <div
          role="alert"
          className="rounded-card border-rule bg-surface flex flex-col items-center gap-2 border border-dashed p-6 text-center"
        >
          <TriangleAlert className="text-expense h-6 w-6" aria-hidden />
          <p className="text-ink text-sm">{t('txn.tagGone', 'এই ট্যাগটি আর নেই।')}</p>
          <p className="text-ink-muted text-xs">
            ট্যাগটি মুছে ফেলা হয়েছে বা অন্য ট্যাগের সাথে মিলিয়ে দেওয়া হয়েছে। ছাঁকনিটি সরিয়ে
            পুরো খাতা দেখুন।
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-1"
            onClick={() => setFilters({ tagId: '' })}
          >
            ছাঁকনিটি সরান
          </Button>
        </div>
      ) : transactions.isError ? (
        <LedgerError onRetry={() => void transactions.refetch()} />
      ) : transactions.isLoading ? (
        <div className="rounded-card border-rule bg-surface overflow-hidden border">
          <SkeletonRows rows={6} />
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-card border-rule border border-dashed p-8 text-center">
          <p className="text-ink">
            {unfiltered
              ? t('txn.empty', 'এখনও কোনো লেনদেন নেই।')
              : t('txn.emptyFiltered', 'এই ফিল্টারে কোনো লেনদেন নেই।')}
          </p>
          <p className="text-ink-muted mt-1 text-sm">
            {unfiltered
              ? t('txn.emptyHint', '+ বোতাম দিয়ে প্রথম লেনদেনটি যোগ করুন।')
              : t('txn.emptyFilteredHint', 'উপরের ফিল্টার বদলে দেখুন।')}
          </p>
        </div>
      ) : (
        /* Three columns from 1024px: filters above, list here, detail at the
           right. Below that the detail opens as a sheet instead. */
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div
            data-testid="ledger-list"
            className="rounded-card border-rule bg-surface min-w-0 overflow-hidden border"
          >
            {groups.map(([date, rows]) => (
              <section key={date}>
                <h2 className="border-rule bg-greenbar text-ink-muted sticky top-0 z-10 border-b px-3 py-1.5 text-xs font-medium">
                  {fmtDate(date)}
                </h2>
                <ul>
                  {rows.map((txn) => {
                    const receipts = attachmentsOf(txn);
                    const row = (
                      <div
                        className={cn(
                          'flex items-center gap-2 px-3 py-2.5',
                          selected === txn.id && 'bg-greenbar',
                        )}
                      >
                        {/* A real button, so the row is reachable by keyboard
                            and its actions no longer sit inside a clickable
                            div that would swallow their taps. */}
                        <button
                          type="button"
                          onClick={() => openRow(txn)}
                          className="flex min-w-0 flex-1 items-center gap-2 text-left"
                        >
                          <span className="min-w-0 flex-1">
                            <span className="text-ink flex items-center gap-1.5">
                              <span className="truncate text-sm">{labelOf(txn)}</span>
                              <AttachmentBadge count={receipts.length} />
                            </span>
                            <span className="text-ink-muted block truncate text-xs">
                              {txn.type === 'TRANSFER'
                                ? `${txn.accountName} → ${txn.counterAccountName}`
                                : [txn.accountName, txn.categoryName].filter(Boolean).join(' · ')}
                              {txn.source !== 'MANUAL' ? ` · ${sourceLabel(txn.source)}` : ''}
                            </span>
                          </span>

                          <span className="amount-col shrink-0 pl-2 text-right">
                            <Money
                              minor={txn.amountMinor}
                              colored
                              signed
                              className="block text-sm"
                            />
                            {txn.balanceAfterMinor !== undefined ? (
                              <Money
                                minor={txn.balanceAfterMinor}
                                className="text-ink-muted block text-[11px]"
                                decimals={false}
                              />
                            ) : null}
                          </span>
                        </button>

                        {/* Buttons at every size; the swipe gesture below is an
                            accelerator, never the only way to reach an action. */}
                        {rowActions(txn)}
                      </div>
                    );

                    const body = (
                      <>
                        {row}
                        {tagChips(txn)}
                      </>
                    );

                    return (
                      <li key={txn.id} className="ledger-row border-rule border-b last:border-b-0">
                        <SwipeRow
                          enabled={coarse}
                          right={{
                            label: t('common.edit', 'সম্পাদনা'),
                            icon: <Pencil className="h-4 w-4" aria-hidden />,
                            className: 'bg-brass',
                            onAction: () => setEditing(txn),
                          }}
                          left={{
                            label: t('common.delete', 'মুছুন'),
                            icon: <Trash2 className="h-4 w-4" aria-hidden />,
                            className: 'bg-expense',
                            onAction: () => remove.mutate(txn),
                          }}
                        >
                          {body}
                        </SwipeRow>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}

            {/* Transaction fifty-one lives here. */}
            {transactions.hasNextPage ? (
              <div className="border-rule border-t p-3">
                <Button
                  variant="outline"
                  size="block"
                  disabled={transactions.isFetchingNextPage}
                  onClick={() => {
                    haptic('tap');
                    void transactions.fetchNextPage();
                  }}
                >
                  {transactions.isFetchingNextPage ? t('txn.loading', 'আনা হচ্ছে…') : 'আরও দেখুন'}
                </Button>
              </div>
            ) : shown > PAGE_SIZE ? (
              <p className="text-ink-muted border-rule border-t px-3 py-3 text-center text-xs">
                সবগুলো দেখানো হয়েছে — মোট {bn(shown)}টি
              </p>
            ) : null}
          </div>

          {/* Persistent detail pane — desktop only (spec §5). */}
          <aside className="hidden lg:block">
            <div className="rounded-card border-rule bg-surface sticky top-0 border p-4">
              {detail ? (
                <TransactionDetail
                  txn={detail}
                  actions={rowActions(detail)}
                  activeTagId={filters.tagId}
                  onFilterTag={(id) => setFilters({ tagId: id })}
                  onReceipts={() => setReceiptsFor(detail)}
                />
              ) : (
                <p className="text-ink-muted text-sm">
                  বিস্তারিত দেখতে বাঁ পাশের তালিকা থেকে একটি লেনদেন বেছে নিন।
                </p>
              )}
            </div>
          </aside>
        </div>
      )}

      {/* Below 1024px the same detail arrives as a sheet, never a modal. */}
      <Sheet
        open={detailOpen && detail !== null}
        onOpenChange={(open) => setDetailOpen(open)}
        title={t('txn.detail', 'লেনদেনের বিবরণ')}
        description={detail ? fmtDate(detail.date) : undefined}
      >
        {detail ? (
          <TransactionDetail
            txn={detail}
            actions={rowActions(detail)}
            activeTagId={filters.tagId}
            onFilterTag={(id) => {
              // Filtering is a change to the list behind this sheet; stay to
              // watch it happen and the sheet is covering the answer.
              setDetailOpen(false);
              setFilters({ tagId: id });
            }}
            onReceipts={() => {
              setDetailOpen(false);
              setReceiptsFor(detail);
            }}
          />
        ) : null}
      </Sheet>

      {undoable ? (
        <UndoToast
          message={`${t('txn.deleted', 'মোছা হয়েছে')}: ${undoable.label}`}
          onUndo={() => {
            restore.mutate(undoable.id);
            setUndoable(null);
          }}
          onDismiss={() => setUndoable(null)}
        />
      ) : null}

      <ReceiptSheet
        txn={liveReceiptsFor}
        onClose={() => setReceiptsFor(null)}
        onSaved={() => void queryClient.invalidateQueries({ queryKey: ['transactions'] })}
      />

      <QuickAddSheet
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        editing={editing}
      />
    </div>
  );
}

// --- filters ---------------------------------------------------------------

function FilterBar({
  filters,
  setFilters,
  accounts,
  categories,
  tags,
  activeCount,
  panelOpen,
  onPanelToggle,
}: {
  filters: FilterState;
  setFilters: (patch: Partial<FilterState>) => void;
  accounts: AccountDto[];
  categories: CategoryDto[];
  tags: TagDto[];
  activeCount: number;
  panelOpen: boolean;
  onPanelToggle: () => void;
}) {
  const { name: displayNameOf } = useDisplayName();
  const [typed, setTyped] = React.useState(filters.q);
  const [moreOpen, setMoreOpen] = React.useState(Boolean(filters.source || filters.personId));

  /* One request when the typing stops, not one per keystroke. Through a ref
   * because `setFilters` is rebuilt on every URL change, and a dependency on it
   * would restart this timer each time some other filter moved. */
  const setFiltersRef = React.useRef(setFilters);
  setFiltersRef.current = setFilters;
  React.useEffect(() => {
    const timer = setTimeout(() => setFiltersRef.current({ q: typed.trim() }), 300);
    return () => clearTimeout(timer);
  }, [typed]);

  /* The box follows the URL when the URL changes from somewhere else — a
   * cleared chip, the back button — but not while the user is mid-word,
   * because the debounce above has not committed that word yet. */
  React.useEffect(() => setTyped(filters.q), [filters.q]);

  /**
   * People come from the loans list because there is no endpoint that lists
   * them. Only fetched once the disclosure is open, so the khata does not pay
   * for a filter almost nobody opens, and a failure just hides the control.
   */
  const people = useQuery({
    // Under the `loans` namespace so a loan write invalidates it, but its own
    // leaf so it never collides with the loans screen's own list cache.
    queryKey: ['loans', 'person-options'],
    queryFn: () => api<LoanPersonRow[]>('/loans'),
    enabled: moreOpen,
    staleTime: 60_000,
  });

  const peopleOptions = React.useMemo(() => {
    const seen = new Map<string, string>();
    for (const loan of people.data ?? []) {
      if (loan.personId && !seen.has(loan.personId)) seen.set(loan.personId, loan.personName);
    }
    return [...seen.entries()];
  }, [people.data]);

  const now = new Date();
  const today = toLocalDateString(now);
  const monthStart = startOfMonth(now);
  const presets: readonly (readonly [string, string, string])[] = [
    [t('range.thisMonth', 'এই মাস'), toLocalDateString(monthStart), today],
    [
      t('range.lastMonth', 'গত মাস'),
      toLocalDateString(startOfMonth(addDays(monthStart, -1))),
      toLocalDateString(addDays(monthStart, -1)),
    ],
    [t('range.thisYear', 'এই বছর'), `${today.slice(0, 4)}-01-01`, today],
  ];

  const clearAll = (): void => {
    haptic('tap');
    setTyped('');
    setFilters(Object.fromEntries(FILTER_KEYS.map((key) => [key, ''])) as Partial<FilterState>);
  };

  const nameOf = (list: { id: string; name: string }[], id: string): string =>
    list.find((row) => row.id === id)?.name ?? id;

  const categoryName = (id: string): string => {
    const hit = categories.find((c) => c.id === id);
    return hit ? displayNameOf(hit) : id;
  };

  /* A tag arrived at from the by-tag report may be filtering the list before
     the tag list itself has loaded, so the id stands in for one render. */
  const tagLabel = (id: string): string => {
    const hit = tags.find((t) => t.id === id);
    return hit ? displayNameOf(hit) : 'ট্যাগ';
  };

  const chipLabel = (key: FilterKey): string => {
    const value = filters[key];
    switch (key) {
      case 'from':
        return `${fmtDate(value)} ${t('range.from', 'থেকে')}`;
      case 'to':
        return `${fmtDate(value)} ${t('range.to', 'পর্যন্ত')}`;
      case 'accountId':
        return nameOf(accounts, value);
      case 'categoryId':
        return categoryName(value);
      case 'tagId':
        return `${t('nav.tags', 'ট্যাগ')}: ${tagLabel(value)}`;
      case 'type':
        return typeLabel(value);
      case 'source':
        return sourceLabel(value);
      case 'personId':
        return peopleOptions.find(([id]) => id === value)?.[1] ?? t('txn.person', 'ব্যক্তি');
      default:
        return value;
    }
  };

  /* A malformed `from`/`to` in a hand-edited URL must not take the screen down:
   * formatLedgerDate throws on anything that is not YYYY-MM-DD. */
  const safeChipLabel = (key: FilterKey): string => {
    try {
      return chipLabel(key);
    } catch {
      return filters[key];
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <Search
            className="text-ink-muted pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2"
            aria-hidden
          />
          <Input
            aria-label={t('common.search', 'খুঁজুন')}
            placeholder={`${t('common.search', 'খুঁজুন')}…`}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            enterKeyHint="search"
            type="search"
            className="pl-9"
          />
        </div>

        {/* On a phone five stacked selects would push the ledger off the
            screen, so they fold away behind one button that says how many are
            on. From 768px the panel is simply always there. */}
        <Button
          variant="outline"
          size="sm"
          onClick={onPanelToggle}
          aria-expanded={panelOpen}
          className="shrink-0 md:hidden"
        >
          <SlidersHorizontal className="h-4 w-4" aria-hidden />
          ফিল্টার
          {activeCount > 0 ? (
            <span className="bg-income flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[11px] font-medium text-white">
              {bn(activeCount)}
            </span>
          ) : null}
        </Button>
      </div>

      <div
        className={cn(
          'grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4',
          !panelOpen && 'hidden md:grid',
        )}
      >
        <Field label={t('txn.fromDate', 'শুরুর তারিখ')} htmlFor="fl-from">
          <Input
            id="fl-from"
            type="date"
            value={filters.from}
            max={filters.to || undefined}
            onChange={(e) => setFilters({ from: e.target.value })}
          />
        </Field>
        <Field label={t('txn.toDate', 'শেষ তারিখ')} htmlFor="fl-to">
          <Input
            id="fl-to"
            type="date"
            value={filters.to}
            min={filters.from || undefined}
            onChange={(e) => setFilters({ to: e.target.value })}
          />
        </Field>
        <Field label="অ্যাকাউন্ট" htmlFor="fl-account">
          <Select
            id="fl-account"
            value={filters.accountId}
            onChange={(e) => setFilters({ accountId: e.target.value })}
          >
            <option value="">{t('txn.allAccounts', 'সব অ্যাকাউন্ট')}</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="ক্যাটাগরি" htmlFor="fl-category">
          <Select
            id="fl-category"
            value={filters.categoryId}
            onChange={(e) => setFilters({ categoryId: e.target.value })}
          >
            <option value="">{t('txn.allCategories', 'সব ক্যাটাগরি')}</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {displayNameOf(c)}
              </option>
            ))}
          </Select>
        </Field>
        {/* Only when there are tags to choose from. An empty dropdown next to
            ক্যাটাগরি is the fastest way to teach somebody that tags are a
            second, broken category list. */}
        {tags.length > 0 ? (
          <Field label="ট্যাগ" htmlFor="fl-tag" className="sm:col-span-2 lg:col-span-1">
            <Select
              id="fl-tag"
              value={filters.tagId}
              onChange={(e) => setFilters({ tagId: e.target.value })}
            >
              <option value="">{t('txn.allTags', 'সব ট্যাগ')}</option>
              {tags.map((tag) => (
                <option key={tag.id} value={tag.id}>
                  {displayNameOf(tag)}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}

        <Field label="ধরন" htmlFor="fl-type" className="sm:col-span-2 lg:col-span-1">
          <Select
            id="fl-type"
            value={filters.type}
            onChange={(e) => setFilters({ type: e.target.value })}
          >
            <option value="">{t('txn.allKinds', 'সব ধরন')}</option>
            {['EXPENSE', 'INCOME', 'TRANSFER', 'ADJUSTMENT', 'OPENING_BALANCE'].map((value) => (
              <option key={value} value={value}>
                {typeLabel(value)}
              </option>
            ))}
            <optgroup label={t('nav.loans', 'ধার-দেনা')}>
              {['LOAN_GIVEN', 'LOAN_REPAID', 'BORROWED', 'BORROW_REPAID'].map((value) => (
                <option key={value} value={value}>
                  {typeLabel(value)}
                </option>
              ))}
            </optgroup>
            <optgroup label={t('txn.savingsInsurance', 'সঞ্চয় ও বিমা')}>
              {['SAVINGS_DEPOSIT', 'SAVINGS_WITHDRAWAL', 'PREMIUM_PAID'].map((value) => (
                <option key={value} value={value}>
                  {typeLabel(value)}
                </option>
              ))}
            </optgroup>
          </Select>
        </Field>

        {/* Fills whatever is left of the four-column row, so adding the tag
            select above does not push the presets onto a line of their own. */}
        <div
          className={cn(
            'flex items-end sm:col-span-2',
            tags.length > 0 ? 'lg:col-span-2' : 'lg:col-span-3',
          )}
        >
          <div className="chip-strip w-full">
            {presets.map(([label, from, to]) => (
              <button
                key={label}
                type="button"
                aria-pressed={filters.from === from && filters.to === to}
                onClick={() => {
                  haptic('tap');
                  setFilters({ from, to });
                }}
                className={cn(
                  'press border-rule flex min-h-11 shrink-0 items-center rounded-full border px-3.5 text-sm md:min-h-9',
                  filters.from === from && filters.to === to
                    ? 'bg-income border-income font-medium text-white'
                    : 'bg-surface text-ink hover:bg-greenbar',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Everything else the API can filter on, one tap away rather than
            taking up the screen for the ninety per cent who never touch it. */}
        <div className="sm:col-span-2 lg:col-span-4">
          <button
            type="button"
            onClick={() => setMoreOpen((open) => !open)}
            aria-expanded={moreOpen}
            className="press text-ink-muted hover:text-ink flex min-h-11 items-center gap-1 text-sm md:min-h-9"
          >
            <ChevronDown
              className={cn('h-4 w-4 transition-transform', moreOpen && 'rotate-180')}
              aria-hidden
            />
            আরও ফিল্টার
          </button>

          {moreOpen ? (
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Field label={t('txn.source', 'কোথা থেকে এসেছে')} htmlFor="fl-source">
                <Select
                  id="fl-source"
                  value={filters.source}
                  onChange={(e) => setFilters({ source: e.target.value })}
                >
                  <option value="">{t('txn.allSources', 'সব উৎস')}</option>
                  {Object.entries(SOURCE_LABEL).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </Select>
              </Field>

              {peopleOptions.length > 0 ? (
                <Field label={t('txn.personFilter', 'ব্যক্তি (ধার-দেনা)')} htmlFor="fl-person">
                  <Select
                    id="fl-person"
                    value={filters.personId}
                    onChange={(e) => setFilters({ personId: e.target.value })}
                  >
                    <option value="">{t('txn.everyone', 'সবাই')}</option>
                    {peopleOptions.map(([id, name]) => (
                      <option key={id} value={id}>
                        {name}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {/* What is actually on, and one tap to take any of it off. */}
      {activeCount > 0 ? (
        <div className="chip-strip" aria-label={t('txn.activeFilters', 'চালু ফিল্টার')}>
          {filters.q ? (
            <FilterChip
              label={`${t('common.search', 'খুঁজুন')}: ${filters.q}`}
              onClear={() => {
                setTyped('');
                setFilters({ q: '' });
              }}
            />
          ) : null}
          {CHIP_KEYS.filter((key) => filters[key]).map((key) => (
            <FilterChip
              key={key}
              label={safeChipLabel(key)}
              onClear={() => setFilters({ [key]: '' })}
            />
          ))}
          <button
            type="button"
            onClick={clearAll}
            className="press text-ink-muted hover:text-ink flex min-h-11 shrink-0 items-center px-2 text-sm underline md:min-h-9"
          >
            সব মুছুন
          </button>
        </div>
      ) : null}
    </div>
  );
}

function FilterChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span className="border-income bg-income/10 text-ink flex min-h-11 shrink-0 items-center gap-1 rounded-full border pl-3.5 pr-1 text-sm md:min-h-9">
      <span className="max-w-[10rem] truncate">{label}</span>
      <button
        type="button"
        onClick={() => {
          haptic('tap');
          onClear();
        }}
        aria-label={`${t('txn.removeFilter', 'ফিল্টার সরান')}: ${label}`}
        className="press hover:bg-income/20 flex h-8 w-8 items-center justify-center rounded-full"
      >
        <X className="h-3.5 w-3.5" aria-hidden />
      </button>
    </span>
  );
}

function LedgerError({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="rounded-card border-rule bg-surface flex flex-col items-center gap-2 border border-dashed p-6 text-center"
    >
      <TriangleAlert className="text-expense h-6 w-6" aria-hidden />
      <p className="text-ink text-sm">{t('txn.listFailed', 'লেনদেনের তালিকা আনা যায়নি।')}</p>
      <p className="text-ink-muted text-xs">
        {t('common.checkConnection', 'ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।')}
      </p>
      <Button variant="outline" size="sm" className="mt-1" onClick={onRetry}>
        <RotateCw className="h-4 w-4" aria-hidden />
        আবার চেষ্টা করুন
      </Button>
    </div>
  );
}

// --- detail & receipts -----------------------------------------------------

function TransactionDetail({
  txn,
  actions,
  activeTagId,
  onFilterTag,
  onReceipts,
}: {
  txn: LedgerTxn;
  actions: React.ReactNode;
  activeTagId: string;
  onFilterTag: (id: string) => void;
  onReceipts: () => void;
}) {
  const receipts = attachmentsOf(txn);
  const editable = SIMPLE_TYPES.has(txn.type) && txn.accountId !== null;

  return (
    <dl className="space-y-3 text-sm">
      <div>
        <dt className="text-ink-muted text-xs">{t('entry.amount', 'পরিমাণ')}</dt>
        <dd>
          <Money minor={txn.amountMinor} colored signed className="text-xl" />
        </dd>
      </div>
      <div>
        <dt className="text-ink-muted text-xs">{t('entry.description', 'বিবরণ')}</dt>
        <dd className="text-ink break-words">{txn.description || '—'}</dd>
      </div>
      <div>
        <dt className="text-ink-muted text-xs">{t('entry.date', 'তারিখ')}</dt>
        <dd className="text-ink">{fmtDate(txn.date)}</dd>
      </div>
      <div>
        <dt className="text-ink-muted text-xs">{t('entry.kind', 'ধরন')}</dt>
        <dd className="text-ink">{typeLabel(txn.type)}</dd>
      </div>
      <div>
        <dt className="text-ink-muted text-xs">{t('entry.account', 'অ্যাকাউন্ট')}</dt>
        <dd className="text-ink">
          {txn.type === 'TRANSFER'
            ? `${txn.accountName ?? '—'} → ${txn.counterAccountName ?? '—'}`
            : (txn.accountName ?? '—')}
        </dd>
      </div>
      <div>
        <dt className="text-ink-muted text-xs">{t('entry.category', 'ক্যাটাগরি')}</dt>
        <dd className="text-ink">{txn.categoryName ?? '—'}</dd>
      </div>
      {/* Beside the category on purpose: one line says what the money went on,
          the next says who it was for. */}
      <div>
        <dt className="text-ink-muted text-xs">{t('nav.tags', 'ট্যাগ')}</dt>
        <dd className="mt-1">
          {txn.tags && txn.tags.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5">
              {txn.tags.map((tag) => {
                const on = activeTagId === tag.id;
                return (
                  <li key={tag.id}>
                    <button
                      type="button"
                      aria-pressed={on}
                      aria-label={
                        on
                          ? `${tag.name} — ${t('txn.unfilterTag', 'ট্যাগের ছাঁকনি সরান')}`
                          : `${tag.name} — ${t('txn.filterByTag', 'ট্যাগ দিয়ে ছাঁকুন')}`
                      }
                      onClick={() => {
                        haptic('tap');
                        onFilterTag(on ? '' : tag.id);
                      }}
                      className={cn(
                        'press flex min-h-11 items-center gap-1.5 rounded-full border px-3 text-xs md:min-h-9',
                        on
                          ? 'border-income bg-income/15 text-ink font-medium'
                          : 'border-rule bg-surface text-ink hover:bg-greenbar',
                      )}
                    >
                      <TagDot color={tag.color} className="h-2 w-2" />
                      <span className="max-w-40 truncate">{tag.name}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-ink-muted text-xs">
              কোনো ট্যাগ নেই — সম্পাদনা করে কার জন্য খরচ তা লিখে রাখতে পারেন।
            </p>
          )}
        </dd>
      </div>
      {txn.notes ? (
        <div>
          <dt className="text-ink-muted text-xs">{t('entry.notes', 'নোট')}</dt>
          <dd className="text-ink break-words">{txn.notes}</dd>
        </div>
      ) : null}

      <div>
        <dt className="text-ink-muted text-xs">{t('txn.receipts', 'রসিদ')}</dt>
        <dd className="mt-1">
          {receipts.length > 0 ? (
            <ul className="flex flex-wrap gap-2">
              {receipts.map((id) => (
                <li key={id}>
                  <AttachmentViewer id={id} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-ink-muted text-xs">
              {t('txn.noReceipts', 'কোনো রসিদ যোগ করা হয়নি।')}
            </p>
          )}
          {editable ? (
            <Button variant="outline" size="sm" className="mt-2" onClick={onReceipts}>
              <Paperclip className="h-4 w-4" aria-hidden />
              রসিদ যোগ করুন
            </Button>
          ) : (
            /* A loan or savings transaction is owned by that module; rewriting
               it through the simple transaction body would unbalance it. */
            <p className="text-ink-muted mt-2 text-xs">
              এই লেনদেনটি অন্য জায়গা থেকে তৈরি — সেখান থেকেই রসিদ যোগ করুন।
            </p>
          )}
        </dd>
      </div>

      <div className="pt-1">{actions}</div>
    </dl>
  );
}

/**
 * Attach receipts to one transaction.
 *
 * Both halves work: `POST /v1/attachments` stores the bytes and hands back an
 * id, and the transaction write links them.
 *
 * The echo check below stays. It was written when the link half did not exist —
 * `present()` never returned `attachmentIds`, so a save appeared to work and
 * quietly dropped the receipt — and it is what noticed. Keeping it means a
 * future regression in that column shows as a message and a cleaned-up upload
 * rather than as bytes on the server's disk belonging to nothing.
 */
function ReceiptSheet({
  txn,
  onClose,
  onSaved,
}: {
  txn: LedgerTxn | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [ids, setIds] = React.useState<string[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  /** Ids uploaded in this sitting; the ones we own until the save lands. */
  const fresh = React.useRef<string[]>([]);

  /* Keyed on the id alone: `txn` is a fresh object on every refetch, and
   * resetting the picker each time one arrived would throw away a receipt the
   * user had just added. */
  const txnRef = React.useRef(txn);
  txnRef.current = txn;
  const txnId = txn?.id ?? null;
  React.useEffect(() => {
    if (!txnId) return;
    const current = txnRef.current;
    setIds(current ? attachmentsOf(current) : []);
    setError(null);
    fresh.current = [];
  }, [txnId]);

  const discardOrphans = React.useCallback(async (): Promise<void> => {
    const orphans = fresh.current;
    fresh.current = [];
    await Promise.all(
      orphans.map((id) => api(`/attachments/${id}`, { method: 'DELETE' }).catch(() => undefined)),
    );
  }, []);

  const close = (): void => {
    // Anything uploaded but never saved would sit on disk forever otherwise.
    void discardOrphans();
    onClose();
  };

  const save = async (): Promise<void> => {
    if (!txn || !txn.accountId) return;
    setSaving(true);
    setError(null);
    try {
      /* A transfer's two sides come back swapped when the list was filtered by
       * the destination account — `present()` puts the focused account first so
       * the sign reads correctly, and a positive amount is exactly that case.
       * Writing the row back in that order would reverse the transfer, so put
       * the source back on `accountId` before sending it. */
      const flipped = txn.type === 'TRANSFER' && txn.amountMinor > 0;
      const accountId = flipped ? (txn.counterAccountId ?? txn.accountId) : txn.accountId;
      const counterAccountId = flipped ? txn.accountId : txn.counterAccountId;

      const saved = await api<LedgerTxn>(`/transactions/${txn.id}`, {
        method: 'PATCH',
        body: {
          date: txn.date,
          type: txn.type,
          amountMinor: Math.abs(txn.amountMinor),
          accountId,
          counterAccountId: counterAccountId ?? undefined,
          categoryId: txn.categoryId ?? undefined,
          description: txn.description ?? undefined,
          notes: txn.notes ?? undefined,
          payee: txn.payee ?? undefined,
          source: txn.source,
          attachmentIds: ids,
        },
      });

      const echoed = saved.attachmentIds;
      if (!echoed || ids.some((id) => !echoed.includes(id))) {
        await discardOrphans();
        setIds(attachmentsOf(txn));
        setError(
          t(
            'txn.receiptFailed',
            'রসিদটি সংরক্ষণ করা যায়নি — সার্ভার এখনো লেনদেনের সাথে রসিদ যুক্ত রাখতে পারছে না।',
          ),
        );
        return;
      }

      fresh.current = [];
      haptic('success');
      onSaved();
      onClose();
    } catch (err) {
      haptic('warn');
      setError(err instanceof Error ? err.message : t('common.saveFailed', 'সংরক্ষণ করা যায়নি'));
    } finally {
      setSaving(false);
    }
  };

  const trackUpload = React.useCallback((uploaded: UploadedAttachment): void => {
    fresh.current = [...fresh.current, uploaded.id];
  }, []);

  return (
    <Sheet
      open={txn !== null}
      onOpenChange={(open) => !open && close()}
      title={t('txn.receipts', 'রসিদ')}
      description={txn ? labelOf(txn) : undefined}
    >
      <div className="flex flex-col gap-4">
        <AttachmentPicker value={ids} onChange={setIds} onUploaded={trackUpload} />

        {error ? (
          <p role="alert" className="bg-expense/10 text-expense rounded-md px-3 py-2 text-sm">
            {error}
          </p>
        ) : null}

        <Button size="block" disabled={saving} onClick={() => void save()}>
          {saving ? t('common.saving', 'সংরক্ষণ হচ্ছে…') : t('common.save', 'সংরক্ষণ করুন')}
        </Button>
        <Button variant="outline" size="block" onClick={close}>
          বাতিল
        </Button>
      </div>
    </Sheet>
  );
}
