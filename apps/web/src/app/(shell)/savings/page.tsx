'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Info, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';
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

interface Projection {
  installmentCount: number;
  depositedMinor: number;
  profitMinor: number;
  maturityMinor: number;
  formula: string;
}
interface Progress {
  paidCount: number;
  missedCount: number;
  remainingCount: number;
  paidMinor: number;
  percentComplete: number;
}
interface Instalment {
  id: string;
  dueDate: string;
  expectedMinor: number;
  status: 'DUE' | 'PAID' | 'MISSED' | 'SKIPPED';
}
interface SavingsPlan {
  id: string;
  planName: string;
  institution: string | null;
  planType: string;
  installmentMinor: number;
  principalMinor: number;
  frequency: string;
  termMonths: number;
  startDate: string;
  profitRateBps: number;
  profitCalc: string;
  status: string;
  projection: Projection;
  progress: Progress;
  installments?: Instalment[];
}

const PLAN_TYPES = [
  ['DPS', 'ডিপিএস'],
  ['FDR', 'এফডিআর'],
  ['SANCHAYPATRA', 'সঞ্চয়পত্র'],
  ['RECURRING_DEPOSIT', 'রেকারিং ডিপোজিট'],
  ['GOAL_SAVINGS', 'লক্ষ্য সঞ্চয়'],
] as const;

const FREQUENCIES = [
  ['MONTHLY', 'মাসিক'],
  ['QUARTERLY', 'ত্রৈমাসিক'],
  ['HALF_YEARLY', 'ষাণ্মাসিক'],
  ['YEARLY', 'বার্ষিক'],
] as const;

const PROFIT_CALCS = [
  ['COMPOUND_YEARLY', 'বার্ষিক চক্রবৃদ্ধি'],
  ['COMPOUND_QUARTERLY', 'ত্রৈমাসিক চক্রবৃদ্ধি'],
  ['COMPOUND_MONTHLY', 'মাসিক চক্রবৃদ্ধি'],
  ['SIMPLE', 'সরল হার'],
] as const;

const STATUSES = [
  ['ACTIVE', 'চলমান'],
  ['MATURED', 'মেয়াদপূর্ণ'],
  ['CLOSED', 'বন্ধ'],
] as const;

const labelOf = (pairs: readonly (readonly [string, string])[], value: string): string =>
  pairs.find(([v]) => v === value)?.[1] ?? value;

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

/** A ring is easier to read at a glance than a bar when it sits beside a number. */
function ProgressRing({ percent }: { percent: number }) {
  const size = 44;
  const stroke = 4;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;

  return (
    <svg
      width={size}
      height={size}
      className="shrink-0"
      role="img"
      aria-label={`${percent}% সম্পন্ন`}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="var(--hishab-greenbar)"
        strokeWidth={stroke}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="var(--hishab-income)"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - percent / 100)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text
        x="50%"
        y="50%"
        textAnchor="middle"
        dominantBaseline="central"
        className="fill-ink"
        style={{ fontSize: 10 }}
      >
        {fmtNumber(String(Math.trunc(percent)))}%
      </text>
    </svg>
  );
}

