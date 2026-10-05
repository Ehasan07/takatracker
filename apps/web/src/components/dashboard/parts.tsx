'use client';

/**
 * The pieces every panel on this screen is built from: a card with a heading and
 * a stated scope, a failure state, and the badge that says how a figure moved.
 *
 * These are near-twins of `app/(shell)/reports/parts.tsx` and are deliberately
 * not imported from it. That folder belongs to the reports screen and is being
 * reshaped around its own panels; a dashboard whose layout broke because a
 * report changed a prop would be a coupling that buys nothing. Forty lines of
 * duplication is the cheaper of the two.
 */

import { ArrowDownRight, ArrowUpRight, Minus, RotateCw, TriangleAlert } from '@/components/icons';
import * as React from 'react';
import { Money } from '@/components/money';
import { Skeleton } from '@/components/skeleton';
import { Button } from '@/components/ui/button';
import { fmtNumber } from '@/lib/format';
import { t } from '@/lib/t';
import { cn } from '@/lib/utils';
import { changeOf } from './month';

/**
 * Today, but not until the browser has one.
 *
 * "আজ" is a different day on the server than in the browser for anybody reading
 * this near midnight, and a window computed during the server render would
 * hydrate into a different one — and would send the *server's* month to the API.
 * So nothing date-dependent renders until after mount, which is the same reason
 * the reports screen and the loan statement both take their date in an effect.
 */
export function useToday(): Date | null {
  const [today, setToday] = React.useState<Date | null>(null);
  React.useEffect(() => setToday((current) => current ?? new Date()), []);
  return today;
}

/**
 * A dashboard card.
 *
 * `scope` is not decoration. Some of these figures answer "since the 1st" and
 * some answer "all of last month", and a reader who mixes the two up is holding
 * a number that looks right and is not — so every card states which it is,
 * directly under its own name.
 */
export function DashPanel({
  title,
  scope,
  testId,
  className,
  children,
}: {
  title: string;
  scope?: string;
  testId?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      data-testid={testId}
      className={cn('rounded-card border-rule bg-surface border p-4', className)}
    >
      <h2 className="text-ink-muted text-sm font-medium">{title}</h2>
      {scope ? <p className="text-ink-muted mt-0.5 text-xs">{scope}</p> : null}
      {children}
    </section>
  );
}

export function DashSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="mt-3 space-y-2" aria-hidden>
      <Skeleton className="h-7 w-40" />
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-3.5 w-full" />
      ))}
    </div>
  );
}

/** A panel that could not load says so, and offers the one thing that helps. */
export function DashError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="border-rule mt-3 flex flex-col items-center gap-2 rounded-md border border-dashed p-4 text-center"
    >
      <TriangleAlert className="text-expense h-5 w-5" aria-hidden />
      <p className="text-ink text-sm">{message}</p>
      <Button variant="outline" size="sm" className="mt-1" onClick={onRetry}>
        <RotateCw className="h-4 w-4" aria-hidden />
        {t('dashboard.retry', 'আবার চেষ্টা করুন')}
      </Button>
    </div>
  );
}

/**
 * How a figure moved, in four signals at once.
 *
 * The arrow says it by shape, the word says it in Bengali, the amount carries
 * its own sign, and the colour says it a fourth time. That ordering is the
 * point: one man in twelve cannot separate the red from the green, one of the
 * four themes has no colour to give at all, and the arrow and the word both
 * still work in each of those cases.
 *
 * `goodWhen` is the caller's, because the app cannot know it: income rising is
 * good news and spending rising is not, and a component that coloured both the
 * same way would congratulate somebody on a ৳4,000 increase in their electricity
 * bill.
 *
 * Two things it refuses to print. A percentage change from zero — there is no
 * such percentage, so it says what happened in words instead. And a percentage
 * where the base is a *negative* net, where "50% better than −৳2,000" is a
 * sentence with no meaning; the amount of the change is still exact and is still
 * shown.
 */
export function ChangeNote({
  currentMinor,
  previousMinor,
  goodWhen,
  comparison,
  className,
}: {
  currentMinor: number;
  previousMinor: number;
  goodWhen: 'up' | 'down';
  /** "গত মাসের একই সময়ে" — what this is measured against, named. */
  comparison: string;
  className?: string;
}) {
  const change = changeOf(currentMinor, previousMinor);

  if (change.direction === 'flat') {
    return (
      <p className={cn('text-ink-muted flex flex-wrap items-center gap-x-1 text-xs', className)}>
        <Minus className="h-3 w-3 shrink-0" aria-hidden />
        <span>{t('dashboard.change.same', 'অপরিবর্তিত')}</span>
        <span>· {comparison}</span>
      </p>
    );
  }

  const up = change.direction === 'up';
  const good = up === (goodWhen === 'up');
  const Arrow = up ? ArrowUpRight : ArrowDownRight;
  /* A share of a negative base is not a share of anything. The change itself is
     still an exact number of poisha, so only the percentage is withheld. */
  const share = previousMinor > 0 ? change.tenths : null;

  return (
    <p className={cn('flex flex-wrap items-baseline gap-x-1 text-xs', className)}>
      <span className={cn('flex items-center gap-0.5', good ? 'text-income' : 'text-expense')}>
        <Arrow className="h-3 w-3 shrink-0 self-center" aria-hidden />
        <Money minor={Math.abs(change.deltaMinor)} decimals={false} />
        {share === null ? null : <> ({fmtNumber((share / 10).toFixed(1))}%)</>}{' '}
        {up ? t('dashboard.change.up', 'বেড়েছে') : t('dashboard.change.down', 'কমেছে')}
      </span>
      <span className="text-ink-muted">
        · {comparison} <Money minor={previousMinor} decimals={false} />
      </span>
    </p>
  );
}
