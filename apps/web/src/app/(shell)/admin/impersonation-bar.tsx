'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, LifeBuoy, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api';
import { haptic } from '@/lib/haptics';
import { purgeCachedData } from '@/lib/session-reset';
import { cn } from '@/lib/utils';
import { bnDateTime, bnRemaining } from './labels';
import { clearSupportSession, hasExpired, useNow, useSupportSession } from './impersonation';
import { endImpersonation } from './queries';

/**
 * The support-mode bar.
 *
 * ## Why it says what it says
 *
 * Everything here is read out of the envelope the API handed back, because
 * there is nothing else to read: the token carries no impersonation claim yet.
 * It names three parties on purpose — the tenant whose data is in play, the
 * person being acted as, and the operator who started it — because a bar that
 * only says "support mode" tells the one person looking at it nothing they can
 * check.
 *
 * The API also returns a ready-made `banner` string. It is not used: it embeds
 * a raw ISO timestamp in Latin digits, which is not a sentence this product
 * shows anybody. The structured fields beside it say the same thing and can be
 * formatted properly.
 *
 * ## Why "শেষ করুন" does not claim to log anybody out
 *
 * `POST /admin/impersonate/end` records the end of the session. It cannot
 * revoke the token — the API says so in its own response `note`, and the only
 * server-side kill switch for an unexpired access token is the customer's
 * `tokenVersion`, which would sign every one of *their* devices out. So this
 * button files the audit row, throws the token away on this device, and the
 * text underneath says plainly that the token stops working when it expires and
 * not before. A "revoke" button that does not revoke is worse than no button.
 */
/** Why the bar is showing a closed notice rather than a live session. */
type ClosedNotice = {
  workspaceName: string;
  workspaceId: string;
  expiresAt: string;
  /** `ended` — the operator pressed the button. `expired` — the clock did it. */
  cause: 'ended' | 'expired';
};

