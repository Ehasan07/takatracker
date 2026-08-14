'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { parseMoneyToMinor, toLocalDateString } from '@hishab/shared';
import { Money } from '@/components/money';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { ApiError, api, endpoints } from '@/lib/api';
import { fmtNumber } from '@/lib/format';
import { haptic } from '@/lib/haptics';
import { useDisplayName } from '@/lib/display-name';
import { t } from '@/lib/t';
import { fetchExpenses, splitKeys, type GroupDetail, type SplitMethod } from '../queries';

/**
 * Record one shared bill.
 *
 * ## The form is ordered the way the moment happens
 *
 * Somebody is standing at a counter. They know the amount, they know who paid,
 * and they know who was there — in that order. Anything else (category, a note,
 * which account) has a sensible default and sits below the fold, because a form
 * that asks eight questions before the first useful one is a form people stop
 * filling in and go back to keeping a mental tally.
 *
 * ## Everybody is on the bill until they are not
 *
 * Every member starts ticked. The common case is the whole group, and starting
 * from empty makes the common case the most work.
 *
 * ## The split is previewed, always
 *
 * The number each person will owe is on screen before saving, because it is the
 * number they are going to be told, and "৳33.34 vs ৳33.33" is exactly the sort
 * of thing that has to be visible rather than discovered later.
 */

const METHODS: { value: SplitMethod; label: string }[] = [
  { value: 'EQUAL', label: 'সমান ভাগে' },
  { value: 'SHARES', label: 'ভাগ অনুযায়ী' },
  { value: 'PERCENT', label: 'শতাংশে' },
  { value: 'EXACT', label: 'নির্দিষ্ট টাকা' },
];

interface Row {
  memberId: string;
  on: boolean;
  amount: string;
  percent: string;
  weight: string;
}

/**
 * A typed amount as poisha, or zero while the box is still empty.
 *
 * `parseMoneyToMinor` *throws* on anything it cannot read — correct for a save
 * path, fatal on a render path. This component computes the total on every
 * keystroke to preview the split, so the very first render (empty box) threw
 * and took the whole group screen down with a client-side exception. Silence is
 * right here and only here: the submit handler still refuses a zero total with
 * a message.
 */
function minorOrZero(input: string): number {
  if (!input.trim()) return 0;
  try {
    return parseMoneyToMinor(input);
  } catch {
    return 0;
  }
}

/**
 * "33.33" as 3333 basis points, without ever touching a float.
 *
 * `Math.round(Number(x) * 100)` is the obvious version and it is banned here for
 * the reason the whole codebase bans it: 33.33 × 100 is 3332.9999999999995 in
 * binary floating point, and a percentage that rounds down leaves the split
 * short of 100% and the bill short of a poisha. Parsed as digits instead.
 */
function toBasisPoints(input: string): number {
  const [whole = '0', fraction = ''] = input.trim().split('.');
  const hundredths = `${fraction}00`.slice(0, 2);
  return Number(whole) * 100 + Number(hundredths);
}

/** The same largest-remainder rule the server uses, for the preview only. */
function previewEqual(totalMinor: number, count: number): number[] {
  if (count <= 0 || totalMinor <= 0) return [];
  const base = Math.floor(totalMinor / count);
  const out = Array.from({ length: count }, () => base);
  let left = totalMinor - base * count;
  for (let i = 0; i < out.length && left > 0; i += 1) {
    out[i] = (out[i] as number) + 1;
    left -= 1;
  }
  return out;
}

