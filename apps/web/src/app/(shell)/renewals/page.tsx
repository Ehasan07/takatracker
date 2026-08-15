'use client';

import {
  RENEWAL_DEFAULTS,
  RENEWAL_KINDS,
  RENEWAL_RECURRENCES,
  type RenewalKind,
  type RenewalRecurrence,
} from '@hishab/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, Plus, Trash2 } from 'lucide-react';
import * as React from 'react';
import { Money } from '@/components/money';
import { SkeletonRows } from '@/components/skeleton';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { api, endpoints } from '@/lib/api';
import { haptic } from '@/lib/haptics';

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

  const rows = useQuery({
    queryKey: ['renewals'],
    queryFn: () => api<Obligation[]>('/renewals'),
  });
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: endpoints.accounts });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['renewals'] });
  };

  const complete = useMutation({
    mutationFn: (id: string) =>
      api<Obligation>(`/renewals/${id}/complete`, { method: 'POST', body: {} }),
    onSuccess: () => {
      haptic('success');
      refresh();
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api<{ id: string }>(`/renewals/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      haptic('tap');
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
                onClick={() => setEditing(row)}
                className="press min-w-0 flex-1 text-left"
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

              {row.status === 'DONE' ? null : (
                <div className="flex shrink-0 gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={complete.isPending}
                    onClick={() => complete.mutate(row.id)}
                  >
                    <Check className="h-4 w-4" aria-hidden />
                    হয়ে গেছে
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`${row.title} — মুছুন`}
                    onClick={() => remove.mutate(row.id)}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* Marking one done rolls the date forward; it does not book the fee. A
          person clearing five years of back khajna does not want five
          transactions dated today. */}
      <p className="text-ink-muted text-xs">
        "হয়ে গেছে" চাপলে পরের তারিখ বসে যাবে — টাকার খরচটা আলাদা করে খাতায় লিখবেন।
      </p>

      <ObligationSheet
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
      />
    </div>
  );
}

function ObligationSheet({
  open,
  editing,
  accounts,
  onClose,
  onSaved,
}: {
  open: boolean;
  editing: Obligation | null;
  accounts: { id: string; name: string }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [kind, setKind] = React.useState<RenewalKind>(editing?.kind ?? 'FITNESS');
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
      </form>
    </Sheet>
  );
}
