'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, FileSpreadsheet, Printer, Search } from 'lucide-react';
import { ApiError, endpoints } from '@/lib/api';
import { t } from '@/lib/t';
import { Money } from '@/components/money';
import { PrintFooterAd } from '@/components/print-footer-ad';
import { SkeletonRows } from '@/components/skeleton';
import { downloadPartyDuesXlsx, fetchPartyDues, partyDueKeys } from './queries';
import type { PartyDueReport, PartyDueRow, PartySide } from './types';
import './print.css';

/**
 * Who owes what, across the whole workspace.
 *
 * One request, and every filter below is computed in the browser from what it
 * returned. A shop with four hundred people on the slate types into the search
 * box and gets an answer in the same frame — a round trip per keystroke would
 * make the screen feel slower the more it had to show, which is backwards.
 *
 * Two locks guard it, both on the server: the workspace needs the
 * `party.due.report` flag a super admin grants, and the member needs to be an
 * owner or an admin. This page renders whatever the API lets through and says
 * plainly what happened when it does not.
 */
export default function PartyDuesPage() {
  const [side, setSide] = useState<PartySide>('customer');
  const [query, setQuery] = useState('');
  const [duesOnly, setDuesOnly] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const me = useQuery({ queryKey: ['me'], queryFn: endpoints.me, staleTime: 5 * 60_000 });
  const report = useQuery({
    queryKey: partyDueKeys.report(),
    queryFn: fetchPartyDues,
    staleTime: 60_000,
    retry: false,
  });

  const data = report.data;

  async function download() {
    if (!data) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      await downloadPartyDuesXlsx(data.asOf);
    } catch (error) {
      setDownloadError(
        error instanceof ApiError ? error.message : 'ফাইল নামানো যায়নি, আবার চেষ্টা করুন',
      );
    } finally {
      setDownloading(false);
    }
  }

  if (report.isError) return <Refused error={report.error} />;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
      <div className="no-print flex flex-wrap items-center justify-between gap-2">
        <Link
          href="/reports"
          className="press text-ink-muted hover:text-ink flex min-h-11 w-fit items-center gap-1.5 text-sm"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          {t('nav.reports', 'রিপোর্ট')}
        </Link>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void download()}
            disabled={!data || downloading}
            className="press border-rule text-ink hover:bg-greenbar flex min-h-11 items-center gap-1.5 rounded-md border px-3 text-sm disabled:opacity-50"
          >
            <FileSpreadsheet className="h-4 w-4" aria-hidden />
            {downloading ? t('dues.downloading', 'নামছে…') : t('dues.downloadXlsx', 'এক্সেল নামান')}
          </button>
          <button
            type="button"
            onClick={() => window.setTimeout(() => window.print(), 50)}
            disabled={!data}
            className="press border-rule text-ink hover:bg-greenbar flex min-h-11 items-center gap-1.5 rounded-md border px-3 text-sm disabled:opacity-50"
          >
            <Printer className="h-4 w-4" aria-hidden />
            {t('dues.print', 'প্রিন্ট বা PDF')}
          </button>
        </div>
      </div>

      <header className="dues-print-only">
        <h2 className="text-ink text-lg font-semibold">
          {me.data?.workspace.name ?? ''} — {t('dues.title', 'বাকির খাতা')}
        </h2>
        <p className="text-ink-muted text-xs">
          {t('dues.asOf', 'তারিখ')}: {data?.asOf ?? ''}
        </p>
      </header>

      <header className="no-print">
        <h1 className="text-ink text-xl font-semibold sm:text-2xl">
          {t('dues.title', 'বাকির খাতা')}
        </h1>
        <p className="text-ink-muted text-sm">
          {t('dues.blurb', 'কে কত বাকিতে নিয়েছে, কত জমা দিয়েছে, আর কত বাকি আছে')}
        </p>
      </header>

      {downloadError ? (
        <p className="no-print border-expense/40 text-expense rounded-md border px-3 py-2 text-sm">
          {downloadError}
        </p>
      ) : null}

      {report.isPending || !data ? (
        <div className="rounded-card border-rule bg-surface overflow-hidden border">
          <SkeletonRows rows={6} />
        </div>
      ) : (
        <>
          <Totals report={data} side={side} />

          <div className="no-print flex flex-wrap items-center gap-2">
            <div
              role="tablist"
              aria-label={t('dues.whichList', 'কোন তালিকা')}
              className="border-rule flex rounded-md border p-0.5"
            >
              <Tab
                active={side === 'customer'}
                onClick={() => setSide('customer')}
                count={data.customers.length}
              >
                {t('dues.customers', 'ক্রেতা')}
              </Tab>
              <Tab
                active={side === 'supplier'}
                onClick={() => setSide('supplier')}
                count={data.suppliers.length}
              >
                {t('dues.suppliers', 'সাপ্লায়ার')}
              </Tab>
            </div>

            <label className="border-rule bg-surface flex min-h-11 flex-1 items-center gap-2 rounded-md border px-3 sm:max-w-xs">
              <Search className="text-ink-muted h-4 w-4 shrink-0" aria-hidden />
              <input
                id="dues-search"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('dues.search', 'নাম, কোড বা ফোন')}
                className="text-ink w-full bg-transparent text-sm outline-none"
              />
            </label>

            <label className="text-ink-muted flex min-h-11 items-center gap-2 text-sm">
              <input
                id="dues-only"
                type="checkbox"
                checked={duesOnly}
                onChange={(event) => setDuesOnly(event.target.checked)}
                className="h-4 w-4"
              />
              {t('dues.onlyOwing', 'শুধু যাদের বাকি আছে')}
            </label>
          </div>

          <Section
            side="customer"
            hidden={side !== 'customer'}
            rows={data.customers}
            query={query}
            duesOnly={duesOnly}
          />
          <Section
            side="supplier"
            hidden={side !== 'supplier'}
            rows={data.suppliers}
            query={query}
            duesOnly={duesOnly}
          />
        </>
      )}

      <PrintFooterAd />
    </div>
  );
}

