'use client';

import {
  Ban,
  Building2,
  Check,
  CircleHelp,
  Hash,
  Infinity as InfinityIcon,
  Minus,
  PackageX,
  TriangleAlert,
} from '@/components/icons';
import * as React from 'react';
import { Money } from '@/components/money';
import { haptic } from '@/lib/haptics';
import { cn } from '@/lib/utils';
import { bnNum } from '../labels';
import { LimitValue } from '../parts';
import { intervalSuffix, NOT_PRICED, OFF_SALE, OFF_SALE_MEANS } from './labels';

/* -------------------------------------------------------------------------
 * The safety rail
 * ---------------------------------------------------------------------- */

/**
 * How many customers are on this package, said before anything can be changed.
 *
 * This is the one number the whole screen is built around. An operator editing
 * a package forty tenants are sitting on must meet that fact on the way in, not
 * discover it in a confirmation dialog after they have made up their mind — so
 * it is a full-width bar directly under the heading, sized like a headline, and
 * it is repeated inside every confirmation this folder shows.
 *
 * `null` is not zero. A payload that carried no count at all gets the wary
 * version of this bar, because "the API did not say" and "nobody is on it" lead
 * to opposite decisions.
 */
export function WorkspaceCountRail({
  count,
  retired = false,
}: {
  count: number | null;
  retired?: boolean;
}) {
  if (count === null) {
    return (
      <div
        role="status"
        className="rounded-card border-brass/40 bg-brass/10 text-ink flex items-start gap-3 border-[1.5px] p-3.5"
      >
        <CircleHelp className="text-brass mt-0.5 h-5 w-5 shrink-0" aria-hidden />
        <div className="min-w-0">
          <p className="text-sm font-medium">কতটি ওয়ার্কস্পেস এই প্যাকেজে আছে তা জানা যায়নি।</p>
          <p className="text-ink-muted mt-0.5 text-xs">
            সার্ভার সংখ্যাটি পাঠায়নি। ধরে নিন গ্রাহক আছেন — এই পাতার প্রতিটি বদল তাঁদের গায়ে
            লাগবে।
          </p>
        </div>
      </div>
    );
  }

  if (count === 0) {
    return (
      <div
        role="status"
        className="rounded-card border-rule bg-greenbar text-ink flex items-start gap-3 border-[1.5px] p-3.5"
      >
        <Building2 className="text-ink-muted mt-0.5 h-5 w-5 shrink-0" aria-hidden />
        <div className="min-w-0">
          <p className="text-sm font-medium">এই প্যাকেজে কোনো ওয়ার্কস্পেস নেই।</p>
          <p className="text-ink-muted mt-0.5 text-xs">
            কারও উপর প্রভাব না ফেলে সীমা ও দাম বদলানো যাবে।
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      role="status"
      className="rounded-card border-brass/50 bg-brass/10 text-ink flex items-start gap-3 border-[1.5px] p-3.5"
    >
      <Building2 className="text-brass mt-0.5 h-6 w-6 shrink-0" aria-hidden />
      <div className="min-w-0">
        <p className="text-lg font-semibold leading-tight">
          {bnNum(count)}টি ওয়ার্কস্পেস এই প্যাকেজে আছে
        </p>
        <p className="text-ink-muted mt-1 text-xs">
          {retired
            ? 'প্যাকেজটি অবসরপ্রাপ্ত হলেও গ্রাহকেরা এতেই আছেন — এখানে যা বদলাবেন তা তাঁদের পরবর্তী অনুরোধ থেকেই কার্যকর হবে।'
            : 'এখানে যা বদলাবেন তা তাঁদের পরবর্তী অনুরোধ থেকেই কার্যকর হবে।'}
        </p>
      </div>
    </div>
  );
}

/** The same fact, compact, for a card in a list. Never smaller than this. */
export function WorkspaceCountBadge({ count }: { count: number | null }) {
  const tone =
    count === null
      ? 'bg-brass/10 text-brass'
      : count === 0
        ? 'bg-greenbar text-ink-muted'
        : 'bg-brass/15 text-brass font-medium';

  return (
    <span
      className={cn('inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-xs', tone)}
    >
      <Building2 className="h-3.5 w-3.5" aria-hidden />
      {count === null ? 'সংখ্যা জানা নেই' : `${bnNum(count)}টি ওয়ার্কস্পেস`}
    </span>
  );
}

/* -------------------------------------------------------------------------
 * Four states, four appearances
 * ---------------------------------------------------------------------- */

/**
 * What a package says about one feature.
 *
 * The panel's `<LimitValue>` draws three states and cannot draw the fourth,
 * because at tenant level there is no fourth: a resolved entitlement is always
 * a number, a zero or an unlimited. A *package* has one more — it can decline
 * to mention a feature at all, which is neither zero nor unlimited but "ask the
 * fallback". That state is drawn as a dashed outline with an em dash, so it
 * reads as an empty slot rather than as a value, and it is the only one of the
 * four with no fill.
 */
export function PlanLimitValue({
  value,
  kind,
  unit,
  className,
}: {
  value: number | null | undefined;
  kind: string;
  unit: string;
  className?: string;
}) {
  if (value === undefined) {
    return (
      <span
        className={cn(
          'border-rule text-ink-muted inline-flex items-center gap-1 rounded-full border border-dashed px-2 py-0.5 text-xs',
          className,
        )}
      >
        <Minus className="h-3.5 w-3.5" aria-hidden />
        {NOT_PRICED}
      </span>
    );
  }
  return <LimitValue value={value} kind={kind} unit={unit} className={className} />;
}

/**
 * The control that can say all four things.
 *
 * A number input cannot: it has one empty state and four meanings to carry.
 * Typing nothing would have to mean unlimited, or not priced, or "I have not
 * decided" — and whichever one it was chosen to mean, the other two would be
 * unreachable. So the state is picked first, as a chip with its own icon and
 * colour, and the number box appears only for the one state that needs it.
 *
 * The chips are the same four everywhere they appear, in the same order and the
 * same colours as `PlanLimitValue` renders them, so the control and the read-out
 * teach each other.
 */
export type LimitState = 'unset' | 'off' | 'on' | 'fixed' | 'unlimited';

export const STATE_LABEL: Record<LimitState, string> = {
  unset: NOT_PRICED,
  off: 'বন্ধ',
  on: 'চালু',
  fixed: 'সংখ্যা',
  unlimited: 'সীমাহীন',
};

const STATE_ICON: Record<LimitState, typeof Minus> = {
  unset: Minus,
  off: Ban,
  on: Check,
  fixed: Hash,
  unlimited: InfinityIcon,
};

/** Which state a stored value is in. `undefined` is the package staying silent. */
export function limitStateOf(kind: string, value: number | null | undefined): LimitState {
  if (value === undefined) return 'unset';
  if (value === null) return 'unlimited';
  if (value === 0) return 'off';
  return kind === 'FLAG' ? 'on' : 'fixed';
}

/**
 * The chips to offer.
 *
 * A FLAG has no ceiling to type, so it gets "চালু" where a LIMIT gets a number
 * box. `unlimited` is not offered on a flag — it resolves to the same "on" and
 * would be a second button doing the first one's job — unless the stored value
 * is already `null`, in which case hiding it would mean the operator could not
 * see, or keep, what the package currently says. Same rule as the override
 * sheet's "সরান", which only appears when there is something to remove.
 */
export function limitStateOptions(kind: string, current: LimitState): LimitState[] {
  const options: LimitState[] =
    kind === 'FLAG' ? ['unset', 'off', 'on'] : ['unset', 'off', 'fixed', 'unlimited'];
  if (!options.includes(current)) options.push(current);
  return options;
}

export function LimitStateChips({
  label,
  state,
  options,
  onChange,
}: {
  label: string;
  state: LimitState;
  options: readonly LimitState[];
  onChange: (state: LimitState) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map((option) => {
        const Icon = STATE_ICON[option];
        const active = option === state;
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => {
              haptic('tap');
              onChange(option);
            }}
            className={cn(
              'press flex min-h-11 items-center gap-1 rounded-full border px-3 text-xs md:min-h-9',
              active
                ? option === 'unset'
                  ? 'border-ink-muted bg-greenbar text-ink font-medium'
                  : 'bg-income border-income font-medium text-white'
                : 'border-rule bg-surface text-ink-muted hover:bg-greenbar',
              !active && option === 'unset' && 'border-dashed',
            )}
          >
            <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
            {STATE_LABEL[option]}
          </button>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------------------
 * Small things every package screen needs
 * ---------------------------------------------------------------------- */

/**
 * One pill, because there is one bit.
 *
 * `retired` is `!isPublic` on the server — the same flag under two names — so a
 * "retired" badge next to a "hidden" badge would be the same fact drawn twice
 * and would imply the operator could change one without the other. The wording
 * covers both readings: a package withdrawn after three years and a bespoke one
 * that was never on the pricing page are indistinguishable in the data, and
 * this says as much.
 */
export function OffSalePill() {
  return (
    <span
      title={OFF_SALE_MEANS}
      className="bg-ink-muted/15 text-ink-muted inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
    >
      <PackageX className="h-3 w-3" aria-hidden />
      {OFF_SALE}
    </span>
  );
}

/** The package new signups land on. It cannot be taken off sale. */
export function DefaultPlanPill() {
  return (
    <span className="bg-income/10 text-income inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium">
      <Check className="h-3 w-3" aria-hidden />
      নতুনদের প্যাকেজ
    </span>
  );
}

/** Zero is "ফ্রি", never ৳০.০০, and every other amount goes through `<Money>`. */
export function PlanPrice({
  priceMinor,
  interval,
  className,
}: {
  priceMinor: number;
  interval: string;
  className?: string;
}) {
  if (priceMinor === 0) return <span className={cn('text-ink', className)}>ফ্রি</span>;
  return (
    <span className={cn('text-ink inline-flex items-baseline gap-0.5', className)}>
      <Money minor={priceMinor} decimals={false} />
      <span className="text-ink-muted text-xs">{intervalSuffix(interval)}</span>
    </span>
  );
}

/** A quiet statement of fact. `Caveat` is for warnings; this is for context. */
export function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-card border-rule bg-greenbar text-ink-muted border-[1.5px] p-3 text-xs">
      {children}
    </p>
  );
}

/** Something that will hurt somebody if it is not read. */
export function Danger({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="alert"
      className="rounded-card border-expense/40 bg-expense/10 text-ink flex items-start gap-2 border-[1.5px] p-3 text-xs"
    >
      <TriangleAlert className="text-expense mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
