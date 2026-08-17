'use client';

import {
  RENEWAL_DEFAULTS,
  RENEWAL_KINDS,
  RENEWAL_RECURRENCES,
  type RenewalKind,
  type RenewalRecurrence,
} from '@hishab/core';
import { formatMinor, parseMoneyToMinor, toLocalDateString } from '@hishab/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, Plus, Trash2 } from 'lucide-react';
import * as React from 'react';
import { CategoryOptions } from '@/components/category-options';
import { Money } from '@/components/money';
import { SkeletonRows } from '@/components/skeleton';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { ApiError, api, endpoints } from '@/lib/api';
import { haptic } from '@/lib/haptics';
import { invalidateAfterWrite } from '@/lib/invalidate';
import { t } from '@/lib/t';

/**
 * Papers that expire.
 *
 * ## Why this is a screen and not a category
 *
 * A fitness certificate, khajna, holding tax, a trade licence. None of it is
 * bookkeeping — the obligation exists whether or not it has been paid, and the
 * payment when it comes is an ordinary expense like any other. It is a calendar
 * with money attached, and the two halves are kept apart on purpose: recording
 * the deadline as a transaction would either put money in the books that has
 * not moved, or lose the deadline the moment it was paid.
 *
 * ## The list is the warning
 *
 * Sorted by how soon, overdue first, with the days spelled out. A screen that
 * shows dates and expects somebody to subtract is a screen that gets read once.
 *
 * ## "হয়ে গেছে" asks about the money, it does not decide
 *
 * The two halves stay apart, but the moment they most often coincide is the
 * moment somebody presses done — they have just paid the fee. So the button
 * opens a sheet that offers to write the expense, prefilled with the estimate
 * and dated the day it was actually paid, with a way out of it that is a button
 * and not a cleared field. Skipping is one tap and leaves the ledger untouched,
 * which is what five years of back khajna in one sitting needs.
 */

interface Obligation {
  id: string;
  accountId: string | null;
  accountName: string | null;
  kind: RenewalKind;
  title: string;
  recurrence: RenewalRecurrence;
  dueDate: string;
  reminderLeadDays: number;
  estimatedCostMinor: number;
  lastCompletedOn: string | null;
  documentRef: string | null;
  note: string | null;
  isMuted: boolean;
  status: string;
  daysLeft: number;
  urgency: 'OVERDUE' | 'DUE_SOON' | 'UPCOMING';
}

const RECURRENCE_LABELS: Record<RenewalRecurrence, string> = {
  YEARLY: 'প্রতি বছর',
  HALF_YEARLY: 'ছয় মাস পরপর',
  QUARTERLY: 'তিন মাস পরপর',
  MONTHLY: 'প্রতি মাসে',
  ONE_OFF: 'একবারই',
};

/** How long is left, said the way somebody would say it out loud. */
function whenText(row: Obligation): string {
  if (row.status === 'DONE') return 'শেষ হয়েছে';
  if (row.daysLeft < 0) return `${Math.abs(row.daysLeft)} দিন পেরিয়ে গেছে`;
  if (row.daysLeft === 0) return 'আজই শেষ দিন';
  return `আর ${row.daysLeft} দিন`;
}

