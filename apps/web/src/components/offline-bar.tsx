'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CloudOff, TriangleAlert } from 'lucide-react';
import * as React from 'react';
import { endpoints } from '@/lib/api';
import { t } from '@/lib/t';
import { fmtNumber } from '@/lib/format';
import {
  countQueued,
  discardQueued,
  flushQueue,
  listFailed,
  onQueueChange,
  setSessionOwner,
  type QueueCounts,
  type QueuedMutation,
} from '@/lib/offline-queue';
import { isImpersonating } from '@/lib/support-session';
import { cn } from '@/lib/utils';

/**
 * "অফলাইন — ৩টি পরিবর্তন অপেক্ষমাণ" (spec §5), plus the two states the original
 * bar could not express: a change the server refused, and a change belonging to
 * a different account on this device. Both have to be visible — a bar that says
 * everything synced over a write that never landed is worse than no bar.
 */

const EMPTY: QueueCounts = { pending: 0, failed: 0, held: 0 };

/** How often a backed-off row gets another chance while a tab is open. */
const RETRY_INTERVAL_MS = 30_000;

const bn = (value: number): string => fmtNumber(String(value));

/** A queued row is a verb and a path; the user needs a noun. */
function mutationLabel(item: QueuedMutation): string {
  if (item.path.startsWith('/transactions')) {
    return item.method === 'DELETE'
      ? t('offline.deleteTxn', 'লেনদেন মুছে ফেলা')
      : t('offline.saveTxn', 'লেনদেন সংরক্ষণ');
  }
  if (item.path.startsWith('/loans')) return t('offline.loan', 'ঋণের হিসাব');
  if (item.path.startsWith('/accounts')) return t('entry.account', 'অ্যাকাউন্ট');
  if (item.path.startsWith('/categories')) return t('entry.category', 'ক্যাটাগরি');
  return t('offline.change', 'পরিবর্তন');
}