export function ImpersonationBar() {
  const session = useSupportSession();
  const queryClient = useQueryClient();
  const router = useRouter();
  /* The clock stops the moment the token dies: the tick that flips this to
   * false is the last one, and `now` then freezes at the time of expiry. */
  const now = useNow(session !== null && Date.parse(session.expiresAt) > Date.now());
  const [copied, setCopied] = React.useState(false);
  const [closed, setClosed] = React.useState<ClosedNotice | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  /**
   * Leave the customer's screens, and take their data out of the cache with it.
   *
   * Both callers below are the same event seen from two sides: the tab has
   * stopped acting as the customer, but it is still *showing* their dashboard,
   * and every query on it is about to refetch under the operator's own cookie.
   * Without this the screens repaint one panel at a time with the operator's
   * own books under the customer's name in the banner — the worst possible
   * moment to take a screenshot, and the exact confusion the banner exists to
   * prevent. `replace`, not `push`: the customer's pages must not be one Back
   * away from a session that no longer exists.
   */
  const leave = React.useCallback(
    (workspaceId: string) => {
      queryClient.clear();
      /* The service worker's offline copies too. They are keyed by URL, so the
       * customer's `/api/v1/accounts` and the operator's are one entry, and it
       * currently holds the customer's. */
      void purgeCachedData();
      router.replace(workspaceId ? `/admin/tenants/${workspaceId}` : '/admin');
    },
    [queryClient, router],
  );

  /**
   * The token ran out while the operator was reading a screen.
   *
   * `lib/api.ts` stops attaching an expired token, so from this tick onwards
   * every request is the operator's own — the session is over whether or not
   * anybody pressed anything. The envelope is deliberately left in place so the
   * banner can go on saying what just happened, and "শেষ করুন" still files the
   * closing audit row against a session that really did exist.
   */
  const expiredNow = session !== null && hasExpired(session, now);
  const handledExpiry = React.useRef(false);
  React.useEffect(() => {
    if (!expiredNow || !session || handledExpiry.current) return;
    handledExpiry.current = true;
    leave(session.impersonation.workspace.id);
  }, [expiredNow, session, leave]);

  /**
   * The session was torn down by something other than the button.
   *
   * `api()` clears the store on a 401 during a support session — the customer's
   * `tokenVersion` moved, their membership was revoked, the workspace was
   * suspended. The store emptying is the only notice this component gets, and a
   * banner that simply vanished would leave an operator believing they were
   * still inside somebody's books.
   */
  const previous = React.useRef(session);
  React.useEffect(() => {
    const before = previous.current;
    previous.current = session;
    if (!before || session || closed) return;
    setClosed({
      workspaceName: before.impersonation.workspace.name,
      workspaceId: before.impersonation.workspace.id,
      expiresAt: before.expiresAt,
      cause: 'expired',
    });
    leave(before.impersonation.workspace.id);
  }, [session, closed, leave]);

  const end = useMutation({
    mutationFn: () => {
      if (!session) throw new Error('no session');
      return endImpersonation({
        workspaceId: session.impersonation.workspace.id,
        sessionId: session.sessionId || undefined,
        actingAsUserId: session.impersonation.actingAs.id || undefined,
      });
    },
    onSuccess: () => {
      if (!session) return;
      haptic('success');
      const { id: workspaceId, name: workspaceName } = session.impersonation.workspace;
      setClosed({ workspaceName, workspaceId, expiresAt: session.expiresAt, cause: 'ended' });
      /* Cleared before `leave`, so the requests the navigation kicks off are
       * already the operator's own rather than one last round under a token
       * that has just been disowned. */
      clearSupportSession();
      leave(workspaceId);
    },
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : 'সেশন বন্ধের তথ্য পাঠানো যায়নি'),
  });

  if (!session) {
    if (!closed) return null;
    return (
      <div
        role="status"
        className="rounded-card border-income/40 bg-income/10 sticky top-0 z-20 mb-3 border p-3"
      >
        <div className="flex items-start gap-2">
          <Check className="text-income mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-ink text-sm font-medium">
              {closed.cause === 'ended'
                ? `${closed.workspaceName}-এর সাপোর্ট সেশন কার্যবিবরণীতে বন্ধ হিসেবে লেখা হয়েছে।`
                : `${closed.workspaceName}-এর সাপোর্ট সেশন শেষ হয়েছে — আপনি আবার নিজের অ্যাকাউন্টে আছেন।`}
            </p>
            <p className="text-ink-muted mt-0.5 text-xs">
              টোকেনটি এই ডিভাইস থেকে মুছে ফেলা হয়েছে। সার্ভার এটি বাতিল করতে পারে না — এটি{' '}
              {bnDateTime(closed.expiresAt)}-এ নিজে থেকেই মেয়াদোত্তীর্ণ হবে।
            </p>
          </div>
          <button
            type="button"
            onClick={() => setClosed(null)}
            aria-label="এই বার্তা সরান"
            className="press touch-target text-ink-muted hover:bg-surface -mr-2 -mt-1 flex items-center justify-center rounded-md"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </div>
    );
  }

  const { workspace, actingAs, startedBy, reason } = session.impersonation;
  const expired = hasExpired(session, now);

  const copyToken = async (): Promise<void> => {
    haptic('tap');
    try {
      await navigator.clipboard.writeText(session.accessToken);
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    } catch {
      setError('ক্লিপবোর্ড ব্যবহার করা যায়নি');
    }
  };

  return (
    /* Sticky rather than fixed: the shell's <main> is the scroll container, so
       this rides the top of the content and never covers the tab bar. Red while
       live, muted once expired — an expired session is no longer dangerous, but
       the row stays until it is dismissed, because vanishing silently would
       leave an operator believing they were still inside somebody's books. */
    /* `region`, not `alert`. The countdown below rewrites itself every second,
       and a live region would read the whole banner out again each time — an
       assistive technology equivalent of a siren that never stops. The region
       has a name, the heading says what it is, and the one part that changes is
       hidden from the accessibility tree with a fixed time beside it. */
    <div
      role="region"
      aria-label="সাপোর্ট মোড"
      className={cn(
        'rounded-card sticky top-0 z-20 mb-3 border p-3',
        expired
          ? 'border-rule bg-greenbar text-ink'
          : 'border-expense bg-expense text-white shadow-lg',
      )}
    >
      <div className="flex min-w-0 items-start gap-2">
        <LifeBuoy className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">সাপোর্ট মোড {expired ? '— মেয়াদ শেষ' : 'চালু'}</p>
          <p className="mt-0.5 text-xs">
            <span className="font-medium">{workspace.name}</span>-এ{' '}
            <span className="font-medium">{actingAs.name || actingAs.email}</span> হিসেবে।
          </p>
          <p className="mt-0.5 text-xs opacity-90">
            শুরু করেছেন {startedBy.email} · কারণ: {reason}
          </p>
          <p className="mt-0.5 text-xs opacity-90">
            {expired ? (
              `${bnDateTime(session.expiresAt)}-এ মেয়াদ শেষ হয়েছে।`
            ) : (
              <>
                <span aria-hidden>{bnRemaining(session.expiresAt)} · </span>
                {bnDateTime(session.expiresAt)} পর্যন্ত।
              </>
            )}
          </p>
        </div>
      </div>

      <p className="mt-2 text-[11px] opacity-90">
        &ldquo;শেষ করুন&rdquo; কার্যবিবরণীতে সেশনের সমাপ্তি লেখে আর টোকেনটি এই ডিভাইস থেকে মুছে
        দেয়। সার্ভার টোকেনটি বাতিল করতে পারে না — সেটি যেভাবেই হোক পনেরো মিনিটেই মেয়াদোত্তীর্ণ
        হয়।
      </p>

      {error ? (
        <p className="mt-2 text-xs font-medium" role="alert">
          {error}
        </p>
      ) : null}

      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          className="bg-surface"
          disabled={end.isPending}
          onClick={() => {
            setError(null);
            end.mutate();
          }}
        >
          {end.isPending ? 'পাঠানো হচ্ছে…' : 'শেষ করুন'}
        </Button>
        <Button size="sm" variant="outline" className="bg-surface" onClick={() => void copyToken()}>
          {copied ? (
            <Check className="h-4 w-4" aria-hidden />
          ) : (
            <Copy className="h-4 w-4" aria-hidden />
          )}
          {copied ? 'কপি হয়েছে' : 'টোকেন কপি করুন'}
        </Button>
      </div>
    </div>
  );
}
