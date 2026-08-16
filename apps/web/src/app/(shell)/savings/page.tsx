'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  Info,
  Landmark,
  Link2,
  Pencil,
  Plus,
  ShieldCheck,
  Trash2,
  TrendingUp,
} from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';
import { formatMinor, parseMoneyToMinor, toLocalDateString } from '@hishab/shared';
import { CategoryOptions } from '@/components/category-options';
import { Money } from '@/components/money';
import { SkeletonRows } from '@/components/skeleton';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { api, ApiError, endpoints } from '@/lib/api';
import { fmtNumber } from '@/lib/format';
import { haptic } from '@/lib/haptics';
import { ShareStatementSheet } from '@/components/share-statement-sheet';
import { t } from '@/lib/t';
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
  /** The ledger row that moved this instalment's money, once one exists. */
  transactionId: string | null;
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
  /** When the term ends. Part of deciding whether profit can have arrived yet. */
  maturityDate: string | null;
  profitRateBps: number;
  profitCalc: string;
  status: string;
  /**
   * `PERIODIC` — a Sanchayapatra, which credits a bank account as it goes.
   * `AT_MATURITY` — a DPS or FDR, which pays nothing at all until the end.
   */
  profitPayout: 'PERIODIC' | 'AT_MATURITY';
  /**
   * What the rate says has built up so far and has *not* been received.
   *
   * Derived from the projection over the months elapsed. Nothing books it, and
   * the screen never puts it in a box somebody can submit.
   */
  accruedProfitMinor: number;
  /**
   * The savings account this instrument's money actually sits in, or null.
   *
   * Optional and it stays optional. Without it the screen behaves exactly as it
   * always has — ticking an instalment moves no money — and with it, ticking one
   * *offers* to book the deposit as a transfer. Nothing here ever assumes.
   */
  linkedAccountId: string | null;
  /** Free text. The migration writes its own warnings here, so the sheet must show it. */
  note: string | null;
  /** Profit actually paid out, summed off the ledger. Not the projection. */
  profitReceivedMinor: number;
  projection: Projection;
  progress: Progress;
  installments?: Instalment[];
}

const PLAN_TYPES = [
  ['DPS', t('savings.type.dps', 'ডিপিএস')],
  ['FDR', t('savings.type.fdr', 'এফডিআর')],
  ['SANCHAYPATRA', t('savings.type.sanchayapatra', 'সঞ্চয়পত্র')],
  ['RECURRING_DEPOSIT', t('savings.type.recurring', 'রেকারিং ডিপোজিট')],
  ['GOAL_SAVINGS', t('savings.type.goal', 'লক্ষ্য সঞ্চয়')],
] as const;

const FREQUENCIES = [
  ['MONTHLY', t('freq.monthly', 'মাসিক')],
  ['QUARTERLY', t('freq.quarterly', 'ত্রৈমাসিক')],
  ['HALF_YEARLY', t('freq.halfYearly', 'ষাণ্মাসিক')],
  ['YEARLY', t('freq.yearly', 'বার্ষিক')],
] as const;

const PROFIT_CALCS = [
  ['COMPOUND_YEARLY', t('savings.calc.yearly', 'বার্ষিক চক্রবৃদ্ধি')],
  ['COMPOUND_QUARTERLY', t('savings.calc.quarterly', 'ত্রৈমাসিক চক্রবৃদ্ধি')],
  ['COMPOUND_MONTHLY', t('savings.calc.monthly', 'মাসিক চক্রবৃদ্ধি')],
  ['SIMPLE', t('savings.calc.simple', 'সরল হার')],
] as const;

const STATUSES = [
  ['ACTIVE', t('status.active', 'চলমান')],
  ['MATURED', t('status.matured', 'মেয়াদপূর্ণ')],
  ['CLOSED', t('status.closed', 'বন্ধ')],
] as const;

const labelOf = (pairs: readonly (readonly [string, string])[], value: string): string =>
  pairs.find(([v]) => v === value)?.[1] ?? value;

/**
 * Whether this instrument can honestly have handed over any profit yet.
 *
 * ## The mistake this replaced
 *
 * "মুনাফা পেয়েছি" used to sit on every plan, with the whole projected maturity
 * profit prefilled. On a Sanchayapatra that is right — it credits a bank
 * account every month or quarter. On a **DPS it is the dangerous kind of
 * wrong**: a DPS pays nothing before maturity, principal and profit arrive
 * together at the end, so a button offering to record profit received is an
 * invitation to book income that has neither been earned nor received. That
 * overstates the year and carries straight into the tax worksheet.
 *
 * ## What is offered instead
 *
 * Three ways an instrument can have paid:
 *
 *  - it pays periodically by construction (`PERIODIC` — the Sanchayapatra);
 *  - the saver has already marked it মেয়াদপূর্ণ or বন্ধ, which is them saying
 *    it is over;
 *  - its maturity date has arrived, which is the case the status has not caught
 *    up with yet — and the one `MatureSheet` sends people to first, since it
 *    asks for the profit to be booked *before* the money is brought home.
 *
 * A running DPS matches none of these and gets no button. It gets the accrued
 * figure, which is a number to look at rather than a number to file.
 */
