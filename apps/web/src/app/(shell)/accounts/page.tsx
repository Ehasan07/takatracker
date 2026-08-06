'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Scale } from 'lucide-react';
import * as React from 'react';
import { parseMoneyToMinor, toLocalDateString } from '@hishab/shared';
import { Money } from '@/components/money';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { SkeletonRows } from '@/components/skeleton';
import { api, endpoints, type AccountDto } from '@/lib/api';

const ACCOUNT_TYPES: { value: string; label: string }[] = [
  { value: 'CASH', label: 'নগদ' },
  { value: 'BANK', label: 'ব্যাংক' },
  { value: 'MOBILE_WALLET', label: 'মোবাইল ওয়ালেট' },
  { value: 'CREDIT_CARD', label: 'ক্রেডিট কার্ড' },
  { value: 'SAVINGS', label: 'সঞ্চয়' },
];

export default function AccountsPage() {
  const queryClient = useQueryClient();
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: endpoints.accounts });
  const [addOpen, setAddOpen] = React.useState(false);
  const [reconciling, setReconciling] = React.useState<AccountDto | null>(null);

  const total = (accounts.data ?? []).reduce((sum, a) => sum + a.balanceMinor, 0);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <header className="flex items-center justify-between gap-2">
        <h1 className="text-ink hidden text-xl font-semibold sm:text-2xl md:block">অ্যাকাউন্ট</h1>
        <Button onClick={() => setAddOpen(true)} size="sm">
          <Plus className="h-4 w-4" aria-hidden />
          নতুন
        </Button>
      </header>

      <section className="rounded-card border-rule bg-surface border p-4">
        <p className="text-ink-muted text-sm">মোট</p>
        <Money minor={total} className="text-2xl font-semibold" />
      </section>

      {accounts.isLoading ? (
        <div className="rounded-card border-rule bg-surface overflow-hidden border">
          <SkeletonRows rows={3} />
        </div>
      ) : accounts.data?.length === 0 ? (
        <div className="rounded-card border-rule border border-dashed p-8 text-center">
          <p className="text-ink">এখনও কোনো অ্যাকাউন্ট নেই।</p>
          <Button className="mt-3" onClick={() => setAddOpen(true)}>
            প্রথম অ্যাকাউন্ট যোগ করুন
          </Button>
        </div>
      ) : (
        <ul className="rounded-card border-rule bg-surface overflow-hidden border">
          {(accounts.data ?? []).map((account) => (
            <li
              key={account.id}
              className="ledger-row border-rule flex items-center gap-3 border-b px-3 py-3 last:border-b-0"
            >
              <div className="min-w-0 flex-1">
                <p className="text-ink truncate text-sm font-medium">{account.name}</p>
                <p className="text-ink-muted truncate text-xs">
                  {ACCOUNT_TYPES.find((t) => t.value === account.type)?.label ?? account.type}
                  {account.accountNumberMasked ? ` · ${account.accountNumberMasked}` : ''}
                </p>
              </div>
              <Money minor={account.balanceMinor} className="amount-col shrink-0 pl-3 text-sm" />
              <button
                type="button"
                aria-label={`${account.name} মেলান`}
                onClick={() => setReconciling(account)}
                className="press touch-target text-ink-muted hover:bg-greenbar flex shrink-0 items-center justify-center rounded-md"
              >
                <Scale className="h-4 w-4" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}

      <AddAccountSheet
        open={addOpen}
        onOpenChange={setAddOpen}
        onSaved={() => void queryClient.invalidateQueries()}
      />
      <ReconcileSheet
        account={reconciling}
        onClose={() => setReconciling(null)}
        onSaved={() => void queryClient.invalidateQueries()}
      />
    </div>
  );
}

function AddAccountSheet({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [name, setName] = React.useState('');
  const [type, setType] = React.useState('CASH');
  const [openingBalance, setOpeningBalance] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      api<AccountDto>('/accounts', {
        method: 'POST',
        body: {
          name,
          type,
          openingBalance: openingBalance ? parseMoneyToMinor(openingBalance) : 0,
        },
      }),
    onSuccess: () => {
      setName('');
      setOpeningBalance('');
      onSaved();
      onOpenChange(false);
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'সংরক্ষণ করা যায়নি'),
  });

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="নতুন অ্যাকাউন্ট">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          save.mutate();
        }}
      >
        <Field label="নাম" htmlFor="acc-name">
          <Input
            id="acc-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            placeholder="যেমন: ব্র্যাক ব্যাংক"
          />
        </Field>
        <Field label="ধরন" htmlFor="acc-type">
          <Select id="acc-type" value={type} onChange={(e) => setType(e.target.value)}>
            {ACCOUNT_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="প্রারম্ভিক জের (৳)" htmlFor="acc-opening">
          <Input
            id="acc-opening"
            value={openingBalance}
            onChange={(e) => setOpeningBalance(e.target.value)}
            inputMode="decimal"
            placeholder="০.০০"
            className="money"
          />
        </Field>
        {error ? (
          <p role="alert" className="text-expense text-sm">
            {error}
          </p>
        ) : null}
        <Button type="submit" size="block" disabled={save.isPending}>
          সংরক্ষণ করুন
        </Button>
      </form>
    </Sheet>
  );
}

function ReconcileSheet({
  account,
  onClose,
  onSaved,
}: {
  account: AccountDto | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [actual, setActual] = React.useState('');
  const [result, setResult] = React.useState<string | null>(null);

  React.useEffect(() => {
    setActual('');
    setResult(null);
  }, [account]);

  const save = useMutation({
    mutationFn: () =>
      api<{ delta: number }>(`/accounts/${account!.id}/reconcile`, {
        method: 'POST',
        body: {
          date: toLocalDateString(new Date()),
          actualBalanceMinor: parseMoneyToMinor(actual),
        },
      }),
    onSuccess: (data) => {
      onSaved();
      setResult(
        data.delta === 0 ? 'হিসাব আগেই মিলে ছিল।' : 'পার্থক্যটি সমন্বয় হিসেবে যোগ করা হয়েছে।',
      );
    },
  });

  return (
    <Sheet
      open={account !== null}
      onOpenChange={(open) => !open && onClose()}
      title="ব্যালেন্স মেলান"
      description={account?.name}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <p className="text-ink-muted text-sm">
          খাতা অনুযায়ী এখন <Money minor={account?.balanceMinor ?? 0} className="inline" />। আসল
          ব্যালেন্স লিখুন — পার্থক্যটি সমন্বয় হিসেবে যোগ হবে।
        </p>
        <Field label="আসল ব্যালেন্স (৳)" htmlFor="rec-actual">
          <Input
            id="rec-actual"
            value={actual}
            onChange={(e) => setActual(e.target.value)}
            inputMode="decimal"
            required
            className="money text-xl"
          />
        </Field>
        {result ? <p className="text-income text-sm">{result}</p> : null}
        <Button type="submit" size="block" disabled={save.isPending}>
          মেলান
        </Button>
      </form>
    </Sheet>
  );
}
