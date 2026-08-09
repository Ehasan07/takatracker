'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { ArrowDownLeft, ArrowUpRight, ChevronRight, CircleHelp, Settings } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';
import { SkeletonRows } from '@/components/skeleton';
import { Button } from '@/components/ui/button';
import { haptic } from '@/lib/haptics';
import { cn } from '@/lib/utils';
import { bnDate, bnDateTime, bnNum, channelLabel, DIRECTION_LABEL, STATUS_FILTERS } from './labels';
import { Chip, ConfidenceMeter, DraftAmount, QueryError, StatusPill, Toast } from './parts';
import { fetchDrafts, inboxKeys } from './queries';
import { ReviewSheet, type Outcome, type StickyPick } from './review-sheet';
import type { DraftPage, DraftView } from './types';

/**
 * The review inbox.
 *
 * An SMS arrives, the server turns it into a draft that claims nothing, and
 * this is where a person checks it and says yes or no. Nothing here writes to
 * the ledger by itself and nothing here ever will: the accept endpoint is the
 * only door, and a human has to open it.
 *
 * The list is the queue and the sheet is the work. Accepting advances to the
 * next draft rather than dropping the user back on the list, because a screen
 * that makes you re-find your place fifty times is a screen people stop using.
 */
export default function InboxPage() {
  const [status, setStatus] = React.useState('PENDING');
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [sticky, setSticky] = React.useState<StickyPick>({ accountId: '', categoryId: '' });
  const [toast, setToast] = React.useState<string | null>(null);

  const drafts = useInfiniteQuery({
    queryKey: inboxKeys.drafts(status),
    queryFn: ({ pageParam }) => fetchDrafts({ status, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last: DraftPage) => last.nextCursor,
  });

  const rows = React.useMemo(
    () => (drafts.data?.pages ?? []).flatMap((page) => page.items),
    [drafts.data],
  );

  const activeIndex = activeId === null ? -1 : rows.findIndex((row) => row.id === activeId);
  const active = activeIndex === -1 ? null : (rows[activeIndex] ?? null);

  const open = (draft: DraftView): void => {
    haptic('select');
    setActiveId(draft.id);
  };

  const onStep = React.useCallback(
    (delta: -1 | 1) => {
      if (activeIndex === -1) return;
      const next = rows[activeIndex + delta];
      if (!next) return;
      haptic('select');
      setActiveId(next.id);
    },
    [rows, activeIndex],
  );

  /**
   * Land on the next draft, not back on the list.
   *
   * The successor is read from the queue as it stands *now*, before the
   * invalidation refetches and the row that was just decided disappears from a
   * PENDING-filtered list. Running out is not an error — it is the end of the
   * pile, and it is said so.
   */
  const onResolved = React.useCallback(
    (saved: DraftView, outcome: Outcome) => {
      const index = rows.findIndex((row) => row.id === saved.id);
      const next = index === -1 ? undefined : rows[index + 1];
      setActiveId(next?.id ?? null);
      const done =
        outcome === 'accepted' ? 'খাতায় যোগ হয়েছে' : 'বাতিল হয়েছে — খাতায় কিছু লেখা হয়নি';
      setToast(next ? `${done} — পরেরটি দেখুন` : `${done}। আপাতত আর কোনো খসড়া নেই।`);
    },
    [rows],
  );

  const closeSheet = React.useCallback(() => setActiveId(null), []);
  const showStatus = status !== 'PENDING';
  const unfiltered = status === 'PENDING';

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-4">
      {/* The app shell has no title for /inbox yet, so this heading carries it
          on a phone too rather than hiding below md: the way /loans does. */}
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h1 className="text-ink hidden text-xl font-semibold sm:text-2xl md:block">
            বার্তার ইনবক্স
          </h1>
          <p className="text-ink-muted text-xs">
            বার্তা থেকে তৈরি খসড়া — আপনি না বললে খাতায় কিছুই যাবে না।
          </p>
        </div>
        <Button variant="outline" size="sm" asChild>
          <Link href="/settings">
            <Settings className="h-4 w-4" aria-hidden />
            সেটআপ
          </Link>
        </Button>
      </header>

      <div className="chip-strip" role="group" aria-label="অবস্থা অনুযায়ী ছাঁকুন">
        {STATUS_FILTERS.map(([value, label]) => (
          <Chip
            key={value || 'all'}
            active={status === value}
            onClick={() => {
              setActiveId(null);
              setStatus(value);
            }}
          >
            {label}
          </Chip>
        ))}
      </div>

      {drafts.isError ? (
        <QueryError message="খসড়ার তালিকা আনা যায়নি।" onRetry={() => void drafts.refetch()} />
      ) : drafts.isLoading ? (
        <div className="rounded-card border-rule bg-surface overflow-hidden border">
          <SkeletonRows rows={5} />
        </div>
      ) : rows.length === 0 ? (
        <EmptyInbox unfiltered={unfiltered} />
      ) : (
        <>
          <p className="text-ink-muted text-xs">
            {bnNum(rows.length)}টি খসড়া{drafts.hasNextPage ? '+' : ''} · নতুনটি উপরে
          </p>
          <ul className="flex flex-col gap-2">
            {rows.map((draft) => (
              <li key={draft.id}>
                <DraftRow draft={draft} showStatus={showStatus} onOpen={() => open(draft)} />
              </li>
            ))}
          </ul>

          {drafts.hasNextPage ? (
            <Button
              variant="outline"
              size="block"
              disabled={drafts.isFetchingNextPage}
              onClick={() => void drafts.fetchNextPage()}
            >
              {drafts.isFetchingNextPage ? 'আনা হচ্ছে…' : 'আরও দেখুন'}
            </Button>
          ) : null}
        </>
      )}

      <ReviewSheet
        draft={active}
        position={activeIndex + 1}
        total={rows.length}
        hasPrev={activeIndex > 0}
        hasNext={activeIndex > -1 && activeIndex < rows.length - 1}
        onStep={onStep}
        onClose={closeSheet}
        onResolved={onResolved}
        sticky={sticky}
        onSticky={setSticky}
      />

      {toast ? <Toast message={toast} onDismiss={() => setToast(null)} /> : null}
    </div>
  );
}

