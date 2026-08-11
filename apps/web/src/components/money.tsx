'use client';

import { formatMinor } from '@hishab/shared';
import { useWorkspaceSettings } from '@/lib/workspace-settings';
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
  currency,
}: {
  minor: number;
  className?: string;
  colored?: boolean;
  signed?: boolean;
  bengaliNumerals?: boolean;
  decimals?: boolean;
  /**
   * Overrides the workspace's currency. For the rare figure that is not in the
   * books' own money — a plan price, quoted in taka whatever a workspace keeps
   * its ledger in.
   */
  currency?: string;
}) {
  const workspace = useWorkspaceSettings();
  const tone = !colored ? '' : minor < 0 ? 'text-expense' : minor > 0 ? 'text-income' : '';
  return (
    <span className={cn('money', tone, className)}>
      {formatMinor(minor, {
        signed,
        bengaliNumerals,
        decimals,
        /* The workspace's currency decides the symbol, the divisor *and* the
         * number of decimal places. A hardcoded ৳ here was fine while this was
         * a Bangladesh-only product and is a hundredfold error on a yen
         * workspace now that it is not. */
        currency: currency ?? workspace.currency,
      })}
    </span>
  );
}