function profitCanHaveArrived(plan: SavingsPlan, today: string): boolean {
  if (plan.profitPayout === 'PERIODIC') return true;
  if (plan.status !== 'ACTIVE') return true;
  return plan.maturityDate !== null && plan.maturityDate <= today;
}

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
  const [sharing, setSharing] = React.useState<SavingsPlan | null>(null);
  /** The plan whose profit is being recorded. `null` closes the sheet. */
  const [profitFor, setProfitFor] = React.useState<SavingsPlan | null>(null);
  /** The plan being brought home at maturity. `null` closes the sheet. */
  const [maturing, setMaturing] = React.useState<SavingsPlan | null>(null);
  /**
   * The instalment being deposited, on a plan that has a linked account.
   *
   * Only ever set for a linked plan: without a link there is nowhere for the
   * money to go and the tick behaves as it always has.
   */
  const [depositing, setDepositing] = React.useState<{
    plan: SavingsPlan;
    instalment: Instalment;
  } | null>(null);

  /* Read once per render rather than per row. Whether a plan has matured is a
     question about a calendar day, not a moment, and the four places that ask
     it must not straddle midnight and disagree. */
  const today = toLocalDateString(new Date());

  const plans = useQuery({
    queryKey: ['savings'],
    queryFn: () => api<SavingsPlan[]>('/savings'),
  });
  const detail = useQuery({
    queryKey: ['savings', openId],
    queryFn: () => api<SavingsPlan>(`/savings/${openId}`),
    enabled: openId !== null,
  });
  /* Only to name the linked account in the detail sheet. Cached under the same
     key every other screen uses, so this costs nothing after the first read. */
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: endpoints.accounts });
  const linkedAccount = (accounts.data ?? []).find((a) => a.id === detail.data?.linkedAccountId);

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
          <p className="text-ink">
            {t('savings.none', 'এখনও কোনো ডিপিএস বা এফডিআর যোগ করা হয়নি।')}
          </p>
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
                  <span className="text-ink-muted text-[11px]">
                    {t('savings.atMaturity', 'মেয়াদপূর্তিতে')}
                  </span>
                </div>
              </button>

              <dl className="border-rule mt-3 grid grid-cols-3 gap-2 border-t pt-2 text-xs">
                <div>
                  <dt className="text-ink-muted">{t('savings.paidIn', 'জমা হয়েছে')}</dt>
                  <dd>
                    <Money minor={plan.progress.paidMinor} className="block" decimals={false} />
                  </dd>
                </div>
                <div>
                  <dt className="text-ink-muted">{t('savings.willPay', 'মোট জমা হবে')}</dt>
                  <dd>
                    <Money
                      minor={plan.projection.depositedMinor}
                      className="block"
                      decimals={false}
                    />
                  </dd>
                </div>
                <div>
                  <dt className="text-ink-muted">{t('savings.profit', 'মুনাফা')}</dt>
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
        title={detail.data?.planName ?? t('savings.word', 'সঞ্চয়')}
        description={detail.data ? labelOf(PLAN_TYPES, detail.data.planType) : undefined}
      >
        {detail.data ? (
          <div className="flex flex-col gap-4">
            <div className="bg-greenbar rounded-md p-3">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-ink-muted text-xs">
                  {t('savings.atMaturityGross', 'মেয়াদপূর্তিতে (কর কাটার আগে)')}
                </span>
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

            {/* On an instrument that pays nothing until the end — a DPS, an FDR
                — this is the honest figure, and it is deliberately not a button.

                What has *built up* is not what has *arrived*. A running DPS
                hands over nothing at all until maturity, so a screen offering
                to record profit received on one would be inviting somebody to
                file income they have not earned yet and have certainly not been
                paid. The number is here to be looked at; nothing books it, and
                under this ledger's cash basis it is neither income nor an
                asset until the bank actually pays. */}
            {detail.data.profitPayout === 'AT_MATURITY' ? (
              <div className="border-rule flex items-center justify-between gap-2 rounded-md border p-3">
                <div className="min-w-0">
                  <p className="text-ink text-sm font-medium">
                    {t('savings.profitAccrued', 'এ পর্যন্ত জমেছে')}
                  </p>
                  <p className="text-ink-muted text-xs">
                    {t(
                      'savings.profitAccruedHint',
                      'হাতে আসেনি — মেয়াদপূর্তিতে আসল ও মুনাফা একসঙ্গে পাবেন। এটি হারের হিসাবে আনুমানিক, কর কাটার আগের।',
                    )}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Money
                    minor={detail.data.accruedProfitMinor}
                    className="text-ink text-base font-semibold"
                  />
                </div>
              </div>
            ) : null}

            {/* What this instrument has actually paid, beside what it promised.
                A Sanchayapatra pays every month or quarter and the bank deducts
                source tax first, so the two are never the same number — and the
                one on the left is the one that happened.

                Shown whatever the instrument, including a running DPS where it
                will read zero: the zero is the point, sitting beside the accrued
                figure above it. */}
            <div className="border-rule flex items-center justify-between gap-2 rounded-md border p-3">
              <div className="min-w-0">
                <p className="text-ink text-sm font-medium">
                  {t('savings.profitReceived', 'এ পর্যন্ত মুনাফা পেয়েছি')}
                </p>
                <p className="text-ink-muted text-xs">
                  {t('savings.profitHint', 'ব্যাংক যা হাতে দিয়েছে — কর কাটার পরে')}
                </p>
                {/* The khata is the primary way in now: an ordinary আয় row with
                    "কোন সঞ্চয় থেকে" set counts here exactly the same. Saying so
                    keeps this screen from implying it owns the figure. */}
                <p className="text-ink-muted mt-1 text-xs">
                  {t(
                    'savings.profitFromLedger',
                    'খাতায় আয় লেখার সময় “কোন সঞ্চয় থেকে” বেছে দিলে সেটিও এখানে যোগ হয়।',
                  )}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Money
                  minor={detail.data.profitReceivedMinor}
                  className="text-income text-base font-semibold"
                />
              </div>
            </div>

            {/* Whether the instalments reach the books, said where somebody
                deciding can read it.

                A DPS deposit is not an expense — it is one asset becoming
                another — and an app that quietly filed it either way would be
                wrong in a direction nobody would notice. So the state of the
                link is on the plan, in a sentence, and the way to change it is
                the ordinary সম্পাদনা button below. */}
            <div className="border-rule flex items-start justify-between gap-3 rounded-md border p-3">
              <div className="min-w-0">
                <p className="text-ink text-sm font-medium">
                  {t('savings.linkedAccount', 'কিস্তির টাকা যে হিসাবে জমা হয়')}
                </p>
                <p className="text-ink-muted mt-0.5 text-xs">
                  {detail.data.linkedAccountId
                    ? t(
                        'savings.linkedOn',
                        'কিস্তিতে টিক দিলে এই হিসাবে টাকা সরানোর সুযোগ পাবেন — খরচ হিসেবে নয়, স্থানান্তর হিসেবে।',
                      )
                    : t(
                        'savings.linkedOff',
                        'যুক্ত করা নেই — কিস্তিতে টিক দিলে শুধু চিহ্ন পড়বে, খাতায় টাকা সরবে না। সম্পাদনা করে একটি সঞ্চয়ী হিসাব বেছে নিতে পারেন।',
                      )}
                </p>
              </div>
              <span className="text-ink shrink-0 text-right text-xs">
                {linkedAccount?.name ?? t('savings.notLinked', 'যুক্ত নেই')}
              </span>
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
                      {/* Whether the money reached the books is the difference
                          between a tick and a ledger row, and a screen that
                          showed both the same way would hide it. */}
                      {row.transactionId
                        ? t('savings.depositBooked', 'খাতায় জমা')
                        : t('savings.markedPaid', 'জমা হয়েছে')}
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        /* A linked plan asks before it moves anything. An
                           unlinked one has nowhere to move money to, so it does
                           what this button has always done. */
                        if (detail.data!.linkedAccountId) {
                          setDepositing({ plan: detail.data!, instalment: row });
                          setOpenId(null);
                          return;
                        }
                        pay.mutate({ planId: detail.data!.id, installmentId: row.id });
                      }}
                      className="press border-rule text-ink hover:bg-greenbar min-h-11 w-24 shrink-0 rounded-md border py-1.5 text-xs"
                    >
                      জমা দিলাম
                    </button>
                  )}
                </li>
              ))}
            </ul>

            {/* One sheet at a time: the detail closes as the editor opens. */}
            <div className="border-rule flex flex-wrap gap-2 border-t pt-3">
              {/* The institution asks for a statement every year, and the API
                  has served SAVINGS since statement sharing shipped — only the
                  button was missing. */}
              {/* First, and the only filled button here, on the instruments
                  where it belongs: on a Sanchayapatra this is the thing somebody
                  does every month, and the rest are done once a year at most.

                  Absent on a running DPS — see `profitCanHaveArrived`. A DPS
                  pays nothing before maturity, so offering to record profit
                  received on one would invite somebody to book income they have
                  not earned. They get the accrued figure above instead. */}
              {profitCanHaveArrived(detail.data, today) ? (
                <Button
                  className="flex-1"
                  onClick={() => {
                    setProfitFor(detail.data!);
                    setOpenId(null);
                  }}
                >
                  <TrendingUp className="h-4 w-4" aria-hidden />
                  {t('savings.gotProfit', 'মুনাফা পেয়েছি')}
                </Button>
              ) : null}
              {/* Offered whatever the status. A plan already marked মেয়াদপূর্ণ or
                  বন্ধ from the status box is exactly the one whose money is
                  still sitting in a savings account waiting to be moved — hiding
                  the button there would strand it. */}
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => {
                  setMaturing(detail.data!);
                  setOpenId(null);
                }}
              >
                <Landmark className="h-4 w-4" aria-hidden />
                {detail.data.status === 'ACTIVE'
                  ? t('savings.mature', 'মেয়াদপূর্তি')
                  : t('savings.moveMoney', 'টাকা সরান')}
              </Button>
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
          kind="SAVINGS"
          subjectId={sharing.id}
          subjectName={sharing.planName}
        />
      ) : null}

      {profitFor ? (
        <ProfitSheet plan={profitFor} onOpenChange={(next) => !next && setProfitFor(null)} />
      ) : null}

      {maturing ? (
        <MatureSheet plan={maturing} onOpenChange={(next) => !next && setMaturing(null)} />
      ) : null}

      {depositing ? (
        <DepositSheet
          plan={depositing.plan}
          instalment={depositing.instalment}
          linkedAccountName={
            (accounts.data ?? []).find((a) => a.id === depositing.plan.linkedAccountId)?.name ?? ''
          }
          onOpenChange={(next) => {
            if (!next) {
              const planId = depositing.plan.id;
              setDepositing(null);
              // Back to the plan the tick was made on, now one instalment on.
              setOpenId(planId);
            }
          }}
        />
      ) : null}

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
  /** A savings account id, or '' for "not linked" — which is the default. */
  linkedAccountId: string;
  note: string;
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
  /* Empty, always. A new plan is not linked to anything until somebody says so:
     defaulting to the only savings account they happen to have would be the app
     deciding that this DPS's money lives there, and being wrong about that puts
     transfers into the wrong account month after month. */
  linkedAccountId: '',
  note: '',
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
  linkedAccountId: plan.linkedAccountId ?? '',
  note: plan.note ?? '',
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
  linkedAccountId: plan.linkedAccountId ?? '',
  note: plan.note ?? '',
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
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: endpoints.accounts });
  /* Only savings accounts, and the server agrees. A link is what lets an
     instalment be booked as a transfer *into* somewhere, and the only somewhere
     that makes sense is the account the bank actually holds the DPS in. An
     archived one is still offered when the plan already points at it, so an
     unrelated edit cannot silently unlink a plan. */
  const savingsAccounts = (accounts.data ?? []).filter(
    (a) => a.type === 'SAVINGS' && (!a.isArchived || a.id === form.linkedAccountId),
  );

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
      title={plan ? t('savings.edit', 'সঞ্চয় সম্পাদনা') : t('savings.new', 'নতুন সঞ্চয়')}
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
            setError(t('form.badAmount', 'টাকার অঙ্কটি বোঝা যায়নি।'));
            return;
          }
          /* 8.25% is 825 basis points — the same two-decimal scaling the money
             parser does, and it reads Bengali digits, which Number() cannot. */
          const profitRateBps = toMinor(form.rate, currency);
          if (profitRateBps === null) {
            setError(t('form.badRate', 'মুনাফার হারটি বোঝা যায়নি।'));
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
            linkedAccountId: form.linkedAccountId,
            note: form.note.trim(),
          };

          if (!plan) {
            save.mutate({
              ...next,
              institution: next.institution || undefined,
              // Absent, not empty: the id column takes a cuid or nothing.
              linkedAccountId: next.linkedAccountId || undefined,
            });
            return;
          }

          /* Only what changed: the API rederives the maturity date whenever it
             is handed a start date or a term, so resending either untouched
             would overwrite a maturity typed off the passbook. */
          const body: Record<string, unknown> = changedOnly(
            { ...planToApi(plan), status: plan.status },
            { ...next, status: form.status },
          );
          /* '' is how this form spells "not linked", and the API spells it
             `null` — omitting the field means "leave it alone", which is the
             one thing somebody unlinking a plan did not ask for. */
          if ('linkedAccountId' in body && body.linkedAccountId === '') {
            body.linkedAccountId = null;
          }
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
          {/* Not required, and the markup used to say otherwise.
              `toMinor` reads an empty rate as zero — the handler was written for
              a plan whose rate nobody has been told yet, which is most of them
              on the day they are opened. The `required` attribute meant the
              browser blocked the submit before that code ever ran, with a
              native bubble that is easy to miss inside a scrolled sheet on a
              phone: the save button simply did nothing. */}
          <Input
            id="sp-rate"
            value={form.rate}
            onChange={set('rate')}
            inputMode="decimal"
            className="money"
            placeholder="যেমন: ৮.২৫"
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

        {/* The one field on this form that can make money move.

            It is last, optional, and empty by default, because most plans do
            not want it: somebody tracking a Sanchayapatra they hold on paper
            wants a schedule and a reminder, not a second account to keep. The
            hint spells out the consequence in both directions, because "যুক্ত
            করুন" on its own tells a reader nothing about what changes. */}
        <Field
          label={t('savings.linkAccount', 'কিস্তির টাকা কোন হিসাবে জমা হয়')}
          htmlFor="sp-linked"
        >
          <Select id="sp-linked" value={form.linkedAccountId} onChange={set('linkedAccountId')}>
            <option value="">{t('savings.linkNone', 'যুক্ত করব না')}</option>
            {savingsAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
          <p className="text-ink-muted mt-1 text-xs">
            {t(
              'savings.linkHint',
              'যুক্ত করলে প্রতিটি কিস্তিতে টিক দেওয়ার সময় জিজ্ঞেস করা হবে টাকাটা কোন হিসাব থেকে গেল, আর সেটি খাতায় স্থানান্তর হিসেবে বসবে — খরচ হিসেবে নয়, কারণ ডিপিএসে টাকা রাখা খরচ নয়, এক হিসাব থেকে আরেক হিসাবে সরানো। যুক্ত না করলে আগের মতোই শুধু চিহ্ন পড়বে, খাতায় কিছু বসবে না।',
            )}
          </p>
          {savingsAccounts.length === 0 ? (
            <p className="text-ink-muted mt-1 text-xs">
              {t(
                'savings.linkNoAccounts',
                'এখনও কোনো “সঞ্চয়ী” ধরনের অ্যাকাউন্ট নেই। অ্যাকাউন্ট পাতা থেকে একটি খুলে নিলে এখানে দেখা যাবে।',
              )}
            </p>
          ) : null}
        </Field>

        <Field label={t('savings.note', 'নোট')} htmlFor="sp-note">
          <Textarea
            id="sp-note"
            value={form.note}
            onChange={set('note')}
            rows={3}
            maxLength={2000}
            placeholder={t(
              'savings.notePlaceholder',
              'যেমন: সিটি ব্যাংক ৮৬২১৬৯৬১০৭০০৩, শাখা গুলশান, নমিনি — আম্মু',
            )}
          />
          <p className="text-ink-muted mt-1 text-xs">
            {t(
              'savings.noteHint',
              'হিসাব নম্বর, শাখা, নমিনি — যা মনে রাখা দরকার। এটি কোনো অ্যাকাউন্টের সঙ্গে যুক্ত হয় না, শুধু লেখা থাকে।',
            )}
          </p>
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

/**
 * "মুনাফা পেয়েছি" — money the instrument has actually handed over.
 *
 * ## Where it is offered, and where it is not
 *
 * Only where profit can have arrived: a Sanchayapatra, which credits a bank
 * account every month or quarter, or any plan that has reached maturity. **Not
 * a running DPS** — see `profitCanHaveArrived`. A DPS pays nothing before the
 * end, so this sheet on one would be a form for filing income nobody has been
 * paid, and the tax worksheet reads what it files.
 *
 * ## Why it is its own button at all
 *
 * Somebody holding four Sanchayapatra does this twelve to forty-eight times a
 * year, and here the instrument is already known. The khata's ordinary আয় sheet
 * now carries a "কোন সঞ্চয় থেকে" picker that does the same job and is the
 * primary route; both write `savingsPlanId` and both count in the same total,
 * so neither screen owns the figure.
 *
 * ## Nothing is prefilled, deliberately
 *
 * The amount box starts empty. It used to open with
 * `projection.profitMinor − profitReceivedMinor` already in it, which reads as
 * "this is what you got" — and on anything short of maturity that figure has
 * not been received at all. The app cannot know what the bank paid: source tax
 * and excise duty come off first, a bonus sometimes goes on, and the only
 * reliable source is the passbook in the person's hand. So it asks, and files
 * exactly what it is told.
 *
 * ## What it does not ask
 *
 * Whether this is income. It is (IFRS 9), and asking a question whose answer is
 * always the same teaches nothing. The principal coming home at maturity is a
 * *transfer* between two accounts and is deliberately not this button.
 */
function ProfitSheet({
  plan,
  onOpenChange,
}: {
  plan: SavingsPlan;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { currency } = useWorkspaceSettings();
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: endpoints.accounts });
  const categories = useQuery({ queryKey: ['categories'], queryFn: endpoints.categories });

  const [accountId, setAccountId] = React.useState('');
  const [categoryId, setCategoryId] = React.useState('');
  const [date, setDate] = React.useState(toLocalDateString(new Date()));
  const [error, setError] = React.useState<string | null>(null);

  /**
   * Empty. Always.
   *
   * This box used to open with `projection.profitMinor − profitReceivedMinor`
   * in it — what the rate says the plan will yield over its whole term, less
   * what has been booked. As a convenience at maturity that was defensible; as
   * a default it was not, because a number sitting in a box labelled "কত টাকা
   * পেলেন" reads as a statement that this is what arrived, and on anything
   * short of maturity none of it has. Income filed that way overstates the year
   * and carries into the tax worksheet.
   *
   * There is no figure the app could put here honestly: the bank deducts source
   * tax and excise duty before it pays and sometimes adds a bonus, so the only
   * true number is the one on the passbook. The person reads it and types it.
   */
  const [amount, setAmount] = React.useState('');

  /* Default to the first live account rather than making somebody pick twice.
     Where profit lands is nearly always the same account month after month. */
  const firstAccountId = (accounts.data ?? []).find((a) => !a.isArchived)?.id ?? '';
  React.useEffect(() => {
    if (firstAccountId) setAccountId((current) => current || firstAccountId);
  }, [firstAccountId]);

  const save = useMutation({
    mutationFn: (amountMinor: number) =>
      api(`/savings/${plan.id}/profit`, {
        method: 'POST',
        body: { amountMinor, accountId, categoryId, date },
      }),
    onSuccess: () => {
      haptic('success');
      /* The money moved, so this is not the savings screen's business alone:
         an account balance changed, the khata has a new row, and the income
         statement is different. */
      for (const key of [['savings'], ['accounts'], ['transactions'], ['summary'], ['reports']]) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
      onOpenChange(false);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'সংরক্ষণ করা যায়নি'),
  });

  return (
    <Sheet
      open
      onOpenChange={onOpenChange}
      title={t('savings.gotProfit', 'মুনাফা পেয়েছি')}
      description={plan.planName}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          const amountMinor = toMinor(amount, currency);
          if (amountMinor === null || amountMinor <= 0) {
            setError('টাকার অঙ্ক লিখুন');
            return;
          }
          if (!categoryId) {
            setError('কোন খাতে বসবে বেছে নিন');
            return;
          }
          save.mutate(amountMinor);
        }}
      >
        <Field label={t('savings.profitAmount', 'কত টাকা পেলেন (৳)')} htmlFor="pf-amount">
          <Input
            id="pf-amount"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            required
            autoFocus
            className="money text-xl"
            placeholder="০.০০"
          />
          {/* Nothing is filled in for them. The bank deducts source tax and
              excise duty before it pays and sometimes adds a bonus, so the
              projection is never the figure that arrived — and a projected
              number sitting in this box would read as a claim that it did. */}
          <p className="text-ink-muted mt-1 text-xs">
            {/* A new key rather than a reworded one: `savings.profitAmountHint`
                is shipped English that says only "exactly what the bank handed
                over", and the sentence that matters now is the second half. */}
            {t(
              'savings.profitReceivedOnly',
              'ব্যাংক যত টাকা হাতে দিয়েছে, ঠিক তত — পাসবই বা এসএমএস দেখে লিখুন। যা এখনও পাননি তা লিখবেন না।',
            )}
          </p>
        </Field>

        <Field label={t('savings.profitAccount', 'কোন অ্যাকাউন্টে ঢুকল')} htmlFor="pf-account">
          <Select
            id="pf-account"
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            required
          >
            {(accounts.data ?? [])
              .filter((a) => !a.isArchived)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </Select>
        </Field>

        <Field label={t('savings.profitCategory', 'আয়ের খাত')} htmlFor="pf-category">
          <Select
            id="pf-category"
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            required
          >
            <option value="">{t('common.choose', 'বেছে নিন')}</option>
            <CategoryOptions categories={categories.data} kind="INCOME" />
          </Select>
        </Field>

        <Field label={t('savings.profitDate', 'কোন তারিখে')} htmlFor="pf-date">
          <Input
            id="pf-date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            required
          />
        </Field>

        {error ? (
          <p role="alert" className="text-expense text-sm">
            {error}
          </p>
        ) : null}
        <Button type="submit" size="block" disabled={save.isPending}>
          {t('common.save', 'সংরক্ষণ করুন')}
        </Button>
      </form>
    </Sheet>
  );
}

