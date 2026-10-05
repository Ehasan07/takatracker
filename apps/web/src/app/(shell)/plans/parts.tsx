'use client';

import { FEATURES, isFeatureKey, type FeatureDefinition } from '@hishab/core';
import { RotateCw, TriangleAlert } from '@/components/icons';
import { Money } from '@/components/money';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/* One implementation, in `lib/format.ts`, which follows the workspace's
   language. Re-exported under the old name so the call sites stay as they are. */
import { fmtNumber as bnNum } from '@/lib/format';

export { bnNum };

/**
 * Kept local to the route rather than shared out of `loans/`, so a change in
 * one feature folder cannot break the other.
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

/** The definition the API enforces against, so nothing here is a second copy. */
export function featureOf(key: string): FeatureDefinition | undefined {
  return isFeatureKey(key) ? FEATURES[key] : undefined;
}

export function featureLabel(key: string, fallback?: string): string {
  return featureOf(key)?.label ?? (fallback && fallback !== '' ? fallback : key);
}

export function unitSuffix(unit: FeatureDefinition['unit']): string {
  if (unit === 'megabytes') return ' মেগাবাইট';
  if (unit === 'tokens') return ' টোকেন';
  if (unit === 'per-month') return 'টি / মাস';
  return 'টি';
}

/**
 * What one plan grants for one feature, in words.
 *
 * A FLAG is a yes or a no. A LIMIT of `null` is unlimited and a LIMIT of 0 is
 * the feature switched off — two different statements, and collapsing them
 * would tell somebody they had something they do not.
 */
export function limitText(key: string, limitValue: number | null): string {
  const definition = featureOf(key);
  if (definition?.kind === 'FLAG') return limitValue === 0 ? 'নেই' : 'আছে';
  if (limitValue === null) return 'সীমাহীন';
  if (limitValue === 0) return 'নেই';
  return `${bnNum(limitValue)}${unitSuffix(definition?.unit)}`;
}

/**
 * A tier's price. Zero is "ফ্রি", not ৳০.০০, and anything above zero is
 * flagged as provisional — `packages/core/src/entitlements.ts` says outright
 * that these numbers are placeholders until pricing is decided.
 */
export function PlanPrice({
  priceMinor,
  interval,
  className,
}: {
  priceMinor: number;
  interval: string;
  className?: string;
}) {
  if (priceMinor <= 0) return <span className="text-ink text-xl font-semibold">ফ্রি</span>;
  return (
    <span className={cn('flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5', className)}>
      <Money minor={priceMinor} className="text-ink text-xl font-semibold" decimals={false} />
      <span className="text-ink-muted text-xs">/ {interval === 'YEARLY' ? 'বছর' : 'মাস'}</span>
      <span className="bg-brass/15 text-brass rounded-full px-2 py-0.5 text-[11px] font-medium">
        খসড়া দাম
      </span>
    </span>
  );
}
