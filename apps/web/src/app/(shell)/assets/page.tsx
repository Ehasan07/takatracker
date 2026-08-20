'use client';

import { useQuery } from '@tanstack/react-query';
import {
  Archive,
  Building2,
  Car,
  ChevronRight,
  Coins,
  LineChart,
  Package,
  Plus,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';
import { Money } from '@/components/money';
import { SkeletonRows } from '@/components/skeleton';
import { Button } from '@/components/ui/button';
import { api, type AccountDto } from '@/lib/api';
import { t } from '@/lib/t';

/**
 * স্থাবর ও দীর্ঘমেয়াদি সম্পদ — the land, the car, the gold, the shares.
 *
 * ## Why this is its own screen
 *
 * These sat among the wallets on `/accounts`, between a bKash balance and a
 * credit card, and the dashboard collapsed the lot into one line reading
 * "৬টি সম্পদ". Neither answers the question somebody with a flat and a car
 * actually has, which is *what do I own and what is it worth now*.
 *
 * IAS 1.54 makes the same split for the same reason: property, plant and
 * equipment on one line, financial investments on another, and neither mixed in
 * with cash. A plot of land and a savings balance are both assets and are not
 * remotely the same kind of fact.
 *
 * ## Cost beside value, always
 *
 * The ledger balance of an asset account is its **carrying amount** — what it
 * cost plus every revaluation since. On its own that number cannot say whether
 * the flat went up or down, so `purchaseCostMinor` is shown next to it and the
 * difference named. That comparison is not decoration: under the revaluation
 * model IAS 16.77(e) requires disclosing what the carrying amount would have
 * been at cost, and this is it.
 *
 * The gain is deliberately never called income. It is a revaluation surplus and
 * it lives in equity (IAS 16.39) — which is what the app already does when you
 * revalue, and what the wording here has to keep true.
 */

type AssetKind = NonNullable<AccountDto['assetKind']>;

/**
 * The five kinds, in balance-sheet order: what you use, then what you hold for
 * its value, then what is financial.
 */
const KINDS: readonly {
  key: AssetKind;
  label: string;
  blurb: string;
  icon: typeof Building2;
}[] = [
  {
    key: 'PROPERTY',
    label: 'স্থাবর সম্পত্তি',
    blurb: 'জমি, ফ্ল্যাট, দোকান',
    icon: Building2,
  },
  { key: 'VEHICLE', label: 'যানবাহন', blurb: 'গাড়ি, মোটরসাইকেল, যন্ত্রপাতি', icon: Car },
  { key: 'GOLD', label: 'স্বর্ণ ও গয়না', blurb: 'সোনা, রুপা, গয়না', icon: Coins },
  { key: 'INVESTMENT', label: 'বিনিয়োগ', blurb: 'শেয়ার, বন্ড, বিও হিসাব', icon: LineChart },
  { key: 'OTHER', label: 'অন্যান্য', blurb: 'যা উপরের কোনোটিতে পড়ে না', icon: Package },
];

const KIND_LABEL: Record<AssetKind, string> = Object.fromEntries(
  KINDS.map((k) => [k.key, k.label]),
) as Record<AssetKind, string>;

export { KIND_LABEL as ASSET_KIND_LABELS };

export default function AssetsPage() {
  /* Archived ones too, because a sold flat still belongs on this page — just
     under its own heading, out of the totals. Its own key so it never collides
     with the live-only list every other screen reads. */
  const accounts = useQuery({
    queryKey: ['accounts', 'withArchived'],
    queryFn: () => api<AccountDto[]>('/accounts?includeArchived=true'),
  });

  const assets = React.useMemo(
    () => (accounts.data ?? []).filter((a) => a.type === 'ASSET' && !a.isArchived),
    [accounts.data],
  );

  /* Sold, and kept. Selling archives the account, so this is the whole record
     of what used to be owned — out of every total on this page, and never
     deleted, because the sale is the last chapter of a history somebody will
     want years later. */
  const sold = React.useMemo(
    () => (accounts.data ?? []).filter((a) => a.type === 'ASSET' && a.isArchived),
    [accounts.data],
  );

  const groups = React.useMemo(
    () =>
      KINDS.map((kind) => ({
        ...kind,
        rows: assets.filter((a) => (a.assetKind ?? 'OTHER') === kind.key),
      })).filter((group) => group.rows.length > 0),
    [assets],
  );

  const totalValue = assets.reduce((sum, a) => sum + a.balanceMinor, 0);
  /* Only over the rows that have a cost recorded. Treating a missing cost as
     zero would report the whole value of that asset as a gain, which is the
     most flattering possible lie. */
  const withCost = assets.filter((a) => a.purchaseCostMinor !== null);
  const totalCost = withCost.reduce((sum, a) => sum + (a.purchaseCostMinor ?? 0), 0);
  const costedValue = withCost.reduce((sum, a) => sum + a.balanceMinor, 0);
  const surplus = costedValue - totalCost;
  const missingCost = assets.length - withCost.length;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <header className="flex items-center justify-between gap-2">
        <h1 className="text-ink hidden text-xl font-semibold sm:text-2xl md:block">
          {t('assets.title', 'স্থাবর ও দীর্ঘমেয়াদি সম্পদ')}
        </h1>
        <Link href="/accounts" className="ms-auto">
          <Button size="sm">
            <Plus className="h-4 w-4" aria-hidden />
            {t('common.new', 'নতুন')}
          </Button>
        </Link>
      </header>

      {accounts.isLoading ? (
        <div className="rounded-card border-rule bg-surface overflow-hidden border">
          <SkeletonRows rows={3} />
        </div>
      ) : assets.length === 0 && sold.length === 0 ? (
        <div className="rounded-card border-rule border border-dashed p-8 text-center">
          <p className="text-ink">
            {t('assets.none', 'এখনও কোনো জমি, গাড়ি বা স্বর্ণ যোগ করা হয়নি।')}
          </p>
          <p className="text-ink-muted mt-1 text-sm">
            {t(
              'assets.noneHint',
              'অ্যাকাউন্ট পাতায় গিয়ে ধরন “সম্পদ” বেছে নিন — তারপর কোনটা জমি আর কোনটা গাড়ি সেটা বলে দিন।',
            )}
          </p>
          <Link href="/accounts">
            <Button className="mt-3">{t('assets.goToAccounts', 'অ্যাকাউন্ট পাতায় যান')}</Button>
          </Link>
        </div>
      ) : (
        <>
          {/* The headline: what it is worth now, and what that cost. */}
          <div className="rounded-card border-rule bg-greenbar border p-4">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-ink-muted text-sm">
                {t('assets.totalValue', 'এখনকার মোট মূল্য')}
              </span>
              <Money minor={totalValue} className="text-ink text-xl font-semibold" />
            </div>

            {withCost.length > 0 ? (
              <div className="border-rule mt-3 flex flex-col gap-1.5 border-t pt-3 text-sm">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-ink-muted">{t('assets.totalCost', 'কেনা দাম')}</span>
                  <Money minor={totalCost} className="text-ink-muted" />
                </div>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-ink flex items-center gap-1.5">
                    {surplus >= 0 ? (
                      <TrendingUp className="text-income h-4 w-4" aria-hidden />
                    ) : (
                      <TrendingDown className="text-expense h-4 w-4" aria-hidden />
                    )}
                    {surplus >= 0
                      ? t('assets.surplus', 'মূল্য বেড়েছে')
                      : t('assets.deficit', 'মূল্য কমেছে')}
                  </span>
                  <Money
                    minor={Math.abs(surplus)}
                    className={
                      surplus >= 0 ? 'text-income font-medium' : 'text-expense font-medium'
                    }
                  />
                </div>
                {/* Said plainly, because somebody seeing a large green number
                    beside their land will otherwise read it as money earned.
                    It is a revaluation surplus and it sits in equity — IAS
                    16.39 — and it is not spendable and not taxable income. */}
                <p className="text-ink-muted mt-1 text-xs">
                  {t(
                    'assets.surplusNote',
                    'দাম বাড়া আয় নয় — বিক্রি না করা পর্যন্ত এটি হাতে আসা টাকা নয়, আর আয় বিবরণীতেও ওঠে না।',
                  )}
                </p>
              </div>
            ) : null}

            {missingCost > 0 ? (
              <p className="text-ink-muted border-rule mt-3 border-t pt-3 text-xs">
                {t(
                  'assets.missingCost',
                  '{n}টি সম্পদের কেনা দাম লেখা নেই, তাই উপরের তুলনায় সেগুলো ধরা হয়নি।',
                ).replace('{n}', String(missingCost))}
              </p>
            ) : null}
          </div>

          {groups.map((group) => {
            const Icon = group.icon;
            const subtotal = group.rows.reduce((sum, a) => sum + a.balanceMinor, 0);
            return (
              <section
                key={group.key}
                className="rounded-card border-rule bg-surface overflow-hidden border"
              >
                <header className="border-rule flex items-center justify-between gap-2 border-b px-3.5 py-2.5">
                  <span className="text-ink flex items-center gap-2 text-sm font-medium">
                    <Icon className="text-ink-muted h-4 w-4" aria-hidden />
                    {group.label}
                  </span>
                  <Money minor={subtotal} className="text-ink shrink-0 text-sm font-semibold" />
                </header>

                <ul className="divide-rule divide-y">
                  {group.rows.map((row) => {
                    const cost = row.purchaseCostMinor;
                    const change = cost === null ? null : row.balanceMinor - cost;
                    return (
                      <li key={row.id}>
                        <Link
                          href={`/accounts/${row.id}/statement`}
                          className="press hover:bg-greenbar flex min-h-11 items-center justify-between gap-3 px-3.5 py-2.5"
                        >
                          <div className="min-w-0">
                            <p className="text-ink truncate text-sm">{row.name}</p>
                            <p className="text-ink-muted truncate text-xs">
                              {cost === null ? (
                                t('assets.noCost', 'কেনা দাম লেখা নেই')
                              ) : (
                                <>
                                  {t('assets.boughtFor', 'কেনা')}{' '}
                                  <Money minor={cost} decimals={false} />
                                  {row.purchaseDate ? ` · ${row.purchaseDate}` : ''}
                                </>
                              )}
                            </p>
                          </div>
                          <div className="shrink-0 text-right">
                            <Money minor={row.balanceMinor} className="text-ink text-sm" />
                            {change !== null && change !== 0 ? (
                              <p
                                className={
                                  change > 0 ? 'text-income text-xs' : 'text-expense text-xs'
                                }
                              >
                                {change > 0 ? '+' : '−'}
                                <Money minor={Math.abs(change)} decimals={false} />
                              </p>
                            ) : null}
                          </div>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}

          {/* Sold, and out of every total above. Kept because "what did I do
              with the Bosila land" is a question that outlives the land. */}
          {sold.length > 0 ? (
            <section className="rounded-card border-rule bg-surface overflow-hidden border opacity-80">
              <header className="border-rule flex items-center gap-2 border-b px-3.5 py-2.5">
                <Archive className="text-ink-muted h-4 w-4" aria-hidden />
                <span className="text-ink-muted text-sm font-medium">
                  {t('assets.sold', 'বিক্রি করা সম্পদ')}
                </span>
              </header>
              <ul className="divide-rule divide-y">
                {sold.map((row) => (
                  <li key={row.id}>
                    <Link
                      href={`/accounts/${row.id}/statement`}
                      className="press hover:bg-greenbar flex min-h-11 items-center justify-between gap-3 px-3.5 py-2.5"
                    >
                      <div className="min-w-0">
                        <p className="text-ink-muted truncate text-sm line-through">{row.name}</p>
                        <p className="text-ink-muted truncate text-xs">
                          {KIND_LABEL[row.assetKind ?? 'OTHER']}
                          {row.purchaseCostMinor !== null ? (
                            <>
                              {' · '}
                              {t('assets.boughtFor', 'কেনা')}{' '}
                              <Money minor={row.purchaseCostMinor} decimals={false} />
                            </>
                          ) : null}
                        </p>
                      </div>
                      <ChevronRight className="text-ink-muted h-4 w-4 shrink-0" aria-hidden />
                    </Link>
                  </li>
                ))}
              </ul>
              <p className="text-ink-muted border-rule border-t px-3.5 py-2 text-xs">
                {t(
                  'assets.soldNote',
                  'এগুলো উপরের মোটের মধ্যে ধরা হয়নি। বিক্রির লাভ বা লোকসান আয় বিবরণীতে আছে।',
                )}
              </p>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
