'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronRight, Plus, UsersRound } from '@/components/icons';
import Link from 'next/link';
import * as React from 'react';
import { CategoryOptions } from '@/components/category-options';
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
  fetchGroups,
  fetchInbox,
  splitKeys,
  type GroupPurpose,
  type GroupSummary,
} from './queries';

/**
 * Groups you spend with.
 *
 * ## Why the headline on each row is what *you* stand at
 *
 * A group's total spending is a number nobody acts on. "করিম owes you ৳2,000"
 * is. So each row leads with the owner's own position and puts the group's size
 * underneath, which is also the order somebody scanning a list on a phone reads
 * in.
 *
 * ## Loading
 *
 * One request for the whole screen, balances included — the API computes every
 * group's position in a single pass rather than a round trip per row. On a
 * Bangladeshi mobile connection the difference between one request and eight is
 * the difference between a screen that opens and a screen that hesitates.
 */

const PURPOSES: { value: GroupPurpose; label: string }[] = [
  { value: 'TRIP', label: 'ট্রিপ' },
  { value: 'HOUSEHOLD', label: 'বাসা / মেস' },
  { value: 'OFFICE', label: 'অফিস' },
  { value: 'EVENT', label: 'অনুষ্ঠান' },
  { value: 'OTHER', label: 'অন্যান্য' },
];

const purposeLabel = (value: GroupPurpose): string =>
  PURPOSES.find((p) => p.value === value)?.label ?? value;

export default function SplitGroupsPage() {
  const [adding, setAdding] = React.useState(false);

  const groups = useQuery({ queryKey: splitKeys.groups(), queryFn: fetchGroups });
  const rows = groups.data ?? [];
  const live = rows.filter((g) => !g.archivedAt);
  const archived = rows.filter((g) => g.archivedAt);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h1 className="text-ink hidden text-xl font-extrabold sm:text-2xl md:block">
            {t('split.titleFull', 'ভাগাভাগি (ShareCost)')}
          </h1>
          <p className="text-ink-muted text-sm">
            {t('split.blurb', 'একসাথে খরচ — কে কত দিয়েছে, কে কত পাবে')}
          </p>
        </div>
        <Button type="button" onClick={() => setAdding(true)}>
          <Plus className="h-4 w-4" aria-hidden />
          {t('split.newGroup', 'নতুন গ্রুপ')}
        </Button>
      </header>

      {/* Bills somebody else recorded, waiting to be let in. Above the groups
          because it is the only part of this screen with something to decide. */}
      <InboxCard />

      {groups.isLoading ? (
        <div className="rounded-card border-rule bg-surface overflow-hidden border-[1.5px]">
          <SkeletonRows rows={3} />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState onStart={() => setAdding(true)} />
      ) : (
        <>
          <GroupList groups={live} />
          {archived.length > 0 ? (
            <details className="rounded-card border-rule bg-surface border-[1.5px]">
              <summary className="press text-ink-muted flex min-h-11 cursor-pointer items-center px-4 text-sm">
                {t('split.archived', 'আর্কাইভ করা গ্রুপ')} ({fmtNumber(archived.length)})
              </summary>
              <div className="px-2 pb-2">
                <GroupList groups={archived} />
              </div>
            </details>
          ) : null}
        </>
      )}

      <NewGroupSheet open={adding} onOpenChange={setAdding} />
    </div>
  );
}

/**
 * Shared bills offered by somebody else's workspace.
 *
 * Nothing here has touched the ledger. Accepting an invitation lets another
 * person put a draft in front of you and nothing more — the same rule the
 * mailbox ingestion follows, and the reason this is a list of decisions rather
 * than a list of entries.
 *
 * Renders nothing when the list is empty, so a screen that has never been
 * invited to anything does not carry an empty box forever.
 */
