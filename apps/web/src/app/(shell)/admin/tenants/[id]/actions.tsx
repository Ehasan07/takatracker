'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { Money } from '@/components/money';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { ApiError } from '@/lib/api';
import { haptic } from '@/lib/haptics';
import { enterSupportSession } from '../../impersonation';
import { bnNum, memberStatusLabel, roleLabel, workspaceStatusLabel } from '../../labels';
import { ActionSheet } from '../../parts';
import {
  assignPlan,
  catalogueKeys,
  fetchPlans,
  invalidateAdminData,
  setTenantStatus,
  startImpersonation,
} from '../../queries';
import type { TenantDetail } from '../../types';

const errorText = (err: unknown, fallback: string): string =>
  err instanceof ApiError ? err.message : fallback;

/* -------------------------------------------------------------------------
 * Move a tenant onto a package
 * ---------------------------------------------------------------------- */

/**
 * The picker is fed by `/v1/entitlements/plans`, which returns only `isPublic`
 * packages. There is no admin endpoint that lists every plan, so a bespoke
 * package assembled for one customer cannot be offered from a dropdown — hence
 * the free-text code as a last resort. The server validates it and answers
 * "এই কোডের কোনো প্ল্যান নেই" for a typo, which is shown as-is.
 */
export function PlanSheet({
  tenant,
  open,
  onOpenChange,
}: {
  tenant: TenantDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const plans = useQuery({
    queryKey: catalogueKeys.plans(),
    queryFn: fetchPlans,
    staleTime: 5 * 60_000,
  });

  const [choice, setChoice] = React.useState('');
  const [typedCode, setTypedCode] = React.useState('');
  const [note, setNote] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) {
      setChoice('');
      setTypedCode('');
      setNote('');
      setError(null);
    }
  }, [open]);

  const planCode = (choice === '__other' ? typedCode : choice).trim();
  const picked = (plans.data ?? []).find((p) => p.code === planCode);
  const canSubmit = planCode !== '' && planCode !== tenant.plan?.code;

  const save = useMutation({
    mutationFn: () => assignPlan(tenant.id, { planCode, note: note.trim() || undefined }),
    onSuccess: () => {
      haptic('success');
      invalidateAdminData(queryClient);
      onOpenChange(false);
    },
    onError: (err) => setError(errorText(err, 'প্ল্যান বসানো যায়নি')),
  });

  return (
    <ActionSheet
      open={open}
      onOpenChange={onOpenChange}
      title="প্ল্যান বসান"
      description={tenant.name}
      canSubmit={canSubmit}
      pending={save.isPending}
      error={error}
      confirmLabel="প্ল্যান বসান"
      onConfirm={() => {
        setError(null);
        save.mutate();
      }}
      fields={
        <>
          <div className="bg-greenbar flex items-baseline justify-between gap-2 rounded-md p-3">
            <span className="text-ink-muted text-xs">এখনকার প্ল্যান</span>
            <span className="text-ink text-sm font-medium">
              {tenant.plan ? `${tenant.plan.name} (${tenant.plan.code})` : 'কোনো প্ল্যান নেই'}
            </span>
          </div>

          <Field label="নতুন প্ল্যান" htmlFor="ap-plan">
            <Select
              id="ap-plan"
              value={choice}
              onChange={(e) => setChoice(e.target.value)}
              required
            >
              <option value="" disabled>
                প্ল্যান বেছে নিন
              </option>
              {(plans.data ?? []).map((plan) => (
                <option key={plan.code} value={plan.code}>
                  {plan.name} ({plan.code})
                </option>
              ))}
              <option value="__other">অন্য কোড লিখি…</option>
            </Select>
          </Field>

          {choice === '__other' ? (
            <Field
              label="প্ল্যানের কোড"
              htmlFor="ap-code"
              error={
                typedCode.trim() !== '' && typedCode.trim() === tenant.plan?.code
                  ? 'এই ওয়ার্কস্পেস আগে থেকেই এই প্ল্যানে আছে।'
                  : undefined
              }
            >
              <Input
                id="ap-code"
                value={typedCode}
                onChange={(e) => setTypedCode(e.target.value)}
                placeholder="যেমন CUSTOM_2026"
                autoCapitalize="characters"
                required
              />
            </Field>
          ) : null}

          {/* Optional here, and that is the API's own decision: a package change
              shows up on the tenant's next bill, so it is not the silent kind. */}
          <Field label="কারণ (ঐচ্ছিক)" htmlFor="ap-note">
            <Textarea
              id="ap-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              maxLength={500}
              placeholder="কার অনুরোধে, কোন টিকিটে"
            />
          </Field>
        </>
      }
      summary={
        <>
          <p>
            <span className="font-medium">{tenant.name}</span> সরে যাবে{' '}
            <span className="font-medium">
              {tenant.plan ? tenant.plan.name : 'কোনো প্ল্যান নেই'}
            </span>{' '}
            থেকে <span className="font-medium">{picked ? picked.name : planCode}</span>-এ।
          </p>
          {picked ? (
            <p className="mt-1 flex flex-wrap items-baseline gap-1">
              নতুন দাম:
              {picked.priceMinor > 0 ? (
                <Money minor={picked.priceMinor} decimals={false} className="font-medium" />
              ) : (
                <span className="font-medium">ফ্রি</span>
              )}
            </p>
          ) : (
            <p className="mt-1">এই কোডটি তালিকায় নেই — সার্ভার না চিনলে কিছুই বদলাবে না।</p>
          )}
          <p className="mt-1">
            সীমাগুলো তাদের পরবর্তী অনুরোধ থেকেই বদলে যাবে। হাতে দেওয়া ওভাররাইডগুলো এতে মুছবে না —
            সেগুলো প্ল্যানের উপরে বসেই থাকবে।
          </p>
          {note.trim() ? <p className="mt-1">কারণ: {note.trim()}</p> : null}
        </>
      }
    />
  );
}

