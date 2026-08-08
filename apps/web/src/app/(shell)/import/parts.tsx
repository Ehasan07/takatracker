'use client';

/**
 * Local copies of two patterns that also live in `(shell)/loans/parts.tsx`.
 * Duplicated on purpose: a feature folder importing another feature folder's
 * internals is how a de-facto shared module gets created without anyone
 * deciding to create one.
 */

import { RotateCw, TriangleAlert } from 'lucide-react';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import { haptic } from '@/lib/haptics';
import { cn } from '@/lib/utils';

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

/** Destructive actions ask first — as a sheet, not a modal. */
export function ConfirmSheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel,
  onConfirm,
  pending = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  pending?: boolean;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={title} description={description}>
      <div className="flex flex-col gap-4">
        {children}
        <Button
          variant="danger"
          size="block"
          disabled={pending}
          onClick={() => {
            haptic('warn');
            onConfirm();
          }}
        >
          {confirmLabel}
        </Button>
        <Button variant="outline" size="block" onClick={() => onOpenChange(false)}>
          থাক
        </Button>
      </div>
    </Sheet>
  );
}

/** A numbered step heading, so the flow reads as one page and not as a wizard. */
export function StepHeader({
  step,
  title,
  hint,
  done = false,
}: {
  step: string;
  title: string;
  hint?: string;
  done?: boolean;
}) {
  return (
    <div className="flex items-start gap-3">
      <span
        aria-hidden
        className={cn(
          'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold',
          done ? 'bg-income text-white' : 'bg-greenbar text-ink-muted',
        )}
      >
        {step}
      </span>
      <div className="min-w-0">
        <h2 className="text-ink text-base font-semibold">{title}</h2>
        {hint ? <p className="text-ink-muted text-xs">{hint}</p> : null}
      </div>
    </div>
  );
}

/** A short-lived status line. */
export function Notice({
  tone,
  children,
}: {
  tone: 'ok' | 'warn' | 'bad';
  children: React.ReactNode;
}) {
  return (
    <p
      role={tone === 'bad' ? 'alert' : 'status'}
      className={cn(
        'rounded-md px-3 py-2 text-sm',
        tone === 'ok' && 'bg-income/10 text-income',
        tone === 'warn' && 'bg-brass/10 text-brass',
        tone === 'bad' && 'bg-expense/10 text-expense',
      )}
    >
      {children}
    </p>
  );
}
