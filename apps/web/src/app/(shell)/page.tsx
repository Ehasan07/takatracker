'use client';

import { useQuery } from '@tanstack/react-query';
import { fmtDate, fmtDateObject, fmtNumber } from '@/lib/format';
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
import { endpoints, type AccountDto } from '@/lib/api';
import { useWorkspaceSettings } from '@/lib/workspace-settings';

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

/**
 * A tint per group, and never the only signal.
 *
 * Green for what is held, red for what is owed, and a neutral brass for what is
 * owned but not spendable. The heading still says which is which in words and
 * every figure still carries its sign, because a colour alone fails anybody
 * reading this in sunlight or with a red-green deficiency — about one man in
 * twelve.
 */
const GROUP_TINT: Record<BreakdownGroup, string> = {
  liquid: 'bg-income/10 text-income',
  asset: 'bg-brass/10 text-brass',
  liability: 'bg-expense/10 text-expense',
};

type AccountType = keyof typeof ACCOUNT_CLASS;

const groupOfAccount = (type: AccountType): BreakdownGroup => {
  if (LIQUID_TYPES.includes(type)) return 'liquid';
  return ACCOUNT_CLASS[type] === 'LIABILITY' ? 'liability' : 'asset';
};

/**
 * Accounts split into the ones the totals cover and the ones they cannot.
 *
 * The app does not convert currency. `LedgerEntry.fxRate` is an `Int` that
 * every writer sets to 1 and nothing anywhere reads a rate, so adding a USD
 * account's $500 into a taka figure would assert a rate of 1.00 that nobody
 * chose — the balances are integers in *each account's* minor unit. Doing it
 * properly means a spot rate per transaction date (IAS 21.21) and a closing
 * rate to retranslate monetary balances by (IAS 21.23(a)); until that exists
 * the honest total is one that says what it covers.
 *
 * The same split, by the same rule, is applied on the server in
 * `AccountsService.position` — which is where `liquidMinor` and
 * `netWorthMinor` come from — and again on the accounts screen. All three
 * compare the account's currency with the workspace's, case-insensitively,
 * because `Account.currency` is a free three-character string that nothing
 * upper-cases on the way in.
 *
 * Before `/auth/me` answers, `homeCurrency` is only a guess, so nothing is
 * called foreign yet: the first paint is exactly what it was.
 */
