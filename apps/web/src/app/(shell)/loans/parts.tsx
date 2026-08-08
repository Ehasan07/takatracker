'use client';

import { TriangleAlert, RotateCw } from 'lucide-react';
import * as React from 'react';
import { Money } from '@/components/money';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import { haptic } from '@/lib/haptics';
import { cn } from '@/lib/utils';
import { bnNum, statusLabel } from './labels';

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

/** A short-lived status message. No undo here — see UndoToast for that. */
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
      className="toast-enter bg-ink text-paper no-print fixed inset-x-3 z-40 rounded-lg px-4 py-3 text-sm shadow-xl md:inset-x-auto md:bottom-6 md:right-6 md:w-80"
      style={{ bottom: 'calc(5.5rem + env(safe-area-inset-bottom))' }}
    >
      {message}
    </div>
  );
}

/** Destructive actions that cannot be undone ask first — as a sheet, not a modal. */
export function ConfirmSheet({
  open,
  onOpenChange,
  title,
  description,
  body,
  confirmLabel,
  onConfirm,
  pending = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  pending?: boolean;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={title} description={description}>
      <div className="flex flex-col gap-4">
        <p className="text-ink text-sm">{body}</p>
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

export function StatusPill({ status }: { status: string }) {
  const tone =
    status === 'OVERDUE'
      ? 'bg-expense/10 text-expense'
      : status === 'COMPLETED'
        ? 'bg-income/10 text-income'
        : status === 'CANCELLED'
          ? 'bg-greenbar text-ink-muted line-through'
          : 'bg-brass/10 text-brass';

  return (
    <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium', tone)}>
      {statusLabel(status)}
    </span>
  );
}

/**
 * Repayment progress. The bar is the glance; the percentage beside it is the
 * fact, because colour and length are never the only signal.
 */
export function ProgressBar({
  percent,
  label,
  className,
}: {
  percent: number;
  label: string;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        className="bg-greenbar border-rule h-2 min-w-0 flex-1 overflow-hidden rounded-full border"
      >
        <div className="bg-income h-full rounded-full" style={{ width: `${percent}%` }} />
      </div>
      <span className="text-ink-muted shrink-0 text-[11px]">{bnNum(percent)}%</span>
    </div>
  );
}

/** One labelled amount in a summary grid. */
export function Tile({
  label,
  minor,
  tone,
  decimals = false,
}: {
  label: string;
  minor: number;
  tone?: string;
  decimals?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-ink-muted truncate text-xs">{label}</dt>
      <dd>
        <Money minor={minor} className={cn('block text-sm', tone)} decimals={decimals} />
      </dd>
    </div>
  );
}
