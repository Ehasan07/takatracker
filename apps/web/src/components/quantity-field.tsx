'use client';

import * as React from 'react';
import { Field, Input } from '@/components/ui/field';
import { useQuantityUnits } from '@/lib/workspace-units';
import { toMilli, type QuantityValue } from './quantity';

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
  /* Called before the early return so the hook order is the same on both
     branches. It costs one cached request whether or not the field is open. */
  const units = useQuantityUnits();

  if (!value) {
    return (
      <button
        type="button"
        onClick={() => onChange({ milli: 0, unit: 'কেজি' })}
        className="press text-brand self-start text-sm underline"
      >
        পরিমাণ লিখবেন? (কত কেজি, কত লিটার)
      </button>
    );
  }

  return (
    <div className="rounded-card border-rule bg-brand-tint space-y-3 border p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-ink text-sm font-medium">পরিমাণ</p>
        <button
          type="button"
          onClick={() => {
            onChange(null);
            setText('');
          }}
          className="press text-ink-muted min-h-11 text-sm underline"
        >
          বাদ দিন
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="কত" htmlFor="qty-amount">
          <Input
            id="qty-amount"
            inputMode="decimal"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              onChange({ ...value, milli: toMilli(e.target.value) ?? 0 });
            }}
            placeholder="১.৫"
          />
        </Field>

        <Field label="একক" htmlFor="qty-unit">
          {/* A `<datalist>`, so the field stays free text. No fixed list
              survives contact with a Bangladeshi kitchen — হালি, বস্তা, গজ and
              a dozen others are all real, and a picker that cannot say the true
              one teaches people to leave the field empty. The workspace's own
              units are in here too, added from সেটিংস › পরিমাণের একক. */}
          <Input
            id="qty-unit"
            list="qty-units"
            value={value.unit}
            onChange={(e) => onChange({ ...value, unit: e.target.value })}
            maxLength={20}
          />
          <datalist id="qty-units">
            {units.map((u) => (
              <option key={u} value={u} />
            ))}
          </datalist>
        </Field>
      </div>

      <p className="text-ink-muted text-xs">
        মাস শেষে দেখতে পাবেন কত {value.unit || 'একক'} কেনা হয়েছে — রিপোর্টে “পরিমাণ” অংশে।
      </p>
    </div>
  );
}
