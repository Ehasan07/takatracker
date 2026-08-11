'use client';

import { FEATURE_KEYS } from '@hishab/core';
import { useQuery } from '@tanstack/react-query';
import { Ban, Check, Info, Lock } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';
import { SkeletonCard, SkeletonRows } from '@/components/skeleton';
import { UsageMeter } from '@/components/usage-meter';
import { api, type EntitlementsDto } from '@/lib/api';
import { cn } from '@/lib/utils';
import { bnNum, featureLabel, featureOf, PlanPrice, QueryError, unitSuffix } from './parts';
import { fetchCatalogue, planKeys, type CataloguePlan } from './queries';
import { CONTACT, PAYMENT_URL } from '@/app/(marketing)/content';

/**
 * The snapshot, plus the field that replaced the guesswork.
 *
 * `measured` is the server's own list of which keys in `usage` are a real
 * measurement rather than a placeholder zero. This screen used to keep that
 * list as a `const` — three keys, written down by hand — and it went stale the
 * day storage, mailbox connections and ingested messages started being counted:
 * the page went on saying "ব্যবহার এখনও গোনা হয় না" beside numbers that were,
 * in fact, being enforced. A limit that reads as unmeasured while a 402 is
 * waiting behind it is the same lie as an empty bar on a limit nobody counts,
 * only in the other direction. So the list comes from the thing that knows.
 *
 * `EntitlementsDto` in `lib/api.ts` does not carry the field yet, so it is
 * widened here rather than there.
 */
interface Snapshot extends EntitlementsDto {
  measured?: string[];
}

const fetchSnapshot = (): Promise<Snapshot> => api<Snapshot>('/entitlements');

/**
 * One feature as this screen needs it: a Bengali name, a kind and a unit.
 *
 * Sourced from `GET /v1/entitlements/features`, the catalogue endpoint, so a
 * limit created by a super admin after this build shipped still renders as
 * "মাসিক এআই টোকেন" and not as `ai.tokens.monthly`. Note the flip: on that
 * endpoint `label` is the **Bengali** string (`labelEn` is the English one),
 * which is the opposite way round from the column names.
 */
