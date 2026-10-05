'use client';

import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { LifeBuoy, Search, ShieldCheck, UserRound } from '@/components/icons';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { SkeletonRows } from '@/components/skeleton';
import { Button } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/field';
import { ApiError } from '@/lib/api';
import { haptic } from '@/lib/haptics';
import { enterSupportSession } from '../impersonation';
import { bnDate, bnNum, memberStatusLabel, roleLabel, workspaceStatusLabel } from '../labels';
import { ActionSheet, NotFoundScreen, QueryError, StatusPill } from '../parts';
import { adminKeys, fetchUsers, isNotHere, startImpersonation, type UserFilters } from '../queries';
import type { UserRow, UserWorkspace } from '../types';

/**
 * Find a person, then step into their books.
 *
 * ## Why this screen exists beside the workspace list
 *
 * A support ticket names a human — an email address, a mobile number, the name
 * they signed up with. It does not name a workspace, which is the one thing
 * `/admin/tenants` needs before it can help. Somebody who belongs to two
 * workspaces could not be found there at all without opening both and reading
 * the member lists.
 *
 * ## Why the door is here rather than only on the tenant page
 *
 * Both doors run the same four steps — `enterSupportSession` — so the two
 * cannot drift apart. What differs is only which one the operator was already
 * looking at when the ticket arrived.
 */