function splitByCurrency(
  accounts: readonly AccountDto[],
  homeCurrency: string,
  ready: boolean,
): { home: AccountDto[]; foreign: AccountDto[] } {
  if (!ready) return { home: [...accounts], foreign: [] };
  const home = homeCurrency.toUpperCase();
  return {
    home: accounts.filter((a) => a.currency.toUpperCase() === home),
    foreign: accounts.filter((a) => a.currency.toUpperCase() !== home),
  };
}

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

  const { currency, ready: currencyReady } = useWorkspaceSettings();
  const { home: homeAccounts, foreign: foreignAccounts } = React.useMemo(
    () => splitByCurrency(accounts.data ?? [], currency, currencyReady),
    [accounts.data, currency, currencyReady],
  );

  /* Reported beside net worth, never added into it — and only the cards kept in
     the books' own currency, because the figure it is added to (`liquidMinor`)
     covers only those. A dollar card's headroom added to a taka total would be
     the same unconverted lie one level down. */
  const undrawn = homeAccounts.reduce((sum, account) => sum + (account.undrawnMinor ?? 0), 0);

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
              signed
              className="shrink-0 font-medium"
            />
          </p>
          <p className="text-ink-muted text-xs">
            {t('dashboard.netWorthHint', 'জমি, সঞ্চয়, পাওনা — সব ধরে, দায় বাদ দিয়ে')}
          </p>

          {/* Spending power, kept firmly outside net worth.
           *
           * "How much could I spend today" and "how much am I worth" are
           * different questions, and a credit limit answers only the first. It
           * is not cash — IAS 7.6 keeps that to what is held, and the undrawn
           * part sits with the bank, which may withdraw it. The Conceptual
           * Framework asks for a resource the entity controls; an unused
           * facility is not one, and no past event has occurred. IAS 7.50(a)
           * settles the treatment: undrawn facilities are disclosed, never
           * recognised.
           *
           * Adding it above would make net worth jump by four lakh for doing
           * nothing at all, which is what makes this a separate block with its
           * own warning rather than another line in the same list. */}
          {undrawn > 0 ? (
            <div className="border-rule mt-3 border-t pt-2">
              <p className="text-ink-muted flex items-baseline justify-between gap-3 text-sm">
                <span>{t('dashboard.spendingPower', 'খরচ করার সামর্থ্য')}</span>
                <Money
                  minor={(summary.data?.liquidMinor ?? 0) + undrawn}
                  className="text-ink shrink-0 font-medium"
                />
              </p>
              <p className="text-ink-muted mt-0.5 flex items-baseline justify-between gap-3 text-xs">
                <span>{t('dashboard.undrawn', 'এর মধ্যে কার্ডে তোলা যাবে')}</span>
                <Money minor={undrawn} className="shrink-0" />
              </p>
              <p className="text-ink-muted mt-1 text-xs">
                {t(
                  'dashboard.undrawnHint',
                  'কার্ডের অংশটা আপনার টাকা নয়, ধার — খরচ করলে দায় বাড়বে আর সুদ শুরু হবে। নিট সম্পদে এটি ধরা হয়নি।',
                )}
              </p>
            </div>
          ) : null}

          {/* Never a bare number: the breakdown is always visible.
           *
           * Two of the three groups are itemised and one is not, and that is
           * IAS 1.60 rather than a layout preference. The current/non-current
           * split exists so a reader can tell what will turn into cash soon
           * from what will not, and IAS 1.29 asks for dissimilar things to be
           * presented apart. A plot of land is not going to be spent this
           * month; listing it row by row between two bank accounts answers a
           * question nobody asked of this screen and buries the one they did.
           *
           * So land, gold and a car arrive as one line with a way through to
           * the detail. Net worth still counts every taka of them — leaving
           * them out of the total would be a different and worse lie. */}
          <ul className="divide-rule mt-3 divide-y border-t pt-1">
            {BREAKDOWN_GROUPS.flatMap(({ key, label }) => {
              /* `homeAccounts`, not every account: these subtotals have to add
                 up to the liquid and net worth figures above, and those come
                 from the server with foreign-currency accounts left out. The
                 excluded ones are listed below in their own money. */
              const rows = homeAccounts.filter(
                (account) => groupOfAccount(account.type as AccountType) === key,
              );
              if (rows.length === 0) return [];
              const subtotal = rows.reduce((sum, account) => sum + account.balanceMinor, 0);
              const cards = rows.filter((account) => account.type === 'CREDIT_CARD');
              const cardTotal = cards.reduce((sum, account) => sum + account.balanceMinor, 0);

              const header = (
                <li
                  key={`head-${key}`}
                  className={`flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-xs font-medium ${GROUP_TINT[key]}`}
                >
                  <span>{t(`dashboard.group.${key}`, label)}</span>
                  <Money minor={subtotal} signed colored className="shrink-0" />
                </li>
              );

              /* The one group that is summarised. Everything a person could
                 spend or owes this month is spelled out; what is locked up in
                 land is a figure and a door. */
              if (key === 'asset') {
                return [
                  header,
                  <li key="asset-summary" className="py-1.5">
                    <Link
                      href="/assets"
                      className="press text-ink-muted hover:text-ink flex items-center justify-between gap-3 text-sm"
                    >
                      <span>
                        {t(
                          'dashboard.assetCount',
                          '{n}টি সম্পদ — জমি, গাড়ি, স্বর্ণ, শেয়ার',
                        ).replace('{n}', String(rows.length))}
                      </span>
                      <ChevronRight className="h-4 w-4 shrink-0" aria-hidden />
                    </Link>
                  </li>,
                ];
              }

              return [
                header,
                ...(cards.length > 1
                  ? [
                      <li
                        key={`cards-${key}`}
                        className="text-ink-muted flex items-center justify-between gap-3 py-1 pl-3 text-xs"
                      >
                        <span>
                          {t('dashboard.ofWhichCards', 'এর মধ্যে ক্রেডিট কার্ড')} ({cards.length})
                        </span>
                        <Money minor={cardTotal} signed colored className="shrink-0" />
                      </li>,
                    ]
                  : []),
                ...rows.map((account) => (
                  <li key={account.id} className="flex items-center justify-between gap-3 py-1.5">
                    <span className="text-ink min-w-0 truncate text-sm">{account.name}</span>
                    <Money
                      minor={account.balanceMinor}
                      signed
                      colored
                      className="shrink-0 text-sm"
                    />
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
            ) : homeAccounts.length === 0 ? (
              /* Everything they have is in another currency. Saying "no
                 accounts" here would be false, and an empty list with no
                 sentence would read as a bug. */
              <li className="text-ink-muted py-2 text-sm">
                {t('dashboard.noHomeAccounts', 'খাতার মুদ্রায় রাখা কোনো অ্যাকাউন্ট নেই।')}
              </li>
            ) : null}
          </ul>

          {/* Named, not hidden.
           *
           * These balances are real and the app can show them; what it cannot
           * do is add them to anything, because it has no rate. IAS 21.23(a)
           * would retranslate a monetary balance at the closing rate and IAS
           * 21.28 would book the difference that falls out — neither is
           * implemented, and `LedgerEntry.fxRate` is an integer column that
           * could not hold 121.50 if it were. So the account keeps its own
           * money, in its own money, and the screen says plainly that it is
           * outside the totals above.
           *
           * Nothing about currency appears at all when every account is in the
           * books' own — which is nearly every workspace. */}
          {foreignAccounts.length > 0 ? (
            <div className="border-rule mt-3 border-t pt-2">
              <p className="text-ink-muted flex items-baseline justify-between gap-3 text-sm">
                <span>{t('dashboard.foreign', 'অন্য মুদ্রার অ্যাকাউন্ট')}</span>
                <span className="text-ink-muted shrink-0 text-xs">
                  {t('dashboard.foreignCount', '{n}টি').replace(
                    '{n}',
                    fmtNumber(String(foreignAccounts.length)),
                  )}
                </span>
              </p>
              <ul className="divide-rule mt-1 divide-y">
                {foreignAccounts.map((account) => (
                  <li key={account.id} className="flex items-center justify-between gap-3 py-1.5">
                    <span className="text-ink min-w-0 truncate text-sm">{account.name}</span>
                    <span className="text-ink-muted shrink-0 text-sm">
                      <Money
                        minor={account.balanceMinor}
                        currency={account.currency}
                        signed
                        className="text-ink"
                      />{' '}
                      {account.currency.toUpperCase()}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="text-ink-muted mt-1 text-xs">
                {t(
                  'dashboard.foreignHint',
                  'উপরের কোনো যোগফলে এগুলো ধরা হয়নি — অ্যাপ এখনও এক মুদ্রা থেকে আরেক মুদ্রায় রূপান্তর করে না। প্রতিটির জের তার নিজের মুদ্রাতেই দেখানো হলো।',
                )}
              </p>
            </div>
          ) : null}
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
