'use client';

import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Gauge } from '@/components/icons';
import Link from 'next/link';
import * as React from 'react';
import { SkeletonCard } from '@/components/skeleton';
import { haptic } from '@/lib/haptics';
import { bnBytes, bnCount, bnDate, bnDateTime, bnNum, bnPercent } from './labels';
import { Caveat, NotFoundScreen, QueryError, StatTile, StatusPill } from './parts';
import {
  adminKeys,
  catalogueKeys,
  fetchFeatureCatalogue,
  fetchOverview,
  isNotHere,
} from './queries';
import type { NearLimitBreach, Overview } from './types';

export default function AdminOverviewPage() {
  const overview = useQuery({ queryKey: adminKeys.overview(), queryFn: fetchOverview });

  /* Names for the keys in `measuredFeatures` and in the near-limit sample. The
   * overview sends keys only, and a key is not a Bengali label. Decoration, not
   * content: if this fails the sweep still reads, with the key where a name
   * would have been, so it gets no error state of its own. */
  const catalogue = useQuery({
    queryKey: catalogueKeys.features(),
    queryFn: fetchFeatureCatalogue,
    staleTime: 5 * 60_000,
  });

  const featureName = React.useMemo(() => {
    const names = new Map((catalogue.data ?? []).map((f) => [f.key, f.label]));
    return (key: string): string => names.get(key) ?? key;
  }, [catalogue.data]);

  if (isNotHere(overview.error)) return <NotFoundScreen />;

  if (overview.isError) {
    return (
      <QueryError
        message="প্ল্যাটফর্মের সারসংক্ষেপ আনা যায়নি।"
        onRetry={() => void overview.refetch()}
      />
    );
  }

  if (overview.isLoading || !overview.data) {
    return (
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <SkeletonCard />
          <SkeletonCard />
        </div>
        <SkeletonCard />
      </div>
    );
  }

  const data = overview.data;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        {/* Named so it cannot collide with the shell's phone title bar if a
            "প্ল্যাটফর্ম" nav entry is added later — two headings with the same
            accessible name on one screen is a strict-mode failure for the tests
            that look them up by role. See the note in nav-model.ts. */}
        <h1 className="text-ink text-xl font-semibold sm:text-2xl">প্ল্যাটফর্মের সারসংক্ষেপ</h1>
        <p className="text-ink-muted text-xs">হিসাব করা হয়েছে {bnDateTime(data.generatedAt)}</p>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="মোট ওয়ার্কস্পেস" value={bnNum(data.tenants.total)} />
        <StatTile
          label={`${bnNum(data.signups.windowDays)} দিনে নতুন`}
          value={bnNum(data.signups.total)}
        />
        <StatTile label="মোট লেনদেন" value={bnNum(data.totals.transactions)} />
        <StatTile
          label="মোট স্টোরেজ"
          value={bnBytes(data.totals.storageBytes)}
          note={`${bnCount(data.totals.storageMb)} মেগাবাইট`}
        />
      </div>

      <NearLimitCard data={data} featureName={featureName} />

      <section className="rounded-card border-rule bg-surface border p-4">
        <h2 className="text-ink text-base font-semibold">অবস্থা অনুযায়ী</h2>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
          {Object.entries(data.tenants.byStatus).length === 0 ? (
            <p className="text-ink-muted col-span-full text-sm">কোনো ওয়ার্কস্পেস নেই।</p>
          ) : (
            Object.entries(data.tenants.byStatus).map(([status, count]) => (
              <div key={status} className="flex min-w-0 items-center justify-between gap-2">
                <dt className="min-w-0">
                  <StatusPill status={status} />
                </dt>
                <dd className="text-ink shrink-0 text-sm font-medium">{bnNum(count)}</dd>
              </div>
            ))
          )}
        </dl>
      </section>

      <section className="rounded-card border-rule bg-surface border p-4">
        <h2 className="text-ink text-base font-semibold">প্ল্যান অনুযায়ী</h2>
        <dl className="mt-3 flex flex-col gap-2">
          {data.tenants.byPlan.length === 0 ? (
            <p className="text-ink-muted text-sm">কোনো প্ল্যান বসানো নেই।</p>
          ) : (
            data.tenants.byPlan.map((plan) => (
              <div key={plan.code} className="flex min-w-0 items-baseline justify-between gap-2">
                <dt className="text-ink min-w-0 truncate text-sm">
                  {plan.name}
                  <span className="text-ink-muted ml-1.5 text-xs">{plan.code}</span>
                </dt>
                <dd className="text-ink shrink-0 text-sm font-medium">{bnNum(plan.count)}</dd>
              </div>
            ))
          )}
        </dl>
      </section>

      <SignupsCard data={data} />
    </div>
  );
}