interface FeatureView {
  key: string;
  label: string;
  /** LIMIT | FLAG | QUOTA, widened — the catalogue is data now, not a union. */
  kind: string;
  unit: string;
  isActive: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

async function fetchFeatureViews(): Promise<FeatureView[]> {
  const raw = await api<unknown>('/entitlements/features');
  const rows = Array.isArray(raw) ? raw : [];
  return rows.map((entry, index): FeatureView => {
    const row = isRecord(entry) ? entry : {};
    const key = typeof row.key === 'string' && row.key !== '' ? row.key : `feature-${index}`;
    return {
      key,
      label: typeof row.label === 'string' && row.label !== '' ? row.label : featureLabel(key),
      kind: typeof row.kind === 'string' ? row.kind : 'LIMIT',
      unit: typeof row.unit === 'string' ? row.unit : 'count',
      isActive: row.isActive === undefined ? true : row.isActive === true,
    };
  });
}

/**
 * What to show when the catalogue cannot be fetched.
 *
 * The shipped defaults, which is what every install has on day one. Fewer
 * features than the server really has, but each one correctly named — better
 * than an empty screen on a page somebody landed on because they were refused
 * something.
 */
const FALLBACK_VIEWS: FeatureView[] = FEATURE_KEYS.map((key) => {
  const definition = featureOf(key);
  return {
    key,
    label: featureLabel(key),
    kind: definition?.kind ?? 'LIMIT',
    unit: definition?.unit ?? 'count',
    isActive: true,
  };
});

/**
 * A QUOTA is a ceiling that refills each period — near enough a LIMIT that
 * drawing it as one is right, and far better than the alternative, which is
 * that a feature the catalogue classified as QUOTA silently vanishes from the
 * screen that is supposed to list every limit.
 */
const isLimitLike = (kind: string): boolean => kind !== 'FLAG';

/** What one plan grants for one feature, in the catalogue's own words. */
function limitTextFor(view: FeatureView | undefined, limitValue: number | null): string {
  if (view?.kind === 'FLAG') return limitValue === 0 ? 'নেই' : 'আছে';
  if (limitValue === null) return 'সীমাহীন';
  if (limitValue === 0) return 'নেই';
  return `${bnNum(limitValue)}${unitSuffix(view?.unit)}`;
}

/** What a person can actually do today about a limit they have hit. */
const RELIEF: Record<string, string> = {
  'accounts.max': 'কোনো অব্যবহৃত অ্যাকাউন্ট আর্কাইভ করলে একটি জায়গা খালি হয়।',
  'transactions.monthly.max': 'প্রতি মাসের ১ তারিখে এই গণনা আবার শূন্য থেকে শুরু হয়।',
  'members.max': 'কোনো সদস্যকে সরালে একটি জায়গা খালি হয়।',
  'attachments.storage.mb': 'পুরনো সংযুক্তি মুছলে জায়গা ফিরে আসে।',
  'email.connections.max': 'কোনো মেইলবক্স সংযোগ মুছলে একটি জায়গা খালি হয়।',
};

export default function PlansPage() {
  const snapshot = useQuery({ queryKey: planKeys.snapshot(), queryFn: fetchSnapshot });
  const catalogue = useQuery({ queryKey: planKeys.catalogue(), queryFn: fetchCatalogue });

  /* Shared with anything else that needs a feature's name. Decoration rather
   * than content — a failure here falls back to the shipped defaults instead of
   * putting an error state on a page whose real content is the snapshot. */
  const features = useQuery({
    queryKey: ['entitlements', 'features'] as const,
    queryFn: fetchFeatureViews,
    staleTime: 5 * 60_000,
  });

  const views = features.data && features.data.length > 0 ? features.data : FALLBACK_VIEWS;
  const viewOf = React.useMemo(() => {
    const byKey = new Map(views.map((view) => [view.key, view]));
    return (key: string): FeatureView | undefined => byKey.get(key);
  }, [views]);

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
          being refused something — so the next step has to be visible without
          scrolling.

          This used to say purchasing did not exist and the prices were a draft.
          Both stopped being true when the invoice link went live, and a page
          that tells somebody they cannot buy what they are trying to buy is
          worse than no page. What is still true, and is said instead, is that
          the invoice cannot tell us who paid — so the switch is by hand. */}
      <div className="rounded-card border-brand/40 bg-brand-tint border p-3.5">
        <p className="text-ink flex items-start gap-2 text-sm">
          <Info className="text-brand mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            <span className="font-medium">প্রিমিয়াম নিতে চাইলে</span> নিচের বোতাম থেকে পেমেন্ট করুন
            — বিকাশ, নগদ বা কার্ডে। পেমেন্টের পর আমরা আপনার অ্যাকাউন্টে প্রিমিয়াম চালু করে দেব;
            ইনভয়েস থেকে কে দিয়েছেন তা স্বয়ংক্রিয়ভাবে মেলানোর ব্যবস্থা এখনো হয়নি, তাই কাজটি হাতে
            হয়। দরকার হলে হটলাইন{' '}
            <a href={CONTACT.hotlineHref} className="text-brand underline">
              {CONTACT.hotline}
            </a>
            ।
          </span>
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <a
            href={PAYMENT_URL}
            target="_blank"
            /* `noopener` is the security half — without it the payment page
               keeps a live handle back into this one. */
            rel="noopener noreferrer"
            className="press bg-brand text-brand-contrast hover:bg-brand-strong inline-flex min-h-11 items-center rounded-md px-4 text-sm font-medium"
          >
            প্রিমিয়াম কিনুন — মাসে ৳৩৫০
          </a>
          <a
            href={CONTACT.whatsapp}
            target="_blank"
            rel="noopener noreferrer"
            className="press border-rule bg-surface text-ink hover:bg-brand-tint inline-flex min-h-11 items-center rounded-md border px-4 text-sm font-medium"
          >
            হোয়াটসঅ্যাপে জানান
          </a>
        </div>
      </div>

      {snapshot.isError ? (
        <QueryError message="আপনার প্ল্যান আনা যায়নি।" onRetry={() => void snapshot.refetch()} />
      ) : snapshot.isLoading ? (
        <SkeletonCard />
      ) : (
        <CurrentPlan data={snapshot.data} views={views} />
      )}

      <section className="flex flex-col gap-3">
        <div>
          <h2 className="text-ink text-base font-semibold">স্তরগুলো</h2>
          <p className="text-ink-muted text-xs">
            আপনার প্ল্যান কী দেয় আর প্রিমিয়ামে কী বাড়ে, পাশাপাশি।
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
          <Catalogue
            plans={catalogue.data ?? []}
            currentCode={snapshot.data?.plan?.code ?? null}
            views={views}
            viewOf={viewOf}
          />
        )}
      </section>
    </div>
  );
}

/* -------------------------------------------------------------------------
 * What you have, and how much of it is gone
 * ---------------------------------------------------------------------- */