/**
 * "মেয়াদপূর্তি" — the DPS is over, bring the money home and close the plan.
 *
 * A **transfer**, and the sheet says so out loud, because this is the one place
 * a person is most likely to get it wrong. What comes out of a matured DPS is
 * mostly their own instalments coming back; calling that income would inflate
 * the year by the size of the deposit and carry into the tax worksheet. The
 * bank's share is booked separately, through "মুনাফা পেয়েছি", and the sheet
 * points at that button rather than quietly doing something reasonable.
 *
 * The amount prefills with the source account's whole balance, so emptying it
 * is one tap — but it stays a box somebody can see and change, because a figure
 * nobody read is a figure nobody checked.
 */
function MatureSheet({
  plan,
  onOpenChange,
}: {
  plan: SavingsPlan;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { currency } = useWorkspaceSettings();
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: endpoints.accounts });

  const [fromId, setFromId] = React.useState('');
  const [toId, setToId] = React.useState('');
  const [amount, setAmount] = React.useState('');
  const [date, setDate] = React.useState(toLocalDateString(new Date()));
  const [error, setError] = React.useState<string | null>(null);

  const live = React.useMemo(
    () => (accounts.data ?? []).filter((a) => !a.isArchived),
    [accounts.data],
  );

  /* Default the source to a savings account if there is one — that is where DPS
     money sits — and the destination to anything else. */
  React.useEffect(() => {
    if (live.length === 0) return;
    setFromId((current) => current || (live.find((a) => a.type === 'SAVINGS') ?? live[0]!).id);
  }, [live]);

  React.useEffect(() => {
    if (!fromId) return;
    setToId((current) =>
      current && current !== fromId ? current : (live.find((a) => a.id !== fromId)?.id ?? ''),
    );
  }, [fromId, live]);

  /* Prefilled from the balance, and re-prefilled when the source changes.
     Deliberately not locked to it: the bank may have taken a closing charge. */
  const sourceBalance = live.find((a) => a.id === fromId)?.balanceMinor ?? 0;
  React.useEffect(() => {
    setAmount(sourceBalance > 0 ? formatMinor(sourceBalance, { symbol: false }) : '');
  }, [sourceBalance]);

  const save = useMutation({
    mutationFn: (amountMinor: number) =>
      api(`/savings/${plan.id}/mature`, {
        method: 'POST',
        body: { fromAccountId: fromId, toAccountId: toId, amountMinor, date },
      }),
    onSuccess: () => {
      haptic('success');
      for (const key of [['savings'], ['accounts'], ['transactions'], ['summary'], ['reports']]) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
      onOpenChange(false);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'সংরক্ষণ করা যায়নি'),
  });

  return (
    <Sheet
      open
      onOpenChange={onOpenChange}
      title={t('savings.mature', 'মেয়াদপূর্তি')}
      description={plan.planName}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          const amountMinor = toMinor(amount, currency);
          if (amountMinor === null || amountMinor <= 0) {
            setError('টাকার অঙ্ক লিখুন');
            return;
          }
          if (!fromId || !toId || fromId === toId) {
            setError('আলাদা দুইটি অ্যাকাউন্ট বেছে নিন');
            return;
          }
          save.mutate(amountMinor);
        }}
      >
        {/* Said before anything is filled in, because this is the sentence that
            stops somebody booking their own money back as earnings. */}
        <div className="rounded-card border-rule bg-greenbar border p-3">
          <p className="text-ink flex items-start gap-2 text-sm">
            <Info className="text-income mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>
              {t(
                'savings.matureHint',
                'এটি এক অ্যাকাউন্ট থেকে আরেক অ্যাকাউন্টে টাকা সরানো — আয় নয়। আপনার নিজের জমা ফেরত আসছে। ব্যাংক যে বাড়তি মুনাফা দিয়েছে সেটি আগে “মুনাফা পেয়েছি” দিয়ে বসিয়ে নিন।',
              )}
            </span>
          </p>
          {/* The sentence above names a button that is not always on screen: a
              running DPS gets no "মুনাফা পেয়েছি", because it has paid nothing
              yet. Somebody closing one early would otherwise be sent looking
              for a control that is not there, so the other route — which always
              works, and is the primary one now — is named beside it. */}
          <p className="text-ink-muted mt-2 text-xs">
            {t(
              'savings.matureProfitWhere',
              'বোতামটি না দেখলে খাতা থেকে আয় লিখে “কোন সঞ্চয় থেকে” এই সঞ্চয়টি বেছে দিন — একই হিসাবে যোগ হবে।',
            )}
          </p>
        </div>

        <Field label={t('savings.matureFrom', 'কোন অ্যাকাউন্টে টাকাটা আছে')} htmlFor="mt-from">
          <Select id="mt-from" value={fromId} onChange={(e) => setFromId(e.target.value)} required>
            {live.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field label={t('savings.matureTo', 'কোথায় নিয়ে যাবেন')} htmlFor="mt-to">
          <Select id="mt-to" value={toId} onChange={(e) => setToId(e.target.value)} required>
            {live
              .filter((a) => a.id !== fromId)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </Select>
        </Field>

        <Field label={t('savings.matureAmount', 'কত টাকা (৳)')} htmlFor="mt-amount">
          <Input
            id="mt-amount"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            required
            className="money text-xl"
            placeholder="০.০০"
          />
          <p className="text-ink-muted mt-1 text-xs">
            {t('savings.matureAmountHint', 'পুরোটা বসানো আছে — অ্যাকাউন্টটি শূন্য হয়ে যাবে।')}
          </p>
        </Field>

        <Field label={t('savings.matureDate', 'কোন তারিখে')} htmlFor="mt-date">
          <Input
            id="mt-date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            required
          />
        </Field>

        {error ? (
          <p role="alert" className="text-expense text-sm">
            {error}
          </p>
        ) : null}
        <Button type="submit" size="block" disabled={save.isPending}>
          {t('common.save', 'সংরক্ষণ করুন')}
        </Button>
      </form>
    </Sheet>
  );
}

