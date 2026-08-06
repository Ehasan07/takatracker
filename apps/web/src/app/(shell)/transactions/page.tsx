'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Search, Trash2 } from 'lucide-react';
import * as React from 'react';
import { formatLedgerDate, fromLocalDateString } from '@hishab/shared';
import { Money } from '@/components/money';
import { QuickAddSheet } from '@/components/quick-add-sheet';
import { SkeletonRows } from '@/components/skeleton';
import { SwipeRow } from '@/components/swipe-row';
import { UndoToast } from '@/components/undo-toast';
import { Input, Select } from '@/components/ui/field';
import { useCoarsePointer, useIsDesktop } from '@/hooks/use-device';
import { api, endpoints, type TransactionDto } from '@/lib/api';
import { cn } from '@/lib/utils';

export default function TransactionsPage() {
  const queryClient = useQueryClient();
  const isDesktop = useIsDesktop();
  const coarse = useCoarsePointer();

  const [accountId, setAccountId] = React.useState('');
  const [type, setType] = React.useState('');
  const [q, setQ] = React.useState('');
  const [editing, setEditing] = React.useState<TransactionDto | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);

  const accounts = useQuery({ queryKey: ['accounts'], queryFn: endpoints.accounts });

  const filters = { accountId: accountId || undefined, type: type || undefined, q: q || undefined };
  const transactions = useQuery({
    queryKey: ['transactions', filters],
    queryFn: () => endpoints.transactions({ ...filters, limit: 50 }),
  });

  /* Deleting is soft, so it can be undone. The toast holds the id until the
   * window closes. */
  const [undoable, setUndoable] = React.useState<{ id: string; label: string } | null>(null);

  const remove = useMutation({
    mutationFn: (txn: TransactionDto) =>
      api(`/transactions/${txn.id}`, { method: 'DELETE', queueWhenOffline: true }),
    onSuccess: (_data, txn) =>
      setUndoable({ id: txn.id, label: txn.description || txn.categoryName || 'লেনদেন' }),
    onSettled: () => queryClient.invalidateQueries(),
  });

  const restore = useMutation({
    mutationFn: (id: string) => api(`/transactions/${id}/restore`, { method: 'POST', body: {} }),
    onSettled: () => queryClient.invalidateQueries(),
  });

  const items = React.useMemo(() => transactions.data?.items ?? [], [transactions.data]);

  // Group by day so the ledger reads like a paper khata.
  const groups = React.useMemo(() => {
    const map = new Map<string, TransactionDto[]>();
    for (const item of items) {
      const bucket = map.get(item.date);
      if (bucket) bucket.push(item);
      else map.set(item.date, [item]);
    }
    return [...map.entries()];
  }, [items]);

  const detail = items.find((t) => t.id === selected) ?? null;

  const rowActions = (txn: TransactionDto) => (
    <div className="flex shrink-0 items-center">
      <button
        type="button"
        aria-label="সম্পাদনা"
        onClick={() => setEditing(txn)}
        className="press touch-target text-ink-muted hover:bg-greenbar flex items-center justify-center rounded-md"
      >
        <Pencil className="h-4 w-4" aria-hidden />
      </button>
      <button
        type="button"
        aria-label="মুছুন"
        onClick={() => remove.mutate(txn)}
        className="press touch-target text-expense hover:bg-greenbar flex items-center justify-center rounded-md"
      >
        <Trash2 className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 xl:max-w-6xl">
      {/* The phone gets its title from the shell's navigation bar. */}
      <header className="hidden items-baseline justify-between gap-2 md:flex">
        <h1 className="text-ink text-2xl font-semibold">খাতা</h1>
        <p className="text-ink-muted text-sm">{items.length} টি লেনদেন</p>
      </header>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <div className="relative">
          <Search
            className="text-ink-muted pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2"
            aria-hidden
          />
          <Input
            aria-label="খুঁজুন"
            placeholder="খুঁজুন…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            enterKeyHint="search"
            type="search"
            className="pl-9"
          />
        </div>
        <Select
          aria-label="অ্যাকাউন্ট"
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
        >
          <option value="">সব অ্যাকাউন্ট</option>
          {(accounts.data ?? []).map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
        <Select aria-label="ধরন" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">সব ধরন</option>
          <option value="EXPENSE">খরচ</option>
          <option value="INCOME">আয়</option>
          <option value="TRANSFER">ট্রান্সফার</option>
          <option value="ADJUSTMENT">সমন্বয়</option>
          <option value="OPENING_BALANCE">প্রারম্ভিক জের</option>
        </Select>
      </div>

      {transactions.isLoading ? (
        <div className="rounded-card border-rule bg-surface overflow-hidden border">
          <SkeletonRows rows={6} />
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-card border-rule border border-dashed p-8 text-center">
          <p className="text-ink">এই ফিল্টারে কোনো লেনদেন নেই।</p>
          <p className="text-ink-muted mt-1 text-sm">+ বোতাম দিয়ে প্রথম লেনদেনটি যোগ করুন।</p>
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
                  {formatLedgerDate(fromLocalDateString(date))}
                </h2>
                <ul>
                  {rows.map((txn) => {
                    const row = (
                      <div
                        className={cn(
                          'flex items-center gap-2 px-3 py-2.5',
                          selected === txn.id && 'bg-greenbar',
                        )}
                        onClick={() => (isDesktop ? setSelected(txn.id) : undefined)}
                      >
                        <div className="min-w-0 flex-1">
                          <p className="text-ink truncate text-sm">
                            {txn.description || txn.categoryName || 'লেনদেন'}
                          </p>
                          <p className="text-ink-muted truncate text-xs">
                            {txn.type === 'TRANSFER'
                              ? `${txn.accountName} → ${txn.counterAccountName}`
                              : [txn.accountName, txn.categoryName].filter(Boolean).join(' · ')}
                            {txn.source !== 'MANUAL' ? ` · ${txn.source}` : ''}
                          </p>
                        </div>

                        <div className="amount-col shrink-0 pl-2 text-right">
                          <Money minor={txn.amountMinor} colored signed className="block text-sm" />
                          {txn.balanceAfterMinor !== undefined ? (
                            <Money
                              minor={txn.balanceAfterMinor}
                              className="text-ink-muted block text-[11px]"
                              decimals={false}
                            />
                          ) : null}
                        </div>

                        {/* Buttons at every size; the swipe gesture below is an
                            accelerator, never the only way to reach an action. */}
                        {rowActions(txn)}
                      </div>
                    );

                    return (
                      <li key={txn.id} className="ledger-row border-rule border-b last:border-b-0">
                        <SwipeRow
                          enabled={coarse}
                          right={{
                            label: 'সম্পাদনা',
                            icon: <Pencil className="h-4 w-4" aria-hidden />,
                            className: 'bg-brass',
                            onAction: () => setEditing(txn),
                          }}
                          left={{
                            label: 'মুছুন',
                            icon: <Trash2 className="h-4 w-4" aria-hidden />,
                            className: 'bg-expense',
                            onAction: () => remove.mutate(txn),
                          }}
                        >
                          {row}
                        </SwipeRow>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>

          {/* Persistent detail pane — desktop only (spec §5). */}
          <aside className="hidden lg:block">
            <div className="rounded-card border-rule bg-surface sticky top-0 border p-4">
              {detail ? (
                <dl className="space-y-3 text-sm">
                  <div>
                    <dt className="text-ink-muted text-xs">পরিমাণ</dt>
                    <dd>
                      <Money minor={detail.amountMinor} colored signed className="text-xl" />
                    </dd>
                  </div>
                  <div>
                    <dt className="text-ink-muted text-xs">বিবরণ</dt>
                    <dd className="text-ink break-words">{detail.description || '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-ink-muted text-xs">তারিখ</dt>
                    <dd className="text-ink">
                      {formatLedgerDate(fromLocalDateString(detail.date))}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-ink-muted text-xs">অ্যাকাউন্ট</dt>
                    <dd className="text-ink">{detail.accountName ?? '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-ink-muted text-xs">ক্যাটাগরি</dt>
                    <dd className="text-ink">{detail.categoryName ?? '—'}</dd>
                  </div>
                  {detail.notes ? (
                    <div>
                      <dt className="text-ink-muted text-xs">নোট</dt>
                      <dd className="text-ink break-words">{detail.notes}</dd>
                    </div>
                  ) : null}
                  <div className="pt-1">{rowActions(detail)}</div>
                </dl>
              ) : (
                <p className="text-ink-muted text-sm">
                  বিস্তারিত দেখতে বাঁ পাশের তালিকা থেকে একটি লেনদেন বেছে নিন।
                </p>
              )}
            </div>
          </aside>
        </div>
      )}

      {undoable ? (
        <UndoToast
          message={`মোছা হয়েছে: ${undoable.label}`}
          onUndo={() => {
            restore.mutate(undoable.id);
            setUndoable(null);
          }}
          onDismiss={() => setUndoable(null)}
        />
      ) : null}

      <QuickAddSheet
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        editing={editing}
      />
    </div>
  );
}
