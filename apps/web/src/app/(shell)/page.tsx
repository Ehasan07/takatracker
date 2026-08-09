'use client';

import { useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { formatLedgerDate, fromLocalDateString } from '@hishab/shared';
import { Money } from '@/components/money';
import { SkeletonCard } from '@/components/skeleton';
import { endpoints } from '@/lib/api';

export default function DashboardPage() {
  const summary = useQuery({ queryKey: ['summary'], queryFn: endpoints.summary });
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: endpoints.accounts });
  const recent = useQuery({
    queryKey: ['transactions', { limit: 5 }],
    queryFn: () => endpoints.transactions({ limit: 5 }),
  });

  const totalBalance = (accounts.data ?? []).reduce((sum, a) => sum + a.balanceMinor, 0);
  const topCategories = (summary.data?.expenseByCategory ?? []).slice(0, 5);
  const largest = topCategories[0]?.totalMinor ?? 0;

  if (summary.isLoading && accounts.isLoading) {
    return (
      <div className="mx-auto grid w-full max-w-5xl grid-cols-1 gap-3 md:grid-cols-2 xl:max-w-6xl">
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 xl:max-w-6xl">
      {/* On a phone the shell's navigation bar already names the screen. */}
      <header className="flex items-baseline justify-between gap-2">
        <h1 className="text-ink hidden text-xl font-semibold sm:text-2xl md:block">ড্যাশবোর্ড</h1>
        <p className="text-ink-muted text-sm">{formatLedgerDate(new Date())}</p>
      </header>

      {/* Single column on phones, two up from tablet */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <section className="rounded-card border-rule bg-surface border p-4">
          <h2 className="text-ink-muted text-sm font-medium">এই মাসের হিসাব</h2>
          <dl className="mt-3 grid grid-cols-3 gap-2">
            <div className="min-w-0">
              <dt className="text-ink-muted text-xs">আয়</dt>
              <dd>
                <Money
                  minor={summary.data?.incomeMinor ?? 0}
                  className="text-income block"
                  decimals={false}
                />
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-ink-muted text-xs">খরচ</dt>
              <dd>
                <Money
                  minor={summary.data?.expenseMinor ?? 0}
                  className="text-expense block"
                  decimals={false}
                />
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-ink-muted text-xs">নিট</dt>
              <dd>
                <Money
                  minor={summary.data?.netMinor ?? 0}
                  colored
                  signed
                  className="block"
                  decimals={false}
                />
              </dd>
            </div>
          </dl>
        </section>

        <section className="rounded-card border-rule bg-surface border p-4">
          <Link
            href="/accounts"
            className="press text-ink-muted hover:text-ink flex items-center gap-1 text-sm font-medium"
          >
            মোট ব্যালেন্স
            <ChevronRight className="h-4 w-4" aria-hidden />
          </Link>
          <p className="mt-1">
            <Money minor={totalBalance} className="text-2xl font-semibold" />
          </p>
          {/* Never a bare number: the breakdown is always visible. */}
          <ul className="divide-rule mt-3 divide-y">
            {(accounts.data ?? []).map((account) => (
              <li key={account.id} className="flex items-center justify-between gap-3 py-1.5">
                <span className="text-ink min-w-0 truncate text-sm">{account.name}</span>
                <Money minor={account.balanceMinor} className="shrink-0 text-sm" />
              </li>
            ))}
            {accounts.data?.length === 0 ? (
              <li className="text-ink-muted py-2 text-sm">
                কোনো অ্যাকাউন্ট নেই।{' '}
                <Link href="/accounts" className="text-income underline">
                  একটি যোগ করুন
                </Link>
              </li>
            ) : null}
          </ul>
        </section>

        <section className="rounded-card border-rule bg-surface border p-4">
          <h2 className="text-ink-muted text-sm font-medium">শীর্ষ ৫ খরচের খাত</h2>
          {topCategories.length === 0 ? (
            <p className="text-ink-muted mt-2 text-sm">এই মাসে এখনও কোনো খরচ নেই।</p>
          ) : (
            <ul className="mt-3 flex flex-col gap-2">
              {topCategories.map((row) => (
                <li key={row.categoryId ?? row.name} className="flex flex-col gap-1">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-ink min-w-0 truncate text-sm">{row.name}</span>
                    <Money minor={row.totalMinor} className="shrink-0 text-sm" decimals={false} />
                  </div>
                  <div className="bg-greenbar h-1.5 w-full rounded-full">
                    <div
                      className="bg-brass h-1.5 rounded-full"
                      style={{ width: `${largest > 0 ? (row.totalMinor / largest) * 100 : 0}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-card border-rule bg-surface border p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-ink-muted text-sm font-medium">সাম্প্রতিক লেনদেন</h2>
            <Link href="/transactions" className="text-income text-sm underline">
              সব দেখুন
            </Link>
          </div>
          {recent.data?.items.length === 0 ? (
            <p className="text-ink-muted mt-2 text-sm">
              এখনও কিছু লেখা হয়নি। নিচের + বোতামে প্রথম লেনদেন যোগ করুন।
            </p>
          ) : (
            <ul className="divide-rule mt-2 divide-y">
              {(recent.data?.items ?? []).map((txn) => (
                <li key={txn.id} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="text-ink truncate text-sm">
                      {txn.description || txn.categoryName || txn.accountName}
                    </p>
                    <p className="text-ink-muted truncate text-xs">
                      {formatLedgerDate(fromLocalDateString(txn.date))}
                    </p>
                  </div>
                  <Money minor={txn.amountMinor} colored signed className="shrink-0 text-sm" />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