/**
 * "কিস্তি জমা দিলাম" — on a plan whose money has somewhere to go.
 *
 * ## Why this sheet exists at all
 *
 * Ticking an instalment used to flip a status and nothing else, and the ledger
 * never heard about it. The owner of these books has ten savings plans and
 * ৳31,000 across four savings accounts, which is what years of deposits look
 * like when none of them reach the books.
 *
 * ## Why it is a transfer, and why the sheet says so
 *
 * Money into a DPS is **not an expense**. Nothing is consumed and nobody is
 * owed — ৳2,000 leaves the current account and arrives in the savings account,
 * one asset becoming another. Filed as an expense it understates net worth by
 * every poisha ever saved and overstates the month's spending by the
 * instalment, and both errors run in the direction that makes somebody believe
 * they are poorer than they are. The sentence at the top of this sheet is the
 * only place a person is ever told that, so it goes before the fields.
 *
 * ## Why "শুধু চিহ্ন দিন" is a real button and not a cancel
 *
 * Because it is what this screen did yesterday, and it is still right for a
 * plan whose deposits are already in the books some other way — an auto-debit
 * the bank statement import already picked up, a standing instruction, an
 * instalment somebody paid in cash and entered by hand last week. Moving money
 * a second time would double it. The choice is on the screen, both ways round,
 * and neither is taken for the person.
 */
