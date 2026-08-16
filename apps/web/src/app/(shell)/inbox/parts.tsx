'use client';

/**
 * Local copies of the two patterns that also live in `(shell)/loans/parts.tsx`
 * and `(shell)/import/parts.tsx`. Duplicated on purpose, for the reason the
 * import folder already gives: a feature folder importing another feature
 * folder's internals is how a de-facto shared module gets created without
 * anyone deciding to create one.
 */

import { Quote, RotateCw, Sparkles, TriangleAlert } from 'lucide-react';
import * as React from 'react';
import { formatMinor } from '@hishab/shared';
import { Money } from '@/components/money';
import { Button } from '@/components/ui/button';
import { haptic } from '@/lib/haptics';
import { cn } from '@/lib/utils';
import type { FieldOrigin } from './evidence';
import { bnNum, statusLabel } from './labels';
import type { DraftView } from './types';

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
      className="rounded-card border-rule bg-surface flex flex-col items-center gap-2 border border-dashed p-6 text-center"
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

/** A filter pill. 44px tall on a finger, tighter under a mouse. */
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

/** A short-lived status message. */
export function Toast({
  message,
  onDismiss,
  seconds = 4,
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
      className="toast-enter bg-ink text-paper no-print fixed inset-x-3 z-[60] rounded-lg px-4 py-3 text-sm shadow-xl md:inset-x-auto md:bottom-6 md:right-6 md:w-80"
      style={{ bottom: 'calc(5.5rem + env(safe-area-inset-bottom))' }}
    >
      {message}
    </div>
  );
}

export function StatusPill({ status }: { status: string }) {
  const tone =
    status === 'ACCEPTED'
      ? 'bg-income/10 text-income'
      : status === 'REJECTED'
        ? 'bg-greenbar text-ink-muted line-through'
        : status === 'DUPLICATE'
          ? 'bg-ink/10 text-ink-muted'
          : 'bg-brass/10 text-brass';

  return (
    <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium', tone)}>
      {statusLabel(status)}
    </span>
  );
}

/**
 * How much of the message the parser understood.
 *
 * Zero is its own thing and says so: the server returns 0 when no amount was
 * read at all, which is not "20% certain", it is "this message claims nothing".
 * The bar is the glance, the words beside it are the fact — length and colour
 * are never the only signal.
 */
export function ConfidenceMeter({
  confidence,
  needsReview,
  className,
}: {
  confidence: number;
  needsReview: boolean;
  className?: string;
}) {
  const percent = Math.min(100, Math.max(0, Math.trunc(confidence)));
  const empty = percent === 0;
  const label = empty ? 'কিছুই পড়া যায়নি' : needsReview ? 'যাচাই করে নিন' : 'ভালোভাবে পড়া গেছে';
  const tone = empty ? 'text-ink-muted' : needsReview ? 'text-brass' : 'text-income';
  const fill = empty ? 'bg-ink-muted' : needsReview ? 'bg-brass' : 'bg-income';

  return (
    <div className={cn('flex min-w-0 items-center gap-2', className)}>
      <div
        role="progressbar"
        aria-label="পড়ার নির্ভরযোগ্যতা"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={`${bnNum(percent)} শতাংশ — ${label}`}
        className="bg-greenbar border-rule h-1.5 w-12 shrink-0 overflow-hidden rounded-full border"
      >
        <div
          className={cn('h-full rounded-full', fill)}
          style={{ width: `${empty ? 100 : percent}%` }}
        />
      </div>
      <span className={cn('truncate text-[11px]', tone)}>
        {empty ? label : `${bnNum(percent)}% · ${label}`}
      </span>
    </div>
  );
}

/**
 * Where a value came from — the distinction the whole screen turns on.
 *
 * A quotation and a guess must never look alike, so they differ in icon, in
 * colour, in shape and in words. `missing` is deliberately quiet: an empty
 * field is a job to do, not a fault.
 */
export function OriginBadge({
  origin,
  quoted,
  className,
}: {
  origin: FieldOrigin;
  quoted?: string;
  className?: string;
}) {
  if (origin === 'read') {
    return (
      <span
        className={cn(
          'text-brass bg-brass/10 inline-flex max-w-full items-center gap-1 rounded px-1.5 py-0.5 text-[11px]',
          className,
        )}
      >
        <Quote className="h-3 w-3 shrink-0" aria-hidden />
        <span className="sr-only">বার্তা থেকে পড়া হয়েছে:</span>
        <span className="truncate font-mono">{quoted}</span>
      </span>
    );
  }

  if (origin === 'guessed') {
    return (
      <span
        className={cn(
          'text-ink-muted border-rule inline-flex items-center gap-1 rounded border border-dashed px-1.5 py-0.5 text-[11px] italic',
          className,
        )}
      >
        <Sparkles className="h-3 w-3 shrink-0" aria-hidden />
        অনুমান — বার্তায় লেখা ছিল না
      </span>
    );
  }

  return (
    <span className={cn('text-ink-muted text-[11px]', className)}>
      বার্তায় পাওয়া যায়নি — নিজে লিখুন
    </span>
  );
}

/**
 * A draft's amount.
 *
 * A message with no figure gets words, not `<Money minor={0} />`: rendering
 * ৳০.০০ would put a number on the screen that nobody ever sent.
 *
 * A message in another currency gets that currency, and the code beside it. Its
 * `amountMinor` is null — there is no taka figure until somebody supplies a rate
 * — so without this the row would read "অঙ্ক পাওয়া যায়নি" for a message whose
 * amount was perfectly legible, and the queue would give no hint which of fifty
 * drafts is the one that needs a statement looked up.
 */
export function DraftAmount({ draft, className }: { draft: DraftView; className?: string }) {
  const tone =
    draft.direction === 'IN'
      ? 'text-income'
      : draft.direction === 'OUT'
        ? 'text-expense'
        : 'text-ink';

  if (draft.fxCurrency && draft.fxAmountMinor !== null) {
    /* The code rather than the symbol, and the paisa rather than a round
       figure. Several countries write `$`, so the symbol alone does not say
       which money this is; and where a taka row rounds ৳1,250.50 to ৳1,251 and
       loses nothing worth seeing, rounding $4.60 to $5 loses a twelfth of it.
       Written out here instead of through `<Money>`, which always prints a
       symbol, so the row reads the same as the review sheet does. */
    return (
      <span className={cn('block', className)}>
        <span className={cn('money font-semibold', tone)}>
          {formatMinor(draft.fxAmountMinor, { currency: draft.fxCurrency, symbol: false })}
        </span>{' '}
        <span className="text-ink-muted text-xs">{draft.fxCurrency}</span>
      </span>
    );
  }

  if (draft.amountMinor === null) {
    return <span className={cn('text-ink-muted text-sm', className)}>অঙ্ক পাওয়া যায়নি</span>;
  }
  return (
    <Money
      minor={draft.amountMinor}
      decimals={false}
      className={cn('block font-semibold', tone, className)}
    />
  );
}