export function OfflineBar() {
  const [online, setOnline] = React.useState(true);
  const [counts, setCounts] = React.useState<QueueCounts>(EMPTY);
  const [failures, setFailures] = React.useState<QueuedMutation[]>([]);
  const [showFailures, setShowFailures] = React.useState(false);
  const queryClient = useQueryClient();

  /* The shell's existing identity query — same key, same fetcher as the
   * settings screen — so this costs a shared request, not a second fetch.
   *
   * `networkMode: 'always'` and no retry, unlike every other query here. The
   * client default pauses a failed read while offline, and a paused read never
   * settles, which would hang every `await queryClient.invalidateQueries()` in
   * the app for as long as the connection is gone. Identity is also the one
   * read that is never cached (`/auth/*` must not be), so offline it can only
   * fail — and failing is fine: the queue falls back to the stored owner. */
  const me = useQuery({
    queryKey: ['me'],
    queryFn: endpoints.me,
    networkMode: 'always',
    retry: false,
  });
  const userId = me.data?.id ?? null;
  const workspaceId = me.data?.workspace.id ?? null;

  /* Only pending rows are worth waking the retry timer for, and reading it from
   * a ref keeps the timer from being torn down and rebuilt on every count. */
  const pendingRef = React.useRef(0);

  const refresh = React.useCallback(async () => {
    const next = await countQueued();
    pendingRef.current = next.pending;
    setCounts(next);
    setFailures(await listFailed());
  }, []);

  /* `api()` enqueues from outside React, so the queue module is handed the
   * signed-in identity rather than reaching for a hook it cannot use. Every
   * row written from here on is stamped with it. */
  React.useEffect(() => {
    /* Skipped during a support session. `/auth/me` answers as the customer
     * then, and stamping the browser with their id would leave the operator's
     * own parked rows unmatched — held as orphans on their own machine until
     * something restamped it. Nothing can be queued during a session anyway:
     * it is read-only, and `flushQueue` holds every row for its duration. */
    if (isImpersonating()) return;
    if (userId && workspaceId) setSessionOwner({ userId, workspaceId });
  }, [userId, workspaceId]);

  const flush = React.useCallback(async () => {
    const { sent } = await flushQueue();
    await refresh();
    if (sent > 0) await queryClient.invalidateQueries();
  }, [queryClient, refresh]);

  React.useEffect(() => {
    setOnline(navigator.onLine);
    void refresh();

    const handleOnline = (): void => {
      setOnline(true);
      void flush();
    };
    const handleOffline = (): void => setOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    const unsubscribe = onQueueChange(() => void refresh());

    /* The backoff only means something if someone comes back to honour it: the
     * `online` event fires once, and a struggling server outlasts it easily. */
    const timer = setInterval(() => {
      if (pendingRef.current > 0 && navigator.onLine) void flush();
    }, RETRY_INTERVAL_MS);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      clearInterval(timer);
      unsubscribe();
    };
  }, [flush, refresh]);

  /* A held row belongs to whoever queued it. The moment that person is known
   * again — they have just signed back in on this browser — their backlog is
   * due, without waiting for the connection to drop and return first. */
  React.useEffect(() => {
    if (!userId || !workspaceId || !navigator.onLine) return;
    void flush();
  }, [userId, workspaceId, flush]);

  const discard = (id: number | undefined): void => {
    if (id === undefined) return;
    void discardQueued(id);
  };

  const { pending, failed, held } = counts;
  if (online && pending === 0 && failed === 0 && held === 0) return null;

  /* "সংযোগ ফিরেছে" is reassurance, and it must not lead a sentence whose point
   * is that a change did not go through. */
  const parts: string[] = [];
  if (!online) parts.push(t('offline.offline', 'অফলাইন'));
  else if (failed === 0) parts.push(t('offline.back', 'সংযোগ ফিরেছে'));
  if (pending > 0)
    parts.push(t('offline.pendingN', '{n}টি পরিবর্তন অপেক্ষমাণ').replace('{n}', bn(pending)));
  if (failed > 0)
    parts.push(t('offline.failedN', '{n}টি পরিবর্তন সার্ভার নেয়নি').replace('{n}', bn(failed)));

  return (
    <div
      data-testid="offline-bar"
      className={cn(
        'text-ink shrink-0 border-b',
        failed > 0 ? 'border-expense/40 bg-expense/10' : 'border-brass/40 bg-brass/10',
      )}
    >
      <div role="status" className="flex items-center gap-2 px-3 py-2 text-sm">
        {failed > 0 ? (
          <TriangleAlert className="text-expense h-4 w-4 shrink-0" aria-hidden />
        ) : (
          <CloudOff className="h-4 w-4 shrink-0" aria-hidden />
        )}
        <span className="min-w-0 flex-1">{parts.join(' — ')}</span>
        {failed > 0 ? (
          <button
            type="button"
            onClick={() => setShowFailures((open) => !open)}
            aria-expanded={showFailures}
            className="press text-ink min-h-9 shrink-0 rounded-md px-2 text-xs font-medium underline"
          >
            {showFailures ? t('offline.hide', 'লুকান') : t('offline.details', 'বিস্তারিত')}
          </button>
        ) : null}
      </div>

      {/* Counted, never opened up: the amounts belong to the other account. */}
      {held > 0 ? (
        <p className="text-ink-muted px-3 pb-2 text-xs">
          অন্য অ্যাকাউন্টের {bn(held)}টি পরিবর্তন জমা আছে — সেই অ্যাকাউন্টে ঢুকলে পাঠানো হবে।
        </p>
      ) : null}

      {showFailures && failures.length > 0 ? (
        <ul className="border-expense/30 flex flex-col gap-2 border-t px-3 py-2">
          {failures.map((item) => (
            <li key={item.id} className="flex items-start gap-2 text-xs">
              <div className="min-w-0 flex-1">
                <p className="text-ink font-medium">{mutationLabel(item)}</p>
                <p className="text-ink-muted">
                  {item.failureMessage ?? t('offline.refused', 'সার্ভার পরিবর্তনটি নেয়নি')}
                </p>
              </div>
              <button
                type="button"
                onClick={() => discard(item.id)}
                className="press text-expense min-h-9 shrink-0 rounded-md px-2 font-medium underline"
              >
                বাতিল করুন
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
