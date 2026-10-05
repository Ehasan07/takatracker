'use client';

/**
 * The small pieces the tag screens are built from.
 *
 * `QueryError`, `ConfirmSheet` and `Toast` are local copies of patterns that
 * also live in `(shell)/loans/parts.tsx` and `(shell)/categories/page.tsx`.
 * Duplicated on purpose, for the reason written down on the categories screen:
 * a feature folder importing another feature folder's internals is how a
 * de-facto shared module gets created without anyone deciding to create one.
 */

import { RotateCw, TriangleAlert } from '@/components/icons';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import { haptic } from '@/lib/haptics';
import { cn } from '@/lib/utils';
import { safeColour } from './types';

/**
 * A tag's colour, as a dot.
 *
 * Filled when the tag has one, an outline when it does not — so a colourless
 * tag still reads as a tag rather than as a broken one. Colour is never the
 * signal on its own anywhere here: the name is beside it every time.
 */
export function TagDot({ color, className }: { color: string | null; className?: string }) {
  const hex = safeColour(color);
  return (
    <span
      aria-hidden
      className={cn(
        'h-2.5 w-2.5 shrink-0 rounded-full',
        hex ? '' : 'border-ink-muted border border-dashed',
        className,
      )}
      style={hex ? { background: hex } : undefined}
    />
  );
}

/** A tag, drawn. Not interactive — the callers that need a target build one. */
export function TagBadge({
  name,
  color,
  className,
}: {
  name: string;
  color: string | null;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'border-rule text-ink bg-surface inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs',
        className,
      )}
    >
      <TagDot color={color} className="h-2 w-2" />
      <span className="truncate">{name}</span>
    </span>
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
      className="toast-enter bg-ink text-paper no-print fixed inset-x-3 z-40 rounded-lg px-4 py-3 text-sm shadow-xl md:inset-x-auto md:bottom-6 md:right-6 md:w-96"
      style={{ bottom: 'calc(5.5rem + env(safe-area-inset-bottom))' }}
    >
      {message}
    </div>
  );
}

/**
 * Destructive actions ask first — as a sheet, not a modal.
 *
 * `body` is a node so the question can name the number it is about. "Delete
 * this tag?" is a question nobody can answer safely; "delete a word that is on
 * 32 transactions, none of which will be touched" is.
 *
 * `secondary` is the escape hatch beside the destructive button: on the delete
 * question it offers the merge nobody would otherwise find.
 */
export function ConfirmSheet({
  open,
  onOpenChange,
  title,
  description,
  body,
  confirmLabel,
  onConfirm,
  pending = false,
  error = null,
  secondary,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  body: React.ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  pending?: boolean;
  error?: string | null;
  secondary?: { label: string; onClick: () => void; icon?: React.ReactNode };
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={title} description={description}>
      <div className="flex flex-col gap-4">
        <div className="text-ink text-sm">{body}</div>

        {error ? (
          <p role="alert" className="bg-expense/10 text-expense rounded-md px-3 py-2 text-sm">
            {error}
          </p>
        ) : null}

        {secondary ? (
          <Button variant="outline" size="block" onClick={secondary.onClick}>
            {secondary.icon}
            {secondary.label}
          </Button>
        ) : null}

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
