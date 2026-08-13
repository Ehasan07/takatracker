'use client';

import { Download, FileText, Link2, Printer, Share2 } from 'lucide-react';
import * as React from 'react';
import { formatMinor, toLocalDateString } from '@hishab/shared';
import { Money } from '@/components/money';
import { Skeleton, SkeletonRows } from '@/components/skeleton';
import { Field, Input } from '@/components/ui/field';
import { haptic } from '@/lib/haptics';
import { downloadCsv, minorToPlain, printThisPage, shareOrCopy } from './exports';
import { bnDate, bnNum, methodLabel } from './labels';
import { Chip, QueryError, Toast } from './parts';
import type { Statement } from './types';
import './print.css';

export type PresetKey =
  'all' | 'today' | 'yesterday' | 'last7' | 'thisMonth' | 'lastMonth' | 'thisYear' | 'custom';

/** The seven ready-made ranges. 'custom' is the eighth chip and opens two dates. */
export const PRESETS: readonly (readonly [PresetKey, string])[] = [
  ['all', 'সব সময়'],
  ['today', 'আজ'],
  ['yesterday', 'গতকাল'],
  ['last7', 'গত ৭ দিন'],
  ['thisMonth', 'এই মাস'],
  ['lastMonth', 'গত মাস'],
  ['thisYear', 'এই বছর'],
];

export interface DateFilter {
  preset: PresetKey;
  from: string;
  to: string;
}

export const ALL_TIME: DateFilter = { preset: 'all', from: '', to: '' };

/** The query string the API expects — '' when the whole history is wanted. */
export function filterQuery(filter: DateFilter): string {
  const qs = new URLSearchParams();
  if (filter.preset === 'custom') {
    if (filter.from) qs.set('from', filter.from);
    if (filter.to) qs.set('to', filter.to);
  } else if (filter.preset !== 'all') {
    qs.set('preset', filter.preset);
  }
  const text = qs.toString();
  return text ? `?${text}` : '';
}

export function filterLabel(filter: DateFilter): string {
  if (filter.preset === 'custom') {
    return `${filter.from ? bnDate(filter.from) : 'শুরু'} — ${filter.to ? bnDate(filter.to) : 'আজ'}`;
  }
  return PRESETS.find(([key]) => key === filter.preset)?.[1] ?? 'সব সময়';
}

const COLUMNS = ['ক্রম', 'তারিখ', 'বিবরণ', 'ডেবিট', 'ক্রেডিট', 'চলতি জের', 'মাধ্যম', 'রেফারেন্স'];

/**
 * One statement, used by both the loan statement and the party ledger: opening
 * balance, the rows with a running balance, closing balance, the date filters
 * and the four exports.
 */