function InboxCard() {
  const queryClient = useQueryClient();
  const inbox = useQuery({ queryKey: splitKeys.inbox(), queryFn: fetchInbox });
  const categories = useQuery({
    queryKey: ['categories'],
    queryFn: () => endpoints.categories(),
    staleTime: 5 * 60_000,
  });

  /* Which category each waiting draft will be filed under, chosen per row.
   *
   * Accepting writes an expense into these books, and an expense with no
   * category lands in the reports' unclassified bucket — which is where every
   * shared bill used to end up. The button stays disabled until one is picked:
   * a refusal from the server after the tap would be a worse way to learn it. */
  const [filedAs, setFiledAs] = React.useState<Record<string, string>>({});

  const decide = useMutation({
    mutationFn: ({ id, accept }: { id: string; accept: boolean }) =>
      api(`/split/inbox/${id}/${accept ? 'accept' : 'decline'}`, {
        method: 'POST',
        body: accept ? { categoryId: filedAs[id] } : {},
      }),
    onSuccess: () => {
      haptic('tap');
      void queryClient.invalidateQueries({ queryKey: splitKeys.inbox() });
      void queryClient.invalidateQueries({ queryKey: ['summary'] });
      void queryClient.invalidateQueries({ queryKey: ['transactions'] });
    },
  });

  const rows = inbox.data ?? [];
  if (rows.length === 0) return null;

  return (
    <section className="rounded-card border-brand/40 bg-brand-tint border-[1.5px] p-4">
      <h2 className="text-ink text-lg font-bold">{t('split.inbox', 'আপনার অনুমতির অপেক্ষায়')}</h2>
      <p className="text-ink-muted mt-1 text-xs">
        {t('split.inboxHint', 'অন্য কেউ খরচ ভাগ করেছেন। আপনি রাজি হলে তবেই আপনার খাতায় উঠবে।')}
      </p>
      <ul className="divide-rule mt-3 divide-y">
        {rows.map((row) => (
          <li key={row.id} className="flex flex-wrap items-center gap-2 py-2">
            <div className="min-w-0 flex-1">
              <p className="text-ink truncate text-sm font-medium">{row.description}</p>
              <p className="text-ink-muted truncate text-xs">
                {row.groupName} · {row.payerName} · {fmtDate(row.date)}
              </p>
            </div>
            <Money minor={row.amountMinor} className="shrink-0 text-sm font-medium" />
            <Select
              aria-label={`${row.description} — ${t('split.fileUnder', 'খাত')}`}
              value={filedAs[row.id] ?? ''}
              onChange={(e) => setFiledAs((was) => ({ ...was, [row.id]: e.target.value }))}
              className="w-40 shrink-0"
            >
              <option value="">{t('split.pickCategory', 'খাত বেছে নিন')}</option>
              <CategoryOptions categories={categories.data} kind="EXPENSE" />
            </Select>
            <div className="flex shrink-0 gap-1">
              <Button
                type="button"
                size="sm"
                disabled={decide.isPending || !filedAs[row.id]}
                onClick={() => decide.mutate({ id: row.id, accept: true })}
              >
                <Check className="h-4 w-4" aria-hidden />
                {t('split.accept', 'যোগ করুন')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={decide.isPending}
                onClick={() => decide.mutate({ id: row.id, accept: false })}
              >
                {t('split.decline', 'না')}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function GroupList({ groups }: { groups: GroupSummary[] }) {
  if (groups.length === 0) return null;
  return (
    <ul
      className="rounded-card border-rule bg-surface divide-rule divide-y overflow-hidden border-[1.5px]"
      aria-label={t('split.groups', 'গ্রুপ')}
    >
      {groups.map((group) => (
        <li key={group.id}>
          <Link
            href={`/split/${group.id}`}
            className="press hover:bg-greenbar flex items-center gap-3 px-4 py-3"
          >
            <div className="min-w-0 flex-1">
              <p className="text-ink truncate font-medium">{group.name}</p>
              <p className="text-ink-muted truncate text-xs">
                {purposeLabel(group.purpose)} · {fmtNumber(group.memberCount)} জন ·{' '}
                {fmtNumber(group.expenseCount)}টি খরচ
              </p>
            </div>
            <div className="shrink-0 text-right">
              {/* The number somebody actually acts on, so it leads. */}
              {group.myNetMinor === 0 ? (
                <span className="text-ink-muted text-xs">{t('split.settled', 'হিসাব শেষ')}</span>
              ) : (
                <>
                  <Money
                    minor={Math.abs(group.myNetMinor)}
                    className={`block text-sm font-semibold ${
                      group.myNetMinor > 0 ? 'text-income' : 'text-expense'
                    }`}
                    decimals={false}
                  />
                  <span className="text-ink-muted text-[11px]">
                    {group.myNetMinor > 0
                      ? t('split.youGet', 'আপনি পাবেন')
                      : t('split.youOwe', 'আপনি দেবেন')}
                  </span>
                </>
              )}
            </div>
            <ChevronRight className="text-ink-muted h-4 w-4 shrink-0" aria-hidden />
          </Link>
        </li>
      ))}
    </ul>
  );
}

function EmptyState({ onStart }: { onStart: () => void }) {
  return (
    <div className="rounded-card border-rule bg-surface flex flex-col items-center gap-3 border-[1.5px] border-dashed p-8 text-center">
      <UsersRound className="text-ink-muted h-8 w-8" aria-hidden />
      <div>
        <p className="text-ink font-medium">{t('split.emptyTitle', 'এখনও কোনো গ্রুপ নেই')}</p>
        <p className="text-ink-muted mt-1 text-sm">
          {t(
            'split.emptyBody',
            'ট্রিপ, মেস বা অফিসের খরচ একসাথে হলে গ্রুপ বানান। আপনার ভাগটুকুই আপনার খরচে যাবে, বাকিটা পাওনা হিসেবে থাকবে।',
          )}
        </p>
      </div>
      <Button type="button" onClick={onStart}>
        <Plus className="h-4 w-4" aria-hidden />
        {t('split.newGroup', 'নতুন গ্রুপ')}
      </Button>
    </div>
  );
}

function NewGroupSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = React.useState('');
  const [purpose, setPurpose] = React.useState<GroupPurpose>('TRIP');
  /* One box, comma separated. Three taps to add three people is three chances
     to give up on a phone; a line of names is one. */
  const [people, setPeople] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) return;
    setName('');
    setPurpose('TRIP');
    setPeople('');
    setError(null);
  }, [open]);

  const create = useMutation({
    mutationFn: () =>
      api<{ id: string }>('/split/groups', {
        method: 'POST',
        body: {
          name: name.trim(),
          purpose,
          members: people
            .split(',')
            .map((n) => n.trim())
            .filter(Boolean)
            .map((n) => ({ name: n })),
        },
      }),
    onSuccess: () => {
      haptic('success');
      void queryClient.invalidateQueries({ queryKey: splitKeys.groups() });
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
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('split.newGroup', 'নতুন গ্রুপ')}
      description={t('split.newGroupHint', 'যাদের সাথে খরচ ভাগ করবেন')}
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          if (!name.trim()) {
            setError(t('split.nameRequired', 'গ্রুপের নাম দিন'));
            return;
          }
          create.mutate();
        }}
      >
        <Field label={t('split.name', 'গ্রুপের নাম')} htmlFor="group-name">
          <Input
            id="group-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('split.namePlaceholder', 'যেমন: কক্সবাজার ট্রিপ')}
            maxLength={120}
            autoFocus
          />
        </Field>

        <Field label={t('split.purpose', 'ধরন')} htmlFor="group-purpose">
          <Select
            id="group-purpose"
            value={purpose}
            onChange={(e) => setPurpose(e.target.value as GroupPurpose)}
          >
            {PURPOSES.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </Select>
        </Field>

        <Field label={t('split.people', 'কারা আছেন')} htmlFor="group-people">
          <Input
            id="group-people"
            value={people}
            onChange={(e) => setPeople(e.target.value)}
            placeholder={t('split.peoplePlaceholder', 'করিম, রহিম, সালাম')}
          />
        </Field>
        <p className="text-ink-muted -mt-1 text-xs">
          {t(
            'split.peopleHint',
            'কমা দিয়ে নাম লিখুন। আপনি নিজে এমনিতেই গ্রুপে থাকবেন — তাঁদের অ্যাকাউন্ট লাগবে না।',
          )}
        </p>

        {error ? (
          <p role="alert" className="bg-expense/10 text-expense rounded-xl px-3 py-2 text-sm">
            {error}
          </p>
        ) : null}

        <Button type="submit" size="block" disabled={create.isPending}>
          {create.isPending
            ? t('common.saving', 'সংরক্ষণ হচ্ছে…')
            : t('common.save', 'সংরক্ষণ করুন')}
        </Button>
      </form>
    </Sheet>
  );
}