export default function SavingsPage() {
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = React.useState(false);
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState<SavingsPlan | null>(null);
  const [removing, setRemoving] = React.useState<SavingsPlan | null>(null);

  const plans = useQuery({
    queryKey: ['savings'],
    queryFn: () => api<SavingsPlan[]>('/savings'),
  });
  const detail = useQuery({
    queryKey: ['savings', openId],
    queryFn: () => api<SavingsPlan>(`/savings/${openId}`),
    enabled: openId !== null,
  });

  const pay = useMutation({
    mutationFn: ({ planId, installmentId }: { planId: string; installmentId: string }) =>
      api(`/savings/${planId}/installments/${installmentId}/pay`, { method: 'POST', body: {} }),
    onSuccess: () => {
      haptic('success');
      void queryClient.invalidateQueries();
    },
  });

  /* A plan holds no money of its own — paying an instalment does not touch the
     ledger — so nothing outside ['savings'] goes stale when one changes. */
  const remove = useMutation({
    mutationFn: (planId: string) => api(`/savings/${planId}`, { method: 'DELETE' }),
    onSuccess: () => {
      haptic('success');
      void queryClient.invalidateQueries({ queryKey: ['savings'] });
      setRemoving(null);
    },
  });

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <header className="flex items-center justify-between gap-2">
        <h1 className="text-ink hidden text-xl font-semibold sm:text-2xl md:block">
          সঞ্চয় ও ডিপিএস
        </h1>
        <div className="flex items-center gap-2">
          <Link
            href="/insurance"
            className="press border-rule text-ink hover:bg-greenbar flex min-h-11 items-center gap-1.5 rounded-md border px-3 text-sm"
          >
            <ShieldCheck className="h-4 w-4" aria-hidden />
            বীমা
          </Link>
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4" aria-hidden />
            নতুন
          </Button>
        </div>
      </header>

      {plans.isLoading ? (
        <div className="rounded-card border-rule bg-surface overflow-hidden border">
          <SkeletonRows rows={3} />
        </div>
      ) : (plans.data?.length ?? 0) === 0 ? (
        <div className="rounded-card border-rule border border-dashed p-8 text-center">
          <p className="text-ink">এখনও কোনো ডিপিএস বা এফডিআর যোগ করা হয়নি।</p>
          <Button className="mt-3" onClick={() => setAddOpen(true)}>
            প্রথম সঞ্চয় যোগ করুন
          </Button>
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {(plans.data ?? []).map((plan) => (
            <li key={plan.id} className="rounded-card border-rule bg-surface border p-4">
              <button
                type="button"
                onClick={() => setOpenId(plan.id)}
                className="press flex w-full items-center gap-3 text-left"
              >
                <ProgressRing percent={plan.progress.percentComplete} />
                <div className="min-w-0 flex-1">
                  <p className="text-ink truncate text-sm font-medium">{plan.planName}</p>
                  <p className="text-ink-muted truncate text-xs">
                    {labelOf(PLAN_TYPES, plan.planType)}
                    {plan.institution ? ` · ${plan.institution}` : ''} ·{' '}
                    {fmtNumber(String(plan.profitRateBps / 100))}%
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <Money
                    minor={plan.projection.maturityMinor}
                    className="block text-sm"
                    decimals={false}
                  />
                  <span className="text-ink-muted text-[11px]">মেয়াদপূর্তিতে</span>
                </div>
              </button>

              <dl className="border-rule mt-3 grid grid-cols-3 gap-2 border-t pt-2 text-xs">
                <div>
                  <dt className="text-ink-muted">জমা হয়েছে</dt>
                  <dd>
                    <Money minor={plan.progress.paidMinor} className="block" decimals={false} />
                  </dd>
                </div>
                <div>
                  <dt className="text-ink-muted">মোট জমা হবে</dt>
                  <dd>
                    <Money
                      minor={plan.projection.depositedMinor}
                      className="block"
                      decimals={false}
                    />
                  </dd>
                </div>
                <div>
                  <dt className="text-ink-muted">মুনাফা</dt>
                  <dd>
                    <Money
                      minor={plan.projection.profitMinor}
                      className="text-income block"
                      decimals={false}
                    />
                  </dd>
                </div>
              </dl>

              {plan.progress.missedCount > 0 ? (
                <p className="text-expense mt-2 text-xs">
                  {fmtNumber(String(plan.progress.missedCount))}টি কিস্তি বাকি পড়েছে
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {/* Detail: the instalment list, and the formula behind the projection. */}
      <Sheet
        open={openId !== null}
        onOpenChange={(open) => !open && setOpenId(null)}
        title={detail.data?.planName ?? 'সঞ্চয়'}
        description={detail.data ? labelOf(PLAN_TYPES, detail.data.planType) : undefined}
      >
        {detail.data ? (
          <div className="flex flex-col gap-4">
            <div className="bg-greenbar rounded-md p-3">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-ink-muted text-xs">মেয়াদপূর্তিতে (কর কাটার আগে)</span>
                <Money
                  minor={detail.data.projection.maturityMinor}
                  className="text-lg font-semibold"
                />
              </div>
              {/* A projection nobody can check is worth nothing. */}
              <p className="text-ink-muted mt-2 flex gap-1.5 text-[11px]">
                <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                {detail.data.projection.formula}
              </p>
            </div>

            <ul className="divide-rule divide-y">
              {(detail.data.installments ?? []).map((row, i) => (
                <li key={row.id} className="flex items-center gap-2 py-2">
                  <span className="text-ink-muted w-8 shrink-0 text-xs">
                    {fmtNumber(String(i + 1))}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-ink text-sm">{row.dueDate}</p>
                  </div>
                  <Money minor={row.expectedMinor} className="shrink-0 text-sm" decimals={false} />
                  {row.status === 'PAID' ? (
                    <span className="text-income flex w-24 shrink-0 items-center justify-end gap-1 text-xs">
                      <Check className="h-3.5 w-3.5" aria-hidden />
                      জমা হয়েছে
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => pay.mutate({ planId: detail.data!.id, installmentId: row.id })}
                      className="press border-rule text-ink hover:bg-greenbar w-24 shrink-0 rounded-md border py-1.5 text-xs"
                    >
                      জমা দিলাম
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

      <PlanSheet
        open={addOpen || editing !== null}
        plan={editing}
        onOpenChange={(open) => {
          if (!open) {
            setAddOpen(false);
            setEditing(null);
          }
        }}
        onSaved={(planId) => {
          // Back to the plan the user was reading, now with the new figures.
          if (editing) setOpenId(planId);
        }}
      />

      <ConfirmSheet
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title="সঞ্চয় সরিয়ে ফেলবেন?"
        description={removing?.planName}
        body="পরিকল্পনাটি আপনার তালিকা থেকে সরে যাবে এবং অ্যাপে আর ফিরে পাওয়া যাবে না। কিস্তির যে হিসাব রাখা আছে তা খাতায় মুছে-ফেলা অবস্থায় থেকে যায় — একেবারে মুছে যায় না।"
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

interface PlanForm {
  planName: string;
  institution: string;
  planType: string;
  installment: string;
  principal: string;
  frequency: string;
  termMonths: string;
  startDate: string;
  rate: string;
  profitCalc: string;
  status: string;
}

const emptyPlanForm = (): PlanForm => ({
  planName: '',
  institution: '',
  planType: 'DPS',
  installment: '',
  principal: '',
  frequency: 'MONTHLY',
  termMonths: '60',
  startDate: toLocalDateString(new Date()),
  rate: '',
  profitCalc: 'COMPOUND_MONTHLY',
  status: 'ACTIVE',
});

const planToForm = (plan: SavingsPlan): PlanForm => ({
  planName: plan.planName,
  institution: plan.institution ?? '',
  planType: plan.planType,
  // Poisha back to taka the string way; no float touches an amount.
  installment: plan.installmentMinor ? formatMinor(plan.installmentMinor, { symbol: false }) : '',
  principal: plan.principalMinor ? formatMinor(plan.principalMinor, { symbol: false }) : '',
  frequency: plan.frequency,
  termMonths: String(plan.termMonths),
  startDate: plan.startDate,
  // Basis points are hundredths of a percent, so the same scaling applies: 825 → 8.25.
  rate: formatMinor(plan.profitRateBps, { symbol: false }),
  profitCalc: plan.profitCalc,
  status: plan.status,
});

/** The plan as the form would have produced it, for the changed-fields diff. */
const planToApi = (plan: SavingsPlan) => ({
  planName: plan.planName,
  institution: plan.institution ?? '',
  planType: plan.planType,
  installmentMinor: plan.installmentMinor,
  principalMinor: plan.principalMinor,
  frequency: plan.frequency,
  termMonths: plan.termMonths,
  startDate: plan.startDate,
  profitRateBps: plan.profitRateBps,
  profitCalc: plan.profitCalc,
});

/** Add and edit are the same form; `plan` decides which. */
function PlanSheet({
  open,
  plan,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  plan: SavingsPlan | null;
  onOpenChange: (open: boolean) => void;
  onSaved: (planId: string) => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = React.useState<PlanForm>(emptyPlanForm);
  const [error, setError] = React.useState<string | null>(null);
  const set = (key: keyof PlanForm) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  React.useEffect(() => {
    if (!open) return;
    setForm(plan ? planToForm(plan) : emptyPlanForm());
    setError(null);
  }, [open, plan]);

  /* The books' currency decides how many minor units a typed amount is worth — 100 for taka, 1 for yen, 1000 for a dinar. */
  const { currency } = useWorkspaceSettings();
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      plan
        ? api<SavingsPlan>(`/savings/${plan.id}`, { method: 'PATCH', body })
        : api<SavingsPlan>('/savings', { method: 'POST', body }),
    onSuccess: (saved) => {
      haptic('success');
      void queryClient.invalidateQueries({ queryKey: ['savings'] });
      onOpenChange(false);
      onSaved(saved.id);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'সংরক্ষণ করা যায়নি'),
  });

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={plan ? 'সঞ্চয় সম্পাদনা' : 'নতুন সঞ্চয়'}
      description={plan?.planName}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);

          const installmentMinor = toMinor(form.installment, currency);
          const principalMinor = toMinor(form.principal, currency);
          if (installmentMinor === null || principalMinor === null) {
            setError('টাকার অঙ্কটি বোঝা যায়নি।');
            return;
          }
          /* 8.25% is 825 basis points — the same two-decimal scaling the money
             parser does, and it reads Bengali digits, which Number() cannot. */
          const profitRateBps = toMinor(form.rate, currency);
          if (profitRateBps === null) {
            setError('মুনাফার হারটি বোঝা যায়নি।');
            return;
          }

          const next = {
            planName: form.planName.trim(),
            institution: form.institution.trim(),
            planType: form.planType,
            installmentMinor,
            principalMinor,
            frequency: form.frequency,
            termMonths: Number(form.termMonths || '0'),
            startDate: form.startDate,
            profitRateBps,
            profitCalc: form.profitCalc,
          };

          if (!plan) {
            save.mutate({ ...next, institution: next.institution || undefined });
            return;
          }

          /* Only what changed: the API rederives the maturity date whenever it
             is handed a start date or a term, so resending either untouched
             would overwrite a maturity typed off the passbook. */
          const body = changedOnly(
            { ...planToApi(plan), status: plan.status },
            { ...next, status: form.status },
          );
          if (Object.keys(body).length === 0) {
            onOpenChange(false);
            return;
          }
          save.mutate(body);
        }}
      >
        <Field label="নাম" htmlFor="sp-name">
          <Input
            id="sp-name"
            value={form.planName}
            onChange={set('planName')}
            required
            placeholder="যেমন: ডিবিবিএল ডিপিএস"
          />
        </Field>
        <Field label="প্রতিষ্ঠান" htmlFor="sp-inst">
          <Input
            id="sp-inst"
            value={form.institution}
            onChange={set('institution')}
            placeholder="যেমন: ডাচ্‌-বাংলা ব্যাংক"
          />
        </Field>
        <Field label="ধরন" htmlFor="sp-type">
          <Select id="sp-type" value={form.planType} onChange={set('planType')}>
            {PLAN_TYPES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="প্রতি কিস্তি (৳)" htmlFor="sp-inst-amt">
          <Input
            id="sp-inst-amt"
            value={form.installment}
            onChange={set('installment')}
            inputMode="decimal"
            className="money"
            placeholder="ডিপিএসের জন্য"
          />
        </Field>
        <Field label="এককালীন জমা (৳)" htmlFor="sp-principal">
          <Input
            id="sp-principal"
            value={form.principal}
            onChange={set('principal')}
            inputMode="decimal"
            className="money"
            placeholder="এফডিআরের জন্য"
          />
        </Field>
        <Field label="কিস্তির হার" htmlFor="sp-freq">
          <Select id="sp-freq" value={form.frequency} onChange={set('frequency')}>
            {FREQUENCIES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="মেয়াদ (মাস)" htmlFor="sp-term">
          <Input
            id="sp-term"
            type="number"
            min={1}
            max={600}
            value={form.termMonths}
            onChange={set('termMonths')}
            inputMode="numeric"
            required
          />
        </Field>
        {plan ? (
          <p className="text-ink-muted -mt-2 text-xs">
            মেয়াদ বা কিস্তির টাকা বদলালে কিস্তির তালিকা নতুন করে বানানো হয় না — তাতে কোন মাসে জমা
            দিয়েছেন সেই হিসাব মুছে যেত — তাই তালিকা নতুন মেয়াদপূর্তির সঙ্গে নাও মিলতে পারে।
          </p>
        ) : null}
        <Field label="শুরুর তারিখ" htmlFor="sp-start">
          <Input
            id="sp-start"
            type="date"
            value={form.startDate}
            onChange={set('startDate')}
            required
          />
        </Field>
        <Field label="মুনাফার হার (%)" htmlFor="sp-rate">
          <Input
            id="sp-rate"
            value={form.rate}
            onChange={set('rate')}
            inputMode="decimal"
            className="money"
            placeholder="যেমন: ৮.২৫"
            required
          />
        </Field>
        <Field label="মুনাফার হিসাব" htmlFor="sp-calc">
          <Select id="sp-calc" value={form.profitCalc} onChange={set('profitCalc')}>
            {PROFIT_CALCS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </Field>
        {plan ? (
          <Field label="অবস্থা" htmlFor="sp-status">
            <Select id="sp-status" value={form.status} onChange={set('status')}>
              {STATUSES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}

        <p className="text-ink-muted text-xs">
          হার আপনার ব্যাংক যা বলেছে সেটাই লিখুন। কর বা আবগারি শুল্ক হিসাবে ধরা হয় না — প্রক্ষেপণ কর
          কাটার আগের।
        </p>

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
