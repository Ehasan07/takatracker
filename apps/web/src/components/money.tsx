'use client';

import { formatMinor } from '@hishab/shared';
import { cn } from '@/lib/utils';

/**
 * Every amount in the app renders through this component: tabular monospace,
 * right-aligned, in a fixed column. Sign is carried by colour *and* by the
 * minus sign, never by colour alone.
 */
export function Money({
  minor,
  className,
  colored = false,
  signed = false,
  bengaliNumerals = false,
  decimals = true,
}: {
  minor: number;
  className?: string;
  colored?: boolean;
  signed?: boolean;
  bengaliNumerals?: boolean;
  decimals?: boolean;
}) {
  const tone = !colored ? '' : minor < 0 ? 'text-expense' : minor > 0 ? 'text-income' : '';
  return (
    <span className={cn('money', tone, className)}>
      {formatMinor(minor, { signed, bengaliNumerals, decimals })}
    </span>
  );
}
