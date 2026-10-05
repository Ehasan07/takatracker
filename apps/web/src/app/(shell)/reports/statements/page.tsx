'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Printer } from '@/components/icons';
import Link from 'next/link';
import * as React from 'react';
import { StandardNote } from '@/components/info-note';
import { Money } from '@/components/money';
import { SkeletonRows } from '@/components/skeleton';
import { Field, Input } from '@/components/ui/field';
import { toLocalDateString } from '@hishab/shared';
import { fmtDate, fmtDateObject, fmtNumber } from '@/lib/format';
import { t } from '@/lib/t';
import {
  fetchBalanceSheetAt,
  fetchCashFlow,
  fetchIncomeStatement,
  fetchNetWorthChanges,
  reportKeys,
} from '../queries';
import type { CategoryNode } from '../types';

/**
 * The four statements, for any window, on one printable page.
 *
 * ## Why they live together
 *
 * They are not four reports; they are four views of one period that have to
 * agree. The income statement says what was earned and spent, the balance sheet
 * says what that left, the cash flow says where the money came from, and the
 * fourth reconciles the first two. Reading them apart is how somebody misses
 * that they disagree — which is exactly what the reconciliation exists to catch,
 * and why it is on the same page rather than behind a tab.
 *
 * ## Why the existing reports were not replaced
 *
 * "Where did the money go this month" and "what is my position" are different
 * questions asked by different people at different times. The category and tag
 * screens answer the first; these answer the second. Both are wanted.
 */

/**
 * Today, and the start of this year, in the *workspace's* day.
 *
 * `new Date().toISOString().slice(0, 10)` is the obvious version and it is
 * wrong here by up to six hours: Dhaka is UTC+6, so between midnight and 6am
 * the UTC date is still yesterday. The default window would have ended before
 * today, and anything recorded that morning — a revaluation, a bill — would be
 * missing from a statement that looked complete. Caught by a test that revalued
 * land at 5am and could not find it afterwards.
 */
const today = (): string => toLocalDateString(new Date());
const firstOfYear = (): string => `${today().slice(0, 4)}-01-01`;

export default function StatementsPage() {
  const [from, setFrom] = React.useState(firstOfYear);
  const [to, setTo] = React.useState(today);

  const period = React.useMemo(() => ({ from, to }), [from, to]);
  /* The same window a year earlier, which is the comparison IAS 1 has in mind
     and the one a reader can actually interpret. */
  const compare = React.useMemo(
    () => ({
      from: shiftYear(from, -1),
      to: shiftYear(to, -1),
    }),
    [from, to],
  );

  const income = useQuery({
    queryKey: reportKeys.incomeStatement(period, compare),
    queryFn: () => fetchIncomeStatement(period, compare),
  });
  const sheet = useQuery({
    queryKey: reportKeys.balanceSheetAt(to),
    queryFn: () => fetchBalanceSheetAt(to),
  });
  const flow = useQuery({
    queryKey: reportKeys.cashFlow(period),
    queryFn: () => fetchCashFlow(period),
  });
  const changes = useQuery({
    queryKey: reportKeys.netWorthChanges(period),
    queryFn: () => fetchNetWorthChanges(period),
  });

  const loading = income.isLoading || sheet.isLoading || flow.isLoading || changes.isLoading;

  return (
    <div className="statement mx-auto flex w-full max-w-4xl flex-col gap-4">
      <div className="no-print flex flex-wrap items-center justify-between gap-2">
        <Link
          href="/reports"
          className="press text-ink-muted hover:text-ink flex min-h-11 w-fit items-center gap-1.5 text-sm"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          {t('nav.reports', 'রিপোর্ট')}
        </Link>
        <button
          type="button"
          onClick={() => window.print()}
          className="press border-rule text-ink hover:bg-greenbar flex min-h-11 items-center gap-1.5 rounded-md border px-3 text-sm"
        >
          <Printer className="h-4 w-4" aria-hidden />
          {t('statements.print', 'প্রিন্ট বা PDF')}
        </button>
      </div>

      <header>
        <h1 className="text-ink text-xl font-semibold sm:text-2xl">
          {t('statements.title', 'আর্থিক বিবৃতি')}
        </h1>
        <p className="text-ink-muted text-sm">
          {t('statements.blurb', 'আয়-ব্যয়, স্থিতিপত্র, নগদ প্রবাহ ও নিট সম্পদের পরিবর্তন')}
        </p>
      </header>

      <div className="no-print grid grid-cols-2 gap-3">
        <Field label={t('statements.from', 'শুরুর তারিখ')} htmlFor="st-from">
          <Input id="st-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label={t('statements.to', 'শেষ তারিখ')} htmlFor="st-to">
          <Input id="st-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
      </div>

      {loading ? (
        <div className="rounded-card border-rule bg-surface overflow-hidden border">
          <SkeletonRows rows={6} />
        </div>
      ) : (
        <>
          {income.data ? <IncomeStatement data={income.data} /> : null}
          {sheet.data ? <BalanceSheet data={sheet.data} asOf={to} /> : null}
          {flow.data ? <CashFlow data={flow.data} /> : null}
          {changes.data ? <NetWorthChanges data={changes.data} /> : null}
          <BasisOfPreparation
            from={from}
            to={to}
            revalued={(changes.data?.revaluations.length ?? 0) > 0}
          />
        </>
      )}
    </div>
  );
}

