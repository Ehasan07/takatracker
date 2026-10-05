'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Link2, Pencil, PiggyBank, Plus, Trash2 } from '@/components/icons';
import Link from 'next/link';
import * as React from 'react';
import { formatMinor, parseMoneyToMinor, toLocalDateString } from '@hishab/shared';
import { Money } from '@/components/money';
import { SkeletonRows } from '@/components/skeleton';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { ShareStatementSheet } from '@/components/share-statement-sheet';
import { Sheet } from '@/components/ui/sheet';
import { api, ApiError } from '@/lib/api';
import { fmtNumber } from '@/lib/format';
import { haptic } from '@/lib/haptics';
import { t } from '@/lib/t';
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
  /* What the insurer says the policy is worth, transcribed off their statement
     and dated by `valuedOn`. Nothing here is in the ledger. */
  cashValueMinor: number;
  surrenderValueMinor: number;
  policyLoanMinor: number;
  aplMinor: number;
  loanLimitMinor: number;
  valuedOn: string | null;
  netSurrenderMinor: number;
  status: string;
  nextDue?: Premium | null;
  premiums?: Premium[];
}

const FREQUENCIES = [
  ['MONTHLY', t('freq.monthly', 'মাসিক')],
  ['QUARTERLY', t('freq.quarterly', 'ত্রৈমাসিক')],
  ['HALF_YEARLY', t('freq.halfYearly', 'ষাণ্মাসিক')],
  ['YEARLY', t('freq.yearly', 'বার্ষিক')],
] as const;