/* -------------------------------------------------------------------------
 * Who is about to run out of something
 * ---------------------------------------------------------------------- */

function NearLimitCard({
  data,
  featureName,
}: {
  data: Overview;
  featureName: (key: string) => string;
}) {
  const near = data.nearLimit;

  return (
    <section className="rounded-card border-rule bg-surface border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-ink flex items-center gap-2 text-base font-semibold">
          <Gauge className="text-brass h-4 w-4" aria-hidden />
          সীমার কাছাকাছি
        </h2>
        <p className="text-ink-muted text-xs">{bnPercent(near.threshold)} বা তার বেশি ব্যবহার</p>
      </div>

      <p className="text-ink mt-2 text-sm">
        <span className="text-2xl font-semibold">{bnNum(near.tenantCount)}</span>টি ওয়ার্কস্পেস —{' '}
        {bnNum(near.tenantsScanned)}টি দেখে।
      </p>

      {/* The sweep stops at 2000 tenants and says so. Presenting a capped count
          as a total would let an operator conclude nobody else is near a limit,
          which is a claim the number cannot support. */}
      {near.truncated ? (
        <div className="mt-2">
          <Caveat>
            গণনা {bnNum(near.tenantsScanned)}টি ওয়ার্কস্পেসে থেমেছে, তাই সংখ্যাটি{' '}
            <span className="font-medium">সর্বনিম্ন — মোট নয়</span>। এর বাইরেও আরও থাকতে পারে।
          </Caveat>
        </div>
      ) : null}

      {/* Which limits could be measured at all. A feature nothing counts cannot
          be near its ceiling, and its absence from this list is why. */}
      <div className="border-rule mt-3 border-t pt-3">
        <p className="text-ink-muted text-xs">যে সীমাগুলো মাপা গেছে</p>
        {near.measuredFeatures.length === 0 ? (
          <p className="text-brass mt-1 text-xs">
            একটিও নয় — এই হিসাবে কোনো সীমা মাপা যায়নি, তাই উপরের শূন্যটি &ldquo;কেউ সীমার কাছে
            নেই&rdquo; বোঝায় না।
          </p>
        ) : (
          <ul className="mt-1 flex flex-wrap gap-1.5">
            {near.measuredFeatures.map((key) => (
              <li
                key={key}
                className="bg-greenbar text-ink rounded-full px-2 py-0.5 text-[11px]"
                title={key}
              >
                {featureName(key)}
              </li>
            ))}
          </ul>
        )}
      </div>

      {near.sample.length > 0 ? (
        <div className="border-rule mt-3 border-t pt-3">
          {/* Always called a sample, because there is no way to tell from the
              payload whether it is complete: it is capped at twenty *breaches*
              while `tenantCount` counts distinct tenants, and one tenant can
              breach several features. Comparing the two numbers would be a
              guess dressed as a fact. */}
          <p className="text-ink-muted text-xs">
            সবচেয়ে কাছের {bnNum(near.sample.length)}টি — নমুনা, পুরো তালিকা নয়
          </p>
          <ul className="mt-2 flex flex-col gap-2">
            {near.sample.map((breach, index) => (
              <li key={`${breach.workspaceId}-${breach.featureKey}-${index}`}>
                <BreachRow breach={breach} featureName={featureName} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function BreachRow({
  breach,
  featureName,
}: {
  breach: NearLimitBreach;
  featureName: (key: string) => string;
}) {
  const over = breach.used >= breach.limit;
  return (
    <Link
      href={`/admin/tenants/${breach.workspaceId}`}
      onClick={() => haptic('tap')}
      className="press border-rule hover:bg-greenbar flex min-h-11 items-center gap-2 rounded-md border px-3 py-2"
    >
      <div className="min-w-0 flex-1">
        <p className="text-ink truncate text-sm">{breach.name}</p>
        <p className="text-ink-muted truncate text-[11px]">
          {featureName(breach.featureKey)}
          {breach.planCode ? ` · ${breach.planCode}` : ''}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <p
          className={over ? 'text-expense money text-sm font-semibold' : 'text-brass money text-sm'}
        >
          {bnPercent(breach.ratio)}
        </p>
        <p className="text-ink-muted money text-[11px]">
          {bnCount(breach.used)} / {bnCount(breach.limit)}
        </p>
      </div>
      <ChevronRight className="text-ink-muted h-4 w-4 shrink-0" aria-hidden />
    </Link>
  );
}

/* -------------------------------------------------------------------------
 * Signups
 * ---------------------------------------------------------------------- */

/**
 * Thirty days of signups as a bar strip.
 *
 * Drawn with divs rather than a chart library: this is one series of thirty
 * small integers, it has to survive a 320px screen, and an operator opening the
 * platform overview on a phone should not pay for a charting runtime to see it.
 * Empty days are bars of zero height because the API sends them — a chart that
 * skipped them would draw a straight line from the 3rd to the 11th and call it
 * steady growth.
 */
function SignupsCard({ data }: { data: Overview }) {
  const daily = data.signups.daily;
  const peak = daily.reduce((max, day) => Math.max(max, day.count), 0);
  const first = daily[0];
  const last = daily.at(-1);

  return (
    <section className="rounded-card border-rule bg-surface border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-ink text-base font-semibold">
          নতুন ওয়ার্কস্পেস — শেষ {bnNum(data.signups.windowDays)} দিন
        </h2>
        <p className="text-ink-muted text-xs">
          মোট {bnNum(data.signups.total)} · সর্বোচ্চ এক দিনে {bnNum(peak)}
        </p>
      </div>

      {daily.length === 0 ? (
        <p className="text-ink-muted mt-3 text-sm">এই সময়ে কোনো নতুন ওয়ার্কস্পেস নেই।</p>
      ) : (
        <>
          <div
            role="img"
            aria-label={`প্রতিদিনের নতুন ওয়ার্কস্পেস, মোট ${bnNum(data.signups.total)}টি, এক দিনে সর্বোচ্চ ${bnNum(peak)}টি`}
            className="mt-3 flex h-16 items-end gap-px"
          >
            {daily.map((day) => (
              <div
                key={day.date}
                title={`${bnDate(day.date)}: ${bnNum(day.count)}`}
                className="bg-greenbar flex min-w-0 flex-1 items-end rounded-sm"
                style={{ height: '100%' }}
              >
                <div
                  className="bg-income w-full rounded-sm"
                  style={{ height: peak === 0 ? '0%' : `${Math.trunc((day.count / peak) * 100)}%` }}
                />
              </div>
            ))}
          </div>
          <div className="text-ink-muted mt-1 flex justify-between text-[11px]">
            <span>{first ? bnDate(first.date) : ''}</span>
            <span>{last ? bnDate(last.date) : ''}</span>
          </div>
        </>
      )}

      {/* Said once. The API buckets every row into one timezone rather than each
          tenant's, because a day boundary that moves per row is not a chart. */}
      <p className="text-ink-muted mt-2 text-[11px]">
        দিনের সীমা একটিই সময়অঞ্চলে ধরা হয়েছে, প্রতিটি ওয়ার্কস্পেসের নিজের সময়ে নয়।
      </p>
    </section>
  );
}
