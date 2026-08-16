'use client';

import * as React from 'react';
import { Money } from '@/components/money';
import { Sheet } from '@/components/ui/sheet';
import { fmtDate, fmtDateTime12 } from '@/lib/format';
import { t } from '@/lib/t';
import type { DuplicateMatch, DuplicateScope } from './statement-types';

/**
 * What is behind the ⓘ on a row marked "সম্ভাব্য ডুপ্লিকেট".
 *
 * The badge is a claim and this is the evidence for it. Without the evidence
 * the badge is unusable: "this might already be in your books" leaves somebody
 * with no way to check except to go and search the ledger by hand, and a
 * warning you cannot act on is a warning you learn to click past.
 *
 * So each matched entry is shown with the four things that let a person
 * recognise it — the day, the amount and which way it went, what it was called,
 * and **where it came from**. That last one carries most of the weight in
 * practice: "এসএমএস থেকে" on 5 July at ৳৬০ is almost certainly the same
 * rickshaw fare the statement is now offering, whereas a hand-typed entry of
 * the same amount might well be a different one.
 *
 * The sheet is deliberately read-only. Nothing here merges, links or deletes;
 * the only decision available is the approve control on the row behind it,
 * which is where the user was already looking.
 */

/** Where a transaction came from, in words. */
const SOURCE_LABELS: Record<string, string> = {
  MANUAL: 'হাতে লেখা',
  SMS: 'এসএমএস থেকে',
  EMAIL: 'ইমেইল থেকে',
  WEBHOOK: 'অ্যাপ থেকে',
  OCR: 'ছবি থেকে',
  IMPORT: 'আগের কোনো ইমপোর্ট থেকে',
  RECURRING: 'নিয়মিত লেনদেন থেকে',
};

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

export function DuplicateSheet({
  open,
  onOpenChange,
  rowLabel,
  matches,
  moreCount,
  scope,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The statement row this is about, so the sheet says what it is comparing. */
  rowLabel: string;
  matches: readonly DuplicateMatch[];
  moreCount: number;
  scope: DuplicateScope;
}) {
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('import.duplicate.title', 'সম্ভাব্য ডুপ্লিকেট')}
      description={rowLabel}
    >
      <div className="flex flex-col gap-3">
        <p className="text-ink-muted text-sm">
          {t(
            'import.duplicate.explain',
            'একই দিনে, একই অ্যাকাউন্টে, ঠিক এই অঙ্কের লেনদেন খাতায় আগে থেকেই আছে। এটি হয়তো সেটিই — আবার হয়তো নয়, কারণ একই দিনে দুবার একই টাকা খরচ হতেই পারে। মিলিয়ে দেখে আপনি ঠিক করুন।',
          )}
        </p>

        {scope === 'ALL_ACCOUNTS' ? (
          <p className="text-brass bg-brass/10 rounded-md px-3 py-2 text-xs">
            {t(
              'import.duplicate.allAccounts',
              'এখনো কোনো অ্যাকাউন্ট বেছে নেওয়া হয়নি, তাই সব অ্যাকাউন্টে খোঁজা হয়েছে। অ্যাকাউন্ট বেছে নিলে তালিকাটি ছোট হবে।',
            )}
          </p>
        ) : null}

        <ul className="divide-rule border-rule divide-y rounded-md border">
          {matches.map((match) => (
            <li key={match.transactionId} className="flex flex-col gap-1 p-3">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-ink text-sm font-medium">{fmtDate(match.date)}</span>
                <Money
                  minor={match.direction === 'OUT' ? -match.amountMinor : match.amountMinor}
                  colored
                  signed
                  className="text-sm font-semibold"
                />
              </div>
              <p className="text-ink text-sm">
                {match.description?.trim() || t('import.duplicate.noDescription', 'বিবরণ লেখা নেই')}
              </p>
              <p className="text-ink-muted text-xs">
                {match.accountName} · {sourceLabel(match.source)}
                {match.reference ? ` · ${match.reference}` : ''}
              </p>
              <p className="text-ink-muted text-xs">
                {t('import.duplicate.recordedOn', 'খাতায় ওঠে')} {fmtDateTime12(match.createdAt)}
              </p>
            </li>
          ))}
        </ul>

        {moreCount > 0 ? (
          <p className="text-ink-muted text-xs">
            {t('import.duplicate.more', 'এমন আরও লেনদেন আছে')} ({moreCount})
          </p>
        ) : null}

        <p className="text-ink-muted text-xs">
          {t(
            'import.duplicate.noAction',
            'এই তালিকা দেখে অ্যাপ নিজে থেকে কিছুই করবে না — সারিটি বাদও দেবে না, জুড়েও দেবে না।',
          )}
        </p>
      </div>
    </Sheet>
  );
}
