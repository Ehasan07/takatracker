'use client';

import { useQuery } from '@tanstack/react-query';
import * as React from 'react';
import { ChevronDown } from 'lucide-react';
import dynamic from 'next/dynamic';
import { formatMinor, toBengaliDigits } from '@hishab/shared';
import { Skeleton } from '@/components/skeleton';
import { Money } from '@/components/money';
import { SkeletonCard } from '@/components/skeleton';
import { Select } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

interface CategoryRow {
  categoryId: string | null;
  name: string;
  totalMinor: number;
  sharePercent?: number;
}
interface CategoryNode extends CategoryRow {
  rolledUpMinor: number;
  children: CategoryRow[];
}
interface TrendPoint {
  month: string;
  incomeMinor: number;
  expenseMinor: number;
  netMinor: number;
}
interface BalanceLine {
  id: string;
  name: string;
  type: string;
  amountMinor: number;
}
interface BalanceSheetDto {
  assetsMinor: number;
  liabilitiesMinor: number;
  netWorthMinor: number;
  liquidMinor: number;
  assets: BalanceLine[];
  liabilities: BalanceLine[];
}
interface CashFlowDto {
  openingMinor: number;
  inflowMinor: number;
  outflowMinor: number;
  netMinor: number;
  closingMinor: number;
  accounts: string[];
}
interface DrilldownDto {
  category: { id: string; name: string };
  totalMinor: number;
  items: { transactionId: string; date: string; description: string | null; amountMinor: number }[];
}

/* Categorical colours from the ledger palette, ordered so neighbouring slices
   stay distinguishable in both themes and for the most common colour-vision
   deficiencies. */
const SLICE_COLOURS = ['#1F6F4A', '#8E6C18', '#A8342A', '#4C7BA6', '#6B5B95', '#2E8B75'];

/* Recharts is bigger than the rest of this page put together, so it loads
   after the numbers do. The cards above the fold render immediately. */
const chartLoading = () => <Skeleton className="h-full w-full" />;

const TrendChart = dynamic(() => import('@/components/report-charts').then((m) => m.TrendChart), {
  ssr: false,
  loading: chartLoading,
});
const CategoryPie = dynamic(() => import('@/components/report-charts').then((m) => m.CategoryPie), {
  ssr: false,
  loading: chartLoading,
});