/* --- pieces ---------------------------------------------------------------- */

function Tab({
  active,
  onClick,
  count,
  children,
}: {
  active: boolean;
  onClick: () => void;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`press min-h-10 rounded px-3 text-sm ${
        active ? 'bg-greenbar text-ink font-semibold' : 'text-ink-muted'
      }`}
    >
      {children}
      <span className="text-ink-muted ml-1.5 text-xs">{count}</span>
    </button>
  );
}

/**
 * The three figures the screen is opened for.
 *
 * Only the side on screen, because a customer's ৳44,300 and a supplier's
 * ৳1,23,000 are not two halves of one number — netting them would be an answer
 * to a question nobody asks, and showing both at once invites the reader to do
 * the netting themselves.
 */
function Totals({ report, side }: { report: PartyDueReport; side: PartySide }) {
  const totals = side === 'customer' ? report.customerTotals : report.supplierTotals;
  const rows = side === 'customer' ? report.customers : report.suppliers;
  const owing = rows.filter((row) => row[side].outstandingMinor > 0).length;

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <Tile label={t('dues.outstanding', 'মোট বাকি')} minor={totals.outstandingMinor} strong />
      <Tile label={t('dues.overdue', 'মেয়াদোত্তীর্ণ')} minor={totals.overdueMinor} />
      <Tile
        label={side === 'customer' ? t('dues.received', 'মোট জমা') : t('dues.settled', 'মোট শোধ')}
        minor={totals.paidMinor}
      />
      <div className="rounded-card border-rule bg-surface border p-3">
        <p className="text-ink-muted text-xs">{t('dues.owingCount', 'যাদের বাকি আছে')}</p>
        <p className="text-ink mt-1 text-lg font-semibold tabular-nums">{owing}</p>
      </div>
    </div>
  );
}