function DraftRow({
  draft,
  showStatus,
  onOpen,
}: {
  draft: DraftView;
  showStatus: boolean;
  onOpen: () => void;
}) {
  const Icon =
    draft.direction === 'IN'
      ? ArrowDownLeft
      : draft.direction === 'OUT'
        ? ArrowUpRight
        : CircleHelp;
  const tone =
    draft.direction === 'IN'
      ? 'bg-income/10 text-income'
      : draft.direction === 'OUT'
        ? 'bg-expense/10 text-expense'
        : 'bg-greenbar text-ink-muted';

  return (
    <button
      type="button"
      onClick={onOpen}
      className="press rounded-card border-rule bg-surface hover:bg-greenbar block w-full min-w-0 border p-3 text-left"
    >
      <div className="flex min-w-0 items-start gap-3">
        <span
          aria-hidden
          className={cn(
            'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
            tone,
          )}
        >
          <Icon className="h-4 w-4" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline justify-between gap-2">
            <p className="text-ink min-w-0 truncate text-sm font-medium">
              {draft.message?.sender?.trim() || channelLabel(draft.message?.channel)}
            </p>
            <DraftAmount draft={draft} className="shrink-0 text-base" />
          </div>

          <p className="text-ink-muted truncate text-xs">
            {draft.date ? bnDate(draft.date) : bnDateTime(draft.message?.receivedAt)}
            {' · '}
            {draft.direction ? DIRECTION_LABEL[draft.direction] : 'দিক জানা যায়নি'}
          </p>

          {/* The message itself, one line of it. Text, never markup. */}
          {draft.message ? (
            <p className="text-ink-muted mt-0.5 truncate text-xs italic">{draft.message.body}</p>
          ) : null}

          <div className="mt-1.5 flex min-w-0 items-center justify-between gap-2">
            <ConfidenceMeter
              confidence={draft.confidence}
              needsReview={draft.needsReview}
              className="min-w-0 flex-1"
            />
            {showStatus ? <StatusPill status={draft.status} /> : null}
          </div>
        </div>

        <ChevronRight className="text-ink-muted mt-1 h-4 w-4 shrink-0" aria-hidden />
      </div>
    </button>
  );
}

function EmptyInbox({ unfiltered }: { unfiltered: boolean }) {
  return (
    <div className="rounded-card border-rule border border-dashed p-8 text-center">
      <p className="text-ink">
        {unfiltered ? 'যাচাইয়ের অপেক্ষায় কোনো খসড়া নেই।' : 'এই ছাঁকনিতে কোনো খসড়া নেই।'}
      </p>
      {unfiltered ? (
        <>
          <p className="text-ink-muted mx-auto mt-1 max-w-sm text-sm">
            ফোনে আসা ব্যাংক বা বিকাশের এসএমএস এখানে আনতে হলে আগে সেটিংসে ওয়েবহুক চালু করে নিতে হবে।
          </p>
          <Button className="mt-3" asChild>
            <Link href="/settings">সেটিংসে যান</Link>
          </Button>
        </>
      ) : (
        <p className="text-ink-muted mt-1 text-sm">উপরের ছাঁকনি বদলে দেখুন।</p>
      )}
    </div>
  );
}
