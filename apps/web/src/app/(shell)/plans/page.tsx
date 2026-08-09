'use client';

import { FEATURE_KEYS } from '@hishab/core';
import { useQuery } from '@tanstack/react-query';
import { Ban, Check, Info, Lock } from 'lucide-react';
import Link from 'next/link';
import { SkeletonCard, SkeletonRows } from '@/components/skeleton';
import { UsageMeter } from '@/components/usage-meter';
import type { EntitlementsDto } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  bnNum,
  featureLabel,
  featureOf,
  limitText,
  PlanPrice,
  QueryError,
  unitSuffix,
} from './parts';
import { fetchCatalogue, fetchSnapshot, planKeys, type CataloguePlan } from './queries';

/**
 * The only limits the API actually counts.
 *
 * `usage()` in apps/api/src/entitlements/entitlements.service.ts fills every
 * other feature with a hard zero on purpose — those subsystems do not exist
 * yet. Drawing "০ / ৫০ মেগাবাইট" from that zero would report a measurement
 * nobody took, so the unmeasured limits show their ceiling and say so.
 */
const MEASURED: ReadonlySet<string> = new Set([
  'accounts.max',
  'transactions.monthly.max',
  'members.max',
]);

/** What a person can actually do today about a limit they have hit. */
const RELIEF: Record<string, string> = {
  'accounts.max': 'কোনো অব্যবহৃত অ্যাকাউন্ট আর্কাইভ করলে একটি জায়গা খালি হয়।',
  'transactions.monthly.max': 'প্রতি মাসের ১ তারিখে এই গণনা আবার শূন্য থেকে শুরু হয়।',
  'members.max': 'কোনো সদস্যকে সরালে একটি জায়গা খালি হয়।',
};

export default function PlansPage() {
  const snapshot = useQuery({ queryKey: planKeys.snapshot(), queryFn: fetchSnapshot });
  const catalogue = useQuery({ queryKey: planKeys.catalogue(), queryFn: fetchCatalogue });

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <header>
        <h1 className="text-ink hidden text-xl font-semibold sm:text-2xl md:block">
          প্ল্যান ও সীমা
        </h1>
        <p className="text-ink-muted text-sm md:mt-1">
          আপনার প্ল্যান কী কী দেয়, তার কতটা ব্যবহার হয়েছে, আর অন্য স্তরে কী থাকে।
        </p>
      </header>

      {/* First thing on the screen, because somebody who arrived here did so by
          being refused something. Telling them to buy what cannot be bought
          would waste the one visit that mattered. */}
      <div className="rounded-card border-brass/40 bg-brass/10 border p-3.5">
        <p className="text-ink flex items-start gap-2 text-sm">
          <Info className="text-brass mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            <span className="font-medium">এখনই প্ল্যান বদলানোর কোনো উপায় নেই।</span> কেনাকাটার
            ব্যবস্থা এখনও তৈরি হয়নি, তাই এই পাতায় কোথাও &ldquo;কিনুন&rdquo; বোতাম নেই। নিচের
            দামগুলোও চূড়ান্ত নয় — কেবল খসড়া।
          </span>
        </p>
      </div>

      {snapshot.isError ? (
        <QueryError message="আপনার প্ল্যান আনা যায়নি।" onRetry={() => void snapshot.refetch()} />
      ) : snapshot.isLoading ? (
        <SkeletonCard />
      ) : (
        <CurrentPlan data={snapshot.data} />
      )}

      <section className="flex flex-col gap-3">
        <div>
          <h2 className="text-ink text-base font-semibold">স্তরগুলো</h2>
          <p className="text-ink-muted text-xs">
            তুলনার জন্য দেওয়া। এখান থেকে কিছু কেনা বা বদলানো যায় না।
          </p>
        </div>

        {catalogue.isError ? (
          <QueryError
            message="প্ল্যানের তালিকা আনা যায়নি।"
            onRetry={() => void catalogue.refetch()}
          />
        ) : catalogue.isLoading ? (
          <div className="rounded-card border-rule bg-surface overflow-hidden border">
            <SkeletonRows rows={5} />
          </div>
        ) : (catalogue.data ?? []).length === 0 ? (
          <div className="rounded-card border-rule border border-dashed p-8 text-center">
            <p className="text-ink">দেখানোর মতো কোনো প্ল্যান নেই।</p>
          </div>
        ) : (
          <Catalogue plans={catalogue.data ?? []} currentCode={snapshot.data?.plan?.code ?? null} />
        )}
      </section>
    </div>
  );
}

