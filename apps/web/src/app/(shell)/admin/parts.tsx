'use client';

import { Ban, FileQuestion, Infinity as InfinityIcon, RotateCw, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';
import { Skeleton } from '@/components/skeleton';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import { haptic } from '@/lib/haptics';
import { cn } from '@/lib/utils';
import {
  bnCount,
  bnNum,
  bnPercent,
  percentOf,
  unitSuffix,
  UNMEASURED,
  workspaceStatusLabel,
} from './labels';

/**
 * Kept local to this route rather than shared out of `loans/` or `audit/`, the
 * same way `plans/parts.tsx` keeps its own: a change in one feature folder
 * cannot break another.
 */
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

/**
 * What a 404 from any admin endpoint looks like.
 *
 * The guard on `/admin` answers a non-operator exactly as it answers a request
 * for a path that was never routed, so that the panel's existence cannot be
 * discovered by comparing status codes. This is the same statement in HTML: an
 * ordinary "there is nothing at this address" page. It must never say
 * "permission", never say "operator", and never offer a way to ask for access —
 * each of those confirms there is something here to be let into.
 *
 * The app has no root `not-found.tsx`, so this is rendered directly rather than
 * through `notFound()`: a thrown navigation error from a client render is not a
 * thing to bet a security property on.
 */
export function NotFoundScreen() {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center gap-3 py-16 text-center">
      <FileQuestion className="text-ink-muted h-10 w-10" aria-hidden />
      <h1 className="text-ink text-xl font-semibold">৪০৪ — পাওয়া যায়নি</h1>
      <p className="text-ink-muted text-sm">এই ঠিকানায় কোনো পাতা নেই।</p>
      <Button variant="outline" asChild className="mt-2">
        <Link href="/">ড্যাশবোর্ডে ফিরুন</Link>
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

export function StatusPill({ status }: { status: string }) {
  const tone =
    status === 'SUSPENDED' || status === 'CANCELLED'
      ? 'bg-expense/10 text-expense'
      : status === 'ACTIVE'
        ? 'bg-income/10 text-income'
        : 'bg-brass/10 text-brass';

  return (
    <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium', tone)}>
      {workspaceStatusLabel(status)}
    </span>
  );
}

/** One number with a name over it. The overview is made of these. */
export function StatTile({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  note?: string;
  tone?: string;
}) {
  return (
    <div className="rounded-card border-rule bg-surface min-w-0 border p-3.5">
      <p className="text-ink-muted truncate text-xs">{label}</p>
      <p className={cn('text-ink mt-1 truncate text-xl font-semibold', tone)}>{value}</p>
      {note ? <p className="text-ink-muted mt-0.5 truncate text-[11px]">{note}</p> : null}
    </div>
  );
}

/**
 * Every consequential action in this panel, in one shape: fill in the form,
 * then read back what is about to happen and agree to it.
 *
 * The second step is the point. A button labelled "সংরক্ষণ করুন" tells an
 * operator what they pressed, not what it does; `summary` tells them that the
 * tenant is named X, that ৪ people are signed out of a session in progress,
 * that the ceiling goes from ৫০ to unlimited and lapses on a date. It is a node
 * rather than a string so it can carry a `<Money>`, a status pill or an email.
 *
 * `note` and `reason` are required by the server on the actions where they
 * matter, and by `canSubmit` here, so a missing one is a disabled button rather
 * than a round trip that comes back 400 in a language the form did not write.
 */
export function ActionSheet({
  open,
  onOpenChange,
  title,
  description,
  fields,
  summary,
  confirmLabel,
  canSubmit,
  pending = false,
  destructive = false,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  fields: React.ReactNode;
  summary: React.ReactNode;
  confirmLabel: string;
  canSubmit: boolean;
  pending?: boolean;
  destructive?: boolean;
  error?: string | null;
  onConfirm: () => void;
}) {
  const [confirming, setConfirming] = React.useState(false);

  // A reopened sheet always starts on the form. Landing straight on a
  // confirmation for values typed ten minutes ago is how a wrong one gets sent.
  React.useEffect(() => {
    if (!open) setConfirming(false);
  }, [open]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={title} description={description}>
      {confirming ? (
        <div className="flex flex-col gap-4">
          <div
            className={cn(
              'rounded-card border p-3 text-sm',
              destructive
                ? 'border-expense/40 bg-expense/10 text-ink'
                : 'border-rule bg-greenbar text-ink',
            )}
          >
            {summary}
          </div>

          {error ? (
            <p role="alert" className="text-expense text-sm">
              {error}
            </p>
          ) : null}

          <Button
            variant={destructive ? 'danger' : 'primary'}
            size="block"
            disabled={pending}
            onClick={() => {
              haptic('warn');
              onConfirm();
            }}
          >
            {pending ? 'পাঠানো হচ্ছে…' : confirmLabel}
          </Button>
          <Button
            variant="outline"
            size="block"
            disabled={pending}
            onClick={() => setConfirming(false)}
          >
            পিছনে
          </Button>
        </div>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!canSubmit) return;
            haptic('select');
            setConfirming(true);
          }}
        >
          {fields}
          {error ? (
            <p role="alert" className="text-expense text-sm">
              {error}
            </p>
          ) : null}
          <Button type="submit" size="block" disabled={!canSubmit}>
            পরের ধাপ — কী হবে দেখুন
          </Button>
        </form>
      )}
    </Sheet>
  );
}