function DepositSheet({
  plan,
  instalment,
  linkedAccountName,
  onOpenChange,
}: {
  plan: SavingsPlan;
  instalment: Instalment;
  linkedAccountName: string;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { currency } = useWorkspaceSettings();
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: endpoints.accounts });

  const [fromId, setFromId] = React.useState('');
  const [amount, setAmount] = React.useState(() =>
    formatMinor(instalment.expectedMinor, { symbol: false }),
  );
  const [date, setDate] = React.useState(toLocalDateString(new Date()));
  const [error, setError] = React.useState<string | null>(null);

  /* Never the account the money is going *into*: a transfer to itself is
     refused by the server and is not a thing anybody meant to ask for. */
  const sources = React.useMemo(
    () => (accounts.data ?? []).filter((a) => !a.isArchived && a.id !== plan.linkedAccountId),
    [accounts.data, plan.linkedAccountId],
  );

  /* Default to the first current account rather than making somebody pick
     twice: a DPS instalment leaves the same bank account month after month, and
     a wallet or a plot of land is not where it comes from. */
  const firstSourceId =
    sources.find((a) => a.type === 'BANK')?.id ??
    sources.find((a) => a.type === 'CASH' || a.type === 'MOBILE_WALLET')?.id ??
    sources[0]?.id ??
    '';
  React.useEffect(() => {
    if (firstSourceId) setFromId((current) => current || firstSourceId);
  }, [firstSourceId]);

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api(`/savings/${plan.id}/installments/${instalment.id}/pay`, { method: 'POST', body }),
    onSuccess: (result) => {
      haptic('success');
      /* Money moved, so this is not the savings screen's business alone: an
         account balance changed, the khata has a new row and the net worth on
         the dashboard is different. */
      for (const key of [['savings'], ['accounts'], ['transactions'], ['summary'], ['reports']]) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
      /* The two halves can disagree — the tick always lands, the transfer may
         not — so the failure is reported rather than swallowed by a green
         toast. The instalment stays paid either way, which is why this is a
         message and not a rollback. */
      const deposit = (result as { deposit?: { booked: boolean; message: string | null } | null })
        .deposit;
      if (deposit && !deposit.booked) {
        setError(deposit.message ?? 'টাকাটা খাতায় সরানো যায়নি');
        return;
      }
      onOpenChange(false);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'সংরক্ষণ করা যায়নি'),
  });

  return (
    <Sheet
      open
      onOpenChange={onOpenChange}
      title={t('savings.payInstalment', 'কিস্তি জমা দিলাম')}
      description={`${plan.planName} · ${instalment.dueDate}`}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          const amountMinor = toMinor(amount, currency);
          if (amountMinor === null || amountMinor <= 0) {
            setError('টাকার অঙ্ক লিখুন');
            return;
          }
          if (!fromId) {
            setError('কোন অ্যাকাউন্ট থেকে গেল বেছে নিন');
            return;
          }
          save.mutate({ fromAccountId: fromId, amountMinor, paidDate: date });
        }}
      >
        {/* Before any field, because this is the sentence that stops somebody
            believing their savings are money they have spent. */}
        <div className="rounded-card border-rule bg-greenbar border p-3">
          <p className="text-ink flex items-start gap-2 text-sm">
            <Info className="text-income mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>
              {t(
                'savings.depositHint',
                'ডিপিএসে টাকা রাখা খরচ নয় — এক হিসাব থেকে আরেক হিসাবে সরানো। তাই এটি খাতায় স্থানান্তর হিসেবে বসবে, আপনার মোট সম্পদ কমবে না।',
              )}
            </span>
          </p>
        </div>

        <Field label={t('savings.depositFrom', 'কোন অ্যাকাউন্ট থেকে গেল')} htmlFor="dp-from">
          <Select id="dp-from" value={fromId} onChange={(e) => setFromId(e.target.value)} required>
            {sources.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
          <p className="text-ink-muted mt-1 text-xs">
            {t('savings.depositTo', 'জমা হবে:')} {linkedAccountName || plan.planName}
          </p>
        </Field>

        <Field label={t('savings.depositAmount', 'কত টাকা (৳)')} htmlFor="dp-amount">
          <Input
            id="dp-amount"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            required
            className="money text-xl"
            placeholder="০.০০"
          />
          {/* Prefilled from the schedule, and still a box: a late instalment
              collects a penalty and a bank sometimes takes the excise duty out
              of the same debit, so what gets booked has to be what the
              statement says. */}
          <p className="text-ink-muted mt-1 text-xs">
            {t('savings.depositAmountHint', 'কিস্তির নির্ধারিত অঙ্ক বসানো আছে — বদলাতে পারেন।')}
          </p>
        </Field>

        <Field label={t('savings.depositDate', 'কোন তারিখে')} htmlFor="dp-date">
          <Input
            id="dp-date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            required
          />
        </Field>

        {error ? (
          <p role="alert" className="bg-expense/10 text-expense rounded-md px-3 py-2 text-sm">
            {error}
          </p>
        ) : null}

        <Button type="submit" size="block" disabled={save.isPending}>
          {t('savings.depositAndMove', 'জমা দিন ও টাকা সরান')}
        </Button>
        {/* The other half of the choice, and a real one — see the note above
            this component. Outlined rather than filled, because moving the
            money is what most people opening this sheet came to do. */}
        <Button
          type="button"
          variant="outline"
          size="block"
          disabled={save.isPending}
          onClick={() => {
            setError(null);
            save.mutate({ paidDate: date });
          }}
        >
          {t('savings.markOnly', 'শুধু চিহ্ন দিন, টাকা সরাবেন না')}
        </Button>
      </form>
    </Sheet>
  );
}
