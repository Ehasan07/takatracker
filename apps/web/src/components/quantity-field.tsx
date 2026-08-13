'use client';

import * as React from 'react';
import { Field, Input } from '@/components/ui/field';
import { fmtNumber } from '@/lib/format';
import { t } from '@/lib/t';
import { useUnitOptions } from '@/lib/workspace-units';
import { toMilli, type QuantityValue } from './quantity';
import { UnitPicker } from './unit-picker';

export { COMMON_UNITS, fromMilli, toMilli, type QuantityValue } from './quantity';

/**
 * How much of a thing, beside how much it cost.
 *
 * "৳12,000 on fuel this year" is a number the ledger already gives. "340
 * litres" is a different question and it is the one a household acts on,
 * because a price rise and a habit change look identical in taka and completely
 * different in litres.
 *
 * Optional, and hidden until asked for. Almost every entry is a payment with no
 * meaningful quantity — a bus fare is not two of anything — and putting two
 * more boxes on the form for the sake of the minority that wants them would
 * slow down the majority that does not.
 *
 * ## Thousandths, not decimals
 *
 * The stored value is an integer: half a kilo is 500. Same reasoning as money —
 * a float quantity summed over a year drifts, and a drifting answer to "how
 * much rice did we get through" is worse than no answer.
 */

export function QuantityField({
  value,
  onChange,
}: {
  value: QuantityValue | null;
  onChange: (next: QuantityValue | null) => void;
}) {
  const [text, setText] = React.useState('');
  /* Before the early return, so the hook order is the same on both branches.
     It costs one cached request whether or not the field is open. */
  const { fallback } = useUnitOptions();

  if (!value) {
    return (
      <button
        type="button"
        onClick={() => onChange({ milli: 0, unit: fallback })}
        className="press text-brand self-start text-sm underline"
      >
        {t('quantity.open', 'পরিমাণ লিখবেন? (কত কেজি, কত লিটার)')}
      </button>
    );
  }

  return (
    <div className="rounded-card border-rule bg-brand-tint space-y-3 border p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-ink text-sm font-medium">{t('quantity.title', 'পরিমাণ')}</p>
        <button
          type="button"
          onClick={() => {
            onChange(null);
            setText('');
          }}
          className="press text-ink-muted min-h-11 text-sm underline"
        >
          {t('quantity.remove', 'বাদ দিন')}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label={t('quantity.howMuch', 'কত')} htmlFor="qty-amount">
          <Input
            id="qty-amount"
            inputMode="decimal"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              onChange({ ...value, milli: toMilli(e.target.value) ?? 0 });
            }}
            placeholder={fmtNumber('1.5')}
          />
        </Field>

        <Field label={t('quantity.unit', 'একক')} htmlFor="qty-unit">
          <UnitPicker value={value.unit} onChange={(unit) => onChange({ ...value, unit })} />
        </Field>
      </div>

      <p className="text-ink-muted text-xs">
        {t('quantity.hint', 'মাস শেষে দেখতে পাবেন কত কেনা হয়েছে — রিপোর্টের “পরিমাণ” অংশে।')}
      </p>
    </div>
  );
}
