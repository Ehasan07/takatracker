'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Pencil, PackageX, Undo2 } from '@/components/icons';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import * as React from 'react';
import { SkeletonCard } from '@/components/skeleton';
import { Button } from '@/components/ui/button';
import { haptic } from '@/lib/haptics';
import { bnDate, bnNum } from '../../labels';
import { Fact, NotFoundScreen, QueryError } from '../../parts';
import { isNotHere } from '../../queries';
import {
  FALLBACK_PLAN_WARNING,
  intervalLabel,
  isSeededPlan,
  NO_DELETE,
  OFF_SALE,
  OFF_SALE_MEANS,
  SEEDED_PLAN_HISTORY,
} from '../labels';
import { DefaultPlanPill, Note, OffSalePill, PlanPrice, WorkspaceCountRail } from '../parts';
import { PlanFormSheet } from '../plan-form-sheet';
import { fetchAdminPlans, planAdminKeys } from '../queries';
import { LimitsEditor } from './limits-editor';
import { RetireSheet } from './retire-sheet';

/**
 * One package: what it costs, who can buy it, how many customers are on it, and
 * what it grants.
 *
 * There is one read behind this and the list — `GET /admin/plans` returns every
 * package, so the detail is a `find` over the same cache rather than a second
 * request that could disagree with the first. A code that is not in it is not a
 * package, and gets the panel's ordinary not-found page, exactly as a 404 from
 * the API would.
 */
export default function AdminPlanDetailPage() {
  const params = useParams<{ code: string }>();
  const code = React.useMemo(() => {
    const raw = params?.code ?? '';
    try {
      return decodeURIComponent(raw);
    } catch {
      // A malformed escape in the URL is not a package either.
      return raw;
    }
  }, [params]);

  const plans = useQuery({ queryKey: planAdminKeys.list(), queryFn: fetchAdminPlans });

  const [gone, setGone] = React.useState(false);
  const [editOpen, setEditOpen] = React.useState(false);
  const [retireOpen, setRetireOpen] = React.useState(false);

  const onGone = React.useCallback(() => setGone(true), []);

  if (gone || isNotHere(plans.error)) return <NotFoundScreen />;

  if (plans.isError) {
    return <QueryError message="প্যাকেজটি আনা যায়নি।" onRetry={() => void plans.refetch()} />;
  }

  if (plans.isLoading || !plans.data) {
    return (
      <div className="flex flex-col gap-3" aria-busy>
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  const plan = plans.data.find((row) => row.code === code) ?? null;
  if (!plan) return <NotFoundScreen />;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Link
        href="/admin/plans"
        onClick={() => haptic('tap')}
        className="press text-ink-muted hover:text-ink -ml-1 inline-flex min-h-11 items-center gap-1 self-start text-sm md:min-h-9"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        সব প্যাকেজ
      </Link>

      <header className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h1 className="text-ink min-w-0 text-xl font-extrabold sm:text-2xl">{plan.name}</h1>
          {plan.retired ? <OffSalePill /> : null}
          {plan.isDefault ? <DefaultPlanPill /> : null}
        </div>
        <p className="text-ink-muted break-all text-xs">
          {plan.code} · {intervalLabel(plan.interval)} · {plan.currency}
        </p>
      </header>

      {/* The safety rail, before anything that can be pressed. */}
      <WorkspaceCountRail count={plan.workspaceCount} retired={plan.retired} />

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
          <Pencil className="h-4 w-4" aria-hidden />
          নাম ও দাম
        </Button>
        {/* Disabled rather than hidden for the default package: an operator
            looking for the button should find it, and find out why it will not
            do anything, instead of concluding the screen is broken. The API
            refuses it too — this only saves them the 400. */}
        <Button
          size="sm"
          variant={plan.retired ? 'outline' : 'danger'}
          disabled={plan.isDefault && !plan.retired}
          title={plan.isDefault && !plan.retired ? FALLBACK_PLAN_WARNING : undefined}
          onClick={() => setRetireOpen(true)}
        >
          {plan.retired ? (
            <Undo2 className="h-4 w-4" aria-hidden />
          ) : (
            <PackageX className="h-4 w-4" aria-hidden />
          )}
          {plan.retired ? 'ফিরিয়ে আনুন' : 'অবসরে পাঠান'}
        </Button>
      </div>

      {plan.isDefault && !plan.retired ? <Note>{FALLBACK_PLAN_WARNING}</Note> : null}

      {/* Where a delete button would be, and why it is not. */}
      <Note>{NO_DELETE}</Note>

      {/* An operator who remembers "these reset on deploy" needs telling that
          they no longer do — otherwise they will keep working around a screen
          they believe is about to be overwritten. */}
      {isSeededPlan(plan.code) ? <Note>{SEEDED_PLAN_HISTORY}</Note> : null}

      <section className="rounded-card border-rule bg-surface border-[1.5px] p-4">
        <h2 className="text-ink text-base font-semibold">প্যাকেজ</h2>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
          <Fact
            label="দাম"
            value={<PlanPrice priceMinor={plan.priceMinor} interval={plan.interval} />}
          />
          <Fact label="চক্র" value={intervalLabel(plan.interval)} />
          <Fact label="বিক্রির তালিকায়" value={plan.isPublic ? 'আছে' : `নেই — ${OFF_SALE}`} />
          <Fact label="ক্রম" value={bnNum(plan.sortOrder)} />
          <Fact
            label="ওয়ার্কস্পেস"
            value={plan.workspaceCount === null ? 'জানা যায়নি' : bnNum(plan.workspaceCount)}
          />
          <Fact
            label="অবস্থা"
            value={
              plan.retired
                ? plan.retiredAt
                  ? `${OFF_SALE} — ${bnDate(plan.retiredAt)}`
                  : OFF_SALE
                : 'বিক্রি চলছে'
            }
          />
        </dl>
        {/* One flag, two words. Said here because the facts above use both. */}
        <p className="text-ink-muted mt-3 text-[11px]">{OFF_SALE_MEANS}</p>
      </section>

      <LimitsEditor plan={plan} onGone={onGone} />

      <PlanFormSheet
        mode="edit"
        plan={plan}
        plans={plans.data}
        open={editOpen}
        onOpenChange={setEditOpen}
        onGone={onGone}
      />
      <RetireSheet plan={plan} open={retireOpen} onOpenChange={setRetireOpen} onGone={onGone} />
    </div>
  );
}