/** The same day one year earlier; 29 February becomes 28 February. */
function shiftYear(iso: string, delta: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const year = y + delta;
  const lastDay = new Date(Date.UTC(year, m, 0)).getUTCDate();
  return `${year}-${String(m).padStart(2, '0')}-${String(Math.min(d, lastDay)).padStart(2, '0')}`;
}

function Card({
  title,
  subtitle,
  notes = [],
  children,
}: {
  title: string;
  subtitle?: string;
  /**
   * Keys from `ACCOUNTING_NOTES` — the standard each statement is prepared
   * under, tucked behind a ⓘ beside the heading.
   *
   * A list rather than one, because a statement can rest on more than one
   * choice and each deserves its own control: two notes behind one icon is a
   * paragraph nobody finishes, and an icon whose accessible name has to cover
   * both cannot say what either of them is.
   */
  notes?: readonly string[];
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-card border-rule bg-surface loan-print-block border p-4">
      {/* `flex flex-wrap items-baseline` is the contract `InfoNote` documents:
          the trigger flows after the heading, and the opened note — being
          full-basis — drops to its own line across the card. */}
      <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1">
        <h2 className="text-ink text-base font-semibold">{title}</h2>
        {notes.map((key) => (
          <StandardNote key={key} noteKey={key} />
        ))}
      </div>
      {subtitle ? <p className="text-ink-muted text-xs">{subtitle}</p> : null}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Row({
  label,
  minor,
  strong,
  indent,
  compareMinor,
}: {
  label: string;
  minor: number;
  strong?: boolean;
  indent?: boolean;
  compareMinor?: number;
}) {
  return (
    /* `flex-wrap`, and the widths are minimums rather than widths.
     *
     * A crore is fifteen characters of tabular monospace, and the columns were
     * sized for a household's numbers in `rem` — so they grow with the reader's
     * text size while the card does not. At 24px root the pair alone is wider
     * than a 390px card's content box, and because the amounts may not shrink
     * they ran 25px past its edge with the last digits cut off. A balance sheet
     * whose closing figure cannot be read in full is not a balance sheet.
     *
     * Now the label takes what is left and truncates, the amounts keep their
     * alignment through `min-w-*` at ordinary sizes, and when even that will not
     * fit the pair drops to its own line instead of leaving the card. */
    <div
      className={`border-rule flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-b py-1.5 last:border-0 ${
        strong ? 'text-ink font-semibold' : 'text-ink'
      }`}
    >
      <span className={`min-w-0 flex-1 truncate text-sm ${indent ? 'pl-4' : ''}`}>{label}</span>
      {/* The floors are what align short amounts down the column, and they are
          only floors: a crore is wider than any of them and sizes itself. Kept
          small on purpose — a floor is measured in `rem`, so it grows with the
          reader's text while the card does not, and two generous ones were
          exactly what pushed this row past the card's edge. The pair wraps
          rather than spills if even these will not fit. */}
      <span className="ml-auto flex flex-wrap items-baseline justify-end gap-x-4">
        {compareMinor === undefined ? null : (
          <Money
            minor={compareMinor}
            className="text-ink-muted min-w-16 whitespace-nowrap text-right text-xs"
          />
        )}
        <Money minor={minor} className="min-w-20 whitespace-nowrap text-right text-sm" />
      </span>
    </div>
  );
}

function Nodes({ nodes }: { nodes: CategoryNode[] }) {
  return (
    <>
      {nodes.map((node) => (
        <Row key={node.categoryId ?? node.name} label={node.name} minor={node.totalMinor} indent />
      ))}
    </>
  );
}

function IncomeStatement({ data }: { data: import('../types').IncomeStatementDto }) {
  const rate = data.savingsRateBps / 100;
  return (
    <Card
      title={t('statements.income', 'আয়-ব্যয় বিবরণী')}
      /* Where a realised gain lands, and the one place the difference between
         selling and revaluing is visible as a number. */
      notes={['note.disposalGain']}
      subtitle={`${fmtDate(data.from)} — ${fmtDate(data.to)}${
        data.comparison
          ? ` · ${t('statements.against', 'তুলনায়')} ${fmtDate(data.comparison.from)} — ${fmtDate(data.comparison.to)}`
          : ''
      }`}
    >
      <Row
        label={t('statements.totalIncome', 'মোট আয়')}
        minor={data.incomeMinor}
        compareMinor={data.comparison?.incomeMinor}
        strong
      />
      <Nodes nodes={data.income} />
      <Row
        label={t('statements.totalExpense', 'মোট ব্যয়')}
        minor={data.expenseMinor}
        compareMinor={data.comparison?.expenseMinor}
        strong
      />
      <Nodes nodes={data.expenses} />
      <Row
        label={t('statements.surplus', 'উদ্বৃত্ত')}
        minor={data.surplusMinor}
        compareMinor={data.comparison?.surplusMinor}
        strong
      />
      {/* The one figure somebody assessing a household reads before the detail —
          and it is the **surplus** over income, which is the row directly above
          it. It used to be worded "আয়ের X% রাখা হয়েছে", which reads as a savings
          rate and is not one: money not spent may be sitting in a wallet. The
          reports screen now carries a real সঞ্চয়ের হার — what went into savings,
          over income — and two figures using the same words for different
          numbers is how somebody ends up believing the larger one. So this line
          names what it is and points at the difference.

          A `reports.` key on a `statements.` page because that is the prefix
          this string was added under; the pair belong together more than the
          neighbouring keys do. */}
      <p className="text-ink-muted mt-2 text-xs">
        {t(
          'reports.surplusRate',
          'আয়ের {n}% উদ্বৃত্ত থেকেছে — খরচের পর যা বেঁচেছে, সঞ্চয়ে যা গেছে তা নয়',
        ).replace('{n}', fmtNumber(rate.toFixed(1)))}
      </p>
    </Card>
  );
}

function BalanceSheet({ data, asOf }: { data: import('../types').BalanceSheetDto; asOf: string }) {
  return (
    <Card
      title={t('statements.balanceSheet', 'স্থিতিপত্র')}
      /* The two choices this sheet is built on: where the one-year line falls,
         and that a flat and a share portfolio are not one number. */
      notes={['note.currentSplit', 'note.assetsApart']}
      subtitle={`${t('statements.asOf', 'তারিখ')}: ${fmtDate(asOf)}`}
    >
      <Row
        label={t('statements.currentAssets', 'চলতি সম্পদ')}
        minor={data.currentAssetsMinor}
        strong
      />
      {data.assets
        .filter((a) => CURRENT_TYPES.has(a.type))
        .map((a) => (
          <Row key={a.id} label={a.name} minor={a.amountMinor} indent />
        ))}
      <Row
        label={t('statements.nonCurrentAssets', 'অচলতি সম্পদ')}
        minor={data.nonCurrentAssetsMinor}
        strong
      />
      {data.assets
        .filter((a) => !CURRENT_TYPES.has(a.type))
        .map((a) => (
          <Row key={a.id} label={a.name} minor={a.amountMinor} indent />
        ))}
      <Row label={t('statements.totalAssets', 'মোট সম্পদ')} minor={data.assetsMinor} strong />

      <Row
        label={t('statements.currentLiabilities', 'চলতি দায়')}
        minor={data.currentLiabilitiesMinor}
        strong
      />
      <Row
        label={t('statements.nonCurrentLiabilities', 'অচলতি দায়')}
        minor={data.nonCurrentLiabilitiesMinor}
        strong
      />
      <Row
        label={t('statements.totalLiabilities', 'মোট দায়')}
        minor={data.liabilitiesMinor}
        strong
      />
      <Row label={t('statements.netWorth', 'নিট সম্পদ')} minor={data.netWorthMinor} strong />
      <p className="text-ink-muted mt-2 text-xs">
        {t('statements.workingCapital', 'চলতি মূলধন')}:{' '}
        <Money minor={data.workingCapitalMinor} className="text-ink" />
      </p>
    </Card>
  );
}

const CURRENT_TYPES = new Set(['CASH', 'BANK', 'MOBILE_WALLET', 'RECEIVABLE']);

function CashFlow({ data }: { data: import('../types').CashFlowDto }) {
  return (
    <Card
      title={t('statements.cashFlow', 'নগদ প্রবাহ')}
      /* The subtitle already names IAS 7; this says which paragraph, and what
         actually decides the section a movement lands in. */
      notes={['note.cashFlowSections']}
      subtitle={t('statements.cashFlowHint', 'IAS 7 অনুসারে তিন ভাগে')}
    >
      <Row label={t('statements.opening', 'শুরুর নগদ')} minor={data.openingMinor} strong />
      <Row label={t('statements.operating', 'পরিচালন')} minor={data.operatingMinor} />
      <Row label={t('statements.investing', 'বিনিয়োগ')} minor={data.investingMinor} />
      <Row label={t('statements.financing', 'অর্থায়ন')} minor={data.financingMinor} />
      <Row label={t('statements.netMovement', 'নিট পরিবর্তন')} minor={data.netMinor} strong />
      <Row label={t('statements.closing', 'শেষের নগদ')} minor={data.closingMinor} strong />
      {/* Said plainly, because it is the difference between "earned it" and
          "borrowed it" and no single total can show that. */}
      <p className="text-ink-muted mt-2 text-xs">
        {t(
          'statements.sectionsHint',
          'পরিচালন — রোজগার ও সংসার। বিনিয়োগ — জমি, স্বর্ণ, ডিপিএস। অর্থায়ন — ধার নেওয়া, দেওয়া ও শোধ।',
        )}
      </p>
    </Card>
  );
}

function NetWorthChanges({ data }: { data: import('../types').NetWorthChangesDto }) {
  const reconciles = data.openingMinor + data.surplusMinor + data.otherMinor === data.closingMinor;
  return (
    <Card
      title={t('statements.changes', 'নিট সম্পদের পরিবর্তন')}
      /* The statement that answers "why am I richer without having earned
         anything", which is the revaluation and nothing else. */
      notes={['note.revaluationEquity']}
      subtitle={`${fmtDate(data.from)} — ${fmtDate(data.to)}`}
    >
      <Row
        label={t('statements.openingNetWorth', 'শুরুর নিট সম্পদ')}
        minor={data.openingMinor}
        strong
      />
      <Row label={t('statements.surplus', 'উদ্বৃত্ত')} minor={data.surplusMinor} />
      <Row label={t('statements.other', 'অন্যান্য পরিবর্তন')} minor={data.otherMinor} />
      {/* "Other movements: ৳2,00,000" is not an explanation. */}
      {data.revaluations.map((r) => (
        <Row
          key={r.id}
          label={`${r.accountName} — ${r.note ?? t('statements.revalued', 'পুনর্মূল্যায়ন')}`}
          minor={r.deltaMinor}
          indent
        />
      ))}
      <Row
        label={t('statements.closingNetWorth', 'শেষের নিট সম্পদ')}
        minor={data.closingMinor}
        strong
      />
      <p className="text-ink-muted mt-2 text-xs">
        {reconciles
          ? t('statements.reconciles', 'শুরু + উদ্বৃত্ত + অন্যান্য = শেষ ✓')
          : t('statements.doesNotReconcile', 'হিসাব মিলছে না — সহায়তা নিন')}
      </p>
    </Card>
  );
}

/**
 * What these statements are, said on the page.
 *
 * Required by any standard worth citing and, more to the point, required by
 * anybody being handed the page: a reader cannot check a statement whose basis
 * is not stated. Cash basis, one currency, assets at what they cost, unaudited.
 */
function BasisOfPreparation({
  from,
  to,
  revalued,
}: {
  from: string;
  to: string;
  /** True once anything has been marked to a current value in this period. */
  revalued: boolean;
}) {
  return (
    <section className="rounded-card border-rule loan-print-block border border-dashed p-4">
      <h2 className="text-ink-muted text-sm font-medium">
        {t('statements.basis', 'প্রস্তুতির ভিত্তি')}
      </h2>
      <ul className="text-ink-muted mt-2 space-y-1 text-xs">
        {/* The same flex-wrap contract as `Card`, so the note lands on its own
            line under the bullet rather than squeezing the sentence. */}
        <li className="flex flex-wrap items-baseline gap-x-1.5">
          {t(
            'statements.basisCash',
            'নগদ ভিত্তিতে তৈরি — টাকা যেদিন হাতবদল হয়েছে সেদিনই ধরা হয়েছে। বকেয়া বিল, যা এখনো দেওয়া হয়নি, এখানে নেই।',
          )}
          <StandardNote noteKey="note.cashBasis" />
        </li>
        <li>
          {t('statements.basisPeriod', 'সময়কাল')}: {fmtDate(from)} — {fmtDate(to)}
        </li>
        <li className="flex flex-wrap items-baseline gap-x-1.5">
          {/* IFRS lets you use either the cost model or the revaluation model
              and requires the statement to say which. Saying "at cost" after a
              revaluation would be a false basis, which makes everything above
              it uncheckable. */}
          {revalued
            ? t(
                'statements.basisRevalued',
                'কিছু সম্পদ বর্তমান বাজারমূল্যে দেখানো হয়েছে — নিচের "অন্যান্য পরিবর্তন" অংশে বিস্তারিত।',
              )
            : t(
                'statements.basisCost',
                'জমি, স্বর্ণ ও অন্যান্য সম্পদ ক্রয়মূল্যে দেখানো — পুনর্মূল্যায়ন করা হয়নি।',
              )}
          {/* Either way, the thing a reader who knows business accounting will
              silently assume was forgotten. */}
          <StandardNote noteKey="note.noDepreciation" />
        </li>
        <li>
          {t('statements.basisPrepared', 'তৈরির তারিখ')}: {fmtDateObject(new Date())}
        </li>
        <li>
          {t(
            'statements.basisUnaudited',
            'এটি ব্যক্তিগত হিসাব, নিরীক্ষিত নয়। হিসাবরক্ষণ ডাবল-এন্ট্রি পদ্ধতিতে।',
          )}
        </li>
      </ul>
    </section>
  );
}
