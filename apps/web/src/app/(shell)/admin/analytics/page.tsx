'use client';

import { useQuery } from '@tanstack/react-query';
import * as React from 'react';
import { formatMinor } from '@hishab/shared';
import { api } from '@/lib/api';
import { Field, Select } from '@/components/ui/field';
import { bnNum } from '../labels';
import { adminKeys } from '../queries';
import type { CategoryAnalytics } from '../types';

/**
 * What the customer base spends on.
 *
 * Aggregate only. No workspace is named, no row is read, nothing here can be
 * traced back to a person — it answers "what do people use this for" without
 * opening anybody's books, which is the question a product decision actually
 * needs. Reading one customer's figures is a different screen with a different
 * audit row, on their tenant page.
 *
 * The grouping key is the category *name*, normalised, because a category
 * belongs to a workspace: two households that both spend on groceries have two
 * different rows with two different ids, and the name is the only thing they
 * share. That makes this a picture of how people use the seeded tree rather
 * than a census — two people who write different words for the same thing stay
 * apart, and the screen says so rather than implying more precision than it has.
 */
export default function AdminAnalyticsPage() {
  const [kind, setKind] = React.useState<'EXPENSE' | 'INCOME'>('EXPENSE');
  const [window, setWindow] = React.useState<'all' | '30' | '365'>('all');

  const from =
    window === 'all'
      ? undefined
      : new Date(Date.now() - Number(window) * 86_400_000).toISOString().slice(0, 10);

  const filters = { kind, from };
  const analytics = useQuery({
    queryKey: adminKeys.analytics(filters),
    queryFn: () =>
      api<CategoryAnalytics>(
        `/admin/analytics/categories?kind=${kind}${from ? `&from=${from}` : ''}`,
      ),
  });

  const slices = analytics.data?.slices ?? [];
  const biggest = slices[0]?.totalMinor ?? 0;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <header>
        <h1 className="text-ink text-xl font-semibold sm:text-2xl">খাত অনুযায়ী বিশ্লেষণ</h1>
        <p className="text-ink-muted mt-1 text-sm">
          সব ওয়ার্কস্পেস মিলিয়ে, নাম ছাড়া। কোনো একজন গ্রাহকের হিসাব এখানে নেই — সেটি তার নিজের
          পাতায়।
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="ধরন" htmlFor="an-kind">
          <Select
            id="an-kind"
            value={kind}
            onChange={(e) => setKind(e.target.value === 'INCOME' ? 'INCOME' : 'EXPENSE')}
          >
            <option value="EXPENSE">খরচ</option>
            <option value="INCOME">আয়</option>
          </Select>
        </Field>
        <Field label="সময়" htmlFor="an-window">
          <Select
            id="an-window"
            value={window}
            onChange={(e) => setWindow(e.target.value as 'all' | '30' | '365')}
          >
            <option value="all">সব সময়</option>
            <option value="30">শেষ ৩০ দিন</option>
            <option value="365">শেষ ১ বছর</option>
          </Select>
        </Field>
      </div>

      {analytics.isPending ? (
        <p className="text-ink-muted text-sm">আনা হচ্ছে…</p>
      ) : analytics.isError ? (
        <p className="text-expense text-sm">বিশ্লেষণ আনা যায়নি।</p>
      ) : slices.length === 0 ? (
        <p className="text-ink-muted rounded-card border-rule border border-dashed p-6 text-center text-sm">
          এখনো যথেষ্ট লেনদেন নেই।
        </p>
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {slices.map((slice) => (
              <li
                key={`${slice.kind}:${slice.name}`}
                className="rounded-card border-rule bg-surface border p-3"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <p className="text-ink text-sm font-medium">{slice.name}</p>
                  <p className="text-ink money text-sm">
                    {formatMinor(slice.totalMinor, { symbol: false, bengaliNumerals: true })}
                  </p>
                </div>
                {/* A bar rather than a chart library: one div, no bundle. */}
                <div className="bg-brand-tint mt-2 h-1.5 w-full overflow-hidden rounded-full">
                  <div
                    className="bg-brand h-full rounded-full"
                    style={{ width: `${biggest > 0 ? (slice.totalMinor / biggest) * 100 : 0}%` }}
                  />
                </div>
                <p className="text-ink-muted mt-1 text-xs">
                  {bnNum(slice.workspaceCount)}টি ওয়ার্কস্পেস · {bnNum(slice.transactionCount)}টি
                  লেনদেন
                </p>
              </li>
            ))}
          </ul>

          <div className="rounded-card border-rule bg-greenbar border p-4">
            <p className="text-ink-muted text-xs">
              {bnNum(analytics.data.workspacesCounted)}টি ওয়ার্কস্পেসের হিসাব ধরা হয়েছে।{' '}
              {analytics.data.currencyNote}
            </p>
            <p className="text-ink-muted mt-2 text-xs">
              মুদ্রা:{' '}
              {analytics.data.currencies
                .map((c) => `${c.currency} (${bnNum(c.workspaces)})`)
                .join(', ')}
            </p>
          </div>
        </>
      )}
    </div>
  );
}
