'use client';

import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  BadgeCheck,
  LifeBuoy,
  PauseCircle,
  PlayCircle,
  ShieldAlert,
  SlidersHorizontal,
} from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import * as React from 'react';
import { Money } from '@/components/money';
import { SkeletonCard } from '@/components/skeleton';
import { Button } from '@/components/ui/button';
import { haptic } from '@/lib/haptics';
import { cn } from '@/lib/utils';
import {
  actionLabel,
  bnBytes,
  bnCount,
  bnDate,
  bnDateTime,
  bnNum,
  categoryLabel,
  featureName,
  limitText,
  memberStatusLabel,
  periodLabel,
  roleLabel,
  shortId,
} from '../../labels';
import {
  Caveat,
  Fact,
  LimitValue,
  NotFoundScreen,
  QueryError,
  StatusPill,
  UsageBar,
} from '../../parts';
import { adminKeys, fetchTenant, isNotHere } from '../../queries';
import type { TenantDetail, TenantFeature, TenantOverride } from '../../types';
import { ImpersonateSheet, PlanSheet, StatusSheet } from './actions';
import { OverrideSheet } from './override-sheet';
import { FinancePanel } from './finance-panel';
import { MessagesPanel } from './messages-panel';

export default function AdminTenantPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const tenant = useQuery({
    queryKey: adminKeys.tenant(id),
    queryFn: () => fetchTenant(id),
    enabled: Boolean(id),
  });

  const [planOpen, setPlanOpen] = React.useState(false);
  const [statusOpen, setStatusOpen] = React.useState(false);
  const [impersonateOpen, setImpersonateOpen] = React.useState(false);
  const [overrideKey, setOverrideKey] = React.useState<string | null>(null);

  /* A 404 here is either "you are not an operator" or "there is no such
   * workspace" — the API answers both the same way and so does this screen.
   * Neither one is a page, so neither one gets a page. */
  if (isNotHere(tenant.error)) return <NotFoundScreen />;

  if (tenant.isError) {
    return (
      <QueryError message="ওয়ার্কস্পেসটি আনা যায়নি।" onRetry={() => void tenant.refetch()} />
    );
  }

  if (tenant.isLoading || !tenant.data) {
    return (
      <div className="flex flex-col gap-3">
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  const data = tenant.data;
  const suspended = data.status === 'SUSPENDED';
  const feature = data.features.find((f) => f.key === overrideKey) ?? null;
  const overrideFor = (key: string): TenantOverride | null =>
    data.overrides.find((o) => o.featureKey === key) ?? null;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Link
        href="/admin/tenants"
        onClick={() => haptic('tap')}
        className="press text-ink-muted hover:text-ink -ml-1 inline-flex min-h-11 items-center gap-1 self-start text-sm md:min-h-9"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        সব ওয়ার্কস্পেস
      </Link>

      <header className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h1 className="text-ink min-w-0 text-xl font-semibold sm:text-2xl">{data.name}</h1>
          <StatusPill status={data.status} />
        </div>
        <p className="text-ink-muted break-all text-xs">
          {shortId(data.id)} · {data.timezone} · {data.currency}
        </p>
      </header>

      {/* Actions first: an operator opened this screen to do something. */}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => setPlanOpen(true)}>
          <BadgeCheck className="h-4 w-4" aria-hidden />
          প্ল্যান বসান
        </Button>
        <Button
          size="sm"
          variant={suspended ? 'outline' : 'danger'}
          onClick={() => setStatusOpen(true)}
        >
          {suspended ? (
            <PlayCircle className="h-4 w-4" aria-hidden />
          ) : (
            <PauseCircle className="h-4 w-4" aria-hidden />
          )}
          {suspended ? 'পুনরায় সক্রিয় করুন' : 'স্থগিত করুন'}
        </Button>
        <Button size="sm" variant="outline" onClick={() => setImpersonateOpen(true)}>
          <LifeBuoy className="h-4 w-4" aria-hidden />
          সাপোর্ট সেশন
        </Button>
      </div>

      <section className="rounded-card border-rule bg-surface border p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h2 className="text-ink text-base font-semibold">প্ল্যান ও মালিক</h2>
          {data.plan ? <span className="text-ink-muted text-xs">{data.plan.code}</span> : null}
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
          <Fact
            label="প্ল্যান"
            value={
              data.plan ? (
                <span className="flex flex-wrap items-baseline gap-1.5">
                  {data.plan.name}
                  {data.plan.priceMinor > 0 ? (
                    <Money
                      minor={data.plan.priceMinor}
                      decimals={false}
                      className="text-ink-muted text-xs"
                    />
                  ) : (
                    <span className="text-ink-muted text-xs">ফ্রি</span>
                  )}
                </span>
              ) : (
                'কোনো প্ল্যান নেই'
              )
            }
          />
          <Fact label="মালিক" value={data.owner ? data.owner.name || data.owner.email : '—'} />
          <Fact label="মালিকের ইমেইল" value={data.owner?.email ?? '—'} />
          <Fact label="খোলা হয়েছে" value={bnDate(data.createdAt)} />
          <Fact
            label="ট্রায়াল শেষ"
            value={data.trialEndsAt ? bnDate(data.trialEndsAt) : 'ট্রায়াল নেই'}
          />
          <Fact
            label="শেষ কাজ"
            value={
              data.lastActivityAt ? (
                <span className="flex flex-col">
                  <span>{bnDateTime(data.lastActivityAt)}</span>
                  {data.lastActivityAction ? (
                    <span className="text-ink-muted truncate text-[11px]">
                      {actionLabel(data.lastActivityAction)}
                    </span>
                  ) : null}
                </span>
              ) : (
                'কখনো নয়'
              )
            }
          />
        </dl>
      </section>

      <FinancePanel workspaceId={id} />

      <MessagesPanel workspaceId={id} />

      <section className="rounded-card border-rule bg-surface border p-4">
        <h2 className="text-ink text-base font-semibold">আকার</h2>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          <Fact label="সক্রিয় সদস্য" value={bnNum(data.totals.memberCount)} />
          <Fact label="লেনদেন" value={bnNum(data.totals.transactionCount)} />
          <Fact label="সংযুক্তি" value={bnNum(data.totals.attachmentCount)} />
          <Fact
            label="স্টোরেজ"
            value={
              <span className="flex flex-col">
                <span>{bnBytes(data.totals.storageBytes)}</span>
                <span className="text-ink-muted text-[11px]">
                  {bnCount(data.totals.storageMb)} মেগাবাইট
                </span>
              </span>
            }
          />
        </dl>
      </section>

      <FeaturesSection data={data} onOverride={setOverrideKey} />

      <OverridesSection data={data} onOverride={setOverrideKey} />

      <MembersSection data={data} />

      <PlanSheet tenant={data} open={planOpen} onOpenChange={setPlanOpen} />
      <StatusSheet
        tenant={data}
        action={suspended ? 'reactivate' : 'suspend'}
        open={statusOpen}
        onOpenChange={setStatusOpen}
      />
      <ImpersonateSheet tenant={data} open={impersonateOpen} onOpenChange={setImpersonateOpen} />
      <OverrideSheet
        tenant={data}
        feature={feature}
        override={feature ? overrideFor(feature.key) : null}
        open={feature !== null}
        onOpenChange={(next) => {
          if (!next) setOverrideKey(null);
        }}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------
 * What this tenant is entitled to, and how much of it is gone
 * ---------------------------------------------------------------------- */

function FeaturesSection({
  data,
  onOverride,
}: {
  data: TenantDetail;
  onOverride: (key: string) => void;
}) {
  const groups = React.useMemo(() => {
    const byCategory = new Map<string, TenantFeature[]>();
    for (const feature of data.features) {
      const bucket = byCategory.get(feature.category);
      if (bucket) bucket.push(feature);
      else byCategory.set(feature.category, [feature]);
    }
    return [...byCategory.entries()];
  }, [data.features]);

  return (
    <section className="rounded-card border-rule bg-surface border p-4">
      <h2 className="text-ink text-base font-semibold">সীমা ও সুবিধা</h2>

      {/* An empty `Feature` table is not an empty feature list — the API sends
          four hardcoded rows as a stopgap and says so. Reporting that as the
          catalogue would make somebody grant an override against a key nothing
          can accept. */}
      {!data.catalogueSeeded ? (
        <div className="mt-3">
          <Caveat>
            ফিচার ক্যাটালগ এখনো সিড করা হয়নি — <span className="font-medium">Feature</span> টেবিল
            খালি। নিচের তালিকাটি অস্থায়ী, পুরো ক্যাটালগ নয়, আর এই অবস্থায় কোনো ওভাররাইড বসানোও
            যাবে না। এপিআই একবার চালু হলে ক্যাটালগ নিজেই বসে যায়।
          </Caveat>
        </div>
      ) : null}

      {data.features.length === 0 ? (
        <p className="text-ink-muted mt-3 text-sm">দেখানোর মতো কোনো ফিচার নেই।</p>
      ) : (
        <div className="mt-3 flex flex-col gap-4">
          {groups.map(([category, features]) => (
            <div key={category}>
              <h3 className="text-ink-muted text-xs font-medium">{categoryLabel(category)}</h3>
              <ul className="divide-rule mt-1 flex flex-col divide-y">
                {features.map((feature) => (
                  <li key={feature.key}>
                    <FeatureRow
                      feature={feature}
                      seeded={data.catalogueSeeded}
                      onOverride={() => onOverride(feature.key)}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function FeatureRow({
  feature,
  seeded,
  onOverride,
}: {
  feature: TenantFeature;
  seeded: boolean;
  onOverride: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 py-2.5">
      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-ink truncate text-sm">
            {featureName(feature)}
            {feature.overridden ? (
              <span className="bg-brass/15 text-brass ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium">
                ওভাররাইড
              </span>
            ) : null}
          </p>
          <p className="text-ink-muted truncate text-[11px]" title={feature.key}>
            {feature.key} · {periodLabel(feature.period)}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <LimitValue value={feature.effectiveLimit} kind={feature.kind} unit={feature.unit} />
          {feature.overridden ? (
            <p className="text-ink-muted text-[10px]">
              প্ল্যানে {limitText(feature.planLimit, feature.kind, feature.unit)}
            </p>
          ) : null}
        </div>
      </div>

      <div className="flex min-w-0 items-center gap-3">
        <UsageBar
          used={feature.used}
          limit={feature.effectiveLimit}
          ratio={feature.ratio}
          unit={feature.unit}
          label={`${featureName(feature)} — ব্যবহার`}
        />
        <button
          type="button"
          onClick={() => {
            haptic('tap');
            onOverride();
          }}
          disabled={!seeded}
          className={cn(
            'press touch-target text-ink-muted hover:bg-greenbar -mr-2 flex shrink-0 items-center justify-center rounded-md px-2',
            !seeded && 'pointer-events-none opacity-40',
          )}
          aria-label={`${featureName(feature)} সীমা ওভাররাইড করুন`}
          title={seeded ? 'সীমা ওভাররাইড করুন' : 'ক্যাটালগ সিড না হওয়া পর্যন্ত নয়'}
        >
          <SlidersHorizontal className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------
 * Grants made by hand
 * ---------------------------------------------------------------------- */

function OverridesSection({
  data,
  onOverride,
}: {
  data: TenantDetail;
  onOverride: (key: string) => void;
}) {
  if (data.overrides.length === 0) {
    return (
      <section className="rounded-card border-rule bg-surface border p-4">
        <h2 className="text-ink text-base font-semibold">হাতে দেওয়া ওভাররাইড</h2>
        <p className="text-ink-muted mt-2 text-sm">
          কোনো ওভাররাইড নেই — সব সীমা প্ল্যান থেকেই আসছে।
        </p>
      </section>
    );
  }

  const byKey = new Map(data.features.map((f) => [f.key, f]));

  return (
    <section className="rounded-card border-rule bg-surface border p-4">
      <h2 className="text-ink text-base font-semibold">হাতে দেওয়া ওভাররাইড</h2>
      <ul className="divide-rule mt-2 flex flex-col divide-y">
        {data.overrides.map((override) => {
          const feature = byKey.get(override.featureKey);
          return (
            <li key={override.id} className="flex min-w-0 flex-col gap-1 py-2.5">
              <div className="flex min-w-0 items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-ink truncate text-sm">
                    {feature ? featureName(feature) : override.featureKey}
                    {/* An expired override is still a row in the table. It is
                        not applied, and it is not gone — showing it as either
                        one would be wrong. */}
                    {override.expired ? (
                      <span className="bg-greenbar text-ink-muted ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium line-through">
                        মেয়াদোত্তীর্ণ
                      </span>
                    ) : (
                      <span className="bg-income/10 text-income ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium">
                        চালু
                      </span>
                    )}
                  </p>
                  <p className="text-ink-muted truncate text-[11px]">
                    {override.expiresAt
                      ? `${override.expired ? 'শেষ হয়েছে' : 'শেষ হবে'} ${bnDateTime(override.expiresAt)}`
                      : 'মেয়াদ নেই'}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <LimitValue
                    value={override.limitValue}
                    kind={feature?.kind ?? 'LIMIT'}
                    unit={feature?.unit ?? 'count'}
                    className={override.expired ? 'opacity-60' : undefined}
                  />
                </div>
              </div>

              {override.note ? (
                <p className="text-ink text-xs">&ldquo;{override.note}&rdquo;</p>
              ) : (
                <p className="text-brass text-xs">কোনো নোট নেই।</p>
              )}
              <p className="text-ink-muted text-[11px]">
                {override.grantedBy
                  ? `দিয়েছেন ${override.grantedBy.name || override.grantedBy.email}`
                  : 'কে দিয়েছেন জানা যায়নি'}{' '}
                · {bnDateTime(override.createdAt)}
              </p>

              {feature ? (
                <button
                  type="button"
                  onClick={() => {
                    haptic('tap');
                    onOverride(override.featureKey);
                  }}
                  className="press text-income inline-flex min-h-11 items-center self-start text-xs font-medium md:min-h-9"
                >
                  বদলান বা সরান
                </button>
              ) : (
                /* The catalogue no longer carries this key — a retired feature,
                 * or a row from a database this build has never met. The grant
                 * is still live, so it is shown; there is just nothing to edit
                 * it against. */
                <p className="text-brass text-[11px]">
                  এই ফিচারটি এখনকার ক্যাটালগে নেই, তাই এখান থেকে বদলানো যাচ্ছে না।
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* -------------------------------------------------------------------------
 * Who can sign in
 * ---------------------------------------------------------------------- */

function MembersSection({ data }: { data: TenantDetail }) {
  return (
    <section className="rounded-card border-rule bg-surface border p-4">
      <h2 className="text-ink text-base font-semibold">
        সদস্য <span className="text-ink-muted text-sm">({bnNum(data.members.length)})</span>
      </h2>

      {data.members.length === 0 ? (
        <p className="text-ink-muted mt-2 text-sm">কোনো সদস্য নেই।</p>
      ) : (
        <ul className="divide-rule mt-2 flex flex-col divide-y">
          {data.members.map((member) => (
            <li key={member.membershipId} className="flex min-w-0 items-start gap-2 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-ink truncate text-sm">
                  {member.name || member.email}
                  {member.isSuperAdmin ? (
                    <span className="bg-expense/10 text-expense ml-1.5 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium">
                      <ShieldAlert className="h-3 w-3" aria-hidden />
                      অপারেটর
                    </span>
                  ) : null}
                </p>
                <p className="text-ink-muted truncate text-[11px]">{member.email}</p>
              </div>
              <div className="shrink-0 text-right">
                <p className="text-ink text-xs">{roleLabel(member.role)}</p>
                <p className="text-ink-muted text-[11px]">{memberStatusLabel(member.status)}</p>
                {member.emailVerifiedAt === null ? (
                  <p className="text-brass text-[10px]">ইমেইল যাচাই হয়নি</p>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="text-ink-muted mt-2 text-[11px]">
        {/* Said out loud, because the operator badge above is the only warning
            the impersonation picker gives before the API refuses outright. */}
        অপারেটর চিহ্নিত সদস্যের হয়ে সাপোর্ট সেশন চালু করা যায় না।
      </p>
    </section>
  );
}