/* -------------------------------------------------------------------------
 * What you have, and how much of it is gone
 * ---------------------------------------------------------------------- */

function CurrentPlan({ data }: { data: EntitlementsDto | undefined }) {
  const entitlements = data?.entitlements ?? {};
  const usage = data?.usage ?? {};
  const left = data?.remaining ?? {};

  const limits = FEATURE_KEYS.filter((key) => featureOf(key)?.kind === 'LIMIT');
  const flags = FEATURE_KEYS.filter((key) => featureOf(key)?.kind === 'FLAG');

  const exhausted = limits.filter((key) => {
    const limit = entitlements[key] ?? null;
    if (limit === null || !MEASURED.has(key)) return false;
    return (usage[key] ?? 0) >= limit;
  });

  return (
    <section className="rounded-card border-rule bg-surface border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-ink-muted text-sm font-medium">আপনার এখনকার প্ল্যান</h2>
        <span className="text-ink text-base font-semibold">{data?.plan?.name ?? 'ফ্রি'}</span>
      </div>

      {data?.plan ? (
        <div className="mt-1">
          <PlanPrice priceMinor={data.plan.priceMinor} interval="MONTHLY" />
        </div>
      ) : (
        <p className="text-ink-muted mt-1 text-xs">
          কোনো প্ল্যান বসানো নেই, তাই ফ্রি স্তরের সীমাগুলোই প্রযোজ্য।
        </p>
      )}

      {exhausted.length > 0 ? (
        <div className="border-expense/40 bg-expense/10 mt-3 rounded-md border p-3">
          <p className="text-expense text-sm font-medium">
            {exhausted.map((key) => featureLabel(key)).join(', ')} — সীমা শেষ
          </p>
          <ul className="text-ink mt-1 list-disc pl-5 text-xs">
            {exhausted.map((key) => (
              <li key={key}>{RELIEF[key] ?? 'এই সীমা বাড়ানোর ব্যবস্থা এখনও তৈরি হয়নি।'}</li>
            ))}
          </ul>
          {exhausted.includes('accounts.max') ? (
            <Link
              href="/accounts"
              className="press border-rule bg-surface text-ink mt-2 inline-flex min-h-11 items-center rounded-md border px-3 text-xs font-medium md:min-h-9"
            >
              অ্যাকাউন্ট দেখুন
            </Link>
          ) : null}
        </div>
      ) : null}

      <div className="mt-4 flex flex-col gap-3">
        {limits.map((key) => (
          <LimitRow
            key={key}
            featureKey={key}
            limit={entitlements[key] ?? null}
            used={usage[key] ?? 0}
            left={left[key] ?? null}
          />
        ))}
      </div>

      <dl className="border-rule mt-4 grid grid-cols-1 gap-x-4 gap-y-2 border-t pt-3 sm:grid-cols-2">
        {flags.map((key) => {
          const on = (entitlements[key] ?? 0) !== 0;
          return (
            <div key={key} className="flex min-w-0 items-center justify-between gap-2">
              <dt className="text-ink-muted min-w-0 truncate text-xs">{featureLabel(key)}</dt>
              <dd
                className={cn(
                  'flex shrink-0 items-center gap-1 text-xs',
                  on ? 'text-income' : 'text-ink-muted',
                )}
              >
                {on ? (
                  <Check className="h-3.5 w-3.5" aria-hidden />
                ) : (
                  <Ban className="h-3.5 w-3.5" aria-hidden />
                )}
                {on ? 'আছে' : 'নেই'}
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}

function LimitRow({
  featureKey,
  limit,
  used,
  left,
}: {
  featureKey: string;
  limit: number | null;
  used: number;
  left: number | null;
}) {
  const label = featureLabel(featureKey);
  const definition = featureOf(featureKey);

  if (limit === null) {
    return <Plain label={label} value="সীমাহীন" />;
  }
  if (limit === 0) {
    return <Plain label={label} value="এই প্ল্যানে নেই" muted />;
  }
  if (!MEASURED.has(featureKey)) {
    return (
      <Plain
        label={label}
        value={`সর্বোচ্চ ${bnNum(limit)}${unitSuffix(definition?.unit)}`}
        note="ব্যবহার এখনও গোনা হয় না"
      />
    );
  }

  return (
    <div>
      <UsageMeter label={label} used={used} limit={limit} />
      <p className="mt-0.5 text-[11px]">
        {used >= limit ? (
          <span className="text-expense font-medium">সীমা শেষ</span>
        ) : (
          <span className="text-ink-muted">
            আর {bnNum(left ?? Math.max(0, limit - used))}
            {unitSuffix(definition?.unit)} বাকি
          </span>
        )}
      </p>
    </div>
  );
}

function Plain({
  label,
  value,
  note,
  muted = false,
}: {
  label: string;
  value: string;
  note?: string;
  muted?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-2">
      <span className="text-ink-muted min-w-0 truncate text-xs">{label}</span>
      <span className="shrink-0 text-right">
        <span className={cn('text-xs', muted ? 'text-ink-muted' : 'text-ink')}>{value}</span>
        {note ? <span className="text-ink-muted block text-[11px]">{note}</span> : null}
      </span>
    </div>
  );
}

/* -------------------------------------------------------------------------
 * The catalogue
 * ---------------------------------------------------------------------- */

function Catalogue({ plans, currentCode }: { plans: CataloguePlan[]; currentCode: string | null }) {
  // Every key any plan mentions, in the order the core module defines them.
  const keys = FEATURE_KEYS.filter((key) =>
    plans.some((p) => p.features.some((f) => f.key === key)),
  );

  const valueFor = (plan: CataloguePlan, key: string): string => {
    const row = plan.features.find((f) => f.key === key);
    return row ? limitText(key, row.limitValue) : '—';
  };

  return (
    <>
      {/* Phones get a card per plan. A two-column table at 320px would either
          scroll sideways or squeeze the Bengali labels into stubs. */}
      <div className="flex flex-col gap-3 md:hidden">
        {plans.map((plan) => (
          <article
            key={plan.code}
            className={cn(
              'rounded-card border-rule bg-surface border p-4',
              plan.code === currentCode && 'border-income',
            )}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-ink text-base font-semibold">{plan.name}</h3>
              {plan.code === currentCode ? (
                <span className="bg-income/10 text-income rounded-full px-2 py-0.5 text-[11px] font-medium">
                  এখন এটিই চালু
                </span>
              ) : null}
            </div>
            <div className="mt-1">
              <PlanPrice priceMinor={plan.priceMinor} interval={plan.interval} />
            </div>

            <dl className="border-rule mt-3 flex flex-col gap-1.5 border-t pt-3">
              {keys.map((key) => (
                <div key={key} className="flex min-w-0 items-baseline justify-between gap-2">
                  <dt className="text-ink-muted min-w-0 truncate text-xs">{featureLabel(key)}</dt>
                  <dd className="text-ink shrink-0 text-xs">{valueFor(plan, key)}</dd>
                </div>
              ))}
            </dl>

            <p className="text-ink-muted mt-3 flex items-center gap-1.5 text-[11px]">
              <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden />
              আপগ্রেড এখনও চালু হয়নি
            </p>
          </article>
        ))}
      </div>

      {/* Desktop gets the comparison table, in its own scroller so a third tier
          can never push the page sideways. */}
      <div className="rounded-card border-rule bg-surface hidden overflow-x-auto border md:block">
        <table className="w-full min-w-[32rem] text-sm">
          <caption className="text-ink-muted px-4 py-3 text-left text-xs">
            দাম খসড়া, আর এখান থেকে কিছু কেনা যায় না।
          </caption>
          <thead>
            <tr className="border-rule border-y">
              <th scope="col" className="text-ink-muted px-4 py-2 text-left text-xs font-medium">
                সুবিধা
              </th>
              {plans.map((plan) => (
                <th key={plan.code} scope="col" className="px-4 py-2 text-right">
                  <span className="text-ink block font-semibold">{plan.name}</span>
                  <span className="text-ink-muted block text-xs font-normal">
                    {plan.priceMinor <= 0 ? 'ফ্রি' : 'খসড়া দাম'}
                  </span>
                  {plan.code === currentCode ? (
                    <span className="text-income block text-[11px] font-medium">এখন এটিই চালু</span>
                  ) : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-rule divide-y">
            <tr>
              <th scope="row" className="text-ink-muted px-4 py-2 text-left text-xs font-medium">
                মাসিক দাম
              </th>
              {plans.map((plan) => (
                <td key={plan.code} className="px-4 py-2 text-right">
                  <PlanPrice
                    priceMinor={plan.priceMinor}
                    interval={plan.interval}
                    className="justify-end"
                  />
                </td>
              ))}
            </tr>
            {keys.map((key) => (
              <tr key={key}>
                <th scope="row" className="text-ink px-4 py-2 text-left text-xs font-normal">
                  {featureLabel(key)}
                </th>
                {plans.map((plan) => (
                  <td key={plan.code} className="text-ink px-4 py-2 text-right text-xs">
                    {valueFor(plan, key)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
