'use client';

import { useQuery } from '@tanstack/react-query';
import { CalendarRange, ChevronLeft, ChevronRight, Info } from '@/components/icons';
import Link from 'next/link';
import * as React from 'react';
import { Money } from '@/components/money';
import { SkeletonRows } from '@/components/skeleton';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { fmtDate, fmtNumber, getActiveLocale } from '@/lib/format';
import { t } from '@/lib/t';

/**
 * What a month actually costs, once the once-a-year payments are laid flat.
 *
 * ## The whole point, and the whole caveat
 *
 * A ৳12,000 insurance premium leaves the bank in one month. On the khata that
 * month looks ৳12,000 worse and the eleven after it look no better, so "what do
 * we spend in a normal month" cannot be read off any screen. This page divides
 * the premium by twelve and shows ৳1,000 against each month it covers.
 *
 * **It changes nothing.** No transaction is generated here, no balance moves,
 * the income statement is untouched and the khata still shows the whole payment
 * on the day it was made. That is said at the top of the page in the language
 * the books are in, because a reader who thought otherwise would be reading
 * every figure below it wrong.
 *
 * ## Why it is only a way of looking
 *
 * Recognising the prepayment as an asset and releasing it month by month is
 * what IAS 1.27 asks for and it is not what this ledger does. Every statement
 * the app serves declares `basis: 'CASH'`, from one shared constant, and an
 * accrual booked behind that declaration would make it false. A statement
 * header that lies is worse than a monthly figure that needs its own page.
 *
 * ## Where the marking happens
 *
 * On the transaction, in the khata — not here. A payment covers a period
 * because of what was bought, which is a fact about that row, and putting the
 * control anywhere else would separate the fact from the thing it is about.
 * This page is the answer; the khata is where the question is asked.
 */

/** How wide a window this page reads at a time. A year, which is the question. */
const WINDOW_MONTHS = 12;

interface PrepaidLine {
  transactionId: string;
  label: string;
  categoryName: string | null;
  amountMinor: number;
}

interface PrepaidMonth {
  month: string;
  totalMinor: number;
  lines: PrepaidLine[];
}

interface PrepaidItem {
  transactionId: string;
  date: string;
  description: string | null;
  categoryName: string | null;
  accountName: string | null;
  totalMinor: number;
  startMonth: string;
  endMonth: string;
  months: number;
  perMonthMinor: number;
}

interface PrepaidSpread {
  from: string;
  to: string;
  months: PrepaidMonth[];
  items: PrepaidItem[];
  windowTotalMinor: number;
}

/** `2026-04` shifted by whole months, wrapping the year in both directions. */
function shiftMonth(month: string, offset: number): string {
  const ordinal = Number(month.slice(0, 4)) * 12 + (Number(month.slice(5, 7)) - 1) + offset;
  const year = Math.floor(ordinal / 12);
  const inYear = (ordinal % 12) + 1;
  return `${String(year).padStart(4, '0')}-${String(inYear).padStart(2, '0')}`;
}

/** Today's month in the browser's own reckoning — the window's opening guess. */
function thisMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * "এপ্রিল ২০২৬" / "April 2026".
 *
 * Through `Intl` rather than a month table of its own: `formatLedgerDate` in
 * @hishab/shared has the Bengali names but does not export them and always
 * prints a day, which is noise on a column of months. The `catch` is for an
 * environment built without full ICU, where the raw `2026-04` is still readable.
 */
function monthLabel(month: string): string {
  try {
    return new Intl.DateTimeFormat(getActiveLocale() === 'en' ? 'en-GB' : 'bn-BD', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(`${month}-01T00:00:00Z`));
  } catch {
    return fmtNumber(month);
  }
}