export default function RenewalsPage() {
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Obligation | null>(null);
  const [completing, setCompleting] = React.useState<Obligation | null>(null);
  /* Shown when the date rolled forward but the expense did not get written.
     Silence there would be the one unacceptable outcome: the person would go on
     believing they had recorded money that is not in the books. */
  const [feeNotice, setFeeNotice] = React.useState<string | null>(null);

  const rows = useQuery({
    queryKey: ['renewals'],
    queryFn: () => api<Obligation[]>('/renewals'),
  });
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: endpoints.accounts });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['renewals'] });
  };

  const remove = useMutation({
    mutationFn: (id: string) => api<{ id: string }>(`/renewals/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      haptic('success');
      /* The editor is what asked, so the editor is what closes. */
      setEditing(null);
      refresh();
    },
  });

  const list = rows.data ?? [];
  const active = list.filter((row) => row.status !== 'DONE');
  const needAttention = active.filter((row) => row.urgency !== 'UPCOMING');

  /* What the next twelve months will cost, out of the person's own estimates.
     Never a figure this app invented. */
  const yearAhead = active
    .filter((row) => row.daysLeft <= 365)
    .reduce((sum, row) => sum + row.estimatedCostMinor, 0);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <header className="flex items-center justify-between gap-2">
        <div>
          <h1 className="text-ink hidden text-xl font-semibold sm:text-2xl md:block">
            নবায়ন ও কাগজপত্র
          </h1>
          <p className="text-ink-muted mt-1 text-sm">
            ফিটনেস, খাজনা, হোল্ডিং ট্যাক্স, ট্রেড লাইসেন্স — কোনটা কবে শেষ হচ্ছে।
          </p>
        </div>
        <Button onClick={() => setAddOpen(true)} size="sm">
          <Plus className="h-4 w-4" aria-hidden />
          নতুন
        </Button>
      </header>

      {needAttention.length > 0 ? (
        <section className="rounded-card border-expense/40 bg-surface border p-4">
          <p className="text-expense flex items-center gap-1.5 text-sm font-medium">
            <AlertTriangle className="h-4 w-4" aria-hidden />
            {needAttention.length}টি কাগজ এখনই দেখা দরকার
          </p>
        </section>
      ) : null}

      {feeNotice ? (
        <section className="rounded-card border-brass/50 bg-surface border p-4" role="alert">
          <p className="text-ink text-sm font-medium">
            তারিখ এগিয়ে গেছে, কিন্তু খরচটি খাতায় লেখা যায়নি
          </p>
          <p className="text-ink-muted mt-1 text-sm">{feeNotice}</p>
          <p className="text-ink-muted mt-1 text-xs">
            নবায়নটি হয়ে গেছে হিসেবেই থাকল — খরচটা খাতায় গিয়ে হাতে লিখে নিন।
          </p>
          <Button className="mt-2" variant="ghost" size="sm" onClick={() => setFeeNotice(null)}>
            বুঝেছি
          </Button>
        </section>
      ) : null}

      {yearAhead > 0 ? (
        <section className="rounded-card border-rule bg-surface border p-4">
          <p className="text-ink-muted text-sm">আগামী এক বছরে আনুমানিক খরচ</p>
          <Money minor={yearAhead} className="text-xl font-semibold" />
          <p className="text-ink-muted mt-1 text-xs">
            আপনার নিজের দেওয়া হিসাব — অ্যাপ কোনো অঙ্ক বানায় না।
          </p>
        </section>
      ) : null}

      {rows.isLoading ? (
        <div className="rounded-card border-rule bg-surface overflow-hidden border">
          <SkeletonRows rows={3} />
        </div>
      ) : list.length === 0 ? (
        <div className="rounded-card border-rule border border-dashed p-8 text-center">
          <p className="text-ink">এখনো কোনো কাগজ যোগ করা হয়নি।</p>
          <p className="text-ink-muted mt-1 text-sm">
            গাড়ির ফিটনেস, জমির খাজনা, ফ্ল্যাটের হোল্ডিং ট্যাক্স — যেটার তারিখ ভুলে যান সেটা দিয়ে
            শুরু করুন।
          </p>
          <Button className="mt-3" onClick={() => setAddOpen(true)}>
            প্রথমটি যোগ করুন
          </Button>
        </div>
      ) : (
        <ul className="rounded-card border-rule bg-surface overflow-hidden border">
          {list.map((row) => (
            <li
              key={row.id}
              className="border-rule flex flex-col gap-2 border-b p-3 last:border-b-0 sm:flex-row sm:items-center"
            >
              <button
                type="button"
                aria-label={`${row.title} — ${t('common.edit', 'সম্পাদনা')}`}
                onClick={() => setEditing(row)}
                className="press min-h-11 min-w-0 flex-1 text-left"
              >
                <span className="text-ink block truncate text-sm font-medium">{row.title}</span>
                <span className="text-ink-muted block truncate text-xs">
                  {row.accountName ? `${row.accountName} · ` : ''}
                  {row.dueDate} · {RECURRENCE_LABELS[row.recurrence]}
                  {row.documentRef ? ` · ${row.documentRef}` : ''}
                </span>
              </button>

              <span
                className={`shrink-0 text-sm ${
                  row.urgency === 'OVERDUE'
                    ? 'text-expense font-medium'
                    : row.urgency === 'DUE_SOON'
                      ? 'text-brass'
                      : 'text-ink-muted'
                }`}
              >
                {whenText(row)}
              </span>

              {/* The bin used to sit here, and it deleted on one tap with
                  nothing asked — the only control in the app that did. It is
                  inside the row now, at the foot of the editor, where the name
                  and the date are on screen and it takes a second press. */}
              {row.status === 'DONE' ? null : (
                <div className="flex shrink-0 gap-1">
                  <Button variant="outline" size="sm" onClick={() => setCompleting(row)}>
                    <Check className="h-4 w-4" aria-hidden />
                    হয়ে গেছে
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* Marking one done always rolls the date forward. Booking the fee is
          offered in the sheet and never assumed — a person clearing five years
          of back khajna does not want five transactions dated today. */}
      <p className="text-ink-muted text-xs">
        "হয়ে গেছে" চাপলে পরের তারিখ বসে যাবে। চাইলে একই সঙ্গে খরচটাও খাতায় লিখে দিতে পারেন — না
        লিখলেও তারিখ এগিয়ে যাবে।
      </p>

      {/* Mounted only while a row is being completed, unlike the edit sheet
          below. The prefilled amount and date come from that row, and a sheet
          that stayed mounted would keep the first row's figures for the second.
          Unmounting is the cheapest possible reset. */}
      {completing ? (
        <CompleteSheet
          obligation={completing}
          /* Archived accounts are left out: money cannot have come out of one
             today, and a picker full of closed wallets is a picker somebody
             files a fee into by accident. */
          accounts={(accounts.data ?? [])
            .filter((a) => !a.isArchived)
            .map((a) => ({ id: a.id, name: a.name }))}
          onClose={() => setCompleting(null)}
          onDone={(result) => {
            setCompleting(null);
            haptic('success');
            refresh();
            /* Only when money actually moved. Balances, the month's totals and
               the khata are all untouched by a completion that booked nothing,
               and refetching them would be a request that can only return the
               same answer. */
            if (result.fee?.booked) invalidateAfterWrite(queryClient);
            setFeeNotice(result.fee && !result.fee.booked ? result.fee.message : null);
          }}
        />
      ) : null}

      {/* Keyed by the row it is for. The form seeds its state from `editing`
          once, at mount, so a sheet that stayed mounted across two different
          rows showed the first row's values while claiming to edit the second —
          which is precisely the thing tapping a row is now supposed to do. */}
      <ObligationSheet
        key={editing?.id ?? 'new'}
        open={addOpen || editing !== null}
        editing={editing}
        accounts={(accounts.data ?? []).map((a) => ({ id: a.id, name: a.name }))}
        onClose={() => {
          setAddOpen(false);
          setEditing(null);
        }}
        onSaved={() => {
          setAddOpen(false);
          setEditing(null);
          refresh();
        }}
        deleting={remove.isPending}
        onDelete={() => {
          if (editing) remove.mutate(editing.id);
        }}
      />
    </div>
  );
}

/** What became of the optional fee. Reported on every completion. */
interface FeeOutcome {
  booked: boolean;
  transactionId: string | null;
  /** Bengali, ready to show. Why it did not get written. */
  message: string | null;
}

/** The obligation as it now stands, plus the fee's fate — `null` if none was offered. */
interface CompletedObligation extends Obligation {
  fee: FeeOutcome | null;
}

/**
 * The estimate, as something somebody can type over.
 *
 * `formatMinor` does the division in integer arithmetic. Writing
 * `estimatedCostMinor / 100` here would be float maths on money, which this
 * codebase bans everywhere for the reason 33.33 × 100 is 3332.9999999999995.
 * An estimate of nothing prefills nothing: a zero somebody has to delete before
 * they can type is worse than an empty box.
 */
function prefillAmount(estimatedCostMinor: number): string {
  if (estimatedCostMinor <= 0) return '';
  return formatMinor(estimatedCostMinor, { symbol: false, lakhGrouping: false });
}

/**
 * "হয়ে গেছে" — and the question about the money that goes with it.
 *
 * ## The amount is a prefill, not a figure
 *
 * It starts at the person's own estimate, because that is nearly always right
 * and typing it again is work. It is an ordinary editable box because an
 * estimate is not a receipt: the fitness fee went up, the office wanted a
 * photocopy, the mohurer charged extra. What gets booked is what they typed.
 *
 * ## The date is the day it was paid
 *
 * Not today. Somebody clearing a five-year khajna backlog is telling the app
 * when each payment happened, and the expense carries the same date as the
 * completion — otherwise five years of fees land in this month and every report
 * about this month is wrong.
 *
 * ## Skipping is a button
 *
 * Not an emptied field, not an unticked box below the fold. "টাকা লিখব না" is
 * one tap, it completes the renewal, and it leaves the ledger untouched.
 */
function CompleteSheet({
  obligation,
  accounts,
  onClose,
  onDone,
}: {
  obligation: Obligation;
  accounts: { id: string; name: string }[];
  onClose: () => void;
  onDone: (result: CompletedObligation) => void;
}) {
  const [date, setDate] = React.useState(() => toLocalDateString(new Date()));
  const [amount, setAmount] = React.useState(() => prefillAmount(obligation.estimatedCostMinor));
  const [accountId, setAccountId] = React.useState(accounts[0]?.id ?? '');
  const [categoryId, setCategoryId] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  const categories = useQuery({
    queryKey: ['categories'],
    queryFn: () => endpoints.categories(),
    staleTime: 5 * 60_000,
  });

  const complete = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<CompletedObligation>(`/renewals/${obligation.id}/complete`, { method: 'POST', body }),
    onSuccess: onDone,
    onError: (err) => {
      haptic('warn');
      setError(err instanceof ApiError ? err.message : 'সংরক্ষণ করা যায়নি');
    },
  });

  /* Nothing to spend from. Saying so is better than a select with no options
     and a submit button that answers 400. */
  const canBook = accounts.length > 0;

  const bookFee = (): void => {
    setError(null);
    let amountMinor: number;
    try {
      amountMinor = parseMoneyToMinor(amount);
    } catch {
      return setError('টাকার অঙ্কটা বুঝতে পারিনি');
    }
    if (amountMinor <= 0) return setError('কত টাকা দিলেন লিখুন');
    if (!accountId) return setError('কোন অ্যাকাউন্ট থেকে গেল বেছে নিন');
    if (!categoryId) return setError('কোন খাতে যাবে বেছে নিন');
    complete.mutate({ completedOn: date, payment: { amountMinor, accountId, categoryId } });
  };

  /* The date and nothing else — exactly what this endpoint did before the fee
     was ever offered. */
  const skipFee = (): void => {
    setError(null);
    complete.mutate({ completedOn: date });
  };

  return (
    <Sheet
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="হয়ে গেছে"
      description={obligation.title}
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          bookFee();
        }}
      >
        <Field label="কবে হয়েছে" htmlFor="rc-date">
          <Input
            id="rc-date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            required
          />
        </Field>

        <p className="text-ink-muted text-sm">
          টাকাটা এখনই খাতায় লিখে দিতে পারেন। না চাইলে নিচের "টাকা লিখব না" চাপুন — তারিখ ঠিকই
          এগিয়ে যাবে।
        </p>

        <Field label="কত টাকা" htmlFor="rc-amount">
          <Input
            id="rc-amount"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={!canBook}
            autoFocus
          />
        </Field>
        {obligation.estimatedCostMinor > 0 ? (
          <p className="text-ink-muted -mt-2 text-xs">
            আপনার আনুমানিক হিসাবটি বসানো আছে — আসল অঙ্ক আলাদা হলে বদলে নিন।
          </p>
        ) : null}

        <Field label="কোন অ্যাকাউন্ট থেকে" htmlFor="rc-account">
          <Select
            id="rc-account"
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            disabled={!canBook}
          >
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="কোন খাতে" htmlFor="rc-category">
          <Select
            id="rc-category"
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            disabled={!canBook}
          >
            <option value="">বেছে নিন</option>
            {/* Expense only. Filing a fee under an income category would be a
                hole in the books that no report could explain. */}
            <CategoryOptions categories={categories.data} kind="EXPENSE" />
          </Select>
        </Field>

        {canBook ? null : (
          <p className="text-ink-muted text-sm">
            খরচ লেখার মতো কোনো অ্যাকাউন্ট নেই। আগে একটি অ্যাকাউন্ট যোগ করুন, নয়তো শুধু তারিখটাই
            এগিয়ে নিন।
          </p>
        )}

        {error ? (
          <p role="alert" className="text-expense text-sm">
            {error}
          </p>
        ) : null}

        <div className="flex flex-col gap-2 pt-1 sm:flex-row">
          <Button type="submit" disabled={complete.isPending || !canBook}>
            {complete.isPending ? 'রাখা হচ্ছে…' : 'হয়ে গেছে, খরচও লিখুন'}
          </Button>
          <Button type="button" variant="outline" disabled={complete.isPending} onClick={skipFee}>
            টাকা লিখব না
          </Button>
        </div>
      </form>
    </Sheet>
  );
}

function ObligationSheet({
  open,
  editing,
  accounts,
  onClose,
  onSaved,
  onDelete,
  deleting = false,
}: {
  open: boolean;
  editing: Obligation | null;
  accounts: { id: string; name: string }[];
  onClose: () => void;
  onSaved: () => void;
  /** Runs only after the second press below. This form never deletes on one. */
  onDelete: () => void;
  deleting?: boolean;
}) {
  const [kind, setKind] = React.useState<RenewalKind>(editing?.kind ?? 'FITNESS');
  /**
   * The second press.
   *
   * Every other destructive action in the app opens a sheet to ask. This one
   * asks in place instead, because the thing being deleted is a reminder and
   * not money — nothing in the books moves — and stacking a third layer over an
   * editor that is already a sheet leaves a 320px phone with nowhere to read
   * the question from. What matters is that it is never one tap, and it is not.
   */
  const [confirming, setConfirming] = React.useState(false);
  const [form, setForm] = React.useState({
    title: editing?.title ?? RENEWAL_DEFAULTS.FITNESS.label,
    dueDate: editing?.dueDate ?? '',
    recurrence: (editing?.recurrence ?? 'YEARLY') as RenewalRecurrence,
    reminderLeadDays: String(editing?.reminderLeadDays ?? 30),
    cost: editing ? String(Math.trunc(editing.estimatedCostMinor / 100)) : '',
    accountId: editing?.accountId ?? '',
    documentRef: editing?.documentRef ?? '',
  });

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      editing
        ? api<Obligation>(`/renewals/${editing.id}`, { method: 'PATCH', body })
        : api<Obligation>('/renewals', { method: 'POST', body }),
    onSuccess: onSaved,
  });

  /* Choosing the kind fills in the name and the warning, because the whole
     point of the preset list is that most people are ticking a thing they have
     rather than describing one. */
  const chooseKind = (next: RenewalKind): void => {
    setKind(next);
    setForm((f) => ({
      ...f,
      title: RENEWAL_DEFAULTS[next].label,
      recurrence: RENEWAL_DEFAULTS[next].recurrence,
      reminderLeadDays: String(RENEWAL_DEFAULTS[next].leadDays),
    }));
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={editing ? 'কাগজটি বদলান' : 'নতুন কাগজ'}
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          const taka = Number(form.cost.trim() || '0');
          save.mutate({
            kind,
            title: form.title.trim(),
            recurrence: form.recurrence,
            dueDate: form.dueDate,
            reminderLeadDays: Number(form.reminderLeadDays) || 30,
            /* Integer maths on whole taka: no `* 100` on a float. */
            estimatedCostMinor: Number.isFinite(taka) ? Math.trunc(taka) * 100 : 0,
            accountId: form.accountId || null,
            documentRef: form.documentRef.trim() || undefined,
          });
        }}
      >
        <Field label="কীসের কাগজ" htmlFor="r-kind">
          <Select
            id="r-kind"
            value={kind}
            onChange={(e) => chooseKind(e.target.value as RenewalKind)}
          >
            {RENEWAL_KINDS.map((option) => (
              <option key={option} value={option}>
                {RENEWAL_DEFAULTS[option].label}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="নাম" htmlFor="r-title">
          <Input
            id="r-title"
            value={form.title}
            onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
            required
          />
        </Field>

        <Field label="পরের তারিখ" htmlFor="r-due">
          <Input
            id="r-due"
            type="date"
            value={form.dueDate}
            onChange={(e) => setForm((f) => ({ ...f, dueDate: e.target.value }))}
            required
          />
        </Field>

        <Field label="কতদিন পরপর" htmlFor="r-recur">
          <Select
            id="r-recur"
            value={form.recurrence}
            onChange={(e) =>
              setForm((f) => ({ ...f, recurrence: e.target.value as RenewalRecurrence }))
            }
          >
            {RENEWAL_RECURRENCES.map((option) => (
              <option key={option} value={option}>
                {RECURRENCE_LABELS[option]}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="কত দিন আগে মনে করাব" htmlFor="r-lead">
          <Input
            id="r-lead"
            inputMode="numeric"
            value={form.reminderLeadDays}
            onChange={(e) => setForm((f) => ({ ...f, reminderLeadDays: e.target.value }))}
          />
        </Field>

        <Field label="আনুমানিক খরচ (টাকা, ঐচ্ছিক)" htmlFor="r-cost">
          <Input
            id="r-cost"
            inputMode="numeric"
            value={form.cost}
            onChange={(e) => setForm((f) => ({ ...f, cost: e.target.value }))}
          />
        </Field>

        <Field label="কোন সম্পদের (ঐচ্ছিক)" htmlFor="r-account">
          <Select
            id="r-account"
            value={form.accountId}
            onChange={(e) => setForm((f) => ({ ...f, accountId: e.target.value }))}
          >
            <option value="">কোনোটার না</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="নম্বর — রেজিস্ট্রেশন, দাগ, লাইসেন্স (ঐচ্ছিক)" htmlFor="r-ref">
          <Input
            id="r-ref"
            value={form.documentRef}
            onChange={(e) => setForm((f) => ({ ...f, documentRef: e.target.value }))}
          />
        </Field>

        <div className="flex gap-2 pt-1">
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? 'রাখা হচ্ছে…' : 'সংরক্ষণ করুন'}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            বাতিল
          </Button>
        </div>

        {/* Last, below a rule, and only on a paper that already exists. */}
        {editing ? (
          <div className="border-rule mt-2 flex flex-col gap-2 border-t pt-3">
            {confirming ? (
              <>
                <p className="text-ink text-sm">
                  {t(
                    'renewal.deleteAsk',
                    'কাগজটি তালিকা থেকে চলে যাবে এবং এর মনে করানো বন্ধ হবে। আগে লেখা কোনো খরচ মুছবে না।',
                  )}
                </p>
                <div className="flex gap-2">
                  <Button type="button" variant="danger" disabled={deleting} onClick={onDelete}>
                    {deleting
                      ? t('renewal.deleting', 'মোছা হচ্ছে…')
                      : t('renewal.deleteYes', 'হ্যাঁ, মুছে ফেলুন')}
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => setConfirming(false)}>
                    থাক
                  </Button>
                </div>
              </>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="block"
                className="text-expense"
                onClick={() => {
                  haptic('warn');
                  setConfirming(true);
                }}
              >
                <Trash2 className="h-4 w-4" aria-hidden />
                {t('renewal.delete', 'কাগজটি মুছে ফেলুন')}
              </Button>
            )}
          </div>
        ) : null}
      </form>
    </Sheet>
  );
}
