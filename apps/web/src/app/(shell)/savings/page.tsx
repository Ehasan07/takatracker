'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Info, Plus, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';
import { parseMoneyToMinor, toBengaliDigits, toLocalDateString } from '@hishab/shared';
import { Money } from '@/components/money';
import { SkeletonRows } from '@/components/skeleton';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { api, ApiError } from '@/lib/api';
import { haptic } from '@/lib/haptics';

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

const labelOf = (pairs: readonly (readonly [string, string])[], value: string): string =>
  pairs.find(([v]) => v === value)?.[1] ?? value;

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
        {toBengaliDigits(String(Math.trunc(percent)))}%
      </text>
    </svg>
  );
}

export default function SavingsPage() {
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = React.useState(false);
  const [openId, setOpenId] = React.useState<string | null>(null);

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

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <header className="flex items-center justify-between gap-2">
        <h1 className="text-ink hidden text-xl font-semibold sm:text-2xl md:block">
          সঞ্চয় ও বীমা
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
                    {toBengaliDigits(String(plan.profitRateBps / 100))}%
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
                  {toBengaliDigits(String(plan.progress.missedCount))}টি কিস্তি বাকি পড়েছে
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
                    {toBengaliDigits(String(i + 1))}
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
          </div>
        ) : null}
      </Sheet>

      <AddPlanSheet open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}

function AddPlanSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = React.useState({
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
  });
  const [error, setError] = React.useState<string | null>(null);
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const save = useMutation({
    mutationFn: () =>
      api('/savings', {
        method: 'POST',
        body: {
          planName: form.planName,
          institution: form.institution || undefined,
          planType: form.planType,
          installmentMinor: form.installment ? parseMoneyToMinor(form.installment) : 0,
          principalMinor: form.principal ? parseMoneyToMinor(form.principal) : 0,
          frequency: form.frequency,
          termMonths: Number(form.termMonths),
          startDate: form.startDate,
          // The user types the advertised rate; we never infer it.
          profitRateBps: Math.trunc(Number(form.rate || '0') * 100),
          profitCalc: form.profitCalc,
        },
      }),
    onSuccess: () => {
      haptic('success');
      void queryClient.invalidateQueries();
      onOpenChange(false);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'সংরক্ষণ করা যায়নি'),
  });

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="নতুন সঞ্চয়">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          save.mutate();
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
