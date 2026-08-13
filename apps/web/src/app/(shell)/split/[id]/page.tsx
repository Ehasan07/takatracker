'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, HandCoins, Plus, Trash2, UserPlus } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import * as React from 'react';
import { formatMinor, parseMoneyToMinor, toLocalDateString } from '@hishab/shared';
import { Money } from '@/components/money';
import { SkeletonRows } from '@/components/skeleton';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { ApiError, api, endpoints } from '@/lib/api';
import { fmtDate, fmtNumber } from '@/lib/format';
import { haptic } from '@/lib/haptics';
import { t } from '@/lib/t';
import {
  fetchExpenses,
  fetchGroup,
  splitKeys,
  type GroupDetail,
  type Suggestion,
} from '../queries';
import { AddExpenseSheet } from './add-expense-sheet';

/**
 * One group: who stands where, what was spent, and how to square up.
 *
 * ## Balances first, history second
 *
 * The question somebody opens this screen with is "how much do I get back", not
 * "what did we spend on Tuesday". So the standing of every member is the top
 * card, the suggested payments are directly under it, and the list of bills —
 * which is a record rather than a decision — comes last.
 *
 * ## Suggestions are offered, never applied
 *
 * "Fewest payments" rearranges who owes whom: if Karim owes Rahim and Rahim owes
 * you, the tidy answer is Karim paying you directly. That is a change to three
 * people's obligations, and software does not get to make it on their behalf.
 * Each suggestion is a button that opens the settle sheet with the numbers
 * filled in; a person presses it.
 */