function CurrentPlan({ data, views }: { data: Snapshot | undefined; views: FeatureView[] }) {
  const entitlements = data?.entitlements ?? {};
  const usage = data?.usage ?? {};
  const left = data?.remaining ?? {};

  /* The server's list, not ours. An API too old to send it leaves this empty,
   * and every limit then reports its ceiling with "ব্যবহার এখনও গোনা হয় না" —
   * the cautious end of the mistake. Claiming a measurement nobody took is the
   * other end, and that one is unrecoverable: it makes a bar at zero look like
   * headroom. */
  const measured = React.useMemo(() => new Set(data?.measured ?? []), [data?.measured]);

  /* A retired feature this workspace still has is still worth listing — plans
   * that already granted it keep it. One that is retired *and* switched off is
   * noise. */
  const shown = views.filter((view) => view.isActive || (entitlements[view.key] ?? 0) !== 0);
  const limits = shown.filter((view) => isLimitLike(view.kind));
  const flags = shown.filter((view) => view.kind === 'FLAG');

  const exhausted = limits.filter((view) => {
    const limit = entitlements[view.key] ?? null;
    // Unlimited has no end to reach, an unmeasured limit has no number to
    // compare, and a limit of 0 is a feature you do not have rather than one
    // you have used up.
    if (limit === null || limit <= 0 || !measured.has(view.key)) return false;
    return (usage[view.key] ?? 0) >= limit;
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
            {exhausted.map((view) => view.label).join(', ')} — সীমা শেষ
          </p>
          <ul className="text-ink mt-1 list-disc pl-5 text-xs">
            {exhausted.map((view) => (
              <li key={view.key}>
                {RELIEF[view.key] ?? 'এই সীমা বাড়ানোর ব্যবস্থা এখনও তৈরি হয়নি।'}
              </li>
            ))}
          </ul>
          {exhausted.some((view) => view.key === 'accounts.max') ? (
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
        {limits.map((view) => (
          <LimitRow
            key={view.key}
            view={view}
            limit={entitlements[view.key] ?? null}
            used={usage[view.key] ?? 0}
            left={left[view.key] ?? null}
            measured={measured.has(view.key)}
          />
        ))}
      </div>

      <dl className="border-rule mt-4 grid grid-cols-1 gap-x-4 gap-y-2 border-t pt-3 sm:grid-cols-2">
        {flags.map((view) => {
          const on = (entitlements[view.key] ?? 0) !== 0;
          return (
            <div key={view.key} className="flex min-w-0 items-center justify-between gap-2">
              <dt className="text-ink-muted min-w-0 truncate text-xs">{view.label}</dt>
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
  view,
  limit,
  used,
  left,
  measured,
}: {
  view: FeatureView;
  limit: number | null;
  used: number;
  left: number | null;
  measured: boolean;
}) {
  if (limit === null) {
    return <Plain label={view.label} value="সীমাহীন" />;
  }
  if (limit === 0) {
    return <Plain label={view.label} value="এই প্ল্যানে নেই" muted />;
  }
  if (!measured) {
    return (
      <Plain
        label={view.label}
        value={`সর্বোচ্চ ${bnNum(limit)}${unitSuffix(view.unit)}`}
        note="ব্যবহার এখনও গোনা হয় না"
      />
    );
  }

  return (
    <div>
      <UsageMeter label={view.label} used={used} limit={limit} />
      <p className="mt-0.5 text-[11px]">
        {used >= limit ? (
          <span className="text-expense font-medium">সীমা শেষ</span>
        ) : (
          <span className="text-ink-muted">
            আর {bnNum(left ?? Math.max(0, limit - used))}
            {unitSuffix(view.unit)} বাকি
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

function Catalogue({
  plans,
  currentCode,
  views,
  viewOf,
}: {
  plans: CataloguePlan[];
  currentCode: string | null;
  views: FeatureView[];
  viewOf: (key: string) => FeatureView | undefined;
}) {
  /* Every key any plan mentions, in the catalogue's order — and keys the
   * catalogue has never heard of last, rather than dropped. A package built
   * this afternoon out of a feature invented this morning belongs on this table
   * even if the build predates both. */
  const keys = React.useMemo(() => {
    const order = new Map(views.map((view, index) => [view.key, index]));
    const mentioned = new Set(plans.flatMap((plan) => plan.features.map((f) => f.key)));
    return [...mentioned].sort(
      (a, b) =>
        (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER) ||
        a.localeCompare(b),
    );
  }, [plans, views]);

  /* The plan row carries its own Bengali label from `publicPlans()`; the
   * catalogue is preferred only because it is the same source the enforcement
   * reads. Either way a bare key never reaches the screen. */
  const nameOf = (key: string): string => {
    const view = viewOf(key);
    if (view) return view.label;
    const fromPlan = plans
      .flatMap((plan) => plan.features)
      .find((feature) => feature.key === key && feature.label !== '');
    return fromPlan?.label ?? featureLabel(key);
  };

  const valueFor = (plan: CataloguePlan, key: string): string => {
    const row = plan.features.find((f) => f.key === key);
    return row ? limitTextFor(viewOf(key), row.limitValue) : '—';
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
                  <dt className="text-ink-muted min-w-0 truncate text-xs">{nameOf(key)}</dt>
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
                  {nameOf(key)}
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
