'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { parseMoneyToMinor, toAsciiDigits } from '@hishab/shared';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { Money } from '@/components/money';
import { Field, Input, Select } from '@/components/ui/field';
import { ApiError } from '@/lib/api';
import { haptic } from '@/lib/haptics';
import { bnNum } from '../labels';
import { ActionSheet, Segmented } from '../parts';
import { isNotHere } from '../queries';
import { invalidatePlatformCaches } from '../features/queries';
import {
  intervalLabel,
  INTERVAL_OPTIONS,
  NOT_PRICED_MEANS,
  OFF_SALE,
  PRICING_IS_NOT_BILLING,
  PRIVATE_MEANS,
  VISIBILITY_LIVES_ELSEWHERE,
  VISIBILITY_OPTIONS,
} from './labels';
import { createPlan, limitBodyOf, updatePlan, type PlanMetaInput } from './queries';
import { limitMapOf, type AdminPlan } from './types';

/**
 * Create a package, or change what one costs and who can see it.
 *
 * The limits are not here. They are a separate endpoint, a separate save and a
 * separate confirmation on the detail screen, because they are the dangerous
 * half: a price is a number nobody is enforced against yet, a ceiling is
 * something forty tenants can be pushed over. Mixing them into one form would
 * mean one confirmation covering both, and the honest summary for that is too
 * long for anybody to read.
 *
 * `code` is immutable and is not sent by `updatePlan` even though it is on
 * screen. Workspaces are joined to their package by it.
 *
 * Neither is visibility, on the edit side. The API stores one flag and reports
 * it twice — `retired` is `!isPublic` — so a package taken off sale from a
 * dropdown in here would be a retirement performed without the word being used.
 * Creating a package still chooses, because a bespoke tier that was never meant
 * for the pricing page has to be able to start life off it.
 */
/* The server's own rules, mirrored exactly rather than approximated: a code is
 * uppercased, must start with a letter and carries no hyphens, and sort order
 * stops at ten thousand. A client that allowed more would turn a typo into a
 * 400 with a Bengali message about a regular expression. */
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,59}$/;
const MAX_SORT_ORDER = 10_000;
/** One hundred million taka, in poisha. The API's ceiling, not a design choice. */
const MAX_PRICE_MINOR = 1_000_000_000_000;

/** Taka as typed, in poisha. Never `Number(x) * 100` — see `@hishab/shared`. */
function parsePrice(typed: string): number | null {
  const text = typed.trim();
  if (text === '') return null;
  try {
    /* The catalogue is priced in one currency for everybody — deliberately not
       the operator's own workspace currency, which has nothing to do with what
       the product costs. */
    const minor = parseMoneyToMinor(text);
    return minor >= 0 ? minor : null;
  } catch {
    // MoneyParseError, and anything else a malformed string can provoke. The
    // form says "লিখুন একটি সংখ্যা" rather than showing a parser's message.
    return null;
  }
}

/** Poisha back into an editable taka string, without float arithmetic. */
function priceInputOf(priceMinor: number): string {
  if (priceMinor === 0) return '0';
  const whole = Math.trunc(priceMinor / 100);
  const paisa = Math.abs(priceMinor % 100);
  return paisa === 0 ? String(whole) : `${whole}.${String(paisa).padStart(2, '0')}`;
}

