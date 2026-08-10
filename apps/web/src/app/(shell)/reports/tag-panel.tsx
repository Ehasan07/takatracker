'use client';

/**
 * The period cut by *who for* rather than *what on*.
 *
 * It sits beside খাতভিত্তিক হিসাব and answers a different question about the
 * same money: the category report says the household spent ৳১২,০০০ on food,
 * this one says ৳৮,০০০ of everything went on পারিবারিক and ৳৪,০০০ on রমজান.
 *
 * ## The two things this panel exists to get right
 *
 * **The rows do not add up to the total, and that is correct.** A transaction
 * with three tags is on three rows. ৳৫০০ of groceries tagged পারিবারিক and
 * রমজান is ৳৫০০ of family spending *and* ৳৫০০ of Ramadan spending — dividing it
 * between them, or keeping only the first tag, would make both answers false.
 * So the double counting is real, it is measured by the API as `overlapMinor`,
 * and it is printed here in words and in taka. A panel that showed the rows and
 * stayed quiet would be reported as a bug the first time somebody added the
 * column up and got more than their month's spending — and the "fix" somebody
 * would then apply is the one that breaks the numbers.
 *
 * **ট্যাগবিহীন is a row, not a gap.** The API emits it even at zero. It is not
 * drawn as a tag, is not a link into a tag filter, and is never dropped: a
 * report listing only the tags somebody created lets them believe those tags
 * cover their whole month, and they rarely do.
 */

import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Info } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';
import { formatMinor } from '@hishab/shared';
import { Money } from '@/components/money';
import { cn } from '@/lib/utils';
import { TagDot } from '../tags/parts';
import { Panel, PanelSkeleton, QueryError } from './parts';
import { fetchByTag, reportKeys } from './queries';
import { bnNum } from './range';
import type { Period } from './range';
import type { Kind, TagReportRow } from './types';

/** A share can exceed a hundred; the bar cannot. The number beside it is real. */
const barWidth = (sharePercent: number): string => `${Math.max(0, Math.min(100, sharePercent))}%`;

export function TagPanel({
  kind,
  period,
  rangeText,
  action,
}: {
  kind: Kind;
  period: Period;
  /** The same period label every other panel prints, so they cannot disagree. */
  rangeText: string;
  /**
   * The আয়/খরচ control. It writes the same `kind` in the URL that the category
   * panel's copy does, so the two are one setting with two handles rather than
   * two settings that can disagree — and neither panel is ever the one you
   * have to scroll back to.
   */
  action?: React.ReactNode;
}) {
  const report = useQuery({
    queryKey: reportKeys.byTag(kind, period),
    queryFn: () => fetchByTag(kind, period),
  });

  const kindWord = kind === 'INCOME' ? 'আয়' : 'খরচ';

  return (
    <Panel title="ট্যাগভিত্তিক হিসাব" scope={`${rangeText} · ${kindWord}`} action={action}>
      {report.isError ? (
        <QueryError
          message="ট্যাগভিত্তিক হিসাব আনা যায়নি।"
          onRetry={() => void report.refetch()}
        />
      ) : report.isPending ? (
        <PanelSkeleton rows={4} />
      ) : report.data.totalMinor === 0 ? (
        <>
          <p className="text-ink-muted mt-3 text-sm">এই সময়ে কিছু নেই।</p>
          <TagsLink />
        </>
      ) : (
        <TagReport
          data={report.data}
          kindWord={kindWord}
          from={report.data.from}
          to={report.data.to}
        />
      )}
    </Panel>
  );
}