export function AddExpenseSheet({
  open,
  onOpenChange,
  group,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  group: GroupDetail;
}) {
  const queryClient = useQueryClient();
  const { name: display } = useDisplayName();
  const active = React.useMemo(() => group.members.filter((m) => !m.removedAt), [group.members]);
  const self = active.find((m) => m.isSelf);

  const [description, setDescription] = React.useState('');
  const [amount, setAmount] = React.useState('');
  const [date, setDate] = React.useState(() => toLocalDateString(new Date()));
  const [payerId, setPayerId] = React.useState(self?.id ?? '');
  const [method, setMethod] = React.useState<SplitMethod>('EQUAL');
  const [rows, setRows] = React.useState<Row[]>([]);
  const [categoryId, setCategoryId] = React.useState<string | undefined>();
  const [accountId, setAccountId] = React.useState('');
  const [note, setNote] = React.useState('');
  const [fromPot, setFromPot] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const accounts = useQuery({
    queryKey: ['accounts'],
    queryFn: endpoints.accounts,
    enabled: open,
    staleTime: 60_000,
  });

  const categories = useQuery({
    queryKey: ['categories'],
    queryFn: () => endpoints.categories(),
    enabled: open,
    staleTime: 5 * 60_000,
  });

  React.useEffect(() => {
    if (!open) return;
    setDescription('');
    setAmount('');
    setDate(toLocalDateString(new Date()));
    setPayerId(self?.id ?? '');
    setMethod('EQUAL');
    setCategoryId(undefined);
    setNote('');
    setFromPot(group.potAccountId !== null);
    setError(null);
    setRows(
      active.map((m) => ({
        memberId: m.id,
        on: true,
        amount: '',
        percent: '',
        weight: String(m.shareWeight),
      })),
    );
  }, [open, active, self?.id, group.potAccountId]);

  React.useEffect(() => {
    if (!open || accountId) return;
    const first = accounts.data?.[0];
    if (first) setAccountId(first.id);
  }, [open, accountId, accounts.data]);

  /* The category this group was last filed under.
   *
   * A trip's bills are nearly all one kind of spending, so the second expense
   * onwards needs no thought at all — and a required field with a right default
   * is a field nobody notices, which is the point. Still overridable, and still
   * refused when there is nothing to default to. */
  const priorExpenses = useQuery({
    queryKey: splitKeys.expenses(group.id),
    queryFn: () => fetchExpenses(group.id),
    enabled: open,
    staleTime: 60_000,
  });

  React.useEffect(() => {
    if (!open || categoryId) return;
    const last = (priorExpenses.data ?? []).find((e) => e.categoryId);
    if (last?.categoryId) setCategoryId(last.categoryId);
  }, [open, categoryId, priorExpenses.data]);

  const totalMinor = minorOrZero(amount);
  const chosen = rows.filter((r) => r.on);
  const payerIsSelf = payerId === self?.id;
  /* A group with a pot spends the pot by default: that is what the pot is for,
     and somebody who wants to record a pocket payment can still turn it off. */
  const hasPot = group.potAccountId !== null;

  /* What each person will owe, shown before it is saved. Only EQUAL is
     previewed exactly here — the others are typed by the person, so the numbers
     on screen are already theirs. */
  const preview = React.useMemo(() => {
    if (method !== 'EQUAL') return new Map<string, number>();
    const parts = previewEqual(totalMinor, chosen.length);
    return new Map(chosen.map((row, i) => [row.memberId, parts[i] ?? 0]));
  }, [method, totalMinor, chosen]);

  /* Whether any of this bill lands in these books.
   *
   * A bill between two other members posts nothing here — no expense, no
   * category to file it under — so the field is not shown and not required.
   * Everywhere else it is both. */
  const iAmIn = chosen.some((row) => row.memberId === self?.id);

  const nameOf = (memberId: string): string =>
    active.find((m) => m.id === memberId)?.displayName ?? '';

  /* Parents before their children, each child prefixed with its parent, so a
     flat `<select>` still reads as the tree it is. */
  const expenseCategories = React.useMemo(() => {
    const all = (categories.data ?? []).filter((c) => c.kind === 'EXPENSE');
    const byId = new Map(all.map((c) => [c.id, c]));
    return all
      .map((c) => {
        const parent = c.parentId ? byId.get(c.parentId) : undefined;
        /* `displayName`, not `c.name`. The API sends both names and `name` is
           the English one, so this list read `Food & groceries` on a Bengali
           workspace where every other picker in the app reads খাবার ও বাজার. */
        return {
          id: c.id,
          label: parent ? `${display(parent)} › ${display(c)}` : display(c),
        };
      })
      .sort((a, b) => a.label.localeCompare(b.label, 'bn'));
  }, [categories.data, display]);

  const create = useMutation({
    mutationFn: () =>
      api(`/split/groups/${group.id}/expenses`, {
        method: 'POST',
        body: {
          description: description.trim(),
          date,
          totalMinor,
          payerMemberId: payerId,
          splitMethod: method,
          categoryId,
          fromPot: fromPot || undefined,
          accountId: payerIsSelf && !fromPot ? accountId : undefined,
          note: note.trim() || undefined,
          shares: chosen.map((row) => ({
            memberId: row.memberId,
            amountMinor: method === 'EXACT' ? minorOrZero(row.amount) : undefined,
            percentBps: method === 'PERCENT' ? toBasisPoints(row.percent) : undefined,
            shareWeight: method === 'SHARES' ? Number(row.weight || '0') : undefined,
          })),
        },
      }),
    onSuccess: () => {
      haptic('success');
      void queryClient.invalidateQueries({ queryKey: splitKeys.group(group.id) });
      void queryClient.invalidateQueries({ queryKey: splitKeys.expenses(group.id) });
      void queryClient.invalidateQueries({ queryKey: splitKeys.groups() });
      void queryClient.invalidateQueries({ queryKey: ['accounts'] });
      void queryClient.invalidateQueries({ queryKey: ['summary'] });
      onOpenChange(false);
    },
    onError: (err) => {
      haptic('warn');
      setError(
        err instanceof ApiError ? err.message : t('common.saveFailed', 'সংরক্ষণ করা যায়নি'),
      );
    },
  });

  const setRow = (memberId: string, patch: Partial<Row>): void =>
    setRows((current) =>
      current.map((row) => (row.memberId === memberId ? { ...row, ...patch } : row)),
    );

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('split.addExpense', 'খরচ যোগ করুন')}
      description={group.name}
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          if (!description.trim()) return setError(t('split.whatFor', 'কীসের খরচ লিখুন'));
          if (totalMinor <= 0) return setError(t('split.amountRequired', 'টাকার অঙ্ক দিন'));
          if (chosen.length === 0) return setError(t('split.whoRequired', 'অন্তত একজনকে বেছে নিন'));
          if (payerIsSelf && !fromPot && !accountId) {
            return setError(t('split.accountRequired', 'কোন অ্যাকাউন্ট থেকে গেল বেছে নিন'));
          }
          if (iAmIn && !categoryId) {
            return setError(t('split.categoryRequired', 'আপনার ভাগটি কোন খাতে যাবে বেছে নিন'));
          }
          create.mutate();
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('split.amount', 'কত টাকা')} htmlFor="se-amount">
            <Input
              id="se-amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder={fmtNumber('3000')}
              autoFocus
            />
          </Field>
          <Field label={t('split.date', 'তারিখ')} htmlFor="se-date">
            <Input
              id="se-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </Field>
        </div>

        <Field label={t('split.what', 'কীসের খরচ')} htmlFor="se-what">
          <Input
            id="se-what"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('split.whatPlaceholder', 'যেমন: রাতের খাবার')}
            maxLength={200}
          />
        </Field>

        <Field label={t('split.paidBy', 'টাকা দিয়েছেন')} htmlFor="se-payer">
          <Select id="se-payer" value={payerId} onChange={(e) => setPayerId(e.target.value)}>
            {active.map((m) => (
              <option key={m.id} value={m.id}>
                {m.isSelf ? t('split.me', 'আমি') : m.displayName}
              </option>
            ))}
          </Select>
        </Field>

        {hasPot ? (
          <label className="flex min-h-11 items-center gap-2">
            <input
              type="checkbox"
              checked={fromPot}
              onChange={(e) => setFromPot(e.target.checked)}
              className="accent-brand h-5 w-5 shrink-0"
            />
            <span className="text-ink text-sm">{t('split.spendPot', 'তহবিল থেকে খরচ')}</span>
          </label>
        ) : null}

        {fromPot ? (
          <p className="text-ink-muted text-xs">
            {t(
              'split.spendPotHint',
              'তহবিল সবার টাকায় তৈরি — তাই আপনার ভাগটুকু খরচ হবে, বাকিটা অন্যদের পাওনা থেকে কমবে।',
            )}
          </p>
        ) : payerIsSelf ? (
          <Field label={t('split.fromAccount', 'কোন অ্যাকাউন্ট থেকে')} htmlFor="se-account">
            <Select
              id="se-account"
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
              'split.someoneElsePaid',
              'অন্য কেউ দিয়েছেন, তাই আপনার অ্যাকাউন্ট থেকে টাকা যাবে না — শুধু আপনার ভাগটুকু দেনা হিসেবে থাকবে।',
            )}
          </p>
        )}

        <Field label={t('split.method', 'কীভাবে ভাগ হবে')} htmlFor="se-method">
          <Select
            id="se-method"
            value={method}
            onChange={(e) => setMethod(e.target.value as SplitMethod)}
          >
            {METHODS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </Select>
        </Field>

        <fieldset className="rounded-card border-rule border p-3">
          <legend className="text-ink-muted px-1 text-xs">{t('split.who', 'কারা ছিলেন')}</legend>
          <ul className="divide-rule divide-y">
            {rows.map((row) => (
              <li key={row.memberId} className="flex items-center gap-2 py-2">
                <label className="flex min-h-11 min-w-0 flex-1 items-center gap-2">
                  <input
                    type="checkbox"
                    checked={row.on}
                    onChange={(e) => setRow(row.memberId, { on: e.target.checked })}
                    className="accent-brand h-5 w-5 shrink-0"
                  />
                  <span className="text-ink min-w-0 truncate text-sm">{nameOf(row.memberId)}</span>
                </label>

                {!row.on ? null : method === 'EQUAL' ? (
                  /* The app's own money component, not `formatMinor` directly:
                     that renders Latin digits, so the preview read ৳1,000.00 on
                     a screen showing ৳১,০০০.০০ everywhere else. */
                  <Money
                    minor={preview.get(row.memberId) ?? 0}
                    className="text-ink-muted shrink-0 text-sm"
                  />
                ) : method === 'EXACT' ? (
                  <Input
                    inputMode="decimal"
                    value={row.amount}
                    onChange={(e) => setRow(row.memberId, { amount: e.target.value })}
                    aria-label={`${nameOf(row.memberId)} — ${t('split.amount', 'কত টাকা')}`}
                    className="w-24 shrink-0"
                  />
                ) : method === 'PERCENT' ? (
                  <Input
                    inputMode="decimal"
                    value={row.percent}
                    onChange={(e) => setRow(row.memberId, { percent: e.target.value })}
                    aria-label={`${nameOf(row.memberId)} — %`}
                    className="w-20 shrink-0"
                  />
                ) : (
                  <Input
                    inputMode="numeric"
                    value={row.weight}
                    onChange={(e) => setRow(row.memberId, { weight: e.target.value })}
                    aria-label={`${nameOf(row.memberId)} — ${t('split.shares', 'ভাগ')}`}
                    className="w-20 shrink-0"
                  />
                )}
              </li>
            ))}
          </ul>
        </fieldset>

        {/* Out of the folded section and onto the form.
         *
         * It lived behind a `খাত ও নোট` summary with `খাত ছাড়া` selected, so
         * every shared bill any of these books had ever seen went in with no
         * category and piled up in the reports' unclassified bucket. Only the
         * owner's own share is filed here — the others' shares are a receivable,
         * not spending — and a share of your own is spending, which has to say
         * what it was for. */}
        {iAmIn ? (
          <Field label={t('split.category', 'আপনার ভাগ কোন খাতে')} htmlFor="se-category">
            <Select
              id="se-category"
              value={categoryId ?? ''}
              onChange={(e) => setCategoryId(e.target.value || undefined)}
            >
              <option value="">{t('split.pickCategory', 'খাত বেছে নিন')}</option>
              {expenseCategories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}

        <details className="rounded-card border-rule border">
          <summary className="press text-ink-muted flex min-h-11 cursor-pointer items-center px-3 text-sm">
            {t('split.more', 'নোট')}
          </summary>
          <div className="flex flex-col gap-3 px-3 pb-3">
            <Field label={t('split.note', 'নোট')} htmlFor="se-note">
              <Input
                id="se-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={500}
              />
            </Field>
          </div>
        </details>

        {error ? (
          <p role="alert" className="bg-expense/10 text-expense rounded-md px-3 py-2 text-sm">
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
