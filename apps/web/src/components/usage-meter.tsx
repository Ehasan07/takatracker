'use client';

import { toBengaliDigits } from '@hishab/shared';
import { cn } from '@/lib/utils';

/**
 * How much of a plan limit is gone. Shown next to the action it governs, so the
 * ceiling is visible before it is hit rather than discovered by a refusal.
 * Renders nothing when the feature is unlimited — there is no quota to report.
 */
export function UsageMeter({
  label,
  used,
  limit,
  className,
}: {
  label: string;
  used: number;
  limit: number | null;
  className?: string;
}) {
  if (limit === null) return null;

  const ratio = limit === 0 ? 1 : Math.min(1, used / limit);
  const exhausted = used >= limit;
  const tight = !exhausted && ratio >= 0.8;

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-ink-muted">{label}</span>
        {/* Colour is never the only signal — the numbers say it too. */}
        <span
          className={cn(
            'money',
            exhausted ? 'text-expense font-semibold' : tight ? 'text-brass' : 'text-ink-muted',
          )}
        >
          {toBengaliDigits(String(used))}/{toBengaliDigits(String(limit))}
        </span>
      </div>
      <div className="bg-greenbar h-1 w-full rounded-full">
        <div
          className={cn(
            'h-1 rounded-full transition-[width]',
            exhausted ? 'bg-expense' : tight ? 'bg-brass' : 'bg-income',
          )}
          style={{ width: `${ratio * 100}%` }}
        />
      </div>
    </div>
  );
}
