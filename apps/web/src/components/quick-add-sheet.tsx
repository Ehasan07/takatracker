'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { formatMinor, parseMoneyToMinor, toLocalDateString } from '@hishab/shared';
import { api, endpoints, QueuedOfflineError, type TransactionDto } from '@/lib/api';
import { Button } from './ui/button';
import { Field, Input, Select, Textarea } from './ui/field';
import { Sheet } from './ui/sheet';

type Kind = 'EXPENSE' | 'INCOME' | 'TRANSFER';

const TABS: { kind: Kind; label: string }[] = [
  { kind: 'EXPENSE', label: 'খরচ' },
  { kind: 'INCOME', label: 'আয়' },
  { kind: 'TRANSFER', label: 'ট্রান্সফার' },
];

export interface QuickAddSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pass an existing transaction to edit it instead of creating a new one. */
  editing?: TransactionDto | null;
}

export function QuickAddSheet({ open, onOpenChange, editing }: QuickAddSheetProps) {
  const queryClient = useQueryClient();
  const today = toLocalDateString(new Date());

  const accounts = useQuery({ queryKey: ['accounts'], queryFn: endpoints.accounts });
  const categories = useQuery({ queryKey: ['categories'], queryFn: endpoints.categories });

  const [kind, setKind] = React.useState<Kind>('EXPENSE');
  const [amount, setAmount] = React.useState('');
  const [date, setDate] = React.useState(today);
  const [accountId, setAccountId] = React.useState('');
  const [counterAccountId, setCounterAccountId] = React.useState('');
  const [categoryId, setCategoryId] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  // Load the sheet with the row being edited, or reset it for a new entry.
  React.useEffect(() => {
    if (!open) return;
    if (editing) {
      const editKind: Kind =
        editing.type === 'INCOME' ? 'INCOME' : editing.type === 'TRANSFER' ? 'TRANSFER' : 'EXPENSE';
      setKind(editKind);
      setAmount(formatMinor(Math.abs(editing.amountMinor), { symbol: false }));
      setDate(editing.date);
      setAccountId(editing.accountId ?? '');
      setCounterAccountId(editing.counterAccountId ?? '');
      setCategoryId(editing.categoryId ?? '');
      setDescription(editing.description ?? '');
      setNotes(editing.notes ?? '');
    } else {
      setKind('EXPENSE');
      setAmount('');
      setDate(today);
      setCounterAccountId('');
      setCategoryId('');
      setDescription('');
      setNotes('');
    }
    setError(null);
  }, [open, editing, today]);

  const accountList = accounts.data ?? [];
  React.useEffect(() => {
    if (!accountId && accountList.length > 0) setAccountId(accountList[0]!.id);
  }, [accountId, accountList]);

  /* The accounts query may resolve after the sheet is already open. Without a
   * fallback the <select> would sit on an unmatched empty value, which a
   * required control refuses to submit — silently, with no visible error. */
  const effectiveAccountId = accountId || (accountList[0]?.id ?? '');

  const relevantCategories = (categories.data ?? []).filter((c) =>
    kind === 'INCOME' ? c.kind === 'INCOME' : c.kind === 'EXPENSE',
  );

  const save = useMutation({
    mutationFn: async () => {
      const amountMinor = parseMoneyToMinor(amount);
      if (amountMinor <= 0) throw new Error('পরিমাণ শূন্যের চেয়ে বেশি হতে হবে');

      const body = {
        date,
        type: kind,
        amountMinor,
        accountId: effectiveAccountId,
        counterAccountId: kind === 'TRANSFER' ? counterAccountId : undefined,
        categoryId: kind === 'TRANSFER' ? undefined : categoryId || undefined,
        description: description || undefined,
        notes: notes || undefined,
        source: 'MANUAL' as const,
      };

      return api<TransactionDto>(editing ? `/transactions/${editing.id}` : '/transactions', {
        method: editing ? 'PATCH' : 'POST',
        body,
        queueWhenOffline: true,
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      onOpenChange(false);
    },
    onError: async (err) => {
      if (err instanceof QueuedOfflineError) {
        // Parked offline is a success from the user's point of view.
        await queryClient.invalidateQueries();
        onOpenChange(false);
        return;
      }
      setError(err instanceof Error ? err.message : 'সংরক্ষণ করা যায়নি');
    },
  });

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? 'লেনদেন সম্পাদনা' : 'নতুন লেনদেন'}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          save.mutate();
        }}
      >
        <div
          role="tablist"
          aria-label="ধরন"
          className="bg-greenbar grid grid-cols-3 gap-1 rounded-md p-1"
        >
          {TABS.map((tab) => (
            <button
              key={tab.kind}
              type="button"
              role="tab"
              aria-selected={kind === tab.kind}
              onClick={() => setKind(tab.kind)}
              className={
                kind === tab.kind
                  ? 'bg-surface text-ink min-h-11 rounded-md text-sm font-semibold shadow-sm'
                  : 'text-ink-muted min-h-11 rounded-md text-sm'
              }
            >
              {tab.label}
            </button>
          ))}
        </div>

        <Field label="পরিমাণ (৳)" htmlFor="qa-amount">
          <Input
            id="qa-amount"
            name="amount"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required
            autoFocus
            inputMode="decimal"
            enterKeyHint="done"
            placeholder="০.০০"
            className="money text-2xl"
          />
        </Field>

        <Field label="তারিখ" htmlFor="qa-date">
          <Input
            id="qa-date"
            name="date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            required
          />
        </Field>

        <Field
          label={kind === 'TRANSFER' ? 'যে অ্যাকাউন্ট থেকে' : 'অ্যাকাউন্ট'}
          htmlFor="qa-account"
        >
          <Select
            id="qa-account"
            name="accountId"
            value={effectiveAccountId}
            onChange={(e) => setAccountId(e.target.value)}
            required
          >
            {accountList.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>

        {kind === 'TRANSFER' ? (
          <Field label="যে অ্যাকাউন্টে" htmlFor="qa-counter">
            <Select
              id="qa-counter"
              name="counterAccountId"
              value={counterAccountId}
              onChange={(e) => setCounterAccountId(e.target.value)}
              required
            >
              <option value="">বেছে নিন</option>
              {accountList
                .filter((a) => a.id !== effectiveAccountId)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </Select>
          </Field>
        ) : (
          <Field label="ক্যাটাগরি" htmlFor="qa-category">
            <Select
              id="qa-category"
              name="categoryId"
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              required
            >
              <option value="">বেছে নিন</option>
              {relevantCategories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nameBn ?? c.name}
                </option>
              ))}
            </Select>
          </Field>
        )}

        <Field label="বিবরণ" htmlFor="qa-description">
          <Input
            id="qa-description"
            name="description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="যেমন: সাপ্তাহিক বাজার"
          />
        </Field>

        <Field label="নোট" htmlFor="qa-notes">
          <Textarea
            id="qa-notes"
            name="notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>

        {error ? (
          <p role="alert" className="bg-expense/10 text-expense rounded-md px-3 py-2 text-sm">
            {error}
          </p>
        ) : null}

        <Button type="submit" size="block" disabled={save.isPending}>
          {save.isPending ? 'সংরক্ষণ হচ্ছে…' : 'সংরক্ষণ করুন'}
        </Button>
      </form>
    </Sheet>
  );
}