function TagReport({
  data,
  kindWord,
  from,
  to,
}: {
  data: {
    totalMinor: number;
    transactionCount: number;
    taggedMinor: number;
    untaggedMinor: number;
    attributedMinor: number;
    overlapMinor: number;
    rows: TagReportRow[];
  };
  kindWord: string;
  from: string;
  to: string;
}) {
  return (
    <>
      {/* The headline first, and labelled with what makes it the headline: it is
          the one figure on this panel in which every transaction appears once. */}
      <dl className="border-rule mt-3 grid grid-cols-3 gap-2 border-b pb-3 text-xs">
        <div className="min-w-0">
          <dt className="text-ink-muted">মোট {kindWord}</dt>
          <dd>
            <Money
              minor={data.totalMinor}
              className="block text-sm font-semibold"
              decimals={false}
            />
            <span className="text-ink-muted">
              {bnNum(data.transactionCount)}টি লেনদেন, প্রতিটি একবার
            </span>
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-ink-muted">ট্যাগ দেওয়া</dt>
          <dd>
            <Money minor={data.taggedMinor} className="block text-sm" decimals={false} />
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-ink-muted">ট্যাগবিহীন</dt>
          <dd>
            <Money minor={data.untaggedMinor} className="block text-sm" decimals={false} />
          </dd>
        </div>
      </dl>

      <ul className="mt-1">
        {data.rows.map((row) => (
          <TagRow key={row.tagId ?? '__untagged'} row={row} from={from} to={to} />
        ))}
      </ul>

      {/* The paragraph that stops this panel being filed as a bug. */}
      <div className="rounded-card border-rule bg-greenbar mt-3 border p-3">
        <p className="text-ink flex items-start gap-2 text-xs">
          <Info className="text-income mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          {data.overlapMinor > 0 ? (
            <span>
              <span className="font-medium">
                সারিগুলো যোগ করলে মোটের চেয়ে বেশি হবে — এটি ভুল নয়।
              </span>{' '}
              একটি লেনদেনে একাধিক ট্যাগ থাকতে পারে, আর প্রতিটি ট্যাগে পুরো টাকাটাই গোনা হয়। উপরের
              সারিগুলোর যোগফল {formatMinor(data.attributedMinor, { decimals: false })}, তার মধ্যে{' '}
              {formatMinor(data.overlapMinor, { decimals: false })} একাধিক ট্যাগে দুবার বা তার
              বেশিবার গোনা হয়েছে। {formatMinor(data.totalMinor, { decimals: false })}-এ প্রতিটি
              লেনদেন একবারই আছে, আর শতাংশগুলো সেই মোটের ওপর — তাই সব শতাংশ যোগ করলে ১০০%-এর বেশি হতে
              পারে। ৫০০ টাকার বাজার যদি পারিবারিক আর রমজান দুটোতেই থাকে, সেটা সত্যিই দুটোরই ৫০০
              টাকা।
            </span>
          ) : (
            <span>
              এই সময়ে কোনো লেনদেনে একাধিক ট্যাগ নেই, তাই সারিগুলোর যোগফল মোটের সঙ্গেই মিলছে। একই
              লেনদেনে দুটো ট্যাগ দিলে দুটোতেই পুরো টাকাটা গোনা হবে — তখন যোগফল মোটের চেয়ে বেশি
              দেখাবে, আর সেটাই ঠিক।
            </span>
          )}
        </p>
      </div>

      <TagsLink />
    </>
  );
}

function TagRow({ row, from, to }: { row: TagReportRow; from: string; to: string }) {
  const untagged = row.tagId === null;

  const inner = (
    <>
      {untagged ? (
        <span
          aria-hidden
          className="border-ink-muted h-2.5 w-2.5 shrink-0 rounded-sm border border-dashed"
        />
      ) : (
        <TagDot color={row.color} />
      )}
      <span className="min-w-0 flex-1">
        <span className={cn('text-ink block truncate text-sm', untagged && 'italic')}>
          {row.name}
        </span>
        <span className="text-ink-muted block truncate text-xs">
          {untagged
            ? `কোনো ট্যাগ নেই এমন ${bnNum(row.transactionCount)}টি লেনদেন`
            : `${bnNum(row.transactionCount)}টি লেনদেন`}
        </span>
      </span>
      <span className="text-ink-muted shrink-0 text-xs">{bnNum(row.sharePercent.toFixed(1))}%</span>
      <Money minor={row.totalMinor} className="shrink-0 text-sm" decimals={false} />
    </>
  );

  return (
    <li className="py-0.5">
      {untagged ? (
        /* Not a link: there is no `?untagged=1` on the khata, so a tap here
           could only lie about where it was going. */
        <div className="border-ink-muted flex min-h-11 items-center gap-2 border-l-2 border-dashed py-1 pl-2 pr-1">
          {inner}
        </div>
      ) : (
        <Link
          href={`/transactions?tagId=${encodeURIComponent(row.tagId!)}&from=${from}&to=${to}`}
          className="press hover:bg-greenbar flex min-h-11 items-center gap-2 rounded-md px-1"
        >
          {inner}
        </Link>
      )}
      <div className="bg-greenbar mt-0.5 h-1 w-full overflow-hidden rounded-full">
        <div
          className={cn('h-1 rounded-full', untagged ? 'bg-ink-muted/50' : 'bg-income')}
          style={{ width: barWidth(row.sharePercent) }}
        />
      </div>
    </li>
  );
}

function TagsLink() {
  return (
    <Link
      href="/tags"
      className="press text-income hover:bg-greenbar mt-2 inline-flex min-h-11 items-center gap-1.5 rounded-md px-1 text-xs font-medium"
    >
      ট্যাগগুলো গুছিয়ে নিন
      <ArrowRight className="h-3.5 w-3.5" aria-hidden />
    </Link>
  );
}
