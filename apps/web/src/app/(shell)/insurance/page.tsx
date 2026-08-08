'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, PiggyBank, Plus } from 'lucide-react';
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

const freqLabel = (v: string): string => FREQUENCIES.find(([k]) => k === v)?.[1] ?? v;

export default function InsurancePage() {
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = React.useState(false);
  const [openId, setOpenId] = React.useState<string | null>(null);

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
                    {toBengaliDigits(String(i + 1))}
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
          </div>
        ) : null}
      </Sheet>

      <AddPolicySheet open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}

function AddPolicySheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = React.useState({
    insurer: '',
    policyNumberMasked: '',
    policyType: '',
    sumAssured: '',
    premium: '',
    frequency: 'YEARLY',
    startDate: toLocalDateString(new Date()),
    termMonths: '240',
    nomineeName: '',
  });
  const [error, setError] = React.useState<string | null>(null);
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const save = useMutation({
    mutationFn: () =>
      api('/insurance', {
        method: 'POST',
        body: {
          insurer: form.insurer,
          // Only the last digits, never the whole policy number (spec §9).
          policyNumberMasked: form.policyNumberMasked || undefined,
          policyType: form.policyType || undefined,
          sumAssuredMinor: parseMoneyToMinor(form.sumAssured || '0'),
          premiumMinor: parseMoneyToMinor(form.premium || '0'),
          frequency: form.frequency,
          startDate: form.startDate,
          termMonths: Number(form.termMonths),
          nomineeName: form.nomineeName || undefined,
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
    <Sheet open={open} onOpenChange={onOpenChange} title="নতুন বীমা পলিসি">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          save.mutate();
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
        <Field label="নমিনি" htmlFor="ip-nominee">
          <Input id="ip-nominee" value={form.nomineeName} onChange={set('nomineeName')} />
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
