'use client';

import * as React from 'react';
import {
  ChartColumn,
  Exchange,
  Jar,
  Ledger,
  MessageSquareText,
  ShieldCheck,
  SlidersHorizontal,
  Split,
  type LucideIcon,
} from '@/components/icons';
import type { SiteContent } from './content';

/**
 * Fifty-odd features, eight groups, one group open at a time.
 *
 * Every panel is in the server HTML — the inactive ones carry `hidden`, they
 * are not absent — so a crawler reads all of them, find-in-page reaches them,
 * and with JavaScript still loading the first group is simply open. The tabs
 * only decide which one is on screen.
 *
 * Keyboard: the tab list follows the ARIA pattern, one tab stop with the arrow
 * keys, Home and End moving between groups.
 */

const GROUP_ICON: Record<string, LucideIcon> = {
  ledger: Ledger,
  loans: Exchange,
  split: Split,
  planning: Jar,
  insight: ChartColumn,
  input: MessageSquareText,
  trust: ShieldCheck,
  comfort: SlidersHorizontal,
};

export function FeatureTabs({
  groups,
  locale,
}: {
  groups: SiteContent['groups'];
  locale: 'bn' | 'en';
}) {
  const [active, setActive] = React.useState(groups[0]?.id ?? '');
  const tabs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const toBn = (n: number) =>
    locale === 'bn' ? String(n).replace(/[0-9]/g, (d) => '০১২৩৪৫৬৭৮৯'[Number(d)]!) : String(n);

  const onKeyDown = (event: React.KeyboardEvent, index: number) => {
    const last = groups.length - 1;
    const next =
      event.key === 'ArrowRight'
        ? index === last
          ? 0
          : index + 1
        : event.key === 'ArrowLeft'
          ? index === 0
            ? last
            : index - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    setActive(groups[next]!.id);
    tabs.current[next]?.focus();
  };

  return (
    <div className="mt-10">
      <div
        role="tablist"
        aria-label={locale === 'bn' ? 'ফিচারের ভাগ' : 'Feature groups'}
        className="chip-strip flex-wrap sm:flex-wrap"
      >
        {groups.map((group, index) => {
          const selected = group.id === active;
          const Icon = GROUP_ICON[group.id] ?? Ledger;
          return (
            <button
              key={group.id}
              ref={(el) => {
                tabs.current[index] = el;
              }}
              type="button"
              role="tab"
              id={`tab-${group.id}`}
              aria-selected={selected}
              aria-controls={`panel-${group.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActive(group.id)}
              onKeyDown={(e) => onKeyDown(e, index)}
              className={`press inline-flex min-h-12 items-center gap-2 rounded-full border-[1.5px] px-4 text-[15px] font-bold transition-colors ${
                selected
                  ? 'border-brand bg-brand text-brand-contrast'
                  : 'border-rule bg-surface text-ink hover:border-ink-muted'
              }`}
            >
              <Icon className="h-5 w-5" aria-hidden />
              {group.heading.split(/[,(]/)[0]!.trim()}
              <span className="text-[13px] font-semibold opacity-75">
                {toBn(group.features.length)}
              </span>
            </button>
          );
        })}
      </div>

      {groups.map((group) => {
        const Icon = GROUP_ICON[group.id] ?? Ledger;
        return (
          <div
            key={group.id}
            role="tabpanel"
            id={`panel-${group.id}`}
            aria-labelledby={`tab-${group.id}`}
            hidden={group.id !== active}
            className="tt-panel bg-brand mt-7 rounded-[32px] p-2.5 sm:p-3.5"
          >
            <div className="bg-surface rounded-[24px] px-5 pb-3 pt-6 sm:px-8 sm:pt-8">
              <div className="flex flex-wrap items-start gap-4">
                <span className="bg-brand-tint text-brand flex h-16 w-16 shrink-0 items-center justify-center rounded-[18px]">
                  <Icon className="h-8 w-8" aria-hidden />
                </span>
                <div className="min-w-0 flex-1 basis-72">
                  <h3 className="text-ink text-2xl font-extrabold leading-snug sm:text-[28px]">
                    {group.heading}
                  </h3>
                  <p lang="en" className="font-wordmark text-ink-muted mt-0.5 text-sm">
                    {group.headingEn}
                  </p>
                  <p className="text-ink-muted mt-2.5 max-w-3xl text-base leading-relaxed sm:text-[17px]">
                    {group.blurb}
                  </p>
                </div>
              </div>
              <ul className="mt-5 grid gap-x-9 sm:grid-cols-2 lg:grid-cols-3">
                {group.features.map((feature) => (
                  <li key={feature.title} className="border-rule border-t py-5">
                    <h4 className="text-ink text-[17px] font-bold leading-snug">{feature.title}</h4>
                    <p lang="en" className="font-wordmark text-ink-muted mt-0.5 text-[13px]">
                      {feature.titleEn}
                    </p>
                    <p className="text-ink-muted mt-2 text-[15px] leading-relaxed">
                      {feature.body}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        );
      })}
    </div>
  );
}