/* -------------------------------------------------------------------------
 * Suspend / reactivate
 * ---------------------------------------------------------------------- */

/**
 * `reason` is optional on the API and required here, on suspension only.
 *
 * `JwtStrategy` refuses a token whose workspace is SUSPENDED on the very next
 * request, so this signs every member out mid-session — somebody is going to
 * have to explain that, and the audit row is the only place the explanation can
 * live. Reactivation is not destructive and keeps the field optional.
 */
export function StatusSheet({
  tenant,
  action,
  open,
  onOpenChange,
}: {
  tenant: TenantDetail;
  action: 'suspend' | 'reactivate';
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [reason, setReason] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const suspending = action === 'suspend';

  React.useEffect(() => {
    if (!open) {
      setReason('');
      setError(null);
    }
  }, [open]);

  const save = useMutation({
    mutationFn: () => setTenantStatus(tenant.id, action, reason.trim() || undefined),
    onSuccess: () => {
      haptic('success');
      invalidateAdminData(queryClient);
      onOpenChange(false);
    },
    onError: (err) =>
      setError(errorText(err, suspending ? 'স্থগিত করা যায়নি' : 'পুনরায় সক্রিয় করা যায়নি')),
  });

  return (
    <ActionSheet
      open={open}
      onOpenChange={onOpenChange}
      title={suspending ? 'ওয়ার্কস্পেস স্থগিত করুন' : 'পুনরায় সক্রিয় করুন'}
      description={tenant.name}
      destructive={suspending}
      canSubmit={suspending ? reason.trim().length >= 3 : true}
      pending={save.isPending}
      error={error}
      confirmLabel={suspending ? 'স্থগিত করুন' : 'সক্রিয় করুন'}
      onConfirm={() => {
        setError(null);
        save.mutate();
      }}
      fields={
        <>
          <div className="bg-greenbar flex items-baseline justify-between gap-2 rounded-md p-3">
            <span className="text-ink-muted text-xs">এখনকার অবস্থা</span>
            <span className="text-ink text-sm font-medium">
              {workspaceStatusLabel(tenant.status)}
            </span>
          </div>
          <Field
            label={suspending ? 'কারণ' : 'কারণ (ঐচ্ছিক)'}
            htmlFor="st-reason"
            error={
              suspending && reason.length > 0 && reason.trim().length < 3
                ? 'অন্তত তিনটি অক্ষর লিখুন।'
                : undefined
            }
          >
            <Textarea
              id="st-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              maxLength={500}
              required={suspending}
              placeholder={
                suspending ? 'কেন স্থগিত করা হচ্ছে — টিকিট বা সিদ্ধান্তের সূত্র' : 'ঐচ্ছিক'
              }
            />
          </Field>
        </>
      }
      summary={
        suspending ? (
          <>
            <p>
              <span className="font-medium">{tenant.name}</span> স্থগিত হবে।
            </p>
            <p className="mt-1">
              এর <span className="font-medium">{bnNum(tenant.totals.memberCount)}</span> জন সক্রিয়
              সদস্য পরবর্তী অনুরোধেই লগআউট হয়ে যাবেন — চলমান কাজের মাঝপথে। টোকেনের মেয়াদ শেষ
              হওয়ার অপেক্ষা করা হবে না।
            </p>
            <p className="mt-1">
              তাদের কোনো তথ্য মুছবে না, আর পুনরায় সক্রিয় করলে অবস্থা{' '}
              <span className="font-medium">সক্রিয়</span> হবে — আগে যা ছিল তা নয়।
            </p>
            <p className="mt-1">কারণ: {reason.trim()}</p>
          </>
        ) : (
          <>
            <p>
              <span className="font-medium">{tenant.name}</span> আবার সক্রিয় হবে।
            </p>
            <p className="mt-1">
              অবস্থা <span className="font-medium">সক্রিয়</span> হবে, আগে যা ছিল তা নয় — আগের
              অবস্থা কোথাও রাখা হয় না, আর ট্রায়ালে ফেরালে মেয়াদোত্তীর্ণ ট্রায়াল ফিরে আসত।
            </p>
            {reason.trim() ? <p className="mt-1">কারণ: {reason.trim()}</p> : null}
          </>
        )
      }
    />
  );
}

/* -------------------------------------------------------------------------
 * Support session
 * ---------------------------------------------------------------------- */

/**
 * Start a support session.
 *
 * Three kinds of member are not offered, because the API refuses all three and
 * a picker that lists them would turn a policy into a 400:
 *
 *   another operator  — a token minted for them would carry platform access
 *                        while every audit row inside the session named them
 *   a non-active one  — no active membership, no token
 *   nobody at all     — a suspended or cancelled workspace cannot be entered
 *
 * What comes back is a bearer token for the tenant's own user. It is never
 * written into the session cookie: doing so would replace the operator's own
 * session with the customer's, and every later admin action would be filed
 * against the customer.
 */
export function ImpersonateSheet({
  tenant,
  open,
  onOpenChange,
}: {
  tenant: TenantDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const candidates = tenant.members.filter((m) => m.status === 'ACTIVE' && !m.isSuperAdmin);
  const defaultUserId = tenant.owner?.id ?? '';
  const [userId, setUserId] = React.useState(defaultUserId);
  const [reason, setReason] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) {
      setReason('');
      setError(null);
      setUserId(defaultUserId);
    }
  }, [open, defaultUserId]);

  const target = candidates.find((m) => m.id === userId) ?? candidates[0];

  const start = useMutation({
    mutationFn: () =>
      startImpersonation(tenant.id, {
        userId: target?.id,
        reason: reason.trim(),
      }),
    onSuccess: (envelope) => {
      haptic('warn');
      /* Four steps in a fixed order, shared with the people search so the two
       * doors into a workspace cannot drift apart. See `enterSupportSession`. */
      enterSupportSession(envelope, queryClient, router);
      onOpenChange(false);
    },
    onError: (err) => setError(errorText(err, 'সাপোর্ট সেশন চালু করা যায়নি')),
  });

  const blocked = tenant.status === 'SUSPENDED' || tenant.status === 'CANCELLED';

  return (
    <ActionSheet
      open={open}
      onOpenChange={onOpenChange}
      title="সাপোর্ট সেশন চালু করুন"
      description={tenant.name}
      destructive
      canSubmit={!blocked && candidates.length > 0 && reason.trim().length >= 5}
      pending={start.isPending}
      error={error}
      confirmLabel="সেশন চালু করুন"
      onConfirm={() => {
        setError(null);
        start.mutate();
      }}
      fields={
        <>
          {blocked ? (
            <p
              role="alert"
              className="border-expense/40 bg-expense/10 text-ink rounded-md border p-3 text-sm"
            >
              {workspaceStatusLabel(tenant.status)} ওয়ার্কস্পেসে সাপোর্ট সেশন চালু করা যায় না। আগে
              পুনরায় সক্রিয় করুন।
            </p>
          ) : null}

          {candidates.length === 0 ? (
            <p
              role="alert"
              className="border-rule bg-greenbar text-ink rounded-md border p-3 text-sm"
            >
              যাকে হয়ে দেখা যায় এমন কোনো সক্রিয় সদস্য নেই। অপারেটরের হয়ে সেশন চালু করা যায় না।
            </p>
          ) : (
            <Field label="কার হয়ে দেখবেন" htmlFor="im-user">
              <Select
                id="im-user"
                value={target?.id ?? ''}
                onChange={(e) => setUserId(e.target.value)}
              >
                {candidates.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name || member.email} — {roleLabel(member.role)} (
                    {memberStatusLabel(member.status)})
                  </option>
                ))}
              </Select>
            </Field>
          )}

          <Field
            label="কারণ"
            htmlFor="im-reason"
            error={
              reason.length > 0 && reason.trim().length < 5
                ? 'অন্তত পাঁচটি অক্ষর লিখুন — কারণ ছাড়া সেশন পর্যালোচনা করা যায় না।'
                : undefined
            }
          >
            <Textarea
              id="im-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              minLength={5}
              maxLength={500}
              required
              placeholder="কোন টিকিট, কী দেখা দরকার"
            />
          </Field>
        </>
      }
      summary={
        <>
          <p>
            আপনি <span className="font-medium">{tenant.name}</span>-এর{' '}
            <span className="font-medium">{target?.name || target?.email}</span> (
            {roleLabel(target?.role ?? 'MEMBER')}) হিসেবে তাঁদের নিজের পর্দায় কাজ করবেন।
          </p>
          <p className="mt-1">
            সেশনটি <span className="font-medium">এক ঘণ্টা</span> চলে, রিফ্রেশ হয় না, আর কুকিতে লেখা
            হয় না — আপনার নিজের সেশন অক্ষত থাকবে।
          </p>
          <p className="mt-1">
            <span className="font-medium">আপনি লিখতেও পারবেন</span> — লেনদেন, সেটিংস, সবকিছু। যা
            করবেন তা তাঁদের নিজের বইয়ে তাঁদের নামেই বসবে, আর কার্যবিবরণীর প্রতিটি সারির পাশে আপনার
            নাম লেখা থাকবে। পাসওয়ার্ড বদল, ডিভাইস রিভোক আর ডেটা এক্সপোর্ট বন্ধ থাকে।
          </p>
          <p className="mt-1">
            শুরু ও শেষ দুটোই ওই ওয়ার্কস্পেসের কার্যবিবরণীতে আপনার নাম-সহ লেখা হবে, আর গ্রাহক তা
            দেখতে পাবেন।
          </p>
          <p className="mt-1">
            <span className="font-medium">শেষ করলেও টোকেন বাতিল হয় না</span> — সার্ভারের কাছে সেই
            উপায় নেই। এটি মেয়াদ শেষেই কেবল অচল হয়।
          </p>
          <p className="mt-1">কারণ: {reason.trim()}</p>
        </>
      }
    />
  );
}