function Tile({ label, minor, strong }: { label: string; minor: number; strong?: boolean }) {
  return (
    <div className="rounded-card border-rule bg-surface border p-3">
      <p className="text-ink-muted text-xs">{label}</p>
      <Money
        minor={minor}
        className={`mt-1 block text-lg ${strong ? 'text-ink font-semibold' : 'text-ink-muted'}`}
      />
    </div>
  );
}

/**
 * One list, as a table on anything wider than a phone and as cards below that.
 *
 * Both are always in the DOM and one is hidden by CSS, rather than switched on
 * a measured viewport: the print stylesheet needs the table whatever the screen
 * was, and a layout that depends on JavaScript having measured the window is a
 * layout that prints whatever it happened to measure last.
 */
function Section({
  side,
  hidden,
  rows,
  query,
  duesOnly,
}: {
  side: PartySide;
  hidden: boolean;
  rows: readonly PartyDueRow[];
  query: string;
  duesOnly: boolean;
}) {
  const needle = query.trim().toLowerCase();

  const visible = useMemo(() => {
    return rows.filter((row) => {
      if (duesOnly && row[side].outstandingMinor <= 0) return false;
      if (!needle) return true;
      return (
        row.name.toLowerCase().includes(needle) ||
        row.code.toLowerCase().includes(needle) ||
        (row.phone ?? '').toLowerCase().includes(needle)
      );
    });
  }, [rows, side, needle, duesOnly]);

  const shown = useMemo(
    () =>
      visible.reduce(
        (acc, row) => {
          acc.total += row[side].totalMinor;
          acc.paid += row[side].paidMinor;
          acc.outstanding += row[side].outstandingMinor;
          return acc;
        },
        { total: 0, paid: 0, outstanding: 0 },
      ),
    [visible, side],
  );

  const heading =
    side === 'customer' ? t('dues.customers', 'ক্রেতা') : t('dues.suppliers', 'সাপ্লায়ার');
  const totalHeader =
    side === 'customer'
      ? t('dues.totalCredit', 'মোট বাকিতে')
      : t('dues.totalPurchased', 'মোট কেনা');
  const paidHeader =
    side === 'customer' ? t('dues.received', 'মোট জমা') : t('dues.settled', 'মোট শোধ');

  return (
    <section className={`dues-section ${hidden ? 'hidden' : ''}`}>
      <h2 className="dues-print-only text-ink mb-2 text-base font-semibold">{heading}</h2>

      {visible.length === 0 ? (
        <p className="text-ink-muted rounded-card border-rule bg-surface border p-6 text-center text-sm">
          {t('dues.empty', 'এই তালিকায় কেউ নেই')}
        </p>
      ) : (
        <>
          {/* Cards: phone only. */}
          <ul className="dues-cards flex flex-col gap-2 md:hidden">
            {visible.map((row) => (
              <li
                key={row.personId}
                className="rounded-card border-rule bg-surface flex flex-col gap-1 border p-3"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-ink font-medium">{row.name}</span>
                  <Money minor={row[side].outstandingMinor} className="text-ink font-semibold" />
                </div>
                <div className="text-ink-muted flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
                  <span className="tabular-nums">{row.code}</span>
                  {row.phone ? <span className="tabular-nums">{row.phone}</span> : null}
                  {row.archived ? <span>{t('dues.archived', 'মুছে ফেলা')}</span> : null}
                  {row[side].overdueMinor > 0 ? (
                    <span className="text-expense">{t('dues.overdue', 'মেয়াদোত্তীর্ণ')}</span>
                  ) : null}
                </div>
                <div className="text-ink-muted flex flex-wrap gap-x-4 text-xs">
                  <span>
                    {totalHeader} <Money minor={row[side].totalMinor} />
                  </span>
                  <span>
                    {paidHeader} <Money minor={row[side].paidMinor} />
                  </span>
                </div>
              </li>
            ))}
          </ul>

          {/* Table: tablet and up, and always on paper. */}
          <div className="dues-table rounded-card border-rule bg-surface hidden overflow-x-auto border md:block">
            <table className="w-full min-w-[46rem] text-sm">
              <thead>
                <tr className="border-rule text-ink-muted border-b text-left">
                  <th className="px-3 py-2 font-medium">{t('dues.code', 'কোড')}</th>
                  <th className="px-3 py-2 font-medium">{t('dues.name', 'নাম')}</th>
                  <th className="px-3 py-2 font-medium">{t('dues.phone', 'ফোন')}</th>
                  <th className="px-3 py-2 text-right font-medium">{totalHeader}</th>
                  <th className="px-3 py-2 text-right font-medium">{paidHeader}</th>
                  <th className="px-3 py-2 text-right font-medium">
                    {t('dues.remaining', 'বাকি আছে')}
                  </th>
                  <th className="px-3 py-2 font-medium">{t('dues.lastActivity', 'শেষ লেনদেন')}</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <tr key={row.personId} className="border-rule border-b last:border-0">
                    <td className="text-ink-muted px-3 py-2 tabular-nums">{row.code}</td>
                    <td className="text-ink px-3 py-2">
                      <Link href={`/loans/people/${row.personId}`} className="hover:underline">
                        {row.name}
                      </Link>
                      {row.archived ? (
                        <span className="text-ink-muted ml-2 text-xs">
                          {t('dues.archived', 'মুছে ফেলা')}
                        </span>
                      ) : null}
                    </td>
                    <td className="text-ink-muted px-3 py-2 tabular-nums">{row.phone ?? '—'}</td>
                    <td className="px-3 py-2 text-right">
                      <Money minor={row[side].totalMinor} />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Money minor={row[side].paidMinor} />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Money
                        minor={row[side].outstandingMinor}
                        className={row[side].overdueMinor > 0 ? 'text-expense font-semibold' : ''}
                      />
                    </td>
                    <td className="text-ink-muted px-3 py-2 tabular-nums">
                      {row[side].lastActivity ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-rule border-t">
                  <td className="text-ink px-3 py-2 font-semibold" colSpan={3}>
                    {t('dues.total', 'মোট')} · {visible.length}
                  </td>
                  <td className="px-3 py-2 text-right font-semibold">
                    <Money minor={shown.total} />
                  </td>
                  <td className="px-3 py-2 text-right font-semibold">
                    <Money minor={shown.paid} />
                  </td>
                  <td className="px-3 py-2 text-right font-semibold">
                    <Money minor={shown.outstanding} />
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

/**
 * What the two locks look like when one of them is shut.
 *
 * Two different sentences, because the reader can act on one of them and not
 * the other: a 403 is "ask the owner", a 402 is "this workspace has not been
 * given the feature". One message for both would send members to the wrong
 * person.
 */
function Refused({ error }: { error: unknown }) {
  const status = error instanceof ApiError ? error.status : 0;
  const message =
    status === 403
      ? t('dues.refusedRole', 'এই রিপোর্ট শুধু ওয়ার্কস্পেসের মালিক ও অ্যাডমিন দেখতে পারেন।')
      : status === 402
        ? t(
            'dues.refusedFeature',
            'এই ওয়ার্কস্পেসে বাকির খাতা রিপোর্ট চালু নেই। চালু করতে সহায়তা দলকে বলুন।',
          )
        : error instanceof ApiError
          ? error.message
          : t('dues.failed', 'রিপোর্ট আনা যায়নি।');

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <Link
        href="/reports"
        className="press text-ink-muted hover:text-ink flex min-h-11 w-fit items-center gap-1.5 text-sm"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        {t('nav.reports', 'রিপোর্ট')}
      </Link>
      <p className="rounded-card border-rule bg-surface text-ink border p-6 text-sm">{message}</p>
    </div>
  );
}
