'use client';

import { useQuery } from '@tanstack/react-query';
import { fmtDate, fmtDateObject } from '@/lib/format';
import { t } from '@/lib/t';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { ACCOUNT_CLASS, LIQUID_TYPES } from '@hishab/core';
import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { useGreeting } from '@/components/account-menu';
import { FirstRunCard } from '@/components/first-run-card';
import { VerifyEmailCard } from '@/components/verify-email-card';
import { Money } from '@/components/money';
import { SkeletonCard } from '@/components/skeleton';
import { useIsOperator } from '@/app/(shell)/admin/operator-flag';
import { endpoints } from '@/lib/api';

/**
 * The breakdown, in the three parts a balance sheet reads in.
 *
 * A flat list of every account put a plot of land between two bank accounts and
 * a credit card under both, and left the reader to work out which of the
 * fourteen lines they could actually spend. Grouping is not decoration here: it
 * is the current/non-current distinction, and the whole reason it is required.
 */
const BREAKDOWN_GROUPS = [
  { key: 'liquid', label: 'হাতে ও ব্যাংকে' },
  { key: 'asset', label: 'সম্পদ' },
  { key: 'liability', label: 'দায়' },
] as const;

type BreakdownGroup = (typeof BREAKDOWN_GROUPS)[number]['key'];

type AccountType = keyof typeof ACCOUNT_CLASS;

const groupOfAccount = (type: AccountType): BreakdownGroup => {
  if (LIQUID_TYPES.includes(type)) return 'liquid';
  return ACCOUNT_CLASS[type] === 'LIABILITY' ? 'liability' : 'asset';
};