export default function SplitGroupPage() {
  const params = useParams<{ id: string }>();
  const groupId = params.id;
  const [adding, setAdding] = React.useState(false);
  const [addingMember, setAddingMember] = React.useState(false);
  const [settling, setSettling] = React.useState<Suggestion | null>(null);

  const group = useQuery({
    queryKey: splitKeys.group(groupId),
    queryFn: () => fetchGroup(groupId),
    enabled: Boolean(groupId),
  });
  const expenses = useQuery({
    queryKey: splitKeys.expenses(groupId),
    queryFn: () => fetchExpenses(groupId),
    enabled: Boolean(groupId),
  });

  const data = group.data;
  const self = data?.members.find((m) => m.isSelf);
  const nameOf = (memberId: string): string => {
    const member = data?.members.find((m) => m.id === memberId);
    if (!member) return '';
    return member.isSelf ? t('split.me', 'আমি') : member.displayName;
  };

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <Link
        href="/split"
        className="press text-ink-muted hover:text-ink flex min-h-11 w-fit items-center gap-1.5 text-sm"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        {t('split.title', 'ভাগাভাগি')}
      </Link>

      {group.isLoading ? (
        <div className="rounded-card border-rule bg-surface overflow-hidden border">
          <SkeletonRows rows={4} />
        </div>
      ) : !data ? (
        <p className="text-ink-muted text-sm">{t('split.notFound', 'গ্রুপটি পাওয়া যায়নি।')}</p>
      ) : (
        <>
          <header className="rounded-card border-rule bg-surface border p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <h1 className="text-ink truncate text-xl font-semibold">{data.name}</h1>
                <p className="text-ink-muted text-xs">
                  {fmtNumber(data.members.filter((m) => !m.removedAt).length)} জন
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button type="button" variant="outline" onClick={() => setAddingMember(true)}>
                  <UserPlus className="h-4 w-4" aria-hidden />
                  {t('split.addPerson', 'সদস্য')}
                </Button>
                <Button type="button" onClick={() => setAdding(true)}>
                  <Plus className="h-4 w-4" aria-hidden />
                  {t('split.expense', 'খরচ')}
                </Button>
              </div>
            </div>

            <ul className="divide-rule border-rule mt-3 divide-y border-t pt-1">
              {data.members.map((member) => (
                <li key={member.id} className="flex items-center justify-between gap-3 py-2">
                  <span className="text-ink min-w-0 truncate text-sm">
                    {member.isSelf ? t('split.me', 'আমি') : member.displayName}
                    {member.removedAt ? (
                      <span className="text-ink-muted ml-1.5 text-xs">
                        {t('split.left', '· গ্রুপ ছেড়েছেন')}
                      </span>
                    ) : null}
                  </span>
                  {!member.isSelf && !member.removedAt ? (
                    <InviteButton groupId={groupId} memberId={member.id} />
                  ) : null}
                  {member.netMinor === 0 ? (
                    <span className="text-ink-muted shrink-0 text-xs">
                      {t('split.square', 'হিসাব শেষ')}
                    </span>
                  ) : (
                    <span className="shrink-0 text-right">
                      <Money
                        minor={Math.abs(member.netMinor)}
                        className={`block text-sm font-medium ${
                          member.netMinor > 0 ? 'text-income' : 'text-expense'
                        }`}
                      />
                      <span className="text-ink-muted text-[11px]">
                        {member.netMinor > 0
                          ? t('split.getsBack', 'পাবেন')
                          : t('split.owes', 'দেবেন')}
                      </span>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </header>

          {data.suggestions.length > 0 ? (
            <section className="rounded-card border-rule bg-surface border p-4">
              <h2 className="text-ink-muted text-sm font-medium">
                {t('split.settleUp', 'হিসাব মেটাতে')}
              </h2>
              <p className="text-ink-muted mt-1 text-xs">
                {t(
                  'split.settleHint',
                  'সবচেয়ে কম লেনদেনে হিসাব শেষ করার উপায়। চাপলে টাকার অঙ্ক বসানো থাকবে — নিশ্চিত করলে তবেই খাতায় উঠবে।',
                )}
              </p>
              <ul className="mt-2 flex flex-col gap-2">
                {data.suggestions.map((s, i) => (
                  <li key={`${s.fromMemberId}-${s.toMemberId}-${i}`}>
                    <button
                      type="button"
                      onClick={() => setSettling(s)}
                      className="press border-rule hover:bg-greenbar flex min-h-11 w-full items-center gap-2 rounded-md border px-3 text-left text-sm"
                    >
                      <HandCoins className="text-ink-muted h-4 w-4 shrink-0" aria-hidden />
                      <span className="text-ink min-w-0 flex-1 truncate">
                        {nameOf(s.fromMemberId)} → {nameOf(s.toMemberId)}
                      </span>
                      <Money minor={s.amountMinor} className="shrink-0 font-medium" />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="flex flex-col gap-2">
            <h2 className="text-ink text-base font-semibold">
              {t('split.expenses', 'খরচের তালিকা')}
            </h2>
            {expenses.isLoading ? (
              <div className="rounded-card border-rule bg-surface overflow-hidden border">
                <SkeletonRows rows={3} />
              </div>
            ) : (expenses.data ?? []).length === 0 ? (
              <p className="text-ink-muted text-sm">
                {t('split.noExpenses', 'এখনও কোনো খরচ লেখা হয়নি।')}
              </p>
            ) : (
              <ul
                className="rounded-card border-rule bg-surface divide-rule divide-y overflow-hidden border"
                aria-label={t('split.expenses', 'খরচের তালিকা')}
              >
                {(expenses.data ?? []).map((expense) => (
                  <li key={expense.id} className="flex items-start gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-ink truncate text-sm font-medium">{expense.description}</p>
                      <p className="text-ink-muted truncate text-xs">
                        {fmtDate(expense.date)} ·{' '}
                        {expense.payerIsSelf
                          ? t('split.youPaid', 'আপনি দিয়েছেন')
                          : t('split.paidByName', '{name} দিয়েছেন').replace(
                              '{name}',
                              expense.payerName,
                            )}
                      </p>
                      {/* The owner's own share, which is the only part that
                          reached their expenses. Said out loud so nobody
                          wonders why the ledger shows less than the bill. */}
                      <p className="text-ink-muted text-xs">
                        {t('split.yourShare', 'আপনার ভাগ')}:{' '}
                        <Money minor={expense.myShareMinor} className="text-ink" />
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Money minor={expense.totalMinor} className="text-sm" decimals={false} />
                      <DeleteExpense groupId={groupId} expenseId={expense.id} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <AddExpenseSheet open={adding} onOpenChange={setAdding} group={data} />
          <AddMemberSheet open={addingMember} onOpenChange={setAddingMember} groupId={groupId} />
          <SettleSheet
            group={data}
            suggestion={settling}
            selfId={self?.id ?? ''}
            onOpenChange={(open) => !open && setSettling(null)}
          />
        </>
      )}
    </div>
  );
}

/**
 * Invite one member to keep their own side of the books.
 *
 * The link is shown once and copied here, like every other credential this
 * product hands out: only its hash is stored, so there is nothing to read back
 * later.
 */
function InviteButton({ groupId, memberId }: { groupId: string; memberId: string }) {
  const [link, setLink] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  const invite = useMutation({
    mutationFn: () =>
      api<{ url: string }>(`/split/groups/${groupId}/members/${memberId}/invite`, {
        method: 'POST',
        body: {},
      }),
    onSuccess: (res) => {
      haptic('success');
      setLink(`${window.location.origin}${res.url}`);
    },
  });

  if (link) {
    return (
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(link).then(
            () => setCopied(true),
            () => setCopied(false),
          );
        }}
        className="press text-brand shrink-0 text-xs underline"
      >
        {copied ? t('split.copied', 'কপি হয়েছে') : t('split.copyInvite', 'লিংক কপি করুন')}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => invite.mutate()}
      disabled={invite.isPending}
      aria-label={t('split.invite', 'আমন্ত্রণ পাঠান')}
      title={t('split.invite', 'আমন্ত্রণ পাঠান')}
      className="press touch-target text-ink-muted hover:bg-greenbar flex shrink-0 items-center justify-center rounded-md disabled:opacity-50"
    >
      <UserPlus className="h-3.5 w-3.5" aria-hidden />
    </button>
  );
}

function DeleteExpense({ groupId, expenseId }: { groupId: string; expenseId: string }) {
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => api(`/split/groups/${groupId}/expenses/${expenseId}`, { method: 'DELETE' }),
    onSuccess: () => {
      haptic('tap');
      void queryClient.invalidateQueries({ queryKey: splitKeys.group(groupId) });
      void queryClient.invalidateQueries({ queryKey: splitKeys.expenses(groupId) });
      void queryClient.invalidateQueries({ queryKey: ['accounts'] });
      void queryClient.invalidateQueries({ queryKey: ['summary'] });
    },
  });

  return (
    <button
      type="button"
      onClick={() => remove.mutate()}
      disabled={remove.isPending}
      aria-label={t('split.deleteExpense', 'এই খরচটি মুছুন')}
      className="press touch-target text-expense hover:bg-greenbar flex items-center justify-center rounded-md disabled:opacity-50"
    >
      <Trash2 className="h-4 w-4" aria-hidden />
    </button>
  );
}

function AddMemberSheet({
  open,
  onOpenChange,
  groupId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groupId: string;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) {
      setName('');
      setError(null);
    }
  }, [open]);

  const add = useMutation({
    mutationFn: () =>
      api(`/split/groups/${groupId}/members`, { method: 'POST', body: { name: name.trim() } }),
    onSuccess: () => {
      haptic('success');
      void queryClient.invalidateQueries({ queryKey: splitKeys.group(groupId) });
      void queryClient.invalidateQueries({ queryKey: ['people'] });
      onOpenChange(false);
    },
    onError: (err) => {
      haptic('warn');
      setError(
        err instanceof ApiError ? err.message : t('common.saveFailed', 'সংরক্ষণ করা যায়নি'),
      );
    },
  });

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t('split.addPerson', 'সদস্য যোগ করুন')}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          if (!name.trim()) return setError(t('split.personName', 'নাম দিন'));
          add.mutate();
        }}
      >
        <Field label={t('split.personName', 'নাম')} htmlFor="member-name">
          <Input
            id="member-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
            autoFocus
          />
        </Field>
        <p className="text-ink-muted -mt-1 text-xs">
          {t(
            'split.personHint',
            'তাঁর অ্যাকাউন্ট লাগবে না। নামটি আপনার “মানুষজন” তালিকাতেও যোগ হবে, তাই ধার-দেনার হিসাব এক জায়গাতেই থাকবে।',
          )}
        </p>
        {error ? (
          <p role="alert" className="bg-expense/10 text-expense rounded-md px-3 py-2 text-sm">
            {error}
          </p>
        ) : null}
        <Button type="submit" size="block" disabled={add.isPending}>
          {add.isPending ? t('common.saving', 'সংরক্ষণ হচ্ছে…') : t('common.save', 'সংরক্ষণ করুন')}
        </Button>
      </form>
    </Sheet>
  );
}

function SettleSheet({
  group,
  suggestion,
  selfId,
  onOpenChange,
}: {
  group: GroupDetail;
  suggestion: Suggestion | null;
  selfId: string;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [amount, setAmount] = React.useState('');
  const [date, setDate] = React.useState(() => toLocalDateString(new Date()));
  const [accountId, setAccountId] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  const involvesMe = suggestion?.fromMemberId === selfId || suggestion?.toMemberId === selfId;

  const accounts = useQuery({
    queryKey: ['accounts'],
    queryFn: endpoints.accounts,
    enabled: Boolean(suggestion) && involvesMe,
    staleTime: 60_000,
  });

  React.useEffect(() => {
    if (!suggestion) return;
    /* Rendered by the money formatter rather than divided by 100: the box is
       prefilled with a figure a person is about to confirm, and it has to be
       the same string the rest of the app would show them. */
    setAmount(formatMinor(suggestion.amountMinor, { symbol: false }));
    setDate(toLocalDateString(new Date()));
    setError(null);
  }, [suggestion]);

  React.useEffect(() => {
    if (accountId) return;
    const first = accounts.data?.[0];
    if (first) setAccountId(first.id);
  }, [accountId, accounts.data]);

  const settle = useMutation({
    mutationFn: () =>
      api(`/split/groups/${group.id}/settlements`, {
        method: 'POST',
        body: {
          fromMemberId: suggestion?.fromMemberId,
          toMemberId: suggestion?.toMemberId,
          amountMinor: amount.trim() ? parseMoneyToMinor(amount) : 0,
          date,
          accountId: involvesMe ? accountId : undefined,
        },
      }),
    onSuccess: () => {
      haptic('success');
      void queryClient.invalidateQueries({ queryKey: splitKeys.group(group.id) });
      void queryClient.invalidateQueries({ queryKey: splitKeys.groups() });
      void queryClient.invalidateQueries({ queryKey: ['accounts'] });
      onOpenChange(false);
    },
    onError: (err) => {
      haptic('warn');
      setError(
        err instanceof ApiError ? err.message : t('common.saveFailed', 'সংরক্ষণ করা যায়নি'),
      );
    },
  });

  const nameOf = (memberId: string): string => {
    const member = group.members.find((m) => m.id === memberId);
    if (!member) return '';
    return member.isSelf ? t('split.me', 'আমি') : member.displayName;
  };

  return (
    <Sheet
      open={Boolean(suggestion)}
      onOpenChange={onOpenChange}
      title={t('split.settleTitle', 'হিসাব মেটানো')}
      description={
        suggestion ? `${nameOf(suggestion.fromMemberId)} → ${nameOf(suggestion.toMemberId)}` : ''
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          settle.mutate();
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('split.amount', 'কত টাকা')} htmlFor="settle-amount">
            <Input
              id="settle-amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>
          <Field label={t('split.date', 'তারিখ')} htmlFor="settle-date">
            <Input
              id="settle-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </Field>
        </div>

        {involvesMe ? (
          <Field label={t('split.account', 'অ্যাকাউন্ট')} htmlFor="settle-account">
            <Select
              id="settle-account"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
            >
              {(accounts.data ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <p className="text-ink-muted text-xs">
            {t(
              'split.betweenOthers',
              'এটি অন্য দুজনের মধ্যে — আপনার খাতায় কোনো লেনদেন যোগ হবে না, শুধু গ্রুপের হিসাব ঠিক হবে।',
            )}
          </p>
        )}

        {error ? (
          <p role="alert" className="bg-expense/10 text-expense rounded-md px-3 py-2 text-sm">
            {error}
          </p>
        ) : null}

        <Button type="submit" size="block" disabled={settle.isPending}>
          {settle.isPending
            ? t('common.saving', 'সংরক্ষণ হচ্ছে…')
            : t('split.recordPayment', 'পরিশোধ লিখুন')}
        </Button>
      </form>
    </Sheet>
  );
}
