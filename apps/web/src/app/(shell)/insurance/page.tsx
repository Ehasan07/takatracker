'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Pencil, PiggyBank, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';
import { formatMinor, parseMoneyToMinor, toLocalDateString } from '@hishab/shared';
import { Money } from '@/components/money';
import { SkeletonRows } from '@/components/skeleton';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { api, ApiError } from '@/lib/api';
import { fmtNumber } from '@/lib/format';
import { haptic } from '@/lib/haptics';
import { useWorkspaceSettings } from '@/lib/workspace-settings';

interface Premium {
  id: string;
  dueDate: string;
  amountMinor: number;
  status: 'DUE' | 'PAID' | 'MISSED' | 'SKIPPED';
}
interface Policy {
  id: string;
  insurer: string;
  policyNumberMasked: string | null;
  policyType: string | null;
  sumAssuredMinor: number;
  premiumMinor: number;
  frequency: string;
  startDate: string;
  maturityDate: string | null;
  nomineeName: string | null;
  status: string;
  nextDue?: Premium | null;
  premiums?: Premium[];
}

const FREQUENCIES = [
  ['MONTHLY', 'মাসিক'],
  ['QUARTERLY', 'ত্রৈমাসিক'],
  ['HALF_YEARLY', 'ষাণ্মাসিক'],
  ['YEARLY', 'বার্ষিক'],
] as const;

const STATUSES = [
  ['ACTIVE', 'চলমান'],
  ['LAPSED', 'তামাদি (প্রিমিয়াম বন্ধ)'],
  ['MATURED', 'মেয়াদপূর্ণ'],
  ['CANCELLED', 'বাতিল'],
] as const;

const freqLabel = (v: string): string => FREQUENCIES.find(([k]) => k === v)?.[1] ?? v;

/** Taka typed by a human into integer poisha. Null when it cannot be read. */
/* Takes the currency rather than reading it: this is a module-level helper
   and a hook cannot live here. The callers all have it. */
function toMinor(text: string, currency: string): number | null {
  try {
    return parseMoneyToMinor(text.trim() || '0', currency);
  } catch {
    return null;
  }
}

/** Only the fields the user actually touched; the rest are left alone. */
function changedOnly<T extends Record<string, string | number>>(before: T, after: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(after) as (keyof T)[]) {
    if (after[key] !== before[key]) out[key] = after[key];
  }
  return out;
}

