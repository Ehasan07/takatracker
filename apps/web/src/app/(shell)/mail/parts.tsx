'use client';

/**
 * The small pieces the mail screens are built from.
 *
 * `QueryError`, `Chip` and `Toast` are local copies of the patterns in
 * `(shell)/inbox/parts.tsx` and `(shell)/tags/parts.tsx`. Duplicated on purpose,
 * for the reason those files already give: a feature folder importing another
 * feature folder's internals is how a de-facto shared module gets created
 * without anyone deciding to create one.
 */

import { KeyRound, RotateCw, TriangleAlert } from '@/components/icons';
import Link from 'next/link';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { haptic } from '@/lib/haptics';
import { cn } from '@/lib/utils';
import { statusLabel } from './labels';
import type { MailAccountStatus, MailAccountView } from './types';

/** Every query gets one of these instead of a blank screen or an English fallback. */
export function QueryError({
  message = 'তথ্য আনা যায়নি।',
  onRetry,
}: {
  message?: string;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="rounded-card border-rule bg-surface flex flex-col items-center gap-2 border-[1.5px] border-dashed p-6 text-center"
    >
      <TriangleAlert className="text-expense h-6 w-6" aria-hidden />
      <p className="text-ink text-sm">{message}</p>
      <p className="text-ink-muted text-xs">ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।</p>
      <Button variant="outline" size="sm" className="mt-1" onClick={onRetry}>
        <RotateCw className="h-4 w-4" aria-hidden />
        আবার চেষ্টা করুন
      </Button>
    </div>
  );
}

/** A folder tab. 44px tall on a finger, tighter under a mouse. */
export function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={() => {
        haptic('tap');
        onClick();
      }}
      className={cn(
        'press border-rule flex min-h-11 shrink-0 items-center rounded-full border px-3.5 text-sm md:min-h-9',
        active
          ? 'bg-income border-income font-medium text-white'
          : 'bg-surface text-ink hover:bg-greenbar',
      )}
    >
      {children}
    </button>
  );
}

/** A short-lived status message. Long enough to read two sentences of Bengali. */
export function Toast({
  message,
  onDismiss,
  seconds = 6,
}: {
  message: string;
  onDismiss: () => void;
  seconds?: number;
}) {
  React.useEffect(() => {
    const timer = setTimeout(onDismiss, seconds * 1000);
    return () => clearTimeout(timer);
  }, [seconds, onDismiss, message]);

  return (
    <div
      role="status"
      className="toast-enter bg-ink text-paper no-print fixed inset-x-3 z-[60] rounded-lg px-4 py-3 text-sm shadow-xl md:inset-x-auto md:bottom-6 md:right-6 md:w-96"
      style={{ bottom: 'calc(5.5rem + env(safe-area-inset-bottom))' }}
    >
      {message}
    </div>
  );
}

export function StatusPill({ status }: { status: MailAccountStatus }) {
  const tone =
    status === 'ACTIVE'
      ? 'bg-income/10 text-income'
      : status === 'AUTH_FAILED'
        ? 'bg-expense/10 text-expense'
        : 'bg-greenbar text-ink-muted';

  return (
    <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium', tone)}>
      {statusLabel(status)}
    </span>
  );
}

/**
 * A mailbox whose password stopped working, said out loud.
 *
 * This is not decoration and it is not a red dot. `AUTH_FAILED` means the sync
 * worker has **stopped touching the account on purpose** — `dueAccountIds`
 * selects only `ACTIVE` — because presenting a rejected password every fifteen
 * minutes is presenting it ninety-six times a day, and Google answers that by
 * locking the person's whole account, not just our connection.
 *
 * So the wording has to carry three facts a quiet badge cannot: that nothing is
 * arriving, that nothing *will* arrive on its own, and that re-entering the
 * password is the one thing that restarts it. `lastError` is the worker's own
 * Bengali sentence and is shown verbatim underneath — it is the only channel the
 * worker has to reach a person.
 */