export default function AdminUsersPage() {
  const [typed, setTyped] = React.useState('');
  const [q, setQ] = React.useState('');
  const [entering, setEntering] = React.useState<{
    user: UserRow;
    workspace: UserWorkspace;
  } | null>(null);

  /* Debounced, and it matters more here than on an ordinary search box: every
   * request writes an `admin.user_list_viewed` row, and one row per keystroke
   * is a log nobody can read — which defeats the only thing making a
   * cross-tenant people search reviewable. */
  React.useEffect(() => {
    const timer = setTimeout(() => setQ(typed.trim()), 300);
    return () => clearTimeout(timer);
  }, [typed]);

  const filters: UserFilters = React.useMemo(() => ({ q: q || undefined }), [q]);

  const list = useInfiniteQuery({
    queryKey: adminKeys.users(filters),
    queryFn: ({ pageParam }) => fetchUsers(filters, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const rows = React.useMemo(
    () => (list.data?.pages ?? []).flatMap((page) => page.items),
    [list.data],
  );

  if (isNotHere(list.error)) return <NotFoundScreen />;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h1 className="text-ink text-xl font-extrabold sm:text-2xl">ইউজার খুঁজুন</h1>
        {rows.length > 0 ? (
          <p className="text-ink-muted text-xs">
            {bnNum(rows.length)}জন দেখানো হচ্ছে
            {list.hasNextPage ? ', আরও আছে' : ''}
          </p>
        ) : null}
      </header>

      <div className="relative">
        <Search
          className="text-ink-muted pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2"
          aria-hidden
        />
        <Input
          aria-label="নাম, ইমেইল বা মোবাইল নম্বর দিয়ে খুঁজুন"
          placeholder="নাম, ইমেইল বা মোবাইল…"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          type="search"
          enterKeyHint="search"
          className="pl-9"
        />
      </div>

      <p className="text-ink-muted text-xs">প্রতিটি খোঁজ কার্যবিবরণীতে আপনার নাম-সহ লেখা হয়।</p>

      {list.isError ? (
        <QueryError message="ইউজারের তালিকা আনা যায়নি।" onRetry={() => void list.refetch()} />
      ) : list.isLoading ? (
        <div className="rounded-card border-rule bg-surface overflow-hidden border-[1.5px]">
          <SkeletonRows rows={5} />
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-card border-rule border-[1.5px] border-dashed p-8 text-center">
          <UserRound className="text-ink-muted mx-auto h-6 w-6" aria-hidden />
          <p className="text-ink mt-2">{q ? 'এই খোঁজে কাউকে পাওয়া যায়নি।' : 'কোনো ইউজার নেই।'}</p>
        </div>
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {rows.map((user) => (
              <li key={user.id}>
                <UserCard
                  user={user}
                  onEnter={(workspace) => {
                    haptic('tap');
                    setEntering({ user, workspace });
                  }}
                />
              </li>
            ))}
          </ul>

          {list.hasNextPage ? (
            <Button
              variant="outline"
              disabled={list.isFetchingNextPage}
              onClick={() => void list.fetchNextPage()}
            >
              {list.isFetchingNextPage ? 'আনা হচ্ছে…' : 'আরও দেখুন'}
            </Button>
          ) : (
            <p className="text-ink-muted py-2 text-center text-xs">এটুকুই — আর কিছু নেই।</p>
          )}
        </>
      )}

      {entering ? (
        <EnterSheet
          user={entering.user}
          workspace={entering.workspace}
          open
          onOpenChange={(open) => {
            if (!open) setEntering(null);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Whether this row can be walked through, and if not, why.
 *
 * Every refusal here is one the API makes too — an operator, a membership that
 * is not active, a workspace that is suspended or cancelled. Stating them on
 * the button rather than in a 400 is the difference between "why is this
 * greyed out" and "why did that fail".
 */
function blockedReason(user: UserRow, workspace: UserWorkspace): string | null {
  if (user.isSuperAdmin) return 'একজন অপারেটরের হয়ে সেশন চালু করা যায় না';
  if (workspace.membershipStatus !== 'ACTIVE') return 'এই ওয়ার্কস্পেসে সদস্যপদ সক্রিয় নয়';
  if (workspace.status === 'SUSPENDED' || workspace.status === 'CANCELLED') {
    return 'স্থগিত বা বাতিল ওয়ার্কস্পেসে ঢোকা যায় না';
  }
  return null;
}

function UserCard({
  user,
  onEnter,
}: {
  user: UserRow;
  onEnter: (workspace: UserWorkspace) => void;
}) {
  return (
    <div className="rounded-card border-rule bg-surface border-[1.5px] p-3">
      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-ink flex flex-wrap items-center gap-1.5 font-medium">
            <span className="min-w-0 truncate">{user.name}</span>
            {user.isSuperAdmin ? (
              <span className="border-rule text-ink-muted inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]">
                <ShieldCheck className="h-3 w-3" aria-hidden />
                অপারেটর
              </span>
            ) : null}
          </p>
          <p className="text-ink-muted mt-0.5 truncate text-sm">{user.email}</p>
          {user.phone ? <p className="text-ink-muted text-sm">{user.phone}</p> : null}
          <p className="text-ink-muted mt-0.5 text-xs">
            {bnDate(user.createdAt)} থেকে
            {user.emailVerified ? '' : ' · ইমেইল যাচাই হয়নি'}
            {user.deletionRequestedAt ? ' · মুছে ফেলার অনুরোধ আছে' : ''}
          </p>
        </div>
      </div>

      {user.workspaces.length === 0 ? (
        <p className="text-ink-muted mt-2 text-xs">কোনো ওয়ার্কস্পেসে নেই — ঢোকার মতো কিছু নেই।</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-1.5">
          {user.workspaces.map((workspace) => {
            const blocked = blockedReason(user, workspace);
            return (
              <li
                key={workspace.id}
                className="border-rule flex flex-wrap items-center gap-x-2 gap-y-1 border-t pt-1.5"
              >
                <Link
                  href={`/admin/tenants/${workspace.id}`}
                  onClick={() => haptic('tap')}
                  className="text-ink min-w-0 flex-1 truncate text-sm underline-offset-2 hover:underline"
                >
                  {workspace.name}
                </Link>
                <span className="text-ink-muted text-xs">
                  {roleLabel(workspace.role)}
                  {workspace.membershipStatus === 'ACTIVE'
                    ? ''
                    : ` · ${memberStatusLabel(workspace.membershipStatus)}`}
                </span>
                <StatusPill status={workspace.status} />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={blocked !== null}
                  title={blocked ?? undefined}
                  onClick={() => onEnter(workspace)}
                >
                  <LifeBuoy className="h-4 w-4" aria-hidden />
                  ঢুকুন
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * The reason, and then the door.
 *
 * Same wording as the sheet on the workspace page, because it is the same act
 * and an operator should not have to read two different accounts of what they
 * are about to do. The one sentence that is not on that sheet is the fourth
 * below: a session is read-only, which is what keeps a support visit out of the
 * customer's books entirely rather than merely audited.
 */
function EnterSheet({
  user,
  workspace,
  open,
  onOpenChange,
}: {
  user: UserRow;
  workspace: UserWorkspace;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const [reason, setReason] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  const start = useMutation({
    mutationFn: () => startImpersonation(workspace.id, { userId: user.id, reason: reason.trim() }),
    onSuccess: (envelope) => {
      haptic('warn');
      enterSupportSession(envelope, queryClient, router);
      onOpenChange(false);
    },
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : 'সাপোর্ট সেশন চালু করা যায়নি'),
  });

  return (
    <ActionSheet
      open={open}
      onOpenChange={onOpenChange}
      title="সাপোর্ট সেশন চালু করুন"
      description={`${user.name || user.email} — ${workspace.name}`}
      destructive
      canSubmit={reason.trim().length >= 5}
      pending={start.isPending}
      error={error}
      confirmLabel="সেশন চালু করুন"
      onConfirm={() => {
        setError(null);
        start.mutate();
      }}
      fields={
        <Field
          label="কারণ"
          htmlFor="eu-reason"
          error={
            reason.length > 0 && reason.trim().length < 5
              ? 'অন্তত পাঁচটি অক্ষর লিখুন — কারণ ছাড়া সেশন পর্যালোচনা করা যায় না।'
              : undefined
          }
        >
          <Textarea
            id="eu-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            minLength={5}
            maxLength={500}
            required
            placeholder="কোন টিকিট, কী দেখা দরকার"
          />
        </Field>
      }
      summary={
        <>
          <p>
            আপনি <span className="font-medium">{workspace.name}</span>-এ{' '}
            <span className="font-medium">{user.name || user.email}</span> (
            {roleLabel(workspace.role)}) হিসেবে তাঁদের নিজের পর্দা দেখবেন।
          </p>
          <p className="mt-1">
            সেশনটি <span className="font-medium">এক ঘণ্টা</span> চলে, রিফ্রেশ হয় না, আর আপনার নিজের
            সেশন অক্ষত থাকে।
          </p>
          <p className="mt-1">
            <span className="font-medium">আপনি লিখতেও পারবেন</span> — লেনদেন, সেটিংস, সবকিছু। যা
            করবেন তা তাঁদের নিজের বইয়ে তাঁদের নামেই বসবে, আর কার্যবিবরণীর প্রতিটি সারির পাশে আপনার
            নাম লেখা থাকবে। পাসওয়ার্ড বদল, ডিভাইস রিভোক আর ডেটা এক্সপোর্ট বন্ধ থাকে।
          </p>
          <p className="mt-1">
            শুরু ও শেষ দুটোই ওই ওয়ার্কস্পেসের কার্যবিবরণীতে আপনার নাম-সহ লেখা হবে, আর গ্রাহক তা
            দেখতে পাবেন। ওয়ার্কস্পেসের অবস্থা: {workspaceStatusLabel(workspace.status)}।
          </p>
        </>
      }
    />
  );
}
