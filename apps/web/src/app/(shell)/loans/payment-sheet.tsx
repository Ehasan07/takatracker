'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { parseMoneyToMinor, toLocalDateString } from '@hishab/shared';
import { Money } from '@/components/money';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { api, ApiError, endpoints } from '@/lib/api';
import { haptic } from '@/lib/haptics';
import { useWorkspaceSettings } from '@/lib/workspace-settings';
import { METHODS } from './labels';
import { invalidateLoanData } from './queries';
import type { LoanDirection, PaymentMethod } from './types';

/** One instalment against a loan. */
export function PaymentSheet({
  loanId,
  direction,
  outstandingMinor,
  defaultAccountId,
  open,
  onOpenChange,
}: {
  loanId: string;
  direction: LoanDirection;
  outstandingMinor: number;
  defaultAccountId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: endpoints.accounts });

  const [form, setForm] = React.useState({
    date: toLocalDateString(new Date()),
    amount: '',
    method: 'CASH' as PaymentMethod,
    accountId: '',
    referenceNumber: '',
    note: '',
  });
  const [error, setError] = React.useState<string | null>(null);

  const set =
    (key: keyof typeof form) =>
    (e: { target: { value: string } }): void =>
      setForm((f) => ({ ...f, [key]: e.target.value }));

  React.useEffect(() => {
    if (defaultAccountId) {
      setForm((f) => (f.accountId ? f : { ...f, accountId: defaultAccountId }));
    }
  }, [defaultAccountId]);

  /* The books' currency decides how many minor units a typed amount is worth — 100 for taka, 1 for yen, 1000 for a dinar. */
  const { currency } = useWorkspaceSettings();
  const save = useMutation({
    mutationFn: () =>
      api(`/loans/${loanId}/payments`, {
        method: 'POST',
        body: {
          date: form.date,
          amountMinor: parseMoneyToMinor(form.amount || '0', currency),
          method: form.method,
          accountId: form.accountId,
          referenceNumber: form.referenceNumber.trim() || undefined,
          note: form.note.trim() || undefined,
        },
      }),
    onSuccess: () => {
      haptic('success');
      invalidateLoanData(queryClient);
      setForm((f) => ({ ...f, amount: '', referenceNumber: '', note: '' }));
      onOpenChange(false);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'সংরক্ষণ করা যায়নি'),
  });

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="কিস্তি যোগ করুন"
      description={direction === 'LENT' ? 'যে টাকা ফেরত পেলাম' : 'যে টাকা ফেরত দিলাম'}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          save.mutate();
        }}
      >
        <div className="bg-greenbar flex items-baseline justify-between gap-2 rounded-md p-3">
          <span className="text-ink-muted text-xs">এখনও বাকি</span>
          <Money minor={outstandingMinor} className="text-base font-semibold" />
        </div>

        <Field label="তারিখ" htmlFor="lp-date">
          <Input id="lp-date" type="date" value={form.date} onChange={set('date')} required />
        </Field>

        <Field label="পরিমাণ (৳)" htmlFor="lp-amount">
          <Input
            id="lp-amount"
            value={form.amount}
            onChange={set('amount')}
            inputMode="decimal"
            required
            className="money text-xl"
            placeholder="০.০০"
          />
        </Field>

        <Field label="মাধ্যম" htmlFor="lp-method">
          <Select id="lp-method" value={form.method} onChange={set('method')}>
            {METHODS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="কোন অ্যাকাউন্টে" htmlFor="lp-account">
          <Select id="lp-account" value={form.accountId} onChange={set('accountId')} required>
            <option value="" disabled>
              অ্যাকাউন্ট বেছে নিন
            </option>
            {(accounts.data ?? [])
              .filter((account) => !account.isArchived)
              .map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
          </Select>
        </Field>

        <Field label="রেফারেন্স" htmlFor="lp-ref">
          <Input
            id="lp-ref"
            value={form.referenceNumber}
            onChange={set('referenceNumber')}
            placeholder="চেক বা ট্রানজেকশন নম্বর"
          />
        </Field>

        <Field label="নোট" htmlFor="lp-note">
          <Textarea id="lp-note" value={form.note} onChange={set('note')} rows={2} />
        </Field>

        {error ? (
          <p role="alert" className="text-expense text-sm">
            {error}
          </p>
        ) : null}

        <Button type="submit" size="block" disabled={save.isPending || !form.accountId}>
          কিস্তি সংরক্ষণ করুন
        </Button>
      </form>
    </Sheet>
  );
}
