'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { ApiError } from '@/lib/api';
import { haptic } from '@/lib/haptics';
import { invalidatePlatformCaches } from '../../features/queries';
import { bnNum } from '../../labels';
import { ActionSheet } from '../../parts';
import { isNotHere } from '../../queries';
import { FALLBACK_PLAN_WARNING, NO_DELETE, OFF_SALE_MEANS, RETIRE_MEANS } from '../labels';
import { setPlanRetired } from '../queries';
import type { AdminPlan } from '../types';

/**
 * Withdraw a package from sale, or put it back.
 *
 * This is the closest thing to a delete this screen has, and the summary is
 * mostly about what it is *not*: nobody is moved, nothing is recalculated, no
 * limit changes, no session ends. A retired package keeps enforcing exactly
 * what it enforced yesterday for everybody already on it. The one thing that
 * changes is that nothing new can be sold it.
 */
export function RetireSheet({
  plan,
  open,
  onOpenChange,
  onGone,
}: {
  plan: AdminPlan;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onGone: () => void;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = React.useState<string | null>(null);
  const retiring = !plan.retired;

  React.useEffect(() => {
    if (!open) setError(null);
  }, [open]);

  const save = useMutation({
    mutationFn: () => setPlanRetired(plan.code, retiring),
    onSuccess: () => {
      haptic('success');
      invalidatePlatformCaches(queryClient);
      onOpenChange(false);
    },
    onError: (err) => {
      if (isNotHere(err)) {
        onGone();
        return;
      }
      setError(
        err instanceof ApiError
          ? err.message
          : retiring
            ? 'অবসরে পাঠানো যায়নি'
            : 'ফিরিয়ে আনা যায়নি',
      );
    },
  });

  const count = plan.workspaceCount;

  return (
    <ActionSheet
      open={open}
      onOpenChange={onOpenChange}
      title={retiring ? 'প্যাকেজ অবসরে পাঠান' : 'প্যাকেজ ফিরিয়ে আনুন'}
      description={`${plan.name} (${plan.code})`}
      destructive={retiring}
      canSubmit
      pending={save.isPending}
      error={error}
      confirmLabel={retiring ? 'অবসরে পাঠান' : 'বিক্রির তালিকায় ফেরান'}
      onConfirm={() => {
        setError(null);
        save.mutate();
      }}
      fields={
        <>
          <div className="bg-greenbar flex items-baseline justify-between gap-2 rounded-xl p-3">
            <span className="text-ink-muted text-xs">এখন এই প্যাকেজে</span>
            <span className="text-ink text-sm font-medium">
              {count === null
                ? 'কতটি জানা যায়নি'
                : count === 0
                  ? 'কোনো ওয়ার্কস্পেস নেই'
                  : `${bnNum(count)}টি ওয়ার্কস্পেস`}
            </span>
          </div>

          {retiring ? <p className="text-ink-muted text-xs">{RETIRE_MEANS}</p> : null}
          <p className="text-ink-muted text-xs">{OFF_SALE_MEANS}</p>

          {/* No reason box. The endpoint takes no body, so anything typed here
              would be dropped in transit and the operator would never learn
              that their explanation went nowhere. What is recorded is the audit
              row the server writes: who did it, to which package, and how many
              workspaces stayed on it. */}
          <p className="text-ink-muted text-[11px]">
            এই কাজটি কার্যবিবরণীতে আপনার নাম, প্যাকেজের কোড আর কতটি ওয়ার্কস্পেস এতে রয়ে গেল — সেই
            তিনটি তথ্য নিয়ে লেখা হবে। আলাদা করে কারণ লেখার জায়গা এপিআই-তে নেই।
          </p>
        </>
      }
      summary={
        retiring ? (
          <>
            <p>
              <span className="font-medium">{plan.name}</span> ({plan.code}) বিক্রির তালিকা থেকে সরে
              যাবে — দামের পাতায় ও &ldquo;প্ল্যান বসান&rdquo; তালিকায় আর আসবে না।
            </p>
            <p className="mt-1">
              {count === null
                ? 'এতে কতটি ওয়ার্কস্পেস আছে তা জানা যায়নি — যাঁরা আছেন তাঁরা এতেই থাকবেন।'
                : count === 0
                  ? 'এতে কোনো ওয়ার্কস্পেস নেই।'
                  : `এতে থাকা ${bnNum(count)}টি ওয়ার্কস্পেস এতেই থাকবে।`}{' '}
              তাদের সীমা, তথ্য ও সেশন — কিছুই বদলাবে না, কাউকে অন্য প্যাকেজে সরানোও হবে না।
            </p>
            <p className="mt-1">{NO_DELETE}</p>
            {plan.isDefault ? <p className="mt-1 font-medium">{FALLBACK_PLAN_WARNING}</p> : null}
          </>
        ) : (
          <>
            <p>
              <span className="font-medium">{plan.name}</span> ({plan.code}) আবার বিক্রির তালিকায়
              আসবে।
            </p>
            <p className="mt-1">
              এটি সঙ্গে সঙ্গে দামের পাতায় ও ওয়ার্কস্পেসের &ldquo;প্ল্যান বসান&rdquo; তালিকায় ফিরে
              আসবে।
            </p>
            <p className="mt-1">
              সীমা বা দামের কিছুই বদলাবে না — যেমন রেখে গিয়েছিলেন তেমনই ফিরবে।
            </p>
          </>
        )
      }
    />
  );
}