export default function ReportsPage() {
  const [months, setMonths] = React.useState(6);
  const [kind, setKind] = React.useState<'EXPENSE' | 'INCOME'>('EXPENSE');
  const [drilldownId, setDrilldownId] = React.useState<string | null>(null);

  const trend = useQuery({
    queryKey: ['reports', 'trend', months],
    queryFn: () => api<TrendPoint[]>(`/reports/trend?months=${months}`),
  });
  /* Parents, with their children attached. The pie takes the six largest
     parents; the list below can expand any of them. */
  const byCategory = useQuery({
    queryKey: ['reports', 'by-category', kind],
    queryFn: () =>
      api<{ total: number; nodes: CategoryNode[] }>(`/reports/by-category?kind=${kind}`),
  });
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const sheet = useQuery({
    queryKey: ['reports', 'balance-sheet'],
    queryFn: () => api<BalanceSheetDto>('/reports/balance-sheet'),
  });
  const cashFlow = useQuery({
    queryKey: ['reports', 'cash-flow'],
    queryFn: () => api<CashFlowDto>('/reports/cash-flow'),
  });
  const drilldown = useQuery({
    queryKey: ['reports', 'drilldown', drilldownId],
    queryFn: () => api<DrilldownDto>(`/reports/category/${drilldownId}`),
    enabled: drilldownId !== null,
  });

  if (trend.isLoading && sheet.isLoading) {
    return (
      <div className="mx-auto grid w-full max-w-5xl grid-cols-1 gap-3 md:grid-cols-2">
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 xl:max-w-6xl">
      <header className="hidden items-baseline justify-between gap-2 md:flex">
        <h1 className="text-ink text-2xl font-semibold">রিপোর্ট</h1>
      </header>

      {/* Net worth first: it is the number people open a finance app to see. */}
      <section className="rounded-card border-rule bg-surface border p-4">
        <h2 className="text-ink-muted text-sm font-medium">নিট সম্পদ</h2>
        <Money minor={sheet.data?.netWorthMinor ?? 0} colored className="text-2xl font-semibold" />
        <dl className="border-rule mt-3 grid grid-cols-3 gap-2 border-t pt-3 text-xs">
          <div>
            <dt className="text-ink-muted">সম্পদ</dt>
            <dd>
              <Money
                minor={sheet.data?.assetsMinor ?? 0}
                className="text-income block"
                decimals={false}
              />
            </dd>
          </div>
          <div>
            <dt className="text-ink-muted">দায়</dt>
            <dd>
              <Money
                minor={sheet.data?.liabilitiesMinor ?? 0}
                className="text-expense block"
                decimals={false}
              />
            </dd>
          </div>
          <div>
            <dt className="text-ink-muted">হাতে নগদ</dt>
            <dd>
              <Money minor={sheet.data?.liquidMinor ?? 0} className="block" decimals={false} />
            </dd>
          </div>
        </dl>
      </section>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {/* Trend */}
        <section className="rounded-card border-rule bg-surface border p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-ink-muted text-sm font-medium">আয় বনাম খরচ</h2>
            <Select
              aria-label="কত মাস"
              value={String(months)}
              onChange={(e) => setMonths(Number(e.target.value))}
              className="w-auto"
            >
              <option value="3">৩ মাস</option>
              <option value="6">৬ মাস</option>
              <option value="12">১২ মাস</option>
            </Select>
          </div>
          <div className="mt-3 h-56 w-full">
            <TrendChart data={trend.data ?? []} />
          </div>
        </section>

        {/* Category split */}
        <section className="rounded-card border-rule bg-surface border p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-ink-muted text-sm font-medium">এই মাসের খাতভিত্তিক হিসাব</h2>
            <Select
              aria-label="আয় না খরচ"
              value={kind}
              onChange={(e) => setKind(e.target.value as 'EXPENSE' | 'INCOME')}
              className="w-auto"
            >
              <option value="EXPENSE">খরচ</option>
              <option value="INCOME">আয়</option>
            </Select>
          </div>

          {(byCategory.data?.nodes.length ?? 0) === 0 ? (
            <p className="text-ink-muted mt-3 text-sm">এই মাসে কিছু নেই।</p>
          ) : (
            <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="h-40 w-full sm:w-40">
                <CategoryPie
                  colours={SLICE_COLOURS}
                  data={(byCategory.data?.nodes ?? []).slice(0, 6).map((n) => ({
                    name: n.name,
                    value: n.rolledUpMinor,
                  }))}
                />
              </div>

              {/* The legend is the real interface: colour is never the only signal. */}
              <ul className="min-w-0 flex-1">
                {(byCategory.data?.nodes ?? []).map((node, i) => {
                  const total = byCategory.data?.total ?? 0;
                  const share =
                    total === 0 ? 0 : Math.floor((node.rolledUpMinor / total) * 1000 + 0.5) / 10;
                  const isOpen = expanded === node.categoryId;
                  const hasChildren = node.children.length > 0;

                  return (
                    <li key={node.categoryId ?? node.name}>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          disabled={!node.categoryId}
                          onClick={() => node.categoryId && setDrilldownId(node.categoryId)}
                          className="press hover:bg-greenbar flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-md px-1 text-left disabled:cursor-default"
                        >
                          <span
                            aria-hidden
                            className="h-2.5 w-2.5 shrink-0 rounded-full"
                            style={{ background: SLICE_COLOURS[i % SLICE_COLOURS.length] }}
                          />
                          <span className="text-ink min-w-0 flex-1 truncate text-sm">
                            {node.name}
                          </span>
                          <span className="text-ink-muted shrink-0 text-xs">
                            {toBengaliDigits(String(share))}%
                          </span>
                          <Money
                            minor={node.rolledUpMinor}
                            className="shrink-0 text-sm"
                            decimals={false}
                          />
                        </button>

                        {hasChildren ? (
                          <button
                            type="button"
                            aria-expanded={isOpen}
                            aria-label={`${node.name} — উপ-খাত`}
                            onClick={() => setExpanded(isOpen ? null : node.categoryId)}
                            className="press touch-target text-ink-muted hover:bg-greenbar flex shrink-0 items-center justify-center rounded-md"
                          >
                            <ChevronDown
                              className={cn('h-4 w-4 transition-transform', isOpen && 'rotate-180')}
                              aria-hidden
                            />
                          </button>
                        ) : (
                          <span className="w-11 shrink-0" aria-hidden />
                        )}
                      </div>

                      {isOpen ? (
                        <ul className="border-rule mb-1 ml-4 border-l pl-2">
                          {/* Money spent on the parent itself, not on any child. */}
                          {node.totalMinor > 0 ? (
                            <li className="flex items-center justify-between gap-2 py-1">
                              <span className="text-ink-muted min-w-0 truncate text-xs">
                                সরাসরি {node.name}
                              </span>
                              <Money
                                minor={node.totalMinor}
                                className="shrink-0 text-xs"
                                decimals={false}
                              />
                            </li>
                          ) : null}
                          {node.children.map((child) => (
                            <li key={child.categoryId}>
                              <button
                                type="button"
                                onClick={() => child.categoryId && setDrilldownId(child.categoryId)}
                                className="press hover:bg-greenbar flex min-h-9 w-full items-center justify-between gap-2 rounded-md px-1 text-left"
                              >
                                <span className="text-ink min-w-0 truncate text-xs">
                                  {child.name}
                                </span>
                                <Money
                                  minor={child.totalMinor}
                                  className="shrink-0 text-xs"
                                  decimals={false}
                                />
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </section>

        {/* Cash flow */}
        <section className="rounded-card border-rule bg-surface border p-4">
          <h2 className="text-ink-muted text-sm font-medium">নগদ প্রবাহ (এই মাস)</h2>
          <dl className="divide-rule mt-2 divide-y text-sm">
            {[
              ['শুরুর জের', cashFlow.data?.openingMinor ?? 0, ''],
              ['এসেছে', cashFlow.data?.inflowMinor ?? 0, 'text-income'],
              ['গেছে', -(cashFlow.data?.outflowMinor ?? 0), 'text-expense'],
              ['শেষের জের', cashFlow.data?.closingMinor ?? 0, 'font-semibold'],
            ].map(([label, amount, cls]) => (
              <div key={label as string} className="flex items-center justify-between gap-3 py-1.5">
                <dt className="text-ink">{label as string}</dt>
                <dd>
                  <Money minor={amount as number} className={(cls as string) || undefined} />
                </dd>
              </div>
            ))}
          </dl>
          {cashFlow.data?.accounts.length ? (
            <p className="text-ink-muted mt-2 text-xs">
              হিসাবের অ্যাকাউন্ট: {cashFlow.data.accounts.join(', ')}
            </p>
          ) : null}
        </section>

        {/* Balance sheet */}
        <section className="rounded-card border-rule bg-surface border p-4">
          <h2 className="text-ink-muted text-sm font-medium">সম্পদ ও দায়</h2>
          <div className="mt-2 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {(
              [
                ['সম্পদ', sheet.data?.assets ?? []],
                ['দায়', sheet.data?.liabilities ?? []],
              ] as const
            ).map(([title, lines]) => (
              <div key={title}>
                <h3 className="text-ink text-xs font-semibold">{title}</h3>
                <ul className="divide-rule mt-1 divide-y">
                  {lines.length === 0 ? (
                    <li className="text-ink-muted py-1.5 text-xs">কিছু নেই</li>
                  ) : (
                    lines.map((line) => (
                      <li key={line.id} className="flex items-center justify-between gap-2 py-1.5">
                        <span className="text-ink min-w-0 truncate text-sm">{line.name}</span>
                        <Money
                          minor={line.amountMinor}
                          className="shrink-0 text-sm"
                          decimals={false}
                        />
                      </li>
                    ))
                  )}
                </ul>
              </div>
            ))}
          </div>
        </section>
      </div>

      <Sheet
        open={drilldownId !== null}
        onOpenChange={(open) => !open && setDrilldownId(null)}
        title={drilldown.data?.category.name ?? 'বিস্তারিত'}
        description={drilldown.data ? `মোট ${formatMinor(drilldown.data.totalMinor)}` : undefined}
      >
        <ul className="divide-rule divide-y">
          {(drilldown.data?.items ?? []).map((item) => (
            <li key={item.transactionId} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="text-ink truncate text-sm">{item.description || 'লেনদেন'}</p>
                <p className="text-ink-muted text-xs">{item.date}</p>
              </div>
              <Money minor={item.amountMinor} className="shrink-0 text-sm" />
            </li>
          ))}
          {drilldown.data?.items.length === 0 ? (
            <li className="text-ink-muted py-2 text-sm">এই সময়ে কিছু নেই।</li>
          ) : null}
        </ul>
      </Sheet>
    </div>
  );
}
