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
import { CardAmount } from '@/components/card-amount';
import { Money } from '@/components/money';
import { SkeletonCard } from '@/components/skeleton';
import { ComparePanel } from '@/components/dashboard/compare-panel';
import { MoversPanel } from '@/components/dashboard/movers-panel';
import { PacePanel } from '@/components/dashboard/pace-panel';
import { useToday } from '@/components/dashboard/parts';
import { SpendSplit } from '@/components/dashboard/spend-split';
import { TrendPanel } from '@/components/dashboard/trend-panel';
import { monthComparison } from '@/components/dashboard/month';
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
  liquid: 'bg-brand/10 text-brand',
  asset: 'bg-brass/10 text-brass',
  liability: 'bg-expense/10 text-expense',
};

/**
 * The rail down the left of every account row, in its group's colour.
 *
 * The list is the tallest thing on this screen and it used to be a column of
 * names with numbers beside them — a reader had to reach the subtotal header
 * above a row to know which kind of thing it was. A 3px rail carries that up
 * the whole column, so an overdrawn cash account reads as one at a glance
 * rather than after a scroll.
 *
 * Liquid moved off green onto the brand colour. Green means *money in* in this
 * app, and a green rail beside every bank account was quietly competing with
 * the one place green has to mean something.
 */
const GROUP_RAIL: Record<BreakdownGroup, string> = {
  liquid: 'bg-brand',
  asset: 'bg-brass',
  liability: 'bg-expense',
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

/**
 * The month as a proportion.
 *
 * Deliberately not a chart component: two divs and a total, so it costs
 * nothing on a phone and keeps working with JavaScript still downloading.
 * Colour is never the only signal — each row is labelled in words and the
 * amounts keep their own income/expense colours, which is what carries the
 * meaning for a reader who cannot separate red from green.
 */
/**
 * A credit card's balance, with the word that says which way it points.
 *
 * ## Why the word and not just the sign
 *
 * A card is a liability, so this ledger holds it negative when money is owed —
 * correct, and unreadable at a glance. The owner looked at `+৳1,66,867.64` in
 * green on four cards and asked whether it meant due or available, which is
 * exactly the question a minus sign in front of a number does not answer for
 * anybody who is not an accountant. It is also the question worth getting right:
 * a card is the one account where the two readings are opposites.
 *
 * So the sign is dropped and the word carries the direction — বকেয়া when it is
 * owed, জমা when the card is genuinely in credit — with the colour behind it
 * rather than instead of it. Zero says nothing, because nothing is the answer.
 *
 * ## What it is not
 *
 * Not a conversion, and not a correction. The figure is whatever the books hold;
 * if that figure is wrong — and the imported card history made several of them
 * wrong — this makes the wrongness legible rather than hiding it. A card
 * reading জমা ৳23 lakh against a ৳4 lakh limit is now obviously a thing to go
 * and fix, which it was not when it read `+৳23,15,603.43`.
 */
function MonthBars({
  incomeMinor,
  expenseMinor,
  netMinor,
}: {
  incomeMinor: number;
  expenseMinor: number;
  netMinor: number;
}) {
  /* Against the larger of the two, so one bar is always full and the other is
     read against it. Against a fixed maximum instead, a quiet month would draw
     two stubs and say nothing. */
  const peak = Math.max(incomeMinor, expenseMinor, 1);
  const width = (minor: number): string => `${Math.max(0, (minor / peak) * 100)}%`;

  const rows = [
    {
      key: 'income',
      label: t('dashboard.income', 'আয়'),
      minor: incomeMinor,
      bar: 'bg-income',
      text: 'text-income',
    },
    {
      key: 'expense',
      label: t('dashboard.expense', 'খরচ'),
      minor: expenseMinor,
      bar: 'bg-expense',
      text: 'text-expense',
    },
  ];

  return (
    <div className="mt-3 flex flex-col gap-2">
      {rows.map((row) => (
        <div key={row.key} className="grid grid-cols-[3rem_1fr_auto] items-center gap-2">
          <span className="text-ink-muted text-xs">{row.label}</span>
          <span className="bg-greenbar h-2 overflow-hidden rounded-full">
            <span
              className={`block h-full rounded-full ${row.bar}`}
              style={{ width: width(row.minor) }}
            />
          </span>
          <Money
            minor={row.minor}
            className={`${row.text} shrink-0 text-sm font-medium`}
            decimals={false}
          />
        </div>
      ))}
      <p className="bg-greenbar text-ink mt-1 flex items-baseline justify-between gap-3 rounded-md px-3 py-2 text-sm font-medium">
        <span>{t('dashboard.net', 'নিট')}</span>
        <Money minor={netMinor} colored signed className="shrink-0" decimals={false} />
      </p>
    </div>
  );
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

  /* The two windows every analysis panel below is measured over — this month so
     far, and the same stretch of last month. Taken once, here, so seven panels
     cannot disagree about what "গত মাস" means, and null until the browser has a
     date of its own. See `components/dashboard/month.ts`. */
  const today = useToday();
  const month = React.useMemo(() => (today ? monthComparison(today) : null), [today]);

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
  /* What the cards actually owe. A card in credit contributes nothing rather
     than netting against another card's debt: two cards, one ৳10,000 down and
     one ৳10,000 up, owe ৳10,000 between them and not zero — the bank that is
     owed will not accept the other card's balance as payment. */
  const cardsDrawn = homeAccounts.reduce(
    (sum, account) =>
      account.type === 'CREDIT_CARD' && account.balanceMinor < 0 ? sum - account.balanceMinor : sum,
    0,
  );

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

      {/* Two columns that pack their own contents, and one list on a phone.
       *
       * ## What was wrong with the grid this replaced
       *
       * Four cards in a two-column grid, laid out in source order. The
       * breakdown on the right runs to fourteen hundred pixels on a full set of
       * books; the summary card beside it is ninety. A grid row is as tall as
       * its tallest cell, so the left column was a small card followed by
       * roughly *twelve hundred pixels of nothing*, and the next two cards began
       * below the breakdown rather than beside it. Every fix that keeps a flat
       * grid has the same shape — a tall cell spanning rows spreads its
       * neighbours out to fill the span, which trades one gap for four.
       *
       * So each column is its own stack and neither knows how tall the other is.
       *
       * ## What is in which column
       *
       * Left: this month and what to make of it — the figures, the comparison,
       * the pace, what moved, and the last few entries. Right: what is *held* —
       * the account breakdown, where the month's money went, and the six-month
       * shape behind it. The split is by question rather than by height, and the
       * heights come out within a few percent of each other on a real set of
       * books because the two questions happen to need about as much room.
       *
       * ## Why the wrappers are `display: contents` on a phone
       *
       * Two column wrappers would force the phone into "everything in the left
       * column, then the breakdown" — which buries net worth and account
       * balances under five panels of analysis on the screen where they are read
       * most. `contents` makes the wrappers vanish below `md`, so all eight
       * panels are direct children of one flex column and `order-*` puts them in
       * the order a phone wants: this month, then what is in the bank, then the
       * analysis. Above `md` the wrappers become the two columns and the order
       * classes sort within each.
       */}
      <div className="flex flex-col gap-3 md:grid md:grid-cols-2 md:items-start">
        <div data-testid="dashboard-main" className="contents md:flex md:flex-col md:gap-3">
          <section className="rounded-card border-rule bg-surface order-1 border p-4">
            <h2 className="text-ink-muted text-sm font-medium">
              {t('dashboard.thisMonth', 'এই মাসের হিসাব')}
            </h2>
            {/* The window these three cover, said out loud. The panels underneath
              compare *part* of this month with part of the last, and a reader
              who takes one of those figures for one of these gets an answer to a
              question they did not ask. */}
            <p className="text-ink-muted mt-0.5 text-xs">
              {t('dashboard.thisMonthScope', 'চলতি মাসের পুরো হিসাব')}
            </p>
            {/* Two bars and a total, rather than three figures side by side.
             *
             * All three numbers were correct and the screen still could not
             * answer the question people actually ask of it — "is that a lot?"
             * — because comparing ৳3,54,046 against ৳14,71,010 means dividing
             * one by the other in your head. The bars are that division, drawn:
             * spending at a quarter of income is a quarter of the width.
             *
             * Widths come off the same integers `<Money>` prints, scaled to
             * whichever figure is larger so the longer bar is always full. They
             * are percentages of a container — a screenful of pixels, never
             * money — and no rounding here can reach a printed amount. */}
            <MonthBars
              incomeMinor={summary.data?.incomeMinor ?? 0}
              expenseMinor={summary.data?.expenseMinor ?? 0}
              netMinor={summary.data?.netMinor ?? 0}
            />
          </section>

          {/* The three panels that answer a question rather than fill a column,
            in the order a person asks them: how does this month compare with
            the last, where is it heading, and what actually changed. All three
            ride on one request — see `components/dashboard/queries.ts`. */}
          {month ? (
            <>
              <ComparePanel month={month} className="order-3" />
              <PacePanel month={month} className="order-4" />
              <MoversPanel month={month} className="order-6" />
            </>
          ) : (
            /* One frame, until the browser hands over its own date — see
             `useToday`. A placeholder rather than nothing, so the column does
             not jump the moment it arrives. */
            <SkeletonCard className="order-3" />
          )}

          <section className="rounded-card border-rule bg-surface order-8 border p-4">
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
                {t(
                  'dashboard.empty',
                  'এখনও কিছু লেখা হয়নি। নিচের + বোতামে প্রথম লেনদেন যোগ করুন।',
                )}
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

        {/* The other column: what is held, where the month's money went, and
            the six months behind it. The breakdown alone is the tallest thing on
            the screen with a full set of books, which is why it has a column
            rather than a neighbour that had to match its height. */}
        <div data-testid="dashboard-side" className="contents md:flex md:flex-col md:gap-3">
          <section className="rounded-card border-rule bg-surface order-2 border p-4">
            {/* Net worth first, in the largest type on the screen.
             *
             * It used to be the other way round: ৳14,31,268 of liquid cash set
             * at 2xl with net worth beneath it in body size. But the question
             * somebody opens a finance app to answer is "what am I worth", and
             * "what can I touch today" is the *second* question. The old order
             * answered the second one loudest.
             *
             * On the brand ground rather than on paper, because there is one
             * headline figure per screen and it should not have to compete with
             * the four cards under it for the eye. */}
            <div className="bg-brand text-brand-contrast -m-4 mb-0 flex flex-col gap-3 rounded-t-[inherit] p-4">
              <Link href="/accounts" className="press flex items-center gap-1 text-sm opacity-85">
                {t('dashboard.netWorth', 'নিট সম্পদ')}
                <ChevronRight className="h-4 w-4" aria-hidden />
              </Link>
              {/* Poisha kept, and the type scaled instead.
               *
               * The first draft dropped the decimals to keep the headline
               * short. But this is the figure a person quotes, and rounding
               * ৳66,48,828.24 to ৳66,48,828 is a small lie told in the largest
               * type on the screen — the one place this application cannot
               * afford one. So the number stays exact and the size gives way on
               * a narrow phone instead. */}
              <Money
                minor={summary.data?.netWorthMinor ?? 0}
                colored={false}
                signed
                className="text-2xl font-semibold leading-none sm:text-3xl"
              />
              <p className="text-xs opacity-80">
                {t('dashboard.netWorthHint', 'জমি, সঞ্চয়, পাওনা — সব ধরে, দায় বাদ দিয়ে')}
              </p>
              <dl className="border-current/20 grid grid-cols-2 gap-3 border-t pt-3">
                <div className="min-w-0">
                  <dt className="text-xs opacity-80">{t('dashboard.liquid', 'হাতে ও ব্যাংকে')}</dt>
                  <dd>
                    <Money minor={summary.data?.liquidMinor ?? 0} className="block font-semibold" />
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-xs opacity-80">{t('dashboard.cardsDrawn', 'কার্ডে দেনা')}</dt>
                  <dd>
                    <Money minor={cardsDrawn} className="block font-semibold" />
                  </dd>
                </div>
              </dl>
            </div>

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
              <div className="border-rule mt-4 border-t pt-3">
                {/* Two figures rather than their sum.
                 *
                 * It read "খরচ করার সামর্থ্য ৳22,51,983" with three lines
                 * underneath explaining that ৳8,20,715 of it was not the
                 * reader's money. A number that needs a paragraph of caveat is
                 * two numbers that have been added together — so they are two
                 * numbers again: what has been drawn, which is a liability, and
                 * what has not, which is nothing at all. The caveat then fits
                 * in one line and is about the second figure only. */}
                <dl className="grid grid-cols-2 gap-3">
                  <div className="min-w-0">
                    <dt className="text-ink-muted text-xs">
                      {t('dashboard.cardsDrawnLabel', 'কার্ডে তোলা — দায়')}
                    </dt>
                    <dd>
                      <Money minor={cardsDrawn} className="text-expense block font-semibold" />
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-ink-muted text-xs">
                      {t('dashboard.undrawnLabel', 'না-তোলা লিমিট')}
                    </dt>
                    <dd>
                      <Money minor={undrawn} className="text-brass block font-semibold" />
                    </dd>
                  </div>
                </dl>
                <p className="text-ink-muted border-brass mt-2 border-l-2 pl-2 text-xs">
                  {t(
                    'dashboard.undrawnHint',
                    'না-তোলা লিমিট আপনার টাকাও নয়, দায়ও নয় — ব্যাংক যেকোনো দিন কমিয়ে দিতে পারে। নিট সম্পদে ধরা হয়নি।',
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
                /* Only the cards that carry a limit have room to report, and a
                   set of cards with none has nothing to say here. */
                const cardLimit = cards.reduce((sum, a) => sum + a.creditLimitMinor, 0);
                const cardUndrawn = cards.reduce((sum, a) => sum + a.undrawnMinor, 0);
                const cardDrawn = cards.reduce((sum, a) => sum + a.drawnMinor, 0);

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
                          <CardAmount
                            minor={cardTotal}
                            undrawnMinor={cardUndrawn}
                            drawnMinor={cardDrawn}
                            limitMinor={cardLimit}
                          />
                        </li>,
                      ]
                    : []),
                  ...rows.map((account) => (
                    <li
                      key={account.id}
                      className="grid grid-cols-[3px_1fr_auto] items-center gap-2 py-1.5"
                    >
                      {/* The group's colour, except where the row is negative:
                          an overdrawn account is the thing on this list most
                          worth spotting, and it should not have to be read to
                          be found. */}
                      <span
                        aria-hidden
                        className={`h-full min-h-5 rounded-full ${
                          account.balanceMinor < 0 ? 'bg-expense' : GROUP_RAIL[key]
                        }`}
                      />
                      <span className="text-ink min-w-0 truncate text-sm">{account.name}</span>
                      {account.type === 'CREDIT_CARD' ? (
                        <CardAmount
                          minor={account.balanceMinor}
                          undrawnMinor={account.undrawnMinor}
                          drawnMinor={account.drawnMinor}
                          limitMinor={account.creditLimitMinor}
                        />
                      ) : (
                        <Money
                          minor={account.balanceMinor}
                          signed
                          colored
                          className="shrink-0 text-sm"
                        />
                      )}
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

          {/* Where this month's money went, under the accounts it came out of.
              A ring rather than five bars of one colour: every slice is a share
              of the same whole, and the whole is the month — see
              `components/dashboard/spend-split.tsx`. */}
          <section className="rounded-card border-rule bg-surface order-7 border p-4">
            <h2 className="text-ink-muted text-sm font-medium">
              {t('dashboard.split.heading', 'খরচ কোথায় গেল')}
            </h2>
            <p className="text-ink-muted mt-0.5 text-xs">
              {t('dashboard.thisMonthScope', 'চলতি মাসের পুরো হিসাব')}
            </p>
            <SpendSplit rows={summary.data?.expenseByCategory ?? []} />
          </section>

          {/* And the six months behind all of it, so a bad month can be told
              from a normal one. */}
          {month ? (
            <TrendPanel month={month} className="order-5" />
          ) : (
            <SkeletonCard className="order-5" />
          )}
        </div>
      </div>
    </div>
  );
}
