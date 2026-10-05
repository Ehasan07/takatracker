'use client';

import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Layers, PackagePlus, Tags } from '@/components/icons';
import Link from 'next/link';
import * as React from 'react';
import { SkeletonCard } from '@/components/skeleton';
import { Button } from '@/components/ui/button';
import { haptic } from '@/lib/haptics';
import { bnNum } from '../labels';
import { NotFoundScreen, QueryError } from '../parts';
import { isNotHere } from '../queries';
import { intervalLabel, isSeededPlan, NO_DELETE, OFF_SALE_MEANS } from './labels';
import { DefaultPlanPill, Note, OffSalePill, PlanPrice, WorkspaceCountBadge } from './parts';
import { fetchAdminPlans, planAdminKeys } from './queries';
import { PlanFormSheet } from './plan-form-sheet';
import type { AdminPlan } from './types';

/**
 * Every package the platform sells, has ever sold, or keeps to itself.
 *
 * `GET /admin/plans` returns all of them — that is the difference between this
 * screen and `/plans`, which reads `/v1/entitlements/plans` and therefore sees
 * only the public ones. A bespoke package assembled for one customer, and a
 * retired tier three tenants are still sitting on, exist only here.
 *
 * The gate is `admin/layout.tsx`: nothing under `/admin` renders until one
 * request has come back 200, and a 404 from any endpoint below renders the
 * panel's ordinary not-found page rather than admitting that anything was
 * refused. This page re-checks only its own query, for the same reason the
 * tenant screens do.
 */
export default function AdminPlansPage() {
  const plans = useQuery({ queryKey: planAdminKeys.list(), queryFn: fetchAdminPlans });
  const [createOpen, setCreateOpen] = React.useState(false);
  const [gone, setGone] = React.useState(false);
  const onGone = React.useCallback(() => setGone(true), []);

  if (gone || isNotHere(plans.error)) return <NotFoundScreen />;

  const rows = plans.data ?? [];
  const live = rows.filter((plan) => !plan.retired);
  const retired = rows.filter((plan) => plan.retired);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h1 className="text-ink text-xl font-semibold sm:text-2xl">প্যাকেজ ও দাম</h1>
        {rows.length > 0 ? (
          <p className="text-ink-muted text-xs">
            {bnNum(live.length)}টি চালু
            {retired.length > 0 ? `, ${bnNum(retired.length)}টি অবসরে` : ''}
          </p>
        ) : null}
      </header>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <PackagePlus className="h-4 w-4" aria-hidden />
          নতুন প্যাকেজ
        </Button>
        <Button size="sm" variant="outline" asChild>
          <Link href="/admin/features" onClick={() => haptic('tap')}>
            <Tags className="h-4 w-4" aria-hidden />
            ফিচার ক্যাটালগ
          </Link>
        </Button>
      </div>

      {plans.isError ? (
        <QueryError message="প্যাকেজের তালিকা আনা যায়নি।" onRetry={() => void plans.refetch()} />
      ) : plans.isLoading ? (
        <div className="flex flex-col gap-3" aria-busy>
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-card border-rule border border-dashed p-8 text-center">
          <Layers className="text-ink-muted mx-auto h-6 w-6" aria-hidden />
          <p className="text-ink mt-2">কোনো প্যাকেজ নেই।</p>
          <p className="text-ink-muted mt-1 text-sm">
            এপিআই চালু হলে বিল্ডের সঙ্গে আসা প্যাকেজগুলো নিজে থেকেই বসে যায়। নিজে একটি বানাতে উপরের
            বোতামটি ব্যবহার করুন।
          </p>
        </div>
      ) : (
        <>
          <section className="flex min-w-0 flex-col gap-2">
            <h2 className="text-ink-muted text-xs font-medium">বিক্রির তালিকায়</h2>
            {live.length === 0 ? (
              <p className="text-ink-muted text-sm">
                একটিও চালু প্যাকেজ নেই — সবগুলোই অবসরে পাঠানো হয়েছে।
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {live.map((plan) => (
                  <li key={plan.code}>
                    <PlanCard plan={plan} />
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Retired packages are listed, not hidden. Tenants are still on
              them, their limits still come from them, and an operator hunting
              for "why does this workspace have 300 transactions" needs to be
              able to open the package that says so. */}
          {retired.length > 0 ? (
            <section className="flex min-w-0 flex-col gap-2">
              <h2 className="text-ink-muted text-xs font-medium">তালিকার বাইরে</h2>
              <p className="text-ink-muted text-xs">
                নতুন কেউ এগুলো নিতে পারে না। যাঁরা আগে থেকে আছেন তাঁরা এতেই আছেন এবং তাঁদের সীমা
                এখান থেকেই আসছে। {OFF_SALE_MEANS}
              </p>
              <ul className="flex flex-col gap-2">
                {retired.map((plan) => (
                  <li key={plan.code}>
                    <PlanCard plan={plan} />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <Note>{NO_DELETE}</Note>
        </>
      )}

      <PlanFormSheet
        mode="create"
        plan={null}
        plans={rows}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onGone={onGone}
      />
    </div>
  );
}

/**
 * A card, not a table row — six facts about a package do not fit across 320px
 * as columns, and the one that matters most is the tenant count, which gets a
 * badge of its own rather than a cell somebody has to scroll to.
 */
function PlanCard({ plan }: { plan: AdminPlan }) {
  return (
    <Link
      href={`/admin/plans/${encodeURIComponent(plan.code)}`}
      onClick={() => haptic('tap')}
      className="press rounded-card border-rule bg-surface hover:bg-greenbar block border p-3.5"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <p className="text-ink truncate text-sm font-medium">{plan.name}</p>
            {plan.retired ? <OffSalePill /> : null}
            {plan.isDefault ? <DefaultPlanPill /> : null}
          </div>
          <p className="text-ink-muted truncate text-xs">
            {plan.code}
            {isSeededPlan(plan.code) ? ' · বিল্ডের সঙ্গে আসা' : ''}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <PlanPrice priceMinor={plan.priceMinor} interval={plan.interval} className="text-sm" />
          <p className="text-ink-muted text-[11px]">{intervalLabel(plan.interval)}</p>
        </div>
        <ChevronRight className="text-ink-muted mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      </div>

      <div className="border-rule mt-2.5 flex flex-wrap items-center gap-2 border-t pt-2.5">
        <WorkspaceCountBadge count={plan.workspaceCount} />
        <span className="text-ink-muted text-[11px]">
          {plan.limits.length === 0
            ? 'কোনো ফিচারের সীমা বসানো নেই'
            : `${bnNum(plan.limits.length)}টি ফিচারের সীমা বসানো`}
        </span>
      </div>
    </Link>
  );
}
