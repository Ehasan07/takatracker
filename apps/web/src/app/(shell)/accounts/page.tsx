'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellOff, FileUp, PiggyBank, Plus, Scale, Tags } from 'lucide-react';
import * as React from 'react';
import { parseMoneyToMinor, toBengaliDigits, toLocalDateString } from '@hishab/shared';
import { Money } from '@/components/money';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { SkeletonRows } from '@/components/skeleton';
import { api, endpoints, FeatureLimitError, type AccountDto } from '@/lib/api';
import Link from 'next/link';
import { UsageMeter } from '@/components/usage-meter';

const ACCOUNT_TYPES: { value: string; label: string; group: string }[] = [
  { value: 'CASH', label: 'নগদ', group: 'হাতে ও ব্যাংকে' },
  { value: 'BANK', label: 'ব্যাংক', group: 'হাতে ও ব্যাংকে' },
  { value: 'MOBILE_WALLET', label: 'মোবাইল ওয়ালেট', group: 'হাতে ও ব্যাংকে' },
  { value: 'SAVINGS', label: 'সঞ্চয় / ডিপিএস', group: 'হাতে ও ব্যাংকে' },
  { value: 'ASSET', label: 'সম্পদ (জমি, স্বর্ণ, গাড়ি)', group: 'সম্পদ' },
  { value: 'RECEIVABLE', label: 'পাওনা (যা আমি পাব)', group: 'সম্পদ' },
  { value: 'CREDIT_CARD', label: 'ক্রেডিট কার্ড', group: 'দায়' },
  { value: 'LIABILITY', label: 'ঋণ / দায়', group: 'দায়' },
  { value: 'PAYABLE', label: 'দেনা (যা আমি দেব)', group: 'দায়' },
];

const TYPE_GROUPS = ['হাতে ও ব্যাংকে', 'সম্পদ', 'দায়'] as const;

export default function AccountsPage() {
  const queryClient = useQueryClient();
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: endpoints.accounts });
  const entitlements = useQuery({ queryKey: ['entitlements'], queryFn: endpoints.entitlements });
  const [addOpen, setAddOpen] = React.useState(false);
  const [reconciling, setReconciling] = React.useState<AccountDto | null>(null);

  const muteReminders = useMutation({
    mutationFn: (accountId: string) =>
      api<{ cycleMonth: string }>(`/cards/${accountId}/mute-reminders`, {
        method: 'POST',
        body: {},
      }),
    onSuccess: () => void queryClient.invalidateQueries(),
  });

  const total = (accounts.data ?? []).reduce((sum, a) => sum + a.balanceMinor, 0);

  const accountLimit = entitlements.data?.entitlements['accounts.max'] ?? null;
  const accountsUsed = entitlements.data?.usage['accounts.max'] ?? 0;
  const atLimit = accountLimit !== null && accountsUsed >= accountLimit;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <header className="flex items-center justify-between gap-2">
        <h1 className="text-ink hidden text-xl font-semibold sm:text-2xl md:block">অ্যাকাউন্ট</h1>
        <div className="flex items-center gap-2">
          {/* Accounts say what you have; categories say where money goes. Both
              answer "what do I keep books with", so they sit together. */}
          <Link
            href="/import"
            className="press border-rule text-ink hover:bg-greenbar flex min-h-11 items-center gap-1.5 rounded-md border px-3 text-sm"
          >
            <FileUp className="h-4 w-4" aria-hidden />
            আমদানি
          </Link>
          <Link
            href="/savings"
            className="press border-rule text-ink hover:bg-greenbar flex min-h-11 items-center gap-1.5 rounded-md border px-3 text-sm"
          >
            <PiggyBank className="h-4 w-4" aria-hidden />
            সঞ্চয়
          </Link>
          <Link
            href="/categories"
            className="press border-rule text-ink hover:bg-greenbar flex min-h-11 items-center gap-1.5 rounded-md border px-3 text-sm"
          >
            <Tags className="h-4 w-4" aria-hidden />
            ক্যাটাগরি
          </Link>
          <Button
            onClick={() => setAddOpen(true)}
            size="sm"
            disabled={atLimit}
            title={atLimit ? 'প্ল্যানের সীমা শেষ' : undefined}
          >
            <Plus className="h-4 w-4" aria-hidden />
            নতুন
          </Button>
        </div>
      </header>

      <section className="rounded-card border-rule bg-surface border p-4">
        <p className="text-ink-muted text-sm">মোট</p>
        <Money minor={total} className="text-2xl font-semibold" />
        <UsageMeter className="mt-3" label="অ্যাকাউন্ট" used={accountsUsed} limit={accountLimit} />
        {atLimit ? (
          <p className="text-brass mt-2 text-xs">
            প্ল্যানের সীমা শেষ। পুরনো অ্যাকাউন্ট আর্কাইভ করুন, অথবা প্ল্যান আপগ্রেড করুন।
          </p>
        ) : null}
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
                  {account.dueDayOfMonth
                    ? ` · প্রতি মাসের ${toBengaliDigits(String(account.dueDayOfMonth))} তারিখে পেমেন্ট`
                    : ''}
                </p>
              </div>
              <Money minor={account.balanceMinor} className="amount-col shrink-0 pl-3 text-sm" />
              {account.dueDayOfMonth ? (
                <button
                  type="button"
                  aria-label={`${account.name} — এই মাসের রিমাইন্ডার বন্ধ করুন`}
                  title="এই মাসের রিমাইন্ডার বন্ধ করুন"
                  onClick={() => muteReminders.mutate(account.id)}
                  className="press touch-target text-ink-muted hover:bg-greenbar flex shrink-0 items-center justify-center rounded-md"
                >
                  <BellOff className="h-4 w-4" aria-hidden />
                </button>
              ) : null}
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
  const [dueDay, setDueDay] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      api<AccountDto>('/accounts', {
        method: 'POST',
        body: {
          name,
          type,
          openingBalance: openingBalance ? parseMoneyToMinor(openingBalance) : 0,
          // Only a card has a payment due day; sending it for cash would be noise.
          dueDayOfMonth: type === 'CREDIT_CARD' && dueDay ? Number(dueDay) : undefined,
        },
      }),
    onSuccess: () => {
      setName('');
      setOpeningBalance('');
      setDueDay('');
      onSaved();
      onOpenChange(false);
    },
    onError: (err) =>
      setError(
        err instanceof FeatureLimitError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'সংরক্ষণ করা যায়নি',
      ),
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
            {TYPE_GROUPS.map((group) => (
              <optgroup key={group} label={group}>
                {ACCOUNT_TYPES.filter((t) => t.group === group).map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        </Field>
        {type === 'CREDIT_CARD' ? (
          <Field label="পেমেন্টের শেষ তারিখ (মাসের কত তারিখ)" htmlFor="acc-due-day">
            <Input
              id="acc-due-day"
              type="number"
              min={1}
              max={31}
              inputMode="numeric"
              value={dueDay}
              onChange={(e) => setDueDay(e.target.value)}
              placeholder="যেমন: ১২"
            />
          </Field>
        ) : null}

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