export function PlanFormSheet({
  mode,
  plan,
  plans,
  open,
  onOpenChange,
  onGone,
}: {
  mode: 'create' | 'edit';
  plan: AdminPlan | null;
  /** Every package, for the code-collision check and the "start from" picker. */
  plans: AdminPlan[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A 404 from the write. Same statement as a 404 from any other admin call. */
  onGone: () => void;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();

  const [code, setCode] = React.useState('');
  const [name, setName] = React.useState('');
  const [price, setPrice] = React.useState('0');
  const [billingInterval, setBillingInterval] = React.useState('MONTHLY');
  const [visibility, setVisibility] = React.useState<'public' | 'private'>('public');
  const [sortOrder, setSortOrder] = React.useState('0');
  const [copyFrom, setCopyFrom] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  /* Reopened: start from what the package says now, not from whatever was left
   * in the boxes last time. A create sheet gets the next free sort order so two
   * new packages do not both land at zero and sort by code.
   *
   * Keyed on `open` alone, with the package read out of a ref. Any admin write
   * invalidates `['admin']`, so `plan` and `plans` get new identities whenever
   * anything on the platform changes — and an effect that depended on them
   * would wipe a half-typed price because somebody else suspended a tenant. */
  const latest = React.useRef({ mode, plan, plans });
  latest.current = { mode, plan, plans };

  React.useEffect(() => {
    if (!open) return;
    const { mode, plan, plans } = latest.current;
    setError(null);
    if (mode === 'edit' && plan) {
      setCode(plan.code);
      setName(plan.name);
      setPrice(priceInputOf(plan.priceMinor));
      setBillingInterval(plan.interval);
      setVisibility(plan.isPublic ? 'public' : 'private');
      setSortOrder(String(plan.sortOrder));
      setCopyFrom('');
      return;
    }
    const highest = plans.reduce((max, row) => (row.sortOrder > max ? row.sortOrder : max), 0);
    setCode('');
    setName('');
    setPrice('0');
    setBillingInterval('MONTHLY');
    setVisibility('public');
    setSortOrder(String(Math.min(MAX_SORT_ORDER, highest + 10)));
    setCopyFrom('');
  }, [open]);

  const trimmedCode = code.trim().toUpperCase();
  const codeTaken =
    mode === 'create' && plans.some((row) => row.code.toUpperCase() === trimmedCode);
  const codeValid = mode === 'edit' || (CODE_PATTERN.test(trimmedCode) && !codeTaken);

  const priceMinor = parsePrice(price);
  const priceValid = priceMinor !== null && priceMinor <= MAX_PRICE_MINOR;

  const sortDigits = toAsciiDigits(sortOrder).trim();
  const sortValid = /^\d+$/.test(sortDigits) && Number(sortDigits) <= MAX_SORT_ORDER;
  const sortNumber = sortValid ? Number(sortDigits) : 0;

  const nameValid = name.trim().length >= 1 && name.trim().length <= 120;

  const canSubmit = codeValid && nameValid && priceValid && sortValid;

  const source = plans.find((row) => row.code === copyFrom) ?? null;
  const meta: PlanMetaInput = {
    name: name.trim(),
    priceMinor: priceMinor ?? 0,
    interval: billingInterval,
    sortOrder: sortNumber,
  };
  const isPublic = visibility === 'public';

  const save = useMutation({
    mutationFn: () => {
      if (mode === 'edit') {
        if (!plan) throw new Error('no plan');
        return updatePlan(plan.code, meta);
      }
      return createPlan(trimmedCode, { ...meta, isPublic }, limitBodyOf(limitMapOf(source)));
    },
    onSuccess: () => {
      haptic('success');
      invalidatePlatformCaches(queryClient);
      onOpenChange(false);
      // A new package prices nothing yet, so the only useful next screen is the
      // one where its limits are set.
      if (mode === 'create') router.push(`/admin/plans/${encodeURIComponent(trimmedCode)}`);
    },
    onError: (err) => {
      if (isNotHere(err)) {
        onGone();
        return;
      }
      setError(
        err instanceof ApiError
          ? err.message
          : mode === 'create'
            ? 'প্যাকেজ তৈরি করা যায়নি'
            : 'প্যাকেজ সংরক্ষণ করা যায়নি',
      );
    },
  });

  const changed =
    mode === 'create' ||
    !plan ||
    plan.name !== meta.name ||
    plan.priceMinor !== meta.priceMinor ||
    plan.interval !== meta.interval ||
    plan.sortOrder !== meta.sortOrder;

  return (
    <ActionSheet
      open={open}
      onOpenChange={onOpenChange}
      title={mode === 'create' ? 'নতুন প্যাকেজ' : 'প্যাকেজ সম্পাদনা'}
      description={mode === 'edit' && plan ? `${plan.name} (${plan.code})` : undefined}
      canSubmit={canSubmit && changed}
      pending={save.isPending}
      error={error}
      confirmLabel={mode === 'create' ? 'প্যাকেজ তৈরি করুন' : 'পরিবর্তন সংরক্ষণ করুন'}
      onConfirm={() => {
        setError(null);
        save.mutate();
      }}
      fields={
        <>
          {mode === 'create' ? (
            <Field
              label="কোড"
              htmlFor="pl-code"
              error={
                trimmedCode !== '' && codeTaken
                  ? 'এই কোডে আগে থেকেই একটি প্যাকেজ আছে।'
                  : trimmedCode !== '' && !CODE_PATTERN.test(trimmedCode)
                    ? 'ইংরেজি বড় হাতের অক্ষর দিয়ে শুরু, তারপর অক্ষর, সংখ্যা বা আন্ডারস্কোর — ২ থেকে ৬০ অক্ষর।'
                    : undefined
              }
            >
              <Input
                id="pl-code"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="যেমন CUSTOM_2026"
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
                required
              />
              <span className="text-ink-muted text-[11px]">
                একবার তৈরি হলে কোড আর বদলানো যায় না — ওয়ার্কস্পেস এই কোড ধরেই তার প্যাকেজ চেনে।
              </span>
            </Field>
          ) : (
            <div className="bg-greenbar flex items-baseline justify-between gap-2 rounded-md p-3">
              <span className="text-ink-muted text-xs">কোড</span>
              <span className="text-ink text-sm font-medium">{plan?.code}</span>
            </div>
          )}

          <Field label="নাম" htmlFor="pl-name">
            <Input
              id="pl-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="যেমন প্রো"
              maxLength={120}
              required
            />
          </Field>

          <Field
            label="দাম (টাকায়)"
            htmlFor="pl-price"
            error={!priceValid ? 'টাকায় একটি সংখ্যা লিখুন — ৪৯৯ বা ৪৯৯.৫০।' : undefined}
          >
            <Input
              id="pl-price"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              inputMode="decimal"
              className="money text-lg"
              placeholder="০"
              required
            />
            <span className="text-ink-muted text-[11px]">
              {priceMinor === null ? (
                'শূন্য দিলে প্যাকেজটি ফ্রি।'
              ) : priceMinor === 0 ? (
                'শূন্য — প্যাকেজটি ফ্রি।'
              ) : (
                <>
                  সংরক্ষিত হবে <Money minor={priceMinor} /> হিসেবে।
                </>
              )}
            </span>
          </Field>

          <Segmented
            label="চক্র"
            value={billingInterval}
            options={INTERVAL_OPTIONS}
            onChange={setBillingInterval}
          />

          {mode === 'create' ? (
            <div className="flex flex-col gap-1.5">
              <Segmented
                label="বিক্রির তালিকায় থাকবে কি"
                value={visibility}
                options={VISIBILITY_OPTIONS}
                onChange={setVisibility}
              />
              <span className="text-ink-muted text-[11px]">
                {visibility === 'public'
                  ? 'দামের পাতায় ও "প্ল্যান বসান" তালিকায় সঙ্গে সঙ্গে দেখা যাবে।'
                  : PRIVATE_MEANS}
              </span>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              <div className="bg-greenbar flex items-baseline justify-between gap-2 rounded-md p-3">
                <span className="text-ink-muted text-xs">এখন</span>
                <span className="text-ink text-sm font-medium">
                  {plan?.isPublic ? 'বিক্রির তালিকায়' : OFF_SALE}
                </span>
              </div>
              <span className="text-ink-muted text-[11px]">{VISIBILITY_LIVES_ELSEWHERE}</span>
            </div>
          )}

          <Field
            label="ক্রম"
            htmlFor="pl-sort"
            error={!sortValid ? `০ থেকে ${bnNum(MAX_SORT_ORDER)} পর্যন্ত পূর্ণসংখ্যা।` : undefined}
          >
            <Input
              id="pl-sort"
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value)}
              inputMode="numeric"
              className="money"
              required
            />
            <span className="text-ink-muted text-[11px]">
              ছোট সংখ্যা আগে দেখায় — দামের পাতাতেও, এখানেও।
            </span>
          </Field>

          {mode === 'create' ? (
            <Field label="সীমা কোথা থেকে শুরু হবে" htmlFor="pl-copy">
              <Select id="pl-copy" value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
                <option value="">খালি — কোনো সীমা বসবে না</option>
                {plans.map((row) => (
                  <option key={row.code} value={row.code}>
                    {row.name} ({row.code}) — {bnNum(row.limits.length)}টি সীমা নকল হবে
                  </option>
                ))}
              </Select>
              <span className="text-ink-muted text-[11px]">
                নকল করলে সংখ্যাগুলো এখনই বসে যায়; পরের পর্দায় সেগুলো বদলানো যাবে।
              </span>
            </Field>
          ) : null}
        </>
      }
      summary={
        mode === 'create' ? (
          <>
            <p>
              <span className="font-medium">{trimmedCode}</span> কোডে{' '}
              <span className="font-medium">{meta.name}</span> নামে একটি প্যাকেজ তৈরি হবে,{' '}
              {meta.priceMinor === 0 ? (
                <span className="font-medium">ফ্রি</span>
              ) : (
                <>
                  <Money minor={meta.priceMinor} decimals={false} className="font-medium" />{' '}
                  {intervalLabel(meta.interval)}
                </>
              )}
              ।
            </p>
            <p className="mt-1">
              {source
                ? `${source.name}-এর ${bnNum(source.limits.length)}টি সীমা নকল হয়ে বসবে।`
                : 'কোনো ফিচারের সীমা বসবে না।'}
            </p>
            {!source ? <p className="mt-1">{NOT_PRICED_MEANS}</p> : null}
            <p className="mt-1">
              {isPublic
                ? 'প্যাকেজটি সঙ্গে সঙ্গে দামের পাতায় ও "প্ল্যান বসান" তালিকায় দেখা যাবে।'
                : PRIVATE_MEANS}
            </p>
            <p className="mt-1">কোড পরে আর বদলানো যাবে না।</p>
            {meta.priceMinor > 0 ? <p className="mt-1">{PRICING_IS_NOT_BILLING}</p> : null}
          </>
        ) : (
          <>
            <p>
              <span className="font-medium">{plan?.name}</span> ({plan?.code}) বদলাবে।{' '}
              {plan?.workspaceCount === null
                ? 'কতজন এতে আছেন তা জানা যায়নি।'
                : plan?.workspaceCount === 0
                  ? 'এতে কোনো ওয়ার্কস্পেস নেই।'
                  : `এতে ${bnNum(plan?.workspaceCount ?? 0)}টি ওয়ার্কস্পেস আছে।`}
            </p>
            <ul className="mt-1 flex flex-col gap-0.5">
              {plan && plan.name !== meta.name ? (
                <li>
                  নাম: {plan.name} → <span className="font-medium">{meta.name}</span>
                </li>
              ) : null}
              {plan && plan.priceMinor !== meta.priceMinor ? (
                <li className="flex flex-wrap items-baseline gap-1">
                  দাম:{' '}
                  {plan.priceMinor === 0 ? (
                    'ফ্রি'
                  ) : (
                    <Money minor={plan.priceMinor} decimals={false} />
                  )}{' '}
                  →{' '}
                  {meta.priceMinor === 0 ? (
                    <span className="font-medium">ফ্রি</span>
                  ) : (
                    <Money minor={meta.priceMinor} decimals={false} className="font-medium" />
                  )}
                </li>
              ) : null}
              {plan && plan.interval !== meta.interval ? (
                <li>
                  চক্র: {intervalLabel(plan.interval)} →{' '}
                  <span className="font-medium">{intervalLabel(meta.interval)}</span>
                </li>
              ) : null}
              {plan && plan.sortOrder !== meta.sortOrder ? (
                <li>
                  ক্রম: {bnNum(plan.sortOrder)} →{' '}
                  <span className="font-medium">{bnNum(meta.sortOrder)}</span>
                </li>
              ) : null}
            </ul>
            {plan && plan.priceMinor !== meta.priceMinor ? (
              <p className="mt-1">{PRICING_IS_NOT_BILLING}</p>
            ) : null}
            <p className="mt-1">
              সীমাগুলো এতে বদলায় না — সেগুলো নিচের &ldquo;সীমা&rdquo; অংশ থেকে আলাদা করে সংরক্ষণ
              করতে হয়।
            </p>
          </>
        )
      }
    />
  );
}