export default function PrepaidSpreadPage() {
  const [from, setFrom] = React.useState<string>(thisMonth);

  const spread = useQuery({
    queryKey: ['prepaid', 'spread', from, WINDOW_MONTHS],
    queryFn: () =>
      api<PrepaidSpread>(`/transactions/prepaid/spread?from=${from}&months=${WINDOW_MONTHS}`),
  });

  const items = spread.data?.items ?? [];
  const months = spread.data?.months ?? [];

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-ink text-xl font-semibold sm:text-2xl">
          {t('prepaid.heading', 'মাসে মাসে ভাগ')}
        </h1>
        <Link
          href="/transactions"
          className="press border-rule text-ink hover:bg-greenbar flex min-h-11 items-center rounded-md border px-3 text-sm"
        >
          {t('prepaid.backToLedger', 'খাতায় ফিরুন')}
        </Link>
      </header>

      {/* First, before a single figure. Somebody who thinks these numbers are
          in the books would misread every one of them. */}
      <div className="rounded-card border-rule bg-greenbar border p-3">
        <p className="text-ink flex items-start gap-2 text-sm">
          <Info className="text-income mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            {t(
              'prepaid.pageHint',
              'বীমা, লাইসেন্স, সেশন ফি — একবারে দেওয়া কিন্তু সারা বছরের। এখানে সেগুলো মাসে মাসে ভাগ করে দেখানো হচ্ছে, যাতে বোঝা যায় একটা মাস আসলে কত পড়ে।',
            )}
          </span>
        </p>
        <p className="text-ink-muted mt-2 text-xs">
          {t(
            'prepaid.pageWarning',
            'এটি শুধু দেখার হিসাব। খাতায় কিছু বদলায়নি — পুরো টাকাটা যেদিন গেছে সেদিনই বসানো আছে, এবং কোনো মাসিক লেনদেন তৈরি করা হয়নি।',
          )}
        </p>
      </div>

      {/* A year at a time, stepped a year at a time. Anything finer would be a
          date picker for a question nobody asks in months-and-a-half. */}
      <div className="flex items-center justify-between gap-2">
        <Button
          variant="outline"
          size="sm"
          aria-label={t('prepaid.prevYear', 'আগের বছর')}
          onClick={() => setFrom((m) => shiftMonth(m, -WINDOW_MONTHS))}
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </Button>
        <p className="text-ink min-w-0 flex-1 truncate text-center text-sm font-medium">
          {monthLabel(from)} — {monthLabel(shiftMonth(from, WINDOW_MONTHS - 1))}
        </p>
        <Button
          variant="outline"
          size="sm"
          aria-label={t('prepaid.nextYear', 'পরের বছর')}
          onClick={() => setFrom((m) => shiftMonth(m, WINDOW_MONTHS))}
        >
          <ChevronRight className="h-4 w-4" aria-hidden />
        </Button>
      </div>

      {spread.isLoading ? (
        <div className="rounded-card border-rule bg-surface overflow-hidden border">
          <SkeletonRows rows={6} />
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-card border-rule border border-dashed p-8 text-center">
          <CalendarRange className="text-ink-muted mx-auto h-6 w-6" aria-hidden />
          <p className="text-ink mt-2">
            {t('prepaid.empty', 'এখনও কোনো খরচকে কয়েক মাসের বলা হয়নি।')}
          </p>
          <p className="text-ink-muted mt-1 text-sm">
            {t(
              'prepaid.emptyHint',
              'খাতা থেকে একটি খরচ খুলুন — যেমন বীমার প্রিমিয়াম — আর “কয়েক মাসের খরচ” বলে কত মাসের তা লিখে দিন।',
            )}
          </p>
          <Link
            href="/transactions"
            className="press bg-ink text-surface mt-3 inline-flex min-h-11 items-center rounded-md px-4 text-sm"
          >
            {t('prepaid.goToLedger', 'খাতায় যান')}
          </Link>
        </div>
      ) : (
        <>
          {/* The window's own total, labelled for exactly what it is. Calling
              it "this year's expense" would be the one sentence on this page
              that was not true. */}
          <div className="rounded-card border-rule bg-surface flex items-baseline justify-between gap-2 border p-3">
            <span className="text-ink-muted text-xs">
              {t('prepaid.windowTotal', 'এই বারো মাসে ভাগ করে পড়ছে')}
            </span>
            <Money minor={spread.data?.windowTotalMinor ?? 0} className="text-lg font-semibold" />
          </div>

          <ul className="rounded-card border-rule bg-surface divide-rule divide-y overflow-hidden border">
            {months.map((month) => (
              <li key={month.month} className="p-3">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-ink text-sm font-medium">{monthLabel(month.month)}</span>
                  {month.totalMinor > 0 ? (
                    <Money minor={month.totalMinor} className="text-sm" />
                  ) : (
                    <span className="text-ink-muted text-xs">
                      {t('prepaid.nothing', 'কিছু নেই')}
                    </span>
                  )}
                </div>
                {month.lines.length > 0 ? (
                  <ul className="mt-1.5 flex flex-col gap-1">
                    {month.lines.map((line) => (
                      <li
                        key={`${month.month}-${line.transactionId}`}
                        className="flex items-baseline justify-between gap-2"
                      >
                        <span className="text-ink-muted min-w-0 truncate text-xs">
                          {line.label}
                        </span>
                        <Money
                          minor={line.amountMinor}
                          className="text-ink-muted shrink-0 text-xs"
                        />
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>

          {/* Everything marked, whether or not it reaches into the window. A
              premium whose year ended last March would otherwise vanish the
              moment somebody stepped forward, and it is exactly the row they
              would go looking for to correct. */}
          <section className="flex flex-col gap-2">
            <h2 className="text-ink text-sm font-semibold">
              {t('prepaid.itemsHeading', 'যেসব খরচ ভাগ করে দেখানো হচ্ছে')}
            </h2>
            <ul className="rounded-card border-rule bg-surface divide-rule divide-y overflow-hidden border">
              {items.map((item) => (
                <li key={item.transactionId} className="flex items-start gap-3 p-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-ink truncate text-sm">
                      {item.description || item.categoryName || t('entry.transaction', 'লেনদেন')}
                    </p>
                    <p className="text-ink-muted truncate text-xs">
                      {fmtDate(item.date)}
                      {item.accountName ? ` · ${item.accountName}` : ''}
                    </p>
                    <p className="text-ink-muted truncate text-xs">
                      {monthLabel(item.startMonth)} — {monthLabel(item.endMonth)} ·{' '}
                      {t('prepaid.coversN', '{n} মাসের').replace(
                        '{n}',
                        fmtNumber(String(item.months)),
                      )}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <Money minor={item.totalMinor} className="block text-sm" />
                    <span className="text-ink-muted text-[11px]">
                      {t('prepaid.perMonth', 'মাসে')}{' '}
                    </span>
                    <Money minor={item.perMonthMinor} className="text-ink-muted text-[11px]" />
                  </div>
                </li>
              ))}
            </ul>
            <p className="text-ink-muted text-xs">
              {t('prepaid.editHint', 'মেয়াদ বদলাতে বা ভাগ করা বন্ধ করতে খাতা থেকে খরচটি খুলুন।')}
            </p>
          </section>
        </>
      )}
    </div>
  );
}