export function AuthFailedNotice({
  account,
  onFix,
  className,
}: {
  account: MailAccountView;
  /** Absent on the reading screen, which can only send the user to settings. */
  onFix?: () => void;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        'border-expense/40 bg-expense/10 flex flex-col gap-2 rounded-xl border p-3',
        className,
      )}
    >
      <p className="text-expense flex items-start gap-2 text-sm font-medium">
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <span className="min-w-0 break-words">
          <span className="break-all">{account.email}</span> — সিঙ্ক <strong>বন্ধ হয়ে আছে</strong>।
        </span>
      </p>
      <p className="text-ink text-sm">
        পাসওয়ার্ড কাজ করছে না, তাই নতুন কোনো মেইল আনা হচ্ছে না — এবং নিজে থেকে আর চেষ্টাও করা হবে
        না। একই ভুল পাসওয়ার্ড বারবার দিলে আপনার পুরো ইমেইল অ্যাকাউন্টটিই বন্ধ হয়ে যেতে পারে, তাই
        ইচ্ছা করেই থামিয়ে রাখা হয়েছে। <strong>নতুন পাসওয়ার্ড দিলে তবেই আবার চালু হবে।</strong>
      </p>
      {account.lastError ? (
        <p className="text-ink-muted text-xs">সার্ভার যা বলেছে: {account.lastError}</p>
      ) : null}
      {onFix ? (
        <Button size="sm" className="self-start" onClick={onFix}>
          <KeyRound className="h-4 w-4" aria-hidden />
          নতুন পাসওয়ার্ড দিন
        </Button>
      ) : (
        <Button variant="outline" size="sm" className="self-start" asChild>
          <Link href="/settings">
            <KeyRound className="h-4 w-4" aria-hidden />
            সেটিংসে গিয়ে ঠিক করুন
          </Link>
        </Button>
      )}
    </div>
  );
}

/**
 * The body of an email, on the screen.
 *
 * **Text, and only ever text.** `MailMessage.body` is plain text by contract —
 * `apps/api/src/mail-accounts/mail-body.ts` converts HTML to text on the way in
 * so that no markup is ever stored — and the reason that decision was made is
 * the reason this component exists: *anyone in the world can email the mailbox
 * we are syncing and choose exactly what we store*. The body is
 * attacker-controlled by definition.
 *
 * So it is interpolated as a React child, which produces a text node, and there
 * is no `dangerouslySetInnerHTML` here and there must never be one. `<script>`,
 * `<img onerror=…>` and every mutation-XSS trick reach the screen as the
 * characters they are. That is also the only honest thing to show: the person is
 * reading what their bank actually sent.
 *
 * Line breaks are preserved with `whitespace-pre-wrap` — CSS, not by splitting
 * the string and rebuilding it out of elements. Nothing parses this text.
 */
export function MessageBody({ body, className }: { body: string | null; className?: string }) {
  if (!body || body.trim() === '') {
    return (
      <p
        className={cn(
          'border-rule text-ink-muted rounded-xl border border-dashed p-3 text-sm',
          className,
        )}
      >
        এই বার্তায় পড়ার মতো কোনো লেখা পাওয়া যায়নি — সম্ভবত এটি শুধু ছবি বা সংযুক্তি নিয়ে
        এসেছিল।
      </p>
    );
  }

  return (
    <div
      className={cn(
        'border-rule bg-paper text-ink rounded-xl border p-3',
        // Reading typography, not ledger typography: a longer line height and a
        // measure that stops at ~70 characters on a wide window.
        'text-[15px] leading-7 md:text-base',
        // A 200-character tracking URL in a receipt must wrap, not push the page
        // sideways at 320px.
        'whitespace-pre-wrap break-words [overflow-wrap:anywhere]',
        className,
      )}
    >
      <div className="max-w-[70ch]">{body}</div>
    </div>
  );
}