export default function InsurancePage() {
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = React.useState(false);
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState<Policy | null>(null);
  const [removing, setRemoving] = React.useState<Policy | null>(null);

  const policies = useQuery({
    queryKey: ['insurance'],
    queryFn: () => api<Policy[]>('/insurance'),
  });
  const detail = useQuery({
    queryKey: ['insurance', openId],
    queryFn: () => api<Policy>(`/insurance/${openId}`),
    enabled: openId !== null,
  });

  const pay = useMutation({
    mutationFn: ({ policyId, premiumId }: { policyId: string; premiumId: string }) =>
      api(`/insurance/${policyId}/premiums/${premiumId}/pay`, { method: 'POST', body: {} }),
    onSuccess: () => {
      haptic('success');
      void queryClient.invalidateQueries();
    },
  });

  /* A policy holds no money of its own — marking a premium paid does not touch
     the ledger — so nothing outside ['insurance'] goes stale. */
  const remove = useMutation({
    mutationFn: (policyId: string) => api(`/insurance/${policyId}`, { method: 'DELETE' }),
    onSuccess: () => {
      haptic('success');
      void queryClient.invalidateQueries({ queryKey: ['insurance'] });
      setRemoving(null);
    },
  });

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <header className="flex items-center justify-between gap-2">
        <h1 className="text-ink hidden text-xl font-semibold sm:text-2xl md:block">বীমা</h1>
        <div className="flex items-center gap-2">
          <Link
            href="/savings"
            className="press border-rule text-ink hover:bg-greenbar flex min-h-11 items-center gap-1.5 rounded-md border px-3 text-sm"
          >
            <PiggyBank className="h-4 w-4" aria-hidden />
            সঞ্চয়
          </Link>
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4" aria-hidden />
            নতুন
          </Button>
        </div>
      </header>

      {policies.isLoading ? (
        <div className="rounded-card border-rule bg-surface overflow-hidden border">
          <SkeletonRows rows={2} />
        </div>
      ) : (policies.data?.length ?? 0) === 0 ? (
        <div className="rounded-card border-rule border border-dashed p-8 text-center">
          <p className="text-ink">এখনও কোনো বীমা পলিসি যোগ করা হয়নি।</p>
          <Button className="mt-3" onClick={() => setAddOpen(true)}>
            প্রথম পলিসি যোগ করুন
          </Button>
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {(policies.data ?? []).map((policy) => (
            <li key={policy.id} className="rounded-card border-rule bg-surface border p-4">
              <button
                type="button"
                onClick={() => setOpenId(policy.id)}
                className="press flex w-full items-start gap-3 text-left"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-ink truncate text-sm font-medium">
                    {policy.insurer}
                    {policy.policyNumberMasked ? ` ${policy.policyNumberMasked}` : ''}
                  </p>
                  <p className="text-ink-muted truncate text-xs">
                    {policy.policyType ?? 'পলিসি'} · {freqLabel(policy.frequency)} প্রিমিয়াম
                    {policy.nomineeName ? ` · নমিনি ${policy.nomineeName}` : ''}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <Money
                    minor={policy.sumAssuredMinor}
                    className="block text-sm"
                    decimals={false}
                  />
                  <span className="text-ink-muted text-[11px]">বীমার অঙ্ক</span>
                </div>
              </button>

              <div className="border-rule mt-3 flex items-center justify-between gap-2 border-t pt-2 text-xs">
                <span className="text-ink-muted">পরের প্রিমিয়াম</span>
                {policy.nextDue ? (
                  <span className="flex items-center gap-2">
                    <span className="text-ink">{policy.nextDue.dueDate}</span>
                    <Money minor={policy.nextDue.amountMinor} decimals={false} />
                  </span>
                ) : (
                  <span className="text-income">সব পরিশোধ হয়েছে</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <Sheet
        open={openId !== null}
        onOpenChange={(open) => !open && setOpenId(null)}
        title={detail.data?.insurer ?? 'পলিসি'}
        description={detail.data?.policyType ?? undefined}
      >
        {detail.data ? (
          <div className="flex flex-col gap-4">
            <dl className="bg-greenbar grid grid-cols-2 gap-2 rounded-md p-3 text-xs">
              <div>
                <dt className="text-ink-muted">বীমার অঙ্ক</dt>
                <dd>
                  <Money minor={detail.data.sumAssuredMinor} className="block" decimals={false} />
                </dd>
              </div>
              <div>
                <dt className="text-ink-muted">প্রিমিয়াম</dt>
                <dd>
                  <Money minor={detail.data.premiumMinor} className="block" decimals={false} />
                </dd>
              </div>
            </dl>

            {/* The premium calendar: what is due, and what has been paid. */}
            <ul className="divide-rule divide-y">
              {(detail.data.premiums ?? []).map((row, i) => (
                <li key={row.id} className="flex items-center gap-2 py-2">
                  <span className="text-ink-muted w-8 shrink-0 text-xs">
                    {fmtNumber(String(i + 1))}
                  </span>
                  <p className="text-ink min-w-0 flex-1 text-sm">{row.dueDate}</p>
                  <Money minor={row.amountMinor} className="shrink-0 text-sm" decimals={false} />
                  {row.status === 'PAID' ? (
                    <span className="text-income flex w-24 shrink-0 items-center justify-end gap-1 text-xs">
                      <Check className="h-3.5 w-3.5" aria-hidden />
                      পরিশোধিত
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => pay.mutate({ policyId: detail.data!.id, premiumId: row.id })}
                      className="press border-rule text-ink hover:bg-greenbar w-24 shrink-0 rounded-md border py-1.5 text-xs"
                    >
                      দিলাম
                    </button>
                  )}
                </li>
              ))}
            </ul>

            {/* One sheet at a time: the detail closes as the editor opens. */}
            <div className="border-rule flex gap-2 border-t pt-3">
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => {
                  setEditing(detail.data!);
                  setOpenId(null);
                }}
              >
                <Pencil className="h-4 w-4" aria-hidden />
                সম্পাদনা
              </Button>
              <Button
                variant="outline"
                className="text-expense flex-1"
                onClick={() => {
                  remove.reset();
                  setRemoving(detail.data!);
                  setOpenId(null);
                }}
              >
                <Trash2 className="h-4 w-4" aria-hidden />
                সরিয়ে ফেলুন
              </Button>
            </div>
          </div>
        ) : null}
      </Sheet>

      <PolicySheet
        open={addOpen || editing !== null}
        policy={editing}
        onOpenChange={(open) => {
          if (!open) {
            setAddOpen(false);
            setEditing(null);
          }
        }}
        onSaved={(policyId) => {
          // Back to the policy the user was reading, now with the new figures.
          if (editing) setOpenId(policyId);
        }}
      />

      <ConfirmSheet
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title="পলিসি সরিয়ে ফেলবেন?"
        description={removing?.insurer}
        body="পলিসিটি আপনার তালিকা থেকে সরে যাবে এবং অ্যাপে আর ফিরে পাওয়া যাবে না। প্রিমিয়াম পরিশোধের যে হিসাব রাখা আছে তা খাতায় মুছে-ফেলা অবস্থায় থেকে যায় — একেবারে মুছে যায় না।"
        confirmLabel="সরিয়ে ফেলুন"
        pending={remove.isPending}
        error={remove.error ? remove.error.message : null}
        onConfirm={() => {
          if (removing) remove.mutate(removing.id);
        }}
      />
    </div>
  );
}

/**
 * Anything that removes something asks first — as a sheet, not a modal. The
 * loan screens have the same component; written out again here rather than
 * imported across feature folders.
 */
function ConfirmSheet({
  open,
  onOpenChange,
  title,
  description,
  body,
  confirmLabel,
  onConfirm,
  pending = false,
  error = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  pending?: boolean;
  error?: string | null;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={title} description={description}>
      <div className="flex flex-col gap-4">
        <p className="text-ink text-sm">{body}</p>
        {error ? (
          <p role="alert" className="bg-expense/10 text-expense rounded-md px-3 py-2 text-sm">
            {error}
          </p>
        ) : null}
        <Button
          variant="danger"
          size="block"
          disabled={pending}
          onClick={() => {
            haptic('warn');
            onConfirm();
          }}
        >
          {confirmLabel}
        </Button>
        <Button variant="outline" size="block" onClick={() => onOpenChange(false)}>
          থাক
        </Button>
      </div>
    </Sheet>
  );
}

interface PolicyForm {
  insurer: string;
  policyNumberMasked: string;
  policyType: string;
  sumAssured: string;
  premium: string;
  frequency: string;
  startDate: string;
  /** New policies are typed as a term; an existing one carries the real date. */
  termMonths: string;
  maturityDate: string;
  nomineeName: string;
  status: string;
}

const emptyPolicyForm = (): PolicyForm => ({
  insurer: '',
  policyNumberMasked: '',
  policyType: '',
  sumAssured: '',
  premium: '',
  frequency: 'YEARLY',
  startDate: toLocalDateString(new Date()),
  termMonths: '240',
  maturityDate: '',
  nomineeName: '',
  status: 'ACTIVE',
});

const policyToForm = (policy: Policy): PolicyForm => ({
  insurer: policy.insurer,
  policyNumberMasked: policy.policyNumberMasked ?? '',
  policyType: policy.policyType ?? '',
  // Poisha back to taka the string way; no float touches an amount.
  sumAssured: formatMinor(policy.sumAssuredMinor, { symbol: false }),
  premium: formatMinor(policy.premiumMinor, { symbol: false }),
  frequency: policy.frequency,
  startDate: policy.startDate,
  termMonths: '',
  maturityDate: policy.maturityDate ?? '',
  nomineeName: policy.nomineeName ?? '',
  status: policy.status,
});

/** Add and edit are the same form; `policy` decides which. */
function PolicySheet({
  open,
  policy,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  policy: Policy | null;
  onOpenChange: (open: boolean) => void;
  onSaved: (policyId: string) => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = React.useState<PolicyForm>(emptyPolicyForm);
  const [error, setError] = React.useState<string | null>(null);
  const set = (key: keyof PolicyForm) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  React.useEffect(() => {
    if (!open) return;
    setForm(policy ? policyToForm(policy) : emptyPolicyForm());
    setError(null);
  }, [open, policy]);

  /* The books' currency decides how many minor units a typed amount is worth — 100 for taka, 1 for yen, 1000 for a dinar. */
  const { currency } = useWorkspaceSettings();
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      policy
        ? api<Policy>(`/insurance/${policy.id}`, { method: 'PATCH', body })
        : api<Policy>('/insurance', { method: 'POST', body }),
    onSuccess: (saved) => {
      haptic('success');
      void queryClient.invalidateQueries({ queryKey: ['insurance'] });
      onOpenChange(false);
      onSaved(saved.id);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'সংরক্ষণ করা যায়নি'),
  });

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={policy ? 'পলিসি সম্পাদনা' : 'নতুন বীমা পলিসি'}
      description={policy?.insurer}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);

          const sumAssuredMinor = toMinor(form.sumAssured, currency);
          const premiumMinor = toMinor(form.premium, currency);
          if (sumAssuredMinor === null || premiumMinor === null) {
            setError('টাকার অঙ্কটি বোঝা যায়নি।');
            return;
          }

          if (!policy) {
            save.mutate({
              insurer: form.insurer.trim(),
              // Only the last digits, never the whole policy number (spec §9).
              policyNumberMasked: form.policyNumberMasked.trim() || undefined,
              policyType: form.policyType.trim() || undefined,
              sumAssuredMinor,
              premiumMinor,
              frequency: form.frequency,
              startDate: form.startDate,
              termMonths: Number(form.termMonths || '0'),
              nomineeName: form.nomineeName.trim() || undefined,
            });
            return;
          }

          /* The term is not stored — start and maturity are — so the edit form
             moves the date itself. An emptied field means "leave it alone"
             rather than "clear it": the API has no way to unset a maturity. */
          const existingMaturity = policy.maturityDate ?? '';
          const body = changedOnly(
            {
              insurer: policy.insurer,
              policyNumberMasked: policy.policyNumberMasked ?? '',
              policyType: policy.policyType ?? '',
              sumAssuredMinor: policy.sumAssuredMinor,
              premiumMinor: policy.premiumMinor,
              frequency: policy.frequency,
              startDate: policy.startDate,
              maturityDate: existingMaturity,
              nomineeName: policy.nomineeName ?? '',
              status: policy.status,
            },
            {
              insurer: form.insurer.trim(),
              policyNumberMasked: form.policyNumberMasked.trim(),
              policyType: form.policyType.trim(),
              sumAssuredMinor,
              premiumMinor,
              frequency: form.frequency,
              startDate: form.startDate,
              maturityDate: form.maturityDate || existingMaturity,
              nomineeName: form.nomineeName.trim(),
              status: form.status,
            },
          );
          if (Object.keys(body).length === 0) {
            onOpenChange(false);
            return;
          }
          save.mutate(body);
        }}
      >
        <Field label="বীমা প্রতিষ্ঠান" htmlFor="ip-insurer">
          <Input
            id="ip-insurer"
            value={form.insurer}
            onChange={set('insurer')}
            required
            placeholder="যেমন: মেটলাইফ"
          />
        </Field>
        <Field label="পলিসি নম্বর (শেষ কয়েক অঙ্ক)" htmlFor="ip-number">
          <Input
            id="ip-number"
            value={form.policyNumberMasked}
            onChange={set('policyNumberMasked')}
            placeholder="****৪৫২১"
          />
        </Field>
        <Field label="পলিসির ধরন" htmlFor="ip-type">
          <Input
            id="ip-type"
            value={form.policyType}
            onChange={set('policyType')}
            placeholder="যেমন: এনডাওমেন্ট"
          />
        </Field>
        <Field label="বীমার অঙ্ক (৳)" htmlFor="ip-sum">
          <Input
            id="ip-sum"
            value={form.sumAssured}
            onChange={set('sumAssured')}
            inputMode="decimal"
            className="money"
            required
          />
        </Field>
        <Field label="প্রতি প্রিমিয়াম (৳)" htmlFor="ip-premium">
          <Input
            id="ip-premium"
            value={form.premium}
            onChange={set('premium')}
            inputMode="decimal"
            className="money"
            required
          />
        </Field>
        <Field label="প্রিমিয়ামের হার" htmlFor="ip-freq">
          <Select id="ip-freq" value={form.frequency} onChange={set('frequency')}>
            {FREQUENCIES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="শুরুর তারিখ" htmlFor="ip-start">
          <Input
            id="ip-start"
            type="date"
            value={form.startDate}
            onChange={set('startDate')}
            required
          />
        </Field>
        {policy ? (
          <Field label="মেয়াদপূর্তির তারিখ" htmlFor="ip-maturity">
            <Input
              id="ip-maturity"
              type="date"
              value={form.maturityDate}
              onChange={set('maturityDate')}
            />
          </Field>
        ) : (
          <Field label="মেয়াদ (মাস)" htmlFor="ip-term">
            <Input
              id="ip-term"
              type="number"
              min={1}
              max={720}
              value={form.termMonths}
              onChange={set('termMonths')}
              inputMode="numeric"
              required
            />
          </Field>
        )}
        {policy ? (
          <p className="text-ink-muted -mt-2 text-xs">
            প্রিমিয়াম, কিস্তির হার বা মেয়াদপূর্তির তারিখ বদলালে প্রিমিয়ামের তালিকা নতুন করে
            বানানো হয় না — তাতে কোন কিস্তি পরিশোধ হয়েছে সেই হিসাব মুছে যেত — তাই পুরনো তালিকা ও
            তার অঙ্ক আগের মতোই থাকবে।
          </p>
        ) : null}
        <Field label="নমিনি" htmlFor="ip-nominee">
          <Input id="ip-nominee" value={form.nomineeName} onChange={set('nomineeName')} />
        </Field>
        {policy ? (
          <Field label="অবস্থা" htmlFor="ip-status">
            <Select id="ip-status" value={form.status} onChange={set('status')}>
              {STATUSES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}

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