export function StatementView({
  heading,
  subheading,
  filter,
  onFilterChange,
  data,
  isLoading,
  isError,
  onRetry,
  fileBaseName,
  onShareLink,
  children,
}: {
  heading: string;
  subheading?: string;
  filter: DateFilter;
  onFilterChange: (filter: DateFilter) => void;
  data: Statement | undefined;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  fileBaseName: string;
  /**
   * Open the link sheet, on screens that can mint one.
   *
   * It belongs in the same row as the other four ways of sending a statement,
   * not in a corner of the page. It was in a corner, labelled "শেয়ার", beside
   * a button in this row also labelled "শেয়ার" — so the person who wanted a
   * link pressed the one that copies a six-line text summary, which is what
   * happened the first time somebody tried it.
   */
  onShareLink?: () => void;
  /** Anything that belongs above the table on both screen and paper. */
  children?: React.ReactNode;
}) {
  const [toast, setToast] = React.useState<string | null>(null);
  // Set after mount: a build-time date baked into the HTML would not match.
  const [printedOn, setPrintedOn] = React.useState('');
  React.useEffect(() => setPrintedOn(toLocalDateString(new Date())), []);

  const rows = data?.rows ?? [];
  const opening = data?.openingMinor ?? 0;
  const closing = data?.closingMinor ?? 0;
  const range = filterLabel(filter);
  const dismissToast = React.useCallback(() => setToast(null), []);

  const onExcel = (): void => {
    haptic('tap');
    downloadCsv(`${fileBaseName}.csv`, [
      [heading],
      [subheading ?? ''],
      [`সময়: ${range}`],
      [],
      COLUMNS,
      ['', '', 'প্রারম্ভিক জের', '', '', minorToPlain(opening), '', ''],
      ...rows.map((row, i) => [
        String(i + 1),
        (row.date ?? '').slice(0, 10),
        row.description ?? '',
        minorToPlain(row.debitMinor),
        minorToPlain(row.creditMinor),
        minorToPlain(row.balanceMinor),
        methodLabel(row.method),
        row.referenceNumber ?? '',
      ]),
      ['', '', 'সমাপনী জের', '', '', minorToPlain(closing), '', ''],
    ]);
    setToast('এক্সেলের জন্য .csv ফাইল নামানো হয়েছে');
  };

  const onShare = (): void => {
    haptic('tap');
    const text = [
      heading,
      subheading,
      `সময়: ${range}`,
      `প্রারম্ভিক জের: ${formatMinor(opening)}`,
      `সমাপনী জের: ${formatMinor(closing)}`,
      `মোট এন্ট্রি: ${bnNum(rows.length)}টি`,
      'হিসাব — takatracker.com',
    ]
      .filter(Boolean)
      .join('\n');

    void shareOrCopy({ title: heading, text }).then((result) => {
      if (result === 'copied') setToast('বিবরণী ক্লিপবোর্ডে কপি করা হয়েছে');
      else if (result === 'failed') setToast('এই ব্রাউজারে শেয়ার বা কপি করা যায়নি');
    });
  };

  return (
    <section className="flex flex-col gap-4">
      {/* Only on paper: the app has no letterhead on screen. */}
      <div className="loan-print-only">
        <p style={{ fontSize: '9pt' }}>হিসাব — takatracker.com</p>
        <h2 style={{ fontSize: '14pt', fontWeight: 600 }}>{heading}</h2>
        {subheading ? <p style={{ fontSize: '10pt' }}>{subheading}</p> : null}
        <p style={{ fontSize: '10pt' }}>সময়: {range}</p>
        {printedOn ? <p style={{ fontSize: '9pt' }}>প্রিন্টের তারিখ: {bnDate(printedOn)}</p> : null}
      </div>

      {/* Date filters */}
      <div className="no-print flex flex-col gap-2">
        <div className="chip-strip">
          {PRESETS.map(([key, label]) => (
            <Chip
              key={key}
              active={filter.preset === key}
              onClick={() => onFilterChange({ preset: key, from: '', to: '' })}
            >
              {label}
            </Chip>
          ))}
          <Chip
            active={filter.preset === 'custom'}
            onClick={() => onFilterChange({ ...filter, preset: 'custom' })}
          >
            নির্দিষ্ট সময়
          </Chip>
        </div>

        {filter.preset === 'custom' ? (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Field label="শুরুর তারিখ" htmlFor="stmt-from">
              <Input
                id="stmt-from"
                type="date"
                value={filter.from}
                max={filter.to || undefined}
                onChange={(e) => onFilterChange({ ...filter, from: e.target.value })}
              />
            </Field>
            <Field label="শেষ তারিখ" htmlFor="stmt-to">
              <Input
                id="stmt-to"
                type="date"
                value={filter.to}
                min={filter.from || undefined}
                onChange={(e) => onFilterChange({ ...filter, to: e.target.value })}
              />
            </Field>
          </div>
        ) : null}
      </div>

      {/* Exports */}
      <div className="no-print flex flex-col gap-1.5">
        <div
          className={`grid grid-cols-2 gap-2 ${onShareLink ? 'sm:grid-cols-5' : 'sm:grid-cols-4'}`}
        >
          {/* First, because it is the only one that puts the statement in
              somebody else's hands without them needing this app. */}
          {onShareLink ? (
            <ExportButton icon={<Link2 className="h-4 w-4" aria-hidden />} onClick={onShareLink}>
              লিংক
            </ExportButton>
          ) : null}
          <ExportButton icon={<FileText className="h-4 w-4" aria-hidden />} onClick={printThisPage}>
            পিডিএফ
          </ExportButton>
          <ExportButton icon={<Download className="h-4 w-4" aria-hidden />} onClick={onExcel}>
            এক্সেল
          </ExportButton>
          <ExportButton icon={<Printer className="h-4 w-4" aria-hidden />} onClick={printThisPage}>
            প্রিন্ট
          </ExportButton>
          {/* Renamed from "শেয়ার". It sends six lines of text to WhatsApp; the
              button beside it sends the whole statement. Both were called the
              same thing, and the wrong one is the one people pressed. */}
          <ExportButton icon={<Share2 className="h-4 w-4" aria-hidden />} onClick={onShare}>
            সারাংশ
          </ExportButton>
        </div>
        <p className="text-ink-muted text-xs">
          {onShareLink
            ? 'লিংক — যাকে পাঠাবেন তিনি অ্যাকাউন্ট ছাড়াই পুরো বিবরণী দেখতে ও প্রিন্ট করতে পারবেন। সারাংশ — শুধু কয়েক লাইনের হিসাব, হোয়াটসঅ্যাপে পাঠানোর জন্য। '
            : ''}
          পিডিএফ ও প্রিন্ট — দুটিই ব্রাউজারের প্রিন্ট উইন্ডো খোলে; সেখানে গন্তব্য হিসেবে “Save as
          PDF” বেছে নিলে পিডিএফ সংরক্ষিত হবে। এক্সেল ফাইলটি .csv ফরম্যাটে নামে।
        </p>
      </div>

      {children}

      {/* Opening / closing, at a glance and on paper. A zero here before the
          data lands would be a lie, so it waits behind a skeleton. */}
      <dl className="rounded-card border-rule bg-surface loan-print-block grid grid-cols-2 gap-3 border p-4">
        <div className="min-w-0">
          <dt className="text-ink-muted text-xs">প্রারম্ভিক জের</dt>
          <dd>
            {isLoading || isError ? (
              <Skeleton className="mt-1 h-6 w-28" />
            ) : (
              <Money minor={opening} className="block text-lg font-semibold" />
            )}
          </dd>
        </div>
        <div className="min-w-0 text-right">
          <dt className="text-ink-muted text-xs">সমাপনী জের</dt>
          <dd>
            {isLoading || isError ? (
              <Skeleton className="ml-auto mt-1 h-6 w-28" />
            ) : (
              <Money minor={closing} className="block text-lg font-semibold" />
            )}
          </dd>
        </div>
      </dl>

      {isError ? (
        <QueryError message="বিবরণী আনা যায়নি।" onRetry={onRetry} />
      ) : isLoading ? (
        <div className="rounded-card border-rule bg-surface overflow-hidden border">
          <SkeletonRows rows={5} />
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-card border-rule border border-dashed p-8 text-center">
          <p className="text-ink">এই সময়ে কোনো লেনদেন নেই।</p>
          <p className="text-ink-muted mt-1 text-sm">উপরের ফিল্টার বদলে দেখুন।</p>
        </div>
      ) : (
        <>
          {/* Phone: one card per entry, the running balance on its own line. */}
          <ul className="loan-screen-cards flex flex-col gap-2 md:hidden">
            {rows.map((row, i) => (
              <li
                key={`${row.date}-${i}`}
                className="rounded-card border-rule bg-surface border p-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-ink text-sm">{row.description || 'এন্ট্রি'}</p>
                    <p className="text-ink-muted text-xs">
                      {bnNum(i + 1)} · {bnDate(row.date)}
                      {row.method ? ` · ${methodLabel(row.method)}` : ''}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    {row.debitMinor !== 0 ? (
                      <span className="flex items-baseline justify-end gap-1">
                        <span className="text-ink-muted text-[11px]">ডেবিট</span>
                        <Money minor={row.debitMinor} className="text-sm" />
                      </span>
                    ) : null}
                    {row.creditMinor !== 0 ? (
                      <span className="flex items-baseline justify-end gap-1">
                        <span className="text-ink-muted text-[11px]">ক্রেডিট</span>
                        <Money minor={row.creditMinor} className="text-sm" />
                      </span>
                    ) : null}
                  </div>
                </div>
                {row.referenceNumber ? (
                  <p className="text-ink-muted mt-1 truncate text-xs">
                    রেফারেন্স: {row.referenceNumber}
                  </p>
                ) : null}
                <div className="border-rule mt-2 flex items-center justify-between gap-2 border-t pt-2">
                  <span className="text-ink-muted text-xs">চলতি জের</span>
                  <Money minor={row.balanceMinor} className="text-sm font-semibold" />
                </div>
              </li>
            ))}
          </ul>

          {/* Tablet up, and always on paper. */}
          <div className="loan-print-table rounded-card border-rule bg-surface hidden overflow-x-auto border md:block">
            <table className="w-full min-w-[48rem] text-sm">
              <caption className="sr-only">{`${heading} — বিবরণী (${range})`}</caption>
              <thead>
                <tr className="border-rule bg-greenbar border-b">
                  {COLUMNS.map((column, i) => (
                    <th
                      key={column}
                      scope="col"
                      className={`text-ink-muted px-2 py-2 text-xs font-medium ${
                        i >= 3 && i <= 5 ? 'text-right' : 'text-left'
                      }`}
                    >
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr className="border-rule border-b">
                  <td className="text-ink-muted px-2 py-2">—</td>
                  <td className="text-ink-muted px-2 py-2">—</td>
                  <td className="text-ink px-2 py-2">প্রারম্ভিক জের</td>
                  <td className="px-2 py-2 text-right">—</td>
                  <td className="px-2 py-2 text-right">—</td>
                  <td className="px-2 py-2 text-right">
                    <Money minor={opening} />
                  </td>
                  <td className="px-2 py-2">—</td>
                  <td className="px-2 py-2">—</td>
                </tr>
                {rows.map((row, i) => (
                  <tr key={`${row.date}-${i}`} className="ledger-row border-rule border-b">
                    <td className="text-ink-muted px-2 py-2">{bnNum(i + 1)}</td>
                    <td className="text-ink whitespace-nowrap px-2 py-2">{bnDate(row.date)}</td>
                    <td className="text-ink px-2 py-2">{row.description || 'এন্ট্রি'}</td>
                    <td className="px-2 py-2 text-right">
                      {row.debitMinor !== 0 ? <Money minor={row.debitMinor} /> : '—'}
                    </td>
                    <td className="px-2 py-2 text-right">
                      {row.creditMinor !== 0 ? <Money minor={row.creditMinor} /> : '—'}
                    </td>
                    <td className="px-2 py-2 text-right">
                      <Money minor={row.balanceMinor} className="font-semibold" />
                    </td>
                    <td className="text-ink-muted whitespace-nowrap px-2 py-2">
                      {methodLabel(row.method) || '—'}
                    </td>
                    <td className="text-ink-muted px-2 py-2">{row.referenceNumber || '—'}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-greenbar">
                  <td className="px-2 py-2" colSpan={2} />
                  <td className="text-ink px-2 py-2 font-semibold">সমাপনী জের</td>
                  <td className="px-2 py-2" colSpan={2} />
                  <td className="px-2 py-2 text-right">
                    <Money minor={closing} className="font-semibold" />
                  </td>
                  <td className="px-2 py-2" colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}

      {toast ? <Toast message={toast} onDismiss={dismissToast} /> : null}
    </section>
  );
}

function ExportButton({
  icon,
  onClick,
  children,
}: {
  icon: React.ReactNode;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="press border-rule text-ink hover:bg-greenbar bg-surface flex min-h-11 items-center justify-center gap-1.5 rounded-md border px-3 text-sm"
    >
      {icon}
      {children}
    </button>
  );
}
