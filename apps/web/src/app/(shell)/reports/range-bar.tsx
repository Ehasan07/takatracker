'use client';

/**
 * The one control that drives the whole screen: seven ready-made periods, a
 * custom pair of dates, and an export of exactly what is on display.
 *
 * The chip idiom is the loan statement's, deliberately — a user who has learnt
 * the date filter once should not have to learn it again three screens later.
 */

import { Download } from '@/components/icons';
import * as React from 'react';
import { Field, Input } from '@/components/ui/field';
import { ApiError } from '@/lib/api';
import { haptic } from '@/lib/haptics';
import { downloadTransactionsCsv } from './exports';
import { Chip } from './parts';
import { PRESETS, isIsoDate, periodLabel, rangeForPreset, type ReportRange } from './range';

export function RangeBar({
  range,
  onChange,
  today,
}: {
  range: ReportRange;
  onChange: (range: ReportRange) => void;
  today: Date;
}) {
  /* The two date inputs are edited a keystroke at a time and are briefly
     nonsense while that happens. They live here as a draft and only become the
     range — and therefore seven network requests — once they make sense. */
  const [draft, setDraft] = React.useState({ from: range.from, to: range.to });
  React.useEffect(() => {
    setDraft({ from: range.from, to: range.to });
  }, [range.from, range.to]);

  const [exporting, setExporting] = React.useState(false);
  const [status, setStatus] = React.useState<string | null>(null);

  const reversed = isIsoDate(draft.from) && isIsoDate(draft.to) && draft.from > draft.to;

  const editCustom = (patch: Partial<typeof draft>): void => {
    const next = { ...draft, ...patch };
    setDraft(next);
    if (isIsoDate(next.from) && isIsoDate(next.to) && next.from <= next.to) {
      onChange({ preset: 'custom', ...next });
    }
  };

  const onExport = (): void => {
    haptic('tap');
    setExporting(true);
    setStatus(null);
    downloadTransactionsCsv(range)
      .then(() => setStatus('এই সময়ের লেনদেন .csv ফাইলে নামানো হয়েছে'))
      .catch((err: unknown) =>
        setStatus(err instanceof ApiError ? err.message : 'ফাইল নামানো যায়নি'),
      )
      .finally(() => setExporting(false));
  };

  return (
    <section
      aria-label="সময়সীমা"
      className="rounded-card border-rule bg-surface flex flex-col gap-3 border-[1.5px] p-3"
    >
      <div className="chip-strip">
        {PRESETS.map(([key, label]) => (
          <Chip
            key={key}
            active={range.preset === key}
            onClick={() => onChange(rangeForPreset(key, today))}
          >
            {label}
          </Chip>
        ))}
        {/* Switching to custom keeps the days already on screen, so the report
            does not blank out while two dates get typed. */}
        <Chip
          active={range.preset === 'custom'}
          onClick={() => onChange({ preset: 'custom', from: range.from, to: range.to })}
        >
          নির্দিষ্ট সময়
        </Chip>
      </div>

      {range.preset === 'custom' ? (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Field label="শুরুর তারিখ" htmlFor="report-from">
            <Input
              id="report-from"
              type="date"
              value={draft.from}
              max={draft.to || undefined}
              onChange={(e) => editCustom({ from: e.target.value })}
            />
          </Field>
          <Field
            label="শেষ তারিখ"
            htmlFor="report-to"
            error={reversed ? 'শেষ তারিখ শুরুর তারিখের আগে হতে পারে না।' : undefined}
          >
            <Input
              id="report-to"
              type="date"
              value={draft.to}
              min={draft.from || undefined}
              onChange={(e) => editCustom({ to: e.target.value })}
            />
          </Field>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-ink-muted min-w-0 text-xs">
          দেখানো হচ্ছে: <span className="text-ink">{periodLabel(range)}</span>
        </p>
        <button
          type="button"
          onClick={onExport}
          disabled={exporting}
          className="press border-rule text-ink hover:bg-greenbar bg-surface flex min-h-11 shrink-0 items-center gap-1.5 rounded-xl border px-3 text-sm disabled:opacity-50 md:min-h-9"
        >
          <Download className="h-4 w-4" aria-hidden />
          {exporting ? 'নামানো হচ্ছে…' : 'এই সময়ের সিএসভি'}
        </button>
      </div>

      {status ? (
        <p role="status" className="text-ink-muted text-xs">
          {status}
        </p>
      ) : null}
    </section>
  );
}
