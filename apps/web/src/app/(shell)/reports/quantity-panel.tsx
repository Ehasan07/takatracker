'use client';

import { useQuery } from '@tanstack/react-query';
import { Scale } from '@/components/icons';
import { fromMilli } from '@/components/quantity';
import { api } from '@/lib/api';
import { bnNum } from '../admin/labels';
import { periodQuery, type Period } from './range';

/**
 * How much of each thing, not how much it cost.
 *
 * Every other panel on this page is denominated in taka. This one is the
 * question money cannot answer: a price rise and a habit change look identical
 * in ৳ and completely different in litres, so "we spent more on fuel" and "we
 * drove more" are indistinguishable until somebody counts the litres.
 *
 * Units never mix. Kilos and litres are separate totals with separate
 * headings — adding them would produce a number with no meaning, and the one
 * thing worse than no answer here is a confident wrong one.
 *
 * Renders nothing when nobody has recorded a quantity, which is the usual case.
 * An empty panel explaining a feature is a panel in the way.
 */

interface UnitTotal {
  unit: string;
  totalMilli: number;
  transactionCount: number;
  categories: { name: string; totalMilli: number }[];
}

export function QuantityPanel({ period }: { period: Period }) {
  const quantities = useQuery({
    queryKey: ['reports', 'by-quantity', period.from, period.to] as const,
    queryFn: () => api<{ units: UnitTotal[] }>(`/reports/by-quantity?${periodQuery(period)}`),
  });

  const units = quantities.data?.units ?? [];
  if (quantities.isPending || units.length === 0) return null;

  return (
    <section className="rounded-card border-rule bg-surface border p-4">
      <h2 className="text-ink flex items-center gap-2 text-base font-semibold">
        <Scale className="text-brand h-4 w-4" aria-hidden />
        পরিমাণ
      </h2>
      <p className="text-ink-muted mt-1 text-sm">
        কত কিনেছেন, টাকায় নয় — এককে। দাম বাড়া আর বেশি কেনা টাকায় একরকম দেখায়, এখানে আলাদা।
      </p>

      <div className="mt-4 space-y-4">
        {units.map((unit) => (
          <div key={unit.unit}>
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="text-ink text-sm font-medium">{unit.unit}</h3>
              <p className="text-ink money text-sm font-medium">
                {fromMilli(unit.totalMilli)} {unit.unit}
              </p>
            </div>
            <p className="text-ink-muted text-xs">{bnNum(unit.transactionCount)}টি লেনদেনে</p>

            {unit.categories.length > 1 ? (
              <ul className="divide-rule mt-2 divide-y">
                {unit.categories.map((category) => (
                  <li
                    key={category.name}
                    className="flex items-center justify-between gap-3 py-1.5"
                  >
                    <span className="text-ink-muted min-w-0 truncate text-sm">{category.name}</span>
                    <span className="text-ink money shrink-0 text-sm">
                      {fromMilli(category.totalMilli)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}