export default function DashboardPage() {
  /* An operator has no books, so this screen has nothing to tell them. They are
   * sent to the platform overview instead — `replace`, not `push`, so the back
   * button does not walk them into the empty ledger they were just moved out
   * of. Rendering nothing meanwhile avoids a flash of zeroes. */
  const router = useRouter();
  const isOperator = useIsOperator();
  React.useEffect(() => {
    if (isOperator) router.replace('/admin');
  }, [isOperator, router]);

  const { greeting, name } = useGreeting();
  const summary = useQuery({ queryKey: ['summary'], queryFn: endpoints.summary });
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: endpoints.accounts });
  const recent = useQuery({
    queryKey: ['transactions', { limit: 5 }],
    queryFn: () => endpoints.transactions({ limit: 5 }),
  });

  const topCategories = (summary.data?.expenseByCategory ?? []).slice(0, 5);
  const largest = topCategories[0]?.totalMinor ?? 0;

  if (isOperator) return null;

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
      {/* On a phone the shell's navigation bar already names the screen, so the
          greeting carries the phone header instead of a second "ড্যাশবোর্ড". */}
      <header className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
        <div className="min-w-0">
          <h1 className="text-ink hidden text-xl font-semibold sm:text-2xl md:block">
            {t('dashboard.title', 'ড্যাশবোর্ড')}
          </h1>
          {greeting ? (
            <p className="text-ink text-base font-medium md:text-sm md:font-normal">
              {name ? `${greeting}, ${name}` : greeting}
            </p>
          ) : null}
        </div>
        <p className="text-ink-muted text-sm">{fmtDateObject(new Date())}</p>
      </header>

      {/* Above first run: proving the address is what makes a password reset
          reach anybody, so it is the one thing worth doing before setting up
          accounts. Both cards render nothing when they have nothing to say. */}
      <VerifyEmailCard />
      <FirstRunCard />

      {/* Single column on phones, two up from tablet */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <section className="rounded-card border-rule bg-surface border p-4">
          <h2 className="text-ink-muted text-sm font-medium">
            {t('dashboard.thisMonth', 'এই মাসের হিসাব')}
          </h2>
          <dl className="mt-3 grid grid-cols-3 gap-2">
            <div className="min-w-0">
              <dt className="text-ink-muted text-xs">{t('dashboard.income', 'আয়')}</dt>
              <dd>
                <Money
                  minor={summary.data?.incomeMinor ?? 0}
                  className="text-income block"
                  decimals={false}
                />
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-ink-muted text-xs">{t('dashboard.expense', 'খরচ')}</dt>
              <dd>
                <Money
                  minor={summary.data?.expenseMinor ?? 0}
                  className="text-expense block"
                  decimals={false}
                />
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-ink-muted text-xs">{t('dashboard.net', 'নিট')}</dt>
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
            {t('dashboard.liquid', 'হাতে ও ব্যাংকে')}
            <ChevronRight className="h-4 w-4" aria-hidden />
          </Link>
          <p className="mt-1">
            <Money minor={summary.data?.liquidMinor ?? 0} className="text-2xl font-semibold" />
          </p>

          {/* Two figures, because they answer two different questions and the
              old screen answered neither. It added every account of every type
              together and called the result "মোট ব্যালেন্স": a ৳10,00,000 plot
              of land sat in the same total as ৳3,600 of cash, so the headline
              said a person could spend ten lakh they could not touch. It also
              left out money lent, which lives in a hidden control account.

              Above: what can be spent today. Below: what it is all worth. That
              split is the current/non-current distinction every balance sheet
              is required to make, and the reason it is required is exactly the
              mistake this screen was making. */}
          <p className="text-ink-muted mt-3 flex items-baseline justify-between gap-3 text-sm">
            <span>{t('dashboard.netWorth', 'নিট সম্পদ')}</span>
            <Money
              minor={summary.data?.netWorthMinor ?? 0}
              colored
              className="text-ink shrink-0 font-medium"
            />
          </p>
          <p className="text-ink-muted text-xs">
            {t('dashboard.netWorthHint', 'জমি, সঞ্চয়, পাওনা — সব ধরে, দায় বাদ দিয়ে')}
          </p>

          {/* Never a bare number: the breakdown is always visible — and grouped,
              with a subtotal on each heading, because "how much is on my ten
              credit cards" is a question a flat list of fourteen rows cannot
              answer. */}
          <ul className="divide-rule mt-3 divide-y border-t pt-1">
            {BREAKDOWN_GROUPS.flatMap(({ key, label }) => {
              const rows = (accounts.data ?? []).filter(
                (account) => groupOfAccount(account.type as AccountType) === key,
              );
              if (rows.length === 0) return [];
              const subtotal = rows.reduce((sum, account) => sum + account.balanceMinor, 0);
              const cards = rows.filter((account) => account.type === 'CREDIT_CARD');
              const cardTotal = cards.reduce((sum, account) => sum + account.balanceMinor, 0);

              return [
                <li
                  key={`head-${key}`}
                  className="text-ink flex items-center justify-between gap-3 pb-1 pt-2 text-xs font-medium"
                >
                  <span>{t(`dashboard.group.${key}`, label)}</span>
                  <Money minor={subtotal} className="shrink-0" />
                </li>,
                /* The cards on their own line: ten of them is the common case
                   and the one number nobody can add up by eye. */
                ...(cards.length > 1
                  ? [
                      <li
                        key={`cards-${key}`}
                        className="text-ink-muted flex items-center justify-between gap-3 py-1 pl-3 text-xs"
                      >
                        <span>
                          {t('dashboard.ofWhichCards', 'এর মধ্যে ক্রেডিট কার্ড')} ({cards.length})
                        </span>
                        <Money minor={cardTotal} className="shrink-0" />
                      </li>,
                    ]
                  : []),
                ...rows.map((account) => (
                  <li key={account.id} className="flex items-center justify-between gap-3 py-1.5">
                    <span className="text-ink min-w-0 truncate text-sm">{account.name}</span>
                    <Money minor={account.balanceMinor} className="shrink-0 text-sm" />
                  </li>
                )),
              ];
            })}
            {accounts.data?.length === 0 ? (
              <li className="text-ink-muted py-2 text-sm">
                {t('dashboard.noAccounts', 'কোনো অ্যাকাউন্ট নেই।')}{' '}
                <Link href="/accounts" className="text-income underline">
                  {t('dashboard.addOne', 'একটি যোগ করুন')}
                </Link>
              </li>
            ) : null}
          </ul>
        </section>

        <section className="rounded-card border-rule bg-surface border p-4">
          <h2 className="text-ink-muted text-sm font-medium">
            {t('dashboard.topCategories', 'শীর্ষ ৫ খরচের খাত')}
          </h2>
          {topCategories.length === 0 ? (
            <p className="text-ink-muted mt-2 text-sm">
              {t('dashboard.noSpendYet', 'এই মাসে এখনও কোনো খরচ নেই।')}
            </p>
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
            <h2 className="text-ink-muted text-sm font-medium">
              {t('dashboard.recent', 'সাম্প্রতিক লেনদেন')}
            </h2>
            <Link href="/transactions" className="text-income text-sm underline">
              {t('dashboard.seeAll', 'সব দেখুন')}
            </Link>
          </div>
          {recent.data?.items.length === 0 ? (
            <p className="text-ink-muted mt-2 text-sm">
              {t('dashboard.empty', 'এখনও কিছু লেখা হয়নি। নিচের + বোতামে প্রথম লেনদেন যোগ করুন।')}
            </p>
          ) : (
            <ul className="divide-rule mt-2 divide-y">
              {(recent.data?.items ?? []).map((txn) => (
                <li key={txn.id} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="text-ink truncate text-sm">
                      {txn.description || txn.categoryName || txn.accountName}
                    </p>
                    <p className="text-ink-muted truncate text-xs">{fmtDate(txn.date)}</p>
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
