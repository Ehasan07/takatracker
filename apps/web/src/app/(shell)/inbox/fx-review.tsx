'use client';

import { useQuery } from '@tanstack/react-query';
import { Globe } from 'lucide-react';
import * as React from 'react';
import { currencyOf, formatMinor } from '@hishab/shared';
import { convert } from '@/components/fx-convert';
import { Input } from '@/components/ui/field';
import { api } from '@/lib/api';
import { fmtNumber } from '@/lib/format';
import { t } from '@/lib/t';

/**
 * "This message was not in taka."
 *
 * ## The bug this is the visible half of
 *
 * The owner's bank sent `USD 4.6 transacted at OPENAI *CHATGPT SUBSCR`, and the
 * review screen put 4.60 in a box labelled **টাকার পরিমাণ (৳)**. A subscription
 * costing about ৳560 was one tap from being filed at ৳4.60, and there was
 * nothing on the screen that said dollars and no field in which to say so. The
 * draft now arrives with no taka figure at all — the server refuses to invent
 * one — and this block is where the person supplies it.
 *
 * ## Why it asks rather than converts
 *
 * There is a rate endpoint, and what it returns is a *suggestion*. The rate that
 * actually applied is the card issuer's on the day they settled, plus whatever
 * they added for the privilege; it is not the mid-market rate, it is not on any
 * screen here, and a number applied silently would be a guess wearing the
 * clothes of a reading. So the published rate is offered, said out loud to be a
 * suggestion, and whatever is in the box when they press accept is what the
 * books get.
 *
 * ## Two ways in, because two kinds of person arrive here
 *
 * Somebody looking at their card app has a **rate** in front of them. Somebody
 * looking at a bank statement has the **taka figure** already, and making them
 * divide one by the other to recover a rate we would only multiply back is
 * work for nothing. So the rate fills the amount box and the amount box stays
 * editable, and the line under it says both are fine.
 */

interface RateAnswer {
  rate: number;
  asOf: string;
  provider: string;
}

export function FxReviewField({
  currency,
  amountMinor,
  base,
  rate,
  onRateChange,
  quoted,
  disabled,
}: {
  /** ISO 4217 the message named. */
  currency: string;
  /** The original, in integer minor units of `currency`. */
  amountMinor: number;
  /** ISO 4217 the books are kept in. */
  base: string;
  rate: string;
  onRateChange: (next: string) => void;
  /** The exact words the code and figure were read from, for the quotation. */
  quoted?: string;
  disabled: boolean;
}) {
  /* One request, for one pair, and only for the drafts that need it. A taka
     alert never renders this component and never asks. */
  const suggestion = useQuery({
    queryKey: ['fx', base, currency],
    queryFn: () =>
      api<RateAnswer>(
        `/fx/rate?to=${encodeURIComponent(base)}&from=${encodeURIComponent(currency)}`,
      ),
    enabled: !disabled && currency !== base,
    staleTime: 6 * 60 * 60_000,
    retry: false,
  });

  /* A fetched rate fills an empty box and never overwrites what somebody typed.
     The ref is per pair, so arriving twice with the same answer does nothing —
     which is what stops a refetch from stamping over a rate they had corrected. */
  const applied = React.useRef<string | null>(null);
  React.useEffect(() => {
    const fetched = suggestion.data?.rate;
    if (fetched === undefined) return;
    const key = `${currency}:${fetched}`;
    if (applied.current === key) return;
    applied.current = key;
    if (rate.trim() === '') onRateChange(String(fetched));
  }, [suggestion.data, currency, rate, onRateChange]);

  const info = currencyOf(currency);

  return (
    <div className="rounded-card border-brass/40 bg-brass/5 flex flex-col gap-3 border p-3">
      <div className="flex items-start gap-2">
        <Globe className="text-brass mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <div className="min-w-0">
          <p className="text-ink text-sm font-medium">
            {t('inbox.fxTitle', 'বার্তাটি অন্য মুদ্রার')}
          </p>
          <p className="text-ink-muted mt-0.5 text-sm">
            {t(
              'inbox.fxWhy',
              'খাতা {base}-এ রাখা হয়, তাই কত {base} কাটা হয়েছে সেটি আপনাকে বলতে হবে। বার্তায় রেট লেখা নেই — কার্ডের অ্যাপ বা ব্যাংকের স্টেটমেন্টে যা আছে সেটি দিন।',
            ).replaceAll('{base}', currencyOf(base).code)}
          </p>
        </div>
      </div>

      {/* The figure the message actually carried, and its own units beside it.
          Read-only on purpose: this is a quotation, not a field. Correcting the
          parser's reading of it is what the reject button is for. */}
      <p className="text-ink text-sm">
        {t('inbox.fxStated', 'বার্তায় লেখা ছিল')}{' '}
        <strong className="money text-base font-semibold">
          {formatMinor(amountMinor, { currency, symbol: false })} {info.code}
        </strong>
        {quoted ? <span className="text-ink-muted"> · “{quoted}”</span> : null}
      </p>

      <div className="flex min-w-0 flex-col gap-1.5">
        <label htmlFor="dr-fx-rate" className="text-ink text-sm font-medium">
          {`${t('fx.rate', 'রেট')} — ${fmtNumber(1)} ${info.code} = ? ${currencyOf(base).symbol}`}
        </label>
        <Input
          id="dr-fx-rate"
          value={rate}
          onChange={(e) => onRateChange(e.target.value)}
          inputMode="decimal"
          autoComplete="off"
          className="money"
          placeholder="0.00"
        />
        <p className="text-ink-muted text-xs">
          {suggestion.isFetching
            ? t('fx.fetching', 'আজকের রেট আনা হচ্ছে…')
            : suggestion.data
              ? `${t('fx.suggested', 'আজকের প্রকাশিত রেট বসানো হয়েছে। আপনি বদলে দিতে পারেন — যেটা এখানে থাকবে সেটাই খাতায় যাবে।')} (${suggestion.data.provider})`
              : /* Not an error state. The rate was always theirs to declare; the
                   feed only ever offered to fill it in. */
                t('fx.failed', 'রেট আনা যায়নি — নিজে লিখে দিন।')}
        </p>
        <p className="text-ink-muted text-xs">
          {t(
            'inbox.fxOrType',
            'রেট লিখলে নিচের ঘরটি নিজে থেকে ভরে যাবে। স্টেটমেন্টে কাটা অঙ্কটি জানা থাকলে রেট বাদ দিয়ে সরাসরি সেটিই নিচে লিখে দিন।',
          )}
        </p>
      </div>
    </div>
  );
}

/**
 * The taka figure a rate implies, as text for the amount box — or null.
 *
 * All of the arithmetic is `convert` from the entry sheet's own module, which
 * splits the typed rate into an integer over a power of ten and does the
 * multiplication before the single final division. Nothing here multiplies a
 * float by an amount, which is the one operation that could quietly corrupt a
 * figure on this screen.
 */
export function convertedAmountText(
  fxAmountMinor: number,
  fxCurrency: string,
  rate: string,
  base: string,
): string | null {
  const minor = convert(fxAmountMinor, fxCurrency, rate, base);
  if (minor === null || minor <= 0) return null;
  return formatMinor(minor, { symbol: false, currency: base });
}
