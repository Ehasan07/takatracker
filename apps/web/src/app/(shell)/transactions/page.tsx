'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Trash2 } from 'lucide-react';
import * as React from 'react';
import { formatLedgerDate, fromLocalDateString } from '@hishab/shared';
import { Money } from '@/components/money';
import { QuickAddSheet } from '@/components/quick-add-sheet';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/field';
import { api, endpoints, type TransactionDto } from '@/lib/api';

export default function TransactionsPage() {
  const queryClient = useQueryClient();
  const [accountId, setAccountId] = React.useState('');
  const [type, setType] = React.useState('');
  const [q, setQ] = React.useState('');
  const [editing, setEditing] = React.useState<TransactionDto | null>(null);

  const accounts = useQuery({ queryKey: ['accounts'], queryFn: endpoints.accounts });

  const filters = { accountId: accountId || undefined, type: type || undefined, q: q || undefined };
  const transactions = useQuery({
    queryKey: ['transactions', filters],
    queryFn: () => endpoints.transactions({ ...filters, limit: 50 }),
  });

  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/transactions/${id}`, { method: 'DELETE', queueWhenOffline: true }),
    onSettled: () => queryClient.invalidateQueries(),
  });

  const items = transactions.data?.items ?? [];

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

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 xl:max-w-6xl">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-ink text-xl font-semibold sm:text-2xl">খাতা</h1>
        <p className="text-ink-muted text-sm">{items.length} টি লেনদেন</p>
      </header>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <Input
          aria-label="খুঁজুন"
          placeholder="খুঁজুন…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          enterKeyHint="search"
        />
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
        <p className="text-ink-muted text-sm">লোড হচ্ছে…</p>
      ) : items.length === 0 ? (
        <div className="rounded-card border-rule border border-dashed p-8 text-center">
          <p className="text-ink">এই ফিল্টারে কোনো লেনদেন নেই।</p>
          <p className="text-ink-muted mt-1 text-sm">+ বোতাম দিয়ে প্রথম লেনদেনটি যোগ করুন।</p>
        </div>
      ) : (
        <div className="rounded-card border-rule bg-surface overflow-hidden border">
          {groups.map(([date, rows]) => (
            <section key={date}>
              <h2 className="border-rule bg-greenbar text-ink-muted sticky top-0 z-10 border-b px-3 py-1.5 text-xs font-medium">
                {formatLedgerDate(fromLocalDateString(date))}
              </h2>
              <ul>
                {rows.map((txn) => (
                  <li
                    key={txn.id}
                    className="ledger-row border-rule flex items-center gap-2 border-b px-3 py-2 last:border-b-0"
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

                    <div className="flex shrink-0 items-center">
                      <button
                        type="button"
                        aria-label="সম্পাদনা"
                        onClick={() => setEditing(txn)}
                        className="touch-target text-ink-muted hover:bg-greenbar flex items-center justify-center rounded-md"
                      >
                        <Pencil className="h-4 w-4" aria-hidden />
                      </button>
                      <button
                        type="button"
                        aria-label="মুছুন"
                        onClick={() => remove.mutate(txn.id)}
                        className="touch-target text-expense hover:bg-greenbar flex items-center justify-center rounded-md"
                      >
                        <Trash2 className="h-4 w-4" aria-hidden />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {transactions.data?.nextCursor ? (
        <Button
          variant="outline"
          onClick={() =>
            void queryClient.invalidateQueries({ queryKey: ['transactions', filters] })
          }
        >
          আরও দেখুন
        </Button>
      ) : null}

      <QuickAddSheet
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        editing={editing}
      />
    </div>
  );
}