/** A three- or four-way choice, sized for a thumb. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-ink text-sm font-medium">{label}</span>
      <div
        role="radiogroup"
        aria-label={label}
        className="border-rule bg-surface flex flex-col gap-1 rounded-md border p-1 sm:flex-row"
      >
        {options.map(([key, text]) => (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={value === key}
            onClick={() => {
              haptic('tap');
              onChange(key);
            }}
            className={cn(
              'press flex min-h-11 flex-1 items-center justify-center rounded-md px-3 text-sm md:min-h-9',
              value === key ? 'bg-income font-medium text-white' : 'text-ink hover:bg-greenbar',
            )}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * A ceiling, drawn so its three states cannot be confused for one another.
 *
 *   unlimited (`null`)  an ∞, and no bar — there is no proportion of infinity
 *   off (`0`)           a struck-through nought with a "bar" icon
 *   a number            the number
 *
 * Collapsing any two of these is the single worst thing this panel can do: an
 * operator who reads "off" as "unlimited" hands out a feature, and one who
 * reads "unlimited" as a ceiling refuses a customer something they already pay
 * for.
 */
export function LimitValue({
  value,
  kind,
  unit,
  className,
}: {
  value: number | null;
  kind: string;
  unit: string;
  className?: string;
}) {
  if (value === null) {
    return (
      <span className={cn('text-income inline-flex items-center gap-1 text-xs', className)}>
        <InfinityIcon className="h-3.5 w-3.5" aria-hidden />
        সীমাহীন
      </span>
    );
  }
  if (value === 0) {
    return (
      <span className={cn('text-ink-muted inline-flex items-center gap-1 text-xs', className)}>
        <Ban className="h-3.5 w-3.5" aria-hidden />
        {kind === 'FLAG' ? 'বন্ধ' : 'বন্ধ (০)'}
      </span>
    );
  }
  return (
    <span className={cn('text-ink text-xs', className)}>
      {kind === 'FLAG' ? 'চালু' : `${bnCount(value)}${unitSuffix(unit)}`}
    </span>
  );
}

/**
 * Consumption against a ceiling.
 *
 * There is no bar when `used` is `null`, and that is the whole point of this
 * component existing rather than reusing `<UsageMeter>`: a meter drawn at zero
 * says "this tenant has used none of their allowance", and for an unmeasured
 * feature the truth is "nobody is counting". A limit that looks enforced and is
 * not is the worst sentence this screen can utter, so the empty bar is replaced
 * by the words.
 */
export function UsageBar({
  used,
  limit,
  ratio,
  unit,
  label,
}: {
  used: number | null;
  limit: number | null;
  ratio: number | null;
  unit: string;
  label: string;
}) {
  if (used === null) {
    return (
      <span className="text-brass bg-brass/10 inline-flex rounded-full px-2 py-0.5 text-[11px]">
        {UNMEASURED}
      </span>
    );
  }

  const suffix = unitSuffix(unit);

  // Unlimited or switched off: a real number used, but no proportion to draw.
  if (ratio === null || limit === null || limit <= 0) {
    return (
      <span className="text-ink-muted text-[11px]">
        ব্যবহার {bnCount(used)}
        {suffix}
      </span>
    );
  }

  const percent = Math.min(100, Math.max(0, percentOf(ratio)));
  const exhausted = used >= limit;
  const tight = !exhausted && ratio >= 0.8;

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className="text-ink-muted truncate">
          {bnCount(used)} / {bnCount(limit)}
          {suffix}
        </span>
        {/* Colour is never the only signal — the percentage says it too. */}
        <span
          className={cn(
            'money shrink-0',
            exhausted ? 'text-expense font-semibold' : tight ? 'text-brass' : 'text-ink-muted',
          )}
        >
          {bnPercent(ratio)}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        className="bg-greenbar h-1.5 w-full overflow-hidden rounded-full"
      >
        <div
          className={cn(
            'h-full rounded-full',
            exhausted ? 'bg-expense' : tight ? 'bg-brass' : 'bg-income',
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

/** A labelled fact in a definition grid. */
export function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-ink-muted truncate text-xs">{label}</dt>
      <dd className="text-ink truncate text-sm">{value}</dd>
    </div>
  );
}

/** Something the operator must read before trusting the numbers beside it. */
export function Caveat({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-card border-brass/40 bg-brass/10 text-ink flex items-start gap-2 border p-3 text-xs">
      <TriangleAlert className="text-brass mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

export function CardSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-3">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="rounded-card border-rule bg-surface border p-4">
          <Skeleton className="h-4 w-2/5" />
          <Skeleton className="mt-2 h-3 w-3/5" />
          <Skeleton className="mt-3 h-3 w-1/3" />
        </div>
      ))}
    </div>
  );
}

/** Bengali digits with a unit word, for a plain count in a sentence. */
export const countOf = (value: number, word: string): string => `${bnNum(value)}${word}`;
