'use client';

/**
 * The small pieces the report panels are built from: a filter chip, a Bengali
 * error state, a panel shell that always says what period it is about, and the
 * period-on-period comparison badge.
 */

import { ArrowDownRight, ArrowUpRight, Minus, RotateCw, TriangleAlert } from '@/components/icons';
import * as React from 'react';
import { Money } from '@/components/money';
import { Skeleton } from '@/components/skeleton';
import { Button } from '@/components/ui/button';
import { haptic } from '@/lib/haptics';
import { cn } from '@/lib/utils';
import { bnNum } from './range';

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

/**
 * A segmented control: two or three ways of looking at the same thing, all of
 * them visible at once.
 *
 * A `<select>` was here first and it is the wrong shape for this. Choosing
 * between খাত and উপ-খাত, or between আয় and খরচ, is something somebody does
 * four times in a row *while looking at the chart* — and on a phone a native
 * picker covers the chart every time it opens. Buttons cost one tap each, show
 * both answers at once, and never hide what they are changing.
 *
 * `aria-pressed` rather than a radio group: a radio group owes the reader
 * arrow-key navigation and a roving tabstop, and two or three independently
 * tabbable buttons is the simpler promise to keep. The group is named, so a
 * screen reader announces what the pressed button is a choice *about*.
 */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (next: T) => void;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        'border-rule bg-greenbar inline-flex max-w-full shrink-0 gap-0.5 overflow-hidden rounded-full border p-0.5',
        className,
      )}
    >
      {options.map(([key, text]) => (
        <button
          key={key}
          type="button"
          aria-pressed={value === key}
          onClick={() => {
            haptic('tap');
            onChange(key);
          }}
          className={cn(
            /* 44px on a finger, tighter under a mouse — the same floor `Chip`
               keeps, and the reason this is not a row of 32px pills. */
            'press flex min-h-11 min-w-0 items-center justify-center rounded-full px-3 text-sm md:min-h-8',
            value === key
              ? 'bg-surface text-ink font-medium shadow-sm'
              : 'text-ink-muted hover:text-ink',
          )}
        >
          <span className="truncate">{text}</span>
        </button>
      ))}
    </div>
  );
}

/** Every query gets one of these instead of a blank panel or an English fallback. */
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
      className="border-rule mt-3 flex flex-col items-center gap-2 rounded-md border border-dashed p-4 text-center"
    >
      <TriangleAlert className="text-expense h-5 w-5" aria-hidden />
      <p className="text-ink text-sm">{message}</p>
      <p className="text-ink-muted text-xs">ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।</p>
      <Button variant="outline" size="sm" className="mt-1" onClick={onRetry}>
        <RotateCw className="h-4 w-4" aria-hidden />
        আবার চেষ্টা করুন
      </Button>
    </div>
  );
}

/**
 * A report panel.
 *
 * `scope` is not decoration. Some of these numbers answer "between these two
 * dates" and some answer "right now", and a reader who mixes the two up gets a
 * figure that looks right and is not — so every panel states which it is.
 */
export function Panel({
  title,
  scope,
  action,
  children,
  className,
  testId,
}: {
  title: string;
  scope: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <section
      data-testid={testId}
      className={cn('rounded-card border-rule bg-surface border p-4', className)}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-ink-muted text-sm font-medium">{title}</h2>
          <p className="text-ink-muted mt-0.5 text-xs">{scope}</p>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function PanelSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="mt-3 space-y-2" aria-hidden>
      <Skeleton className="h-7 w-40" />
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-3.5 w-full" />
      ))}
    </div>
  );
}

/**
 * This period against the previous equivalent one.
 *
 * The arrow, the word and the colour all say the same thing: colour alone is
 * never the signal, and "up" is good for income and bad for spending, so the
 * caller says which way is which.
 *
 * The percentage is display-only, taken from integer poisha and rounded by
 * integer maths — `Math.round` is banned here and a float never goes near an
 * amount. When there is nothing to compare against, it says so rather than
 * printing an infinity.
 */
export function Delta({
  currentMinor,
  previousMinor,
  goodWhen,
  comparison,
}: {
  currentMinor: number;
  previousMinor: number;
  goodWhen: 'up' | 'down';
  /** "গত মাসের তুলনায়" — which period this is measured against. */
  comparison: string;
}) {
  if (previousMinor === 0) {
    return <p className="text-ink-muted mt-1 text-xs">{comparison} — আগে কিছু ছিল না</p>;
  }

  const change = currentMinor - previousMinor;

  if (change === 0) {
    return (
      <p className="text-ink-muted mt-1 flex flex-wrap items-center gap-x-1 text-xs">
        <Minus className="h-3 w-3 shrink-0" aria-hidden />
        <span>অপরিবর্তিত</span>
        <span>· {comparison}</span>
      </p>
    );
  }

  const up = change > 0;
  const good = up === (goodWhen === 'up');
  // Tenths of a percent, from the absolute change over the absolute base.
  const tenths = Math.floor((Math.abs(change) / Math.abs(previousMinor)) * 1000 + 0.5);
  const Arrow = up ? ArrowUpRight : ArrowDownRight;

  return (
    <p className="mt-1 flex flex-wrap items-baseline gap-x-1 text-xs">
      <span className={cn('flex items-center gap-0.5', good ? 'text-income' : 'text-expense')}>
        <Arrow className="h-3 w-3 shrink-0 self-center" aria-hidden />
        {bnNum((tenths / 10).toFixed(1))}% {up ? 'বেড়েছে' : 'কমেছে'}
      </span>
      <span className="text-ink-muted">
        · {comparison} <Money minor={previousMinor} decimals={false} />
      </span>
    </p>
  );
}
