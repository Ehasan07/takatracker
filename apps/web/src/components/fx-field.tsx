'use client';

import { useQuery } from '@tanstack/react-query';
import * as React from 'react';
import { CURRENCIES, currencyOf, formatMinor, parseMoneyToMinor } from '@hishab/shared';
import { convert, type FxValue } from './fx-convert';
import { api } from '@/lib/api';
import { Field, Input, Select } from '@/components/ui/field';
import { useWorkspaceSettings } from '@/lib/workspace-settings';

/**
 * "This was in another currency."
 *
 * The ledger stays single-currency: what gets stored as the transaction's
 * amount is always the workspace's own money. This field records what the money
 * actually was — the currency and the amount in it — and converts at a rate the
 * *user* confirms.
 *
 * That last part is the whole design. We fetch a published rate and show it, but
 * the number that reaches the books is whichever one is in the box when they
 * press save. So the figure is their declared rate rather than our guess, which
 * is why a free daily feed is honest enough for the job and why the field still
 * works perfectly when the feed is down.
 *
 * ## Weight
 *
 * One request, for one pair, only after somebody opens this section — the
 * server holds the table and hands back a few dozen bytes. Nothing is fetched
 * for the overwhelming majority of entries, which are in the workspace's own
 * currency and never open it.
 */

export { convert, type FxValue } from './fx-convert';

interface RateAnswer {
  rate: number;
  asOf: string;
  provider: string;
}

export function FxField({
  value,
  onChange,
  rate,
  onRateChange,
}: {
  value: FxValue | null;
  onChange: (next: FxValue | null) => void;
  rate: string;
  onRateChange: (next: string) => void;
}) {
  const { currency: base, currencyInfo } = useWorkspaceSettings();
  const [amountText, setAmountText] = React.useState('');
  const open = value !== null;

  /* Only once the section is open, and only for the chosen pair. An entry in
     the workspace's own money — nearly all of them — costs nothing. */
  const suggestion = useQuery({
    queryKey: ['fx', base, value?.currency],
    queryFn: () =>
      api<RateAnswer>(`/fx/rate?to=${encodeURIComponent(base)}&from=${value!.currency}`),
    enabled: open && Boolean(value?.currency) && value?.currency !== base,
    staleTime: 6 * 60 * 60_000,
    retry: false,
  });

  // A fetched rate fills an empty box; it never overwrites what somebody typed.
  const applied = React.useRef<string | null>(null);
  React.useEffect(() => {
    const fetched = suggestion.data?.rate;
    if (fetched === undefined || !value) return;
    const key = `${value.currency}:${fetched}`;
    if (applied.current === key) return;
    applied.current = key;
    if (rate.trim() === '') onRateChange(String(fetched));
  }, [suggestion.data, value, rate, onRateChange]);

  const setCurrency = (code: string): void => {
    applied.current = null;
    onRateChange('');
    onChange({ currency: code, amountMinor: value?.amountMinor ?? 0 });
  };

  const setAmount = (text: string): void => {
    setAmountText(text);
    if (!value) return;
    try {
      onChange({
        ...value,
        amountMinor: text.trim() ? parseMoneyToMinor(text, value.currency) : 0,
      });
    } catch {
      onChange({ ...value, amountMinor: 0 });
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setCurrency(base === 'USD' ? 'BDT' : 'USD')}
        className="press text-income self-start text-sm underline"
      >
        অন্য মুদ্রায় খরচ হয়েছে?
      </button>
    );
  }

  const converted =
    value.amountMinor > 0 ? convert(value.amountMinor, value.currency, rate, base) : null;

  return (
    <div className="rounded-card border-rule bg-greenbar space-y-3 border p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-ink text-sm font-medium">অন্য মুদ্রার খরচ</p>
        <button
          type="button"
          onClick={() => {
            onChange(null);
            onRateChange('');
            setAmountText('');
          }}
          className="press text-ink-muted min-h-11 text-sm underline"
        >
          বাদ দিন
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="মুদ্রা" htmlFor="fx-currency">
          <Select
            id="fx-currency"
            value={value.currency}
            onChange={(e) => setCurrency(e.target.value)}
          >
            {CURRENCIES.map((info) => (
              <option key={info.code} value={info.code}>
                {info.code} — {info.symbol}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="মূল অঙ্ক" htmlFor="fx-amount">
          <Input
            id="fx-amount"
            inputMode="decimal"
            value={amountText}
            onChange={(e) => setAmount(e.target.value)}
            placeholder={currencyOf(value.currency).symbol}
          />
        </Field>
      </div>

      <Field label={`রেট — ১ ${value.currency} = কত ${currencyInfo.symbol}`} htmlFor="fx-rate">
        <Input
          id="fx-rate"
          inputMode="decimal"
          value={rate}
          onChange={(e) => onRateChange(e.target.value)}
          placeholder="0.00"
        />
        <p className="text-ink-muted mt-1 text-xs">
          {suggestion.isFetching
            ? 'আজকের রেট আনা হচ্ছে…'
            : suggestion.data
              ? `আজকের প্রকাশিত রেট বসানো হয়েছে (${suggestion.data.provider})। আপনি বদলে দিতে পারেন — যেটা এখানে থাকবে সেটাই খাতায় যাবে।`
              : /* Not an error state. The rate was always the user's to declare;
                   the feed only ever offered to fill it in. */
                'রেট আনা যায়নি — নিজে লিখে দিন।'}
        </p>
      </Field>

      <p className="text-ink text-sm">
        খাতায় যাবে:{' '}
        <strong className="font-medium">
          {converted && converted > 0 ? formatMinor(converted, { currency: base }) : '—'}
        </strong>
      </p>
    </div>
  );
}
