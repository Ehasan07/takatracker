'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Undo2 } from '@/components/icons';
import * as React from 'react';
import { SkeletonRows } from '@/components/skeleton';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api';
import { haptic } from '@/lib/haptics';
import { cn } from '@/lib/utils';
import { BATCH_STATUS_LABEL, bnDateTime, bnNum } from './labels';
import { ConfirmSheet, Notice, QueryError } from './parts';
import { fetchBatches, importKeys, invalidateAfterImport, revertBatch } from './transport';
import type { ImportBatchView } from './types';

/**
 * Every import that ever ran, newest first, each with one button that undoes
 * it. Reverting deletes real transactions and moves real balances, so it asks
 * first — a stray thumb on a phone must not be able to unwind two hundred rows.
 */
export function ImportHistory() {
  const queryClient = useQueryClient();
  const [pendingBatch, setPendingBatch] = React.useState<ImportBatchView | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const batches = useQuery({ queryKey: importKeys.batches, queryFn: fetchBatches });

  const revert = useMutation({
    mutationFn: (id: string) => revertBatch(id),
    onSuccess: (result) => {
      haptic('success');
      setError(null);
      setNotice(`${bnNum(result.revertedCount)}টি লেনদেন খাতা থেকে সরিয়ে নেওয়া হয়েছে।`);
      setPendingBatch(null);
      invalidateAfterImport(queryClient);
    },
    onError: (err) => {
      haptic('warn');
      setNotice(null);
      setError(err instanceof ApiError ? err.message : 'ফিরিয়ে নেওয়া যায়নি');
      setPendingBatch(null);
    },
  });

  const rows = batches.data ?? [];

  return (
    <section className="rounded-card border-rule bg-surface flex flex-col gap-3 border p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-ink text-base font-semibold">আগের ইমপোর্ট</h2>
        <span className="text-ink-muted text-xs">{bnNum(rows.length)}টি</span>
      </div>

      {notice ? <Notice tone="ok">{notice}</Notice> : null}
      {error ? <Notice tone="bad">{error}</Notice> : null}

      {batches.isError ? (
        <QueryError message="ইমপোর্টের তালিকা আনা যায়নি।" onRetry={() => void batches.refetch()} />
      ) : batches.isLoading ? (
        <div className="rounded-card border-rule overflow-hidden border">
          <SkeletonRows rows={3} />
        </div>
      ) : rows.length === 0 ? (
        <p className="text-ink-muted rounded-md border border-dashed p-6 text-center text-sm">
          এখনও কোনো ফাইল ইমপোর্ট করা হয়নি।
        </p>
      ) : (
        <ul className="divide-rule divide-y">
          {rows.map((batch) => (
            <BatchRow
              key={batch.id}
              batch={batch}
              onRevert={() => {
                haptic('tap');
                setPendingBatch(batch);
              }}
            />
          ))}
        </ul>
      )}

      <ConfirmSheet
        open={pendingBatch !== null}
        onOpenChange={(open) => !open && setPendingBatch(null)}
        title="ইমপোর্ট ফিরিয়ে নেবেন?"
        description={pendingBatch?.filename}
        confirmLabel="হ্যাঁ, ফিরিয়ে নিন"
        pending={revert.isPending}
        onConfirm={() => pendingBatch && revert.mutate(pendingBatch.id)}
      >
        <p className="text-ink text-sm">
          এই ফাইল থেকে যোগ হওয়া {bnNum(pendingBatch?.liveCount ?? 0)}টি লেনদেন খাতা থেকে মুছে যাবে
          এবং অ্যাকাউন্টের স্থিতি আগের জায়গায় ফিরে যাবে।
        </p>
        <p className="text-ink-muted text-sm">
          ইমপোর্টের পরে ওই লেনদেনগুলোতে হাতে করা কোনো পরিবর্তনও চলে যাবে। এই কাজটি আর ফেরানো যাবে
          না।
        </p>
      </ConfirmSheet>
    </section>
  );
}

function BatchRow({ batch, onRevert }: { batch: ImportBatchView; onRevert: () => void }) {
  const reverted = batch.status === 'REVERTED';
  // Rows can also leave one at a time, by hand. Saying so keeps the history honest.
  const partlyGone = !reverted && batch.liveCount !== batch.importedCount;

  return (
    <li className="flex items-start gap-3 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-ink truncate text-sm font-medium">{batch.filename}</p>
        <p className="text-ink-muted text-xs">{bnDateTime(batch.createdAt)}</p>
        <p className="text-ink-muted mt-1 text-xs">
          {bnNum(batch.rowCount)}টি সারি · <span className="text-income">যোগ হয়েছে</span>{' '}
          {bnNum(batch.importedCount)} · বাদ পড়েছে {bnNum(batch.skippedCount)}
        </p>
        {partlyGone ? (
          <p className="text-ink-muted text-xs">এখনও খাতায় আছে {bnNum(batch.liveCount)}টি</p>
        ) : null}
      </div>

      <div className="flex shrink-0 flex-col items-end gap-2">
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-[11px] font-medium',
            reverted
              ? 'bg-greenbar text-ink-muted'
              : batch.status === 'APPLIED'
                ? 'bg-income/10 text-income'
                : 'bg-brass/10 text-brass',
          )}
        >
          {BATCH_STATUS_LABEL[batch.status] ?? batch.status}
        </span>
        {reverted ? null : (
          <Button variant="outline" size="sm" onClick={onRevert}>
            <Undo2 className="h-4 w-4" aria-hidden />
            ফিরিয়ে নিন
          </Button>
        )}
      </div>
    </li>
  );
}