const STATUSES = [
  ['ACTIVE', 'চলমান'],
  ['LAPSED', t('insurance.status.lapsed', 'তামাদি (প্রিমিয়াম বন্ধ)')],
  ['MATURED', 'মেয়াদপূর্ণ'],
  ['CANCELLED', t('insurance.status.cancelled', 'বাতিল')],
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
  const [sharing, setSharing] = React.useState<Policy | null>(null);

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
        <h1 className="text-ink hidden text-xl font-semibold sm:text-2xl md:block">
          {t('insurance.word', 'বীমা')}
        </h1>
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
          <p className="text-ink">{t('insurance.none', 'এখনও কোনো বীমা পলিসি যোগ করা হয়নি।')}</p>
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
                    {policy.policyType ?? t('insurance.policy', 'পলিসি')} ·{' '}
                    {freqLabel(policy.frequency)} প্রিমিয়াম
                    {policy.nomineeName ? ` · নমিনি ${policy.nomineeName}` : ''}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <Money
                    minor={policy.sumAssuredMinor}
                    className="block text-sm"
                    decimals={false}
                  />
                  <span className="text-ink-muted text-[11px]">
                    {t('insurance.sumAssured', 'বীমার অঙ্ক')}
                  </span>
                </div>
              </button>

              <div className="border-rule mt-3 flex items-center justify-between gap-2 border-t pt-2 text-xs">
                <span className="text-ink-muted">
                  {t('insurance.nextPremium', 'পরের প্রিমিয়াম')}
                </span>
                {policy.nextDue ? (
                  <span className="flex items-center gap-2">
                    <span className="text-ink">{policy.nextDue.dueDate}</span>
                    <Money minor={policy.nextDue.amountMinor} decimals={false} />
                  </span>
                ) : (
                  <span className="text-income">{t('insurance.allPaid', 'সব পরিশোধ হয়েছে')}</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <Sheet
        open={openId !== null}
        onOpenChange={(open) => !open && setOpenId(null)}
        title={detail.data?.insurer ?? t('insurance.policy', 'পলিসি')}
        description={detail.data?.policyType ?? undefined}
      >
        {detail.data ? (
          <div className="flex flex-col gap-4">
            <dl className="bg-greenbar grid grid-cols-2 gap-2 rounded-md p-3 text-xs">
              <div>
                <dt className="text-ink-muted">{t('insurance.sumAssured', 'বীমার অঙ্ক')}</dt>
                <dd>
                  <Money minor={detail.data.sumAssuredMinor} className="block" decimals={false} />
                </dd>
              </div>
              <div>
                <dt className="text-ink-muted">{t('insurance.premium', 'প্রিমিয়াম')}</dt>
                <dd>
                  <Money minor={detail.data.premiumMinor} className="block" decimals={false} />
                </dd>
              </div>
            </dl>

            {/* What the insurer says the policy is worth. Shown only once a
                valuation has been typed, and always under its own date: these
                figures go stale — a cash value grows every year and a loan
                grows every month it is not repaid — and an undated one would
                be read as today's. Nothing here is in the ledger, which the
                last line says out loud rather than leaving to be discovered. */}
            {detail.data.valuedOn ? (
              <section className="border-rule rounded-md border p-3">
                <h3 className="text-ink-muted mb-2 text-xs">
                  {t('insurance.valuation', 'বীমা প্রতিষ্ঠানের হিসাব')}
                  {' · '}
                  {detail.data.valuedOn}
                </h3>
                <dl className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <dt className="text-ink-muted">
                      {t('insurance.cashValueShort', 'ক্যাশ ভ্যালু')}
                    </dt>
                    <dd>
                      <Money minor={detail.data.cashValueMinor} className="block" />
                    </dd>
                  </div>
                  <div>
                    <dt className="text-ink-muted">
                      {t('insurance.surrenderShort', 'সারেন্ডার মূল্য')}
                    </dt>
                    <dd>
                      <Money minor={detail.data.surrenderValueMinor} className="block" />
                    </dd>
                  </div>
                  <div>
                    <dt className="text-ink-muted">
                      {t('insurance.policyLoanShort', 'পলিসির ঋণ')}
                    </dt>
                    <dd>
                      <Money minor={detail.data.policyLoanMinor} className="text-expense block" />
                    </dd>
                  </div>
                  <div>
                    <dt className="text-ink-muted">{t('insurance.aplShort', 'APL ঋণ')}</dt>
                    <dd>
                      <Money minor={detail.data.aplMinor} className="text-expense block" />
                    </dd>
                  </div>
                  <div>
                    <dt className="text-ink-muted">
                      {t('insurance.loanLimitShort', 'আরও ঋণ নেওয়া যাবে')}
                    </dt>
                    <dd>
                      <Money minor={detail.data.loanLimitMinor} className="block" />
                    </dd>
                  </div>
                  <div>
                    <dt className="text-ink-muted">
                      {t('insurance.netSurrender', 'এখন ছেড়ে দিলে হাতে আসবে')}
                    </dt>
                    <dd>
                      <Money minor={detail.data.netSurrenderMinor} className="block font-medium" />
                    </dd>
                  </div>
                </dl>
                <p className="text-ink-muted mt-2 text-[11px]">
                  {t(
                    'insurance.valuationNote',
                    'অঙ্কগুলো বীমা প্রতিষ্ঠানের কাগজ থেকে লেখা — খাতায় বসে না, তাই সম্পদ-দেনার হিসাবেও ধরা পড়ে না।',
                  )}
                </p>
              </section>
            ) : null}

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
            <div className="border-rule flex flex-wrap gap-2 border-t pt-3">
              {/* Insurers ask for a premium history, which is precisely what the
                  public statement renders. The API has served INSURANCE since
                  statement sharing shipped; only the button was missing. */}
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => {
                  setSharing(detail.data!);
                  setOpenId(null);
                }}
              >
                <Link2 className="h-4 w-4" aria-hidden />
                {t('share.short', 'শেয়ার')}
              </Button>
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

      {sharing ? (
        <ShareStatementSheet
          open
          onOpenChange={(next) => !next && setSharing(null)}
          kind="INSURANCE"
          subjectId={sharing.id}
          subjectName={sharing.insurer}
        />
      ) : null}

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
  cashValue: string;
  surrenderValue: string;
  policyLoan: string;
  apl: string;
  loanLimit: string;
  valuedOn: string;
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
  cashValue: '',
  surrenderValue: '',
  policyLoan: '',
  apl: '',
  loanLimit: '',
  valuedOn: '',
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
  /* Blank rather than "0.00" when nothing was ever typed: an untouched policy
     should look untouched, and a zero the user did not write invites them to
     leave it there. */
  cashValue: policy.valuedOn ? formatMinor(policy.cashValueMinor, { symbol: false }) : '',
  surrenderValue: policy.valuedOn ? formatMinor(policy.surrenderValueMinor, { symbol: false }) : '',
  policyLoan: policy.valuedOn ? formatMinor(policy.policyLoanMinor, { symbol: false }) : '',
  apl: policy.valuedOn ? formatMinor(policy.aplMinor, { symbol: false }) : '',
  loanLimit: policy.valuedOn ? formatMinor(policy.loanLimitMinor, { symbol: false }) : '',
  valuedOn: policy.valuedOn ?? '',
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
      title={policy ? t('insurance.edit', 'পলিসি সম্পাদনা') : t('insurance.new', 'নতুন বীমা পলিসি')}
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

          /* The insurer's valuation. Every one of the five reads as zero when
             the box is empty, which is what an untyped figure means here — the
             date beside them is what says whether a valuation exists at all. */
          const valuation = {
            cashValueMinor: toMinor(form.cashValue, currency),
            surrenderValueMinor: toMinor(form.surrenderValue, currency),
            policyLoanMinor: toMinor(form.policyLoan, currency),
            aplMinor: toMinor(form.apl, currency),
            loanLimitMinor: toMinor(form.loanLimit, currency),
          };
          if (Object.values(valuation).some((v) => v === null)) {
            setError('বীমা প্রতিষ্ঠানের হিসাবের কোনো একটি অঙ্ক বোঝা যায়নি।');
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
              ...(form.valuedOn ? { ...valuation, valuedOn: form.valuedOn } : {}),
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
              cashValueMinor: policy.cashValueMinor,
              surrenderValueMinor: policy.surrenderValueMinor,
              policyLoanMinor: policy.policyLoanMinor,
              aplMinor: policy.aplMinor,
              loanLimitMinor: policy.loanLimitMinor,
              valuedOn: policy.valuedOn ?? '',
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
              cashValueMinor: valuation.cashValueMinor as number,
              surrenderValueMinor: valuation.surrenderValueMinor as number,
              policyLoanMinor: valuation.policyLoanMinor as number,
              aplMinor: valuation.aplMinor as number,
              loanLimitMinor: valuation.loanLimitMinor as number,
              valuedOn: form.valuedOn,
              status: form.status,
            },
          );
          if (Object.keys(body).length === 0) {
            onOpenChange(false);
            return;
          }
          /* An emptied date means "there is no valuation any more", and the API
             spells that `null`; the empty string this form holds is neither a
             date nor null and would be refused. Every other field on this body
             treats blank as a value, so this is the one that needs saying. */
          if (body.valuedOn === '') body.valuedOn = null as unknown as string;
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

        {/* The insurer's own valuation, and last on purpose: a term policy has
            none at all, and asking for a cash value before the premium would
            suggest every policy ought to have one. The date leads the group
            because it is the field that makes the rest mean anything — without
            it a cash value read two years ago still reads as today's. */}
        <fieldset className="border-rule flex flex-col gap-4 rounded-md border p-3">
          <legend className="text-ink-muted px-1 text-xs">
            {t('insurance.valuation', 'বীমা প্রতিষ্ঠানের হিসাব')}
          </legend>
          <p className="text-ink-muted text-xs">
            {t(
              'insurance.valuationHint',
              'পলিসির কাগজ বা অ্যাপে যা লেখা আছে, হুবহু বসান। এগুলো শুধু দেখানোর জন্য — খাতায় বা সম্পদ-দেনার হিসাবে কিছু বসে না। নেট ওয়ার্থে ধরতে চাইলে ক্যাশ ভ্যালুর জন্য একটি সম্পদ হিসাব আর ঋণের জন্য একটি দেনার হিসাব খুলুন।',
            )}
          </p>
          <Field label={t('insurance.valuedOn', 'কোন তারিখের হিসাব')} htmlFor="ip-valued">
            <Input id="ip-valued" type="date" value={form.valuedOn} onChange={set('valuedOn')} />
          </Field>
          <Field label={t('insurance.cashValue', 'ক্যাশ ভ্যালু (৳)')} htmlFor="ip-cash">
            <Input
              id="ip-cash"
              inputMode="decimal"
              value={form.cashValue}
              onChange={set('cashValue')}
              placeholder="০.০০"
            />
          </Field>
          <Field label={t('insurance.surrenderValue', 'সারেন্ডার মূল্য (৳)')} htmlFor="ip-surr">
            <Input
              id="ip-surr"
              inputMode="decimal"
              value={form.surrenderValue}
              onChange={set('surrenderValue')}
              placeholder="০.০০"
            />
          </Field>
          <Field label={t('insurance.policyLoan', 'পলিসির বিপরীতে ঋণ (৳)')} htmlFor="ip-loan">
            <Input
              id="ip-loan"
              inputMode="decimal"
              value={form.policyLoan}
              onChange={set('policyLoan')}
              placeholder="০.০০"
            />
          </Field>
          <Field
            label={t('insurance.apl', 'স্বয়ংক্রিয় প্রিমিয়াম ঋণ — APL (৳)')}
            htmlFor="ip-apl"
          >
            <Input
              id="ip-apl"
              inputMode="decimal"
              value={form.apl}
              onChange={set('apl')}
              placeholder="০.০০"
            />
          </Field>
          <Field label={t('insurance.loanLimit', 'আরও ঋণ নেওয়া যাবে (৳)')} htmlFor="ip-limit">
            <Input
              id="ip-limit"
              inputMode="decimal"
              value={form.loanLimit}
              onChange={set('loanLimit')}
              placeholder="০.০০"
            />
          </Field>
        </fieldset>
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
