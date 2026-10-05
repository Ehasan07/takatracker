'use client';

import { fiscalYearOf } from '@hishab/core';
import { toLocalDateString } from '@hishab/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Calculator } from '@/components/icons';
import * as React from 'react';
import { Money } from '@/components/money';
import { SkeletonRows } from '@/components/skeleton';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { ApiError, api } from '@/lib/api';
import { fmtNumber } from '@/lib/format';
import { haptic } from '@/lib/haptics';
import { t } from '@/lib/t';

/**
 * আয়কর — a worksheet from the books, and a figure only when somebody has
 * checked the year's rates against the gazette.
 *
 * ## The screen is two halves and they fail separately
 *
 * The **worksheet** always loads: income by head, the investments behind the
 * rebate, net wealth at the year end. Every figure names the categories, plans
 * and policies it came from, because a number a person cannot trace is a number
 * they cannot check — and this sheet exists to be checked, by them and then by
 * their practitioner.
 *
 * The **estimate** appears only after the হিসাব করুন button, and only for a
 * fiscal year whose rates a human has transcribed and verified. When they have
 * not, the button is disabled and the reason sits where the figure would have
 * been, in Bengali. That refusal is the feature, not a gap in it: a tax figure
 * computed on last year's slabs looks exactly like one computed on this year's,
 * and nobody carrying it to their accountant can tell the difference
 * (docs/RENEWALS-AND-TAX.md §3.5).
 *
 * ## The disclaimer is not a footnote
 *
 * It sits inside the same card as the payable figure, at `text-base` — larger
 * than every other body line on the page — and it is rendered before the reader
 * can scroll past the number. §3.6: the wording appears *beside* the figure, not
 * in a footer nobody reads. There is no version of this screen where somebody
 * sees an amount and has to go looking for the caveat.
 *
 * ## Nothing here writes to the ledger
 *
 * Two reads and one deliberate POST that creates nothing. The only thing this
 * screen saves is the taxpayer's own category and area, which are facts about
 * the person rather than about their money.
 */

/* -------------------------------------------------------------------------- */
/* What the API returns                                                       */
/* -------------------------------------------------------------------------- */

interface IncomeSource {
  categoryId: string | null;
  name: string;
  amountMinor: number;
  mapped: boolean;
}

interface IncomeHead {
  head: string;
  label: string;
  amountMinor: number;
  sources: IncomeSource[];
}

interface InvestmentLine {
  kind: 'SAVINGS' | 'INSURANCE';
  id: string;
  name: string;
  detail: string | null;
  paidMinor: number;
  payments: number;
  counted: boolean;
  note: string | null;
}

interface RegimeStatus {
  country: string;
  fiscalYear: string;
  version: number | null;
  found: boolean;
  verified: boolean;
  citation: string | null;
  verifiedAt: string | null;
  verifiedByName: string | null;
  refusal: string | null;
  categories: string[];
  areas: string[];
}

interface TaxProfile {
  country: string;
  category: string;
  area: string;
  isRequiredToFile: boolean;
  tinMasked: string | null;
}

interface Worksheet {
  fiscalYear: string;
  from: string;
  to: string;
  regime: RegimeStatus;
  profile: TaxProfile;
  totalIncomeMinor: number;
  heads: IncomeHead[];
  eligibleInvestmentMinor: number;
  investments: InvestmentLine[];
  netWealthMinor: number;
  taxDeductedAtSourceMinor: number;
  limits: string[];
}

interface TaxLine {
  key: string;
  amountMinor: number;
  rateBps?: number;
  note?: string;
}

interface Estimate {
  totalIncomeMinor: number;
  taxableIncomeMinor: number;
  grossTaxMinor: number;
  rebateMinor: number;
  netTaxMinor: number;
  minimumTaxMinor: number;
  surchargeMinor: number;
  payableMinor: number;
  lines: TaxLine[];
  citation: string;
}

interface EstimateResult {
  worksheet: Worksheet;
  estimate: Estimate;
  rebateBoundBy: string;
}

/* -------------------------------------------------------------------------- */
/* Wording                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The disclaimer, in the owner's own five points, written out properly.
 *
 * An array rather than one paragraph so each point gets its own line and none of
 * them can be skimmed past as a clause in the middle of a sentence. In order:
 * the figure is an estimate from what was recorded; the real amount may differ;
 * have a professional check it; Taka Tracker accepts no liability; the
 * calculator is in beta.
 */
const DISCLAIMER: readonly string[] = [
  'এই হিসাবটি আপনার খাতায় লেখা তথ্য অনুযায়ী কেবল একটি আনুমানিক অঙ্ক — এটি আয়কর রিটার্ন নয়।',
  'প্রকৃত করের পরিমাণ এর চেয়ে ভিন্ন হতে পারে, বিশেষত যে আয় বা বিনিয়োগ এখানে লেখা হয়নি তার জন্য।',
  'রিটার্ন দাখিলের আগে অবশ্যই একজন আয়কর বিশেষজ্ঞ বা আইনজীবী দিয়ে হিসাবটি যাচাই করিয়ে নিন।',
  'এই হিসাব ব্যবহারের ফলে কোনো ক্ষতি বা জরিমানা হলে টাকা ট্র্যাকার তার কোনো দায় নেয় না।',
  'ক্যালকুলেটরটি এখনো বেটা পর্যায়ে আছে।',
];

/** Which of the three caps decided the rebate, said in Bengali. */
const REBATE_CAP_LABEL: Readonly<Record<string, string>> = {
  investment: 'বিনিয়োগের উপর নির্ধারিত হার',
  income: 'করযোগ্য আয়ের উপর নির্ধারিত সর্বোচ্চ সীমা',
  absolute: 'রেয়াতের সর্বোচ্চ নির্দিষ্ট অঙ্ক',
};

/**
 * The taxpayer categories and areas a regime may define, named in Bengali.
 *
 * A lookup and not a list: which keys exist is a fact about the year's Finance
 * Act, and the regime is what says. A key with no entry here shows as itself
 * rather than disappearing from the picker.
 */
const CATEGORY_LABEL: Readonly<Record<string, string>> = {
  general: 'সাধারণ করদাতা',
  female: 'নারী করদাতা',
  senior: '৬৫ বছরের বেশি বয়সী',
  disabled: 'প্রতিবন্ধী করদাতা',
  freedomFighter: 'গেজেটভুক্ত মুক্তিযোদ্ধা',
  thirdGender: 'তৃতীয় লিঙ্গের করদাতা',
};

const AREA_LABEL: Readonly<Record<string, string>> = {
  dhakaChattogramCity: 'ঢাকা ও চট্টগ্রাম সিটি কর্পোরেশন',
  otherCity: 'অন্যান্য সিটি কর্পোরেশন',
  elsewhere: 'সিটি কর্পোরেশনের বাইরে',
};

/**
 * Basis points as a percentage, without a float ever touching a rate.
 *
 * `1000` is `১০%`, `250` is `২.৫%`. Integer division and a remainder rather than
 * `bps / 100`, for the same reason money is integer poisha: a rate that prints
 * as `২.৪৯৯৯৯৯%` is a rate somebody will query.
 */
function bpsLabel(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const hundredths = bps % 100;
  if (hundredths === 0) return `${fmtNumber(whole)}%`;
  const fraction =
    hundredths % 10 === 0 ? String(hundredths / 10) : String(hundredths).padStart(2, '0');
  return `${fmtNumber(whole)}.${fmtNumber(fraction)}%`;
}

/** The current fiscal year and the two before it. Nobody files further back here. */
function fiscalYearChoices(): string[] {
  const current = fiscalYearOf(toLocalDateString(new Date()));
  const startYear = Number(current.split('-')[0]);
  return [0, 1, 2].map((back) => {
    const year = startYear - back;
    return `${year}-${String((year + 1) % 100).padStart(2, '0')}`;
  });
}

/** "২০২৫–২৬" — a fiscal year as somebody would say it. */
function fiscalYearLabel(year: string): string {
  const [start, end] = year.split('-');
  return `${fmtNumber(start ?? '')}–${fmtNumber(end ?? '')}`;
}

/* -------------------------------------------------------------------------- */

export default function TaxPage() {
  const queryClient = useQueryClient();
  const years = React.useMemo(fiscalYearChoices, []);
  const [year, setYear] = React.useState<string>(() => years[0] ?? '');
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<EstimateResult | null>(null);

  const sheet = useQuery({
    queryKey: ['tax', 'worksheet', year],
    queryFn: () => api<Worksheet>(`/tax/worksheet?fiscalYear=${year}`),
  });

  const saveProfile = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<TaxProfile>('/tax/profile', { method: 'PUT', body }),
    onSuccess: () => {
      haptic('tap');
      void queryClient.invalidateQueries({ queryKey: ['tax'] });
    },
    onError: (err) => {
      haptic('warn');
      setError(err instanceof ApiError ? err.message : 'করদাতার তথ্য সংরক্ষণ করা যায়নি');
    },
  });

  const calculate = useMutation({
    mutationFn: () =>
      api<EstimateResult>('/tax/estimate', { method: 'POST', body: { fiscalYear: year } }),
    onSuccess: (data) => {
      haptic('success');
      setError(null);
      setResult(data);
    },
    onError: (err) => {
      haptic('warn');
      setResult(null);
      /* The server's refusal is already a Bengali sentence naming the year and
         saying what is missing. Replacing it with something vaguer here would
         throw away the only useful part of the response. */
      setError(err instanceof ApiError ? err.message : 'হিসাব করা যায়নি');
    },
  });

  /* A figure computed for one year must not stay on screen while another year's
     worksheet is showing — the two would read as one sheet. */
  const changeYear = (next: string): void => {
    setYear(next);
    setResult(null);
    setError(null);
  };

  const regime = sheet.data?.regime;
  const canCalculate = regime?.verified === true;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <header>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-ink text-xl font-extrabold sm:text-2xl">
            {t('settings.tax', 'আয়কর')}
          </h1>
          <span className="border-brass text-brass rounded-xl border px-2 py-0.5 text-xs font-semibold">
            {t('settings.tax.beta', 'বেটা')}
          </span>
        </div>
        <p className="text-ink-muted mt-1 text-sm">
          {t(
            'settings.tax.blurb',
            'জুলাই–জুন অর্থবছরের আয়, বিনিয়োগ ও সম্পদের একটি খসড়া হিসাব। রিটার্ন নয়।',
          )}
        </p>
      </header>

      <section className="rounded-card border-rule bg-surface border-[1.5px] p-4">
        <Field label={t('settings.tax.year', 'অর্থবছর')} htmlFor="tax-year">
          <Select id="tax-year" value={year} onChange={(e) => changeYear(e.target.value)}>
            {years.map((option) => (
              <option key={option} value={option}>
                {fiscalYearLabel(option)}
              </option>
            ))}
          </Select>
        </Field>
        {sheet.data ? (
          <p className="text-ink-muted mt-2 text-xs">
            {t('settings.tax.window', 'হিসাবের সময়সীমা')}: {fmtNumber(sheet.data.from)} —{' '}
            {fmtNumber(sheet.data.to)}
          </p>
        ) : null}
      </section>

      {/* The refusal, where the figure would otherwise be. Above the worksheet
          rather than below it, so nobody reads a page of inputs and then
          discovers the answer is not coming. */}
      {regime && !regime.verified ? (
        <section className="rounded-card border-brass bg-greenbar border-[1.5px] p-4" role="status">
          <div className="flex items-start gap-2">
            <AlertTriangle className="text-brass mt-0.5 h-5 w-5 shrink-0" aria-hidden />
            <div>
              <h2 className="text-ink text-base font-semibold">
                {t('settings.tax.refused', 'এই বছরের হিসাব দেখানো যাচ্ছে না')}
              </h2>
              <p className="text-ink mt-1 text-base">{regime.refusal}</p>
              <p className="text-ink-muted mt-2 text-sm">
                {t(
                  'settings.tax.refused.why',
                  'প্রতি বছর অর্থ আইনে করহার বদলায়। পুরনো বছরের হার দিয়ে হিসাব করলে অঙ্কটি ভুল হবে, অথচ দেখতে ঠিকই লাগবে — তাই যাচাই না হওয়া পর্যন্ত কোনো অঙ্ক দেখানো হয় না।',
                )}
              </p>
            </div>
          </div>
        </section>
      ) : null}

      {/* Only offered for a verified year, because the choices themselves come
          from the year's own rate table. */}
      {regime?.verified && sheet.data ? (
        <section className="rounded-card border-rule bg-surface border-[1.5px] p-4">
          <h2 className="text-ink text-lg font-bold">
            {t('settings.tax.taxpayer', 'করদাতার তথ্য')}
          </h2>
          <p className="text-ink-muted mt-1 text-xs">
            {t(
              'settings.tax.taxpayer.why',
              'করমুক্ত আয়ের সীমা ও ন্যূনতম কর এই দুটির উপর নির্ভর করে — খাতা থেকে জানা যায় না।',
            )}
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field label={t('settings.tax.category', 'করদাতার শ্রেণি')} htmlFor="tax-category">
              <Select
                id="tax-category"
                value={sheet.data.profile.category}
                onChange={(e) => saveProfile.mutate({ category: e.target.value })}
              >
                {regime.categories.map((key) => (
                  <option key={key} value={key}>
                    {CATEGORY_LABEL[key] ?? key}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('settings.tax.area', 'এলাকা')} htmlFor="tax-area">
              <Select
                id="tax-area"
                value={sheet.data.profile.area}
                onChange={(e) => saveProfile.mutate({ area: e.target.value })}
              >
                {regime.areas.map((key) => (
                  <option key={key} value={key}>
                    {AREA_LABEL[key] ?? key}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('settings.tax.tin', 'টিআইএন (শেষ কয়েক অঙ্ক)')} htmlFor="tax-tin">
              <Input
                id="tax-tin"
                defaultValue={sheet.data.profile.tinMasked ?? ''}
                inputMode="numeric"
                maxLength={24}
                onBlur={(e) => saveProfile.mutate({ tinMasked: e.target.value || null })}
              />
            </Field>
          </div>
        </section>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {/* The worksheet — always shown, whether or not a figure is coming.   */}
      {/* ---------------------------------------------------------------- */}

      {sheet.isLoading ? (
        <div className="rounded-card border-rule bg-surface overflow-hidden border-[1.5px]">
          <SkeletonRows rows={5} />
        </div>
      ) : sheet.data ? (
        <>
          <section className="rounded-card border-rule bg-surface border-[1.5px] p-4">
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="text-ink text-lg font-bold">
                {t('settings.tax.income', 'খাতভিত্তিক আয়')}
              </h2>
              <Money minor={sheet.data.totalIncomeMinor} className="text-ink font-semibold" />
            </div>

            {sheet.data.heads.length === 0 ? (
              <p className="text-ink-muted mt-3 text-sm">
                {t('settings.tax.income.none', 'এই অর্থবছরে কোনো আয় লেখা হয়নি।')}
              </p>
            ) : (
              <ul className="divide-rule mt-3 divide-y">
                {sheet.data.heads.map((head) => (
                  <li key={head.head} className="py-2 first:pt-0 last:pb-0">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-ink text-sm font-medium">{head.label}</span>
                      <Money minor={head.amountMinor} className="text-sm" />
                    </div>
                    {/* Where each head's money came from. §3.4: the sheet is
                        worth having because it shows its working. */}
                    <ul className="mt-1">
                      {head.sources.map((source) => (
                        <li
                          key={source.categoryId ?? source.name}
                          className="text-ink-muted flex items-baseline justify-between gap-2 text-xs"
                        >
                          <span className="truncate">
                            {source.name}
                            {source.mapped ? null : (
                              <span className="text-brass">
                                {' '}
                                · {t('settings.tax.unmapped', 'খাত মেলানো যায়নি')}
                              </span>
                            )}
                          </span>
                          <Money minor={source.amountMinor} className="text-xs" decimals={false} />
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded-card border-rule bg-surface border-[1.5px] p-4">
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="text-ink text-lg font-bold">
                {t('settings.tax.investment', 'রেয়াতযোগ্য বিনিয়োগ')}
              </h2>
              <Money
                minor={sheet.data.eligibleInvestmentMinor}
                className="text-ink font-semibold"
              />
            </div>
            <p className="text-ink-muted mt-1 text-xs">
              {t(
                'settings.tax.investment.basis',
                'এই অর্থবছরে যে ডিপিএস কিস্তি, সঞ্চয়পত্র ও বিমার প্রিমিয়াম আসলে পরিশোধ করা হয়েছে — বকেয়া কিস্তি নয়।',
              )}
            </p>

            {sheet.data.investments.length === 0 ? (
              <p className="text-ink-muted mt-3 text-sm">
                {t(
                  'settings.tax.investment.none',
                  'এই অর্থবছরে কোনো কিস্তি বা প্রিমিয়াম পরিশোধ হয়নি।',
                )}
              </p>
            ) : (
              <ul className="divide-rule mt-3 divide-y">
                {sheet.data.investments.map((line) => (
                  <li key={`${line.kind}-${line.id}`} className="py-2 first:pt-0 last:pb-0">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-ink min-w-0 flex-1 truncate text-sm">
                        {line.name}
                        {line.detail ? (
                          <span className="text-ink-muted"> · {line.detail}</span>
                        ) : null}
                      </span>
                      <Money
                        minor={line.paidMinor}
                        className={line.counted ? 'text-sm' : 'text-ink-muted text-sm line-through'}
                      />
                    </div>
                    <p className="text-ink-muted text-xs">
                      {fmtNumber(line.payments)}{' '}
                      {t('settings.tax.investment.payments', 'টি পরিশোধ')}
                      {line.note ? ` · ${line.note}` : ''}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded-card border-rule bg-surface border-[1.5px] p-4">
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="text-ink text-lg font-bold">
                {t('settings.tax.netWealth', 'অর্থবছর শেষে নিট সম্পদ')}
              </h2>
              <Money minor={sheet.data.netWealthMinor} className="text-ink font-semibold" />
            </div>
            <p className="text-ink-muted mt-1 text-xs">
              {t('settings.tax.netWealth.why', 'সারচার্জ প্রযোজ্য হবে কি না তা এর উপর নির্ভর করে।')}
            </p>
          </section>
        </>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {/* The button, and only then the figure.                             */}
      {/* ---------------------------------------------------------------- */}

      <Button
        size="block"
        onClick={() => calculate.mutate()}
        disabled={!canCalculate || calculate.isPending}
      >
        <Calculator className="h-4 w-4" aria-hidden />
        {calculate.isPending
          ? t('settings.tax.calculating', 'হিসাব করা হচ্ছে…')
          : t('settings.tax.calculate', 'হিসাব করুন')}
      </Button>

      {error ? (
        <p role="alert" className="text-expense text-base">
          {error}
        </p>
      ) : null}

      {result ? (
        <section className="rounded-card border-brass bg-surface border-2 p-4">
          <h2 className="text-ink text-lg font-bold">
            {t('settings.tax.payable', 'আনুমানিক প্রদেয় আয়কর')}
          </h2>
          <Money
            minor={result.estimate.payableMinor}
            className="text-ink block text-3xl font-bold"
          />

          {/* Immediately under the figure and at `text-base` — larger than every
              other body line on this page. §3.6: beside the number, never in a
              footer. */}
          <div className="border-rule mt-3 border-t pt-3">
            <ul className="text-ink flex list-disc flex-col gap-1 pl-5 text-base">
              {DISCLAIMER.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>

          {/* The working, line by line. */}
          <dl className="divide-rule mt-4 divide-y text-sm">
            <Row
              label={t('settings.tax.taxableIncome', 'করযোগ্য আয়')}
              minor={result.estimate.taxableIncomeMinor}
            />

            {result.estimate.lines
              .filter((line) => line.key.startsWith('slab.'))
              .map((line) => (
                <Row
                  key={`${line.key}-${line.note ?? ''}`}
                  label={`${t('settings.tax.slab', 'স্ল্যাব')} ${bpsLabel(line.rateBps ?? 0)}`}
                  minor={line.amountMinor}
                />
              ))}

            <Row
              label={t('settings.tax.grossTax', 'মোট কর')}
              minor={result.estimate.grossTaxMinor}
            />

            <Row
              label={t('settings.tax.rebate', 'বিনিয়োগ রেয়াত')}
              minor={-result.estimate.rebateMinor}
              note={`${t('settings.tax.rebate.boundBy', 'সীমা নির্ধারণ করেছে')}: ${
                REBATE_CAP_LABEL[result.rebateBoundBy] ?? result.rebateBoundBy
              }`}
            />

            {result.estimate.minimumTaxMinor > 0 ? (
              <Row
                label={t('settings.tax.minimumTax', 'ন্যূনতম কর')}
                minor={result.estimate.minimumTaxMinor}
                note={t(
                  'settings.tax.minimumTax.why',
                  'হিসাব করা করের চেয়ে বেশি, তাই এটিই প্রযোজ্য',
                )}
              />
            ) : null}

            {result.estimate.surchargeMinor > 0 ? (
              <Row
                label={t('settings.tax.surcharge', 'সারচার্জ')}
                minor={result.estimate.surchargeMinor}
                note={t('settings.tax.surcharge.why', 'নিট সম্পদের উপর ধার্য')}
              />
            ) : null}

            {result.estimate.payableMinor < 0 ? (
              <Row
                label={t('settings.tax.refund', 'ফেরতযোগ্য')}
                minor={-result.estimate.payableMinor}
              />
            ) : null}
          </dl>

          <p className="text-ink-muted mt-3 text-xs">
            {t('settings.tax.citation', 'করহারের উৎস')}: {result.estimate.citation}
            {result.worksheet.regime.verifiedByName
              ? ` · ${t('settings.tax.verifiedBy', 'যাচাই করেছেন')} ${result.worksheet.regime.verifiedByName}`
              : ''}
          </p>
        </section>
      ) : null}

      {/* What the sheet cannot see. Always shown, figure or no figure — the
          limits belong to the inputs, not to the estimate. */}
      {sheet.data ? (
        <section className="rounded-card border-rule border-[1.5px] border-dashed p-4">
          <h2 className="text-ink text-lg font-bold">
            {t('settings.tax.limits', 'এই হিসাবে যা ধরা হয়নি')}
          </h2>
          <ul className="text-ink-muted mt-2 flex list-disc flex-col gap-1 pl-5 text-sm">
            {sheet.data.limits.map((limit) => (
              <li key={limit}>{limit}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/** One line of the worksheet: what it is, what it came to, and why. */
function Row({ label, minor, note }: { label: string; minor: number; note?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-2">
      <dt className="text-ink-muted min-w-0">
        {label}
        {note ? <span className="text-ink-muted block text-xs">{note}</span> : null}
      </dt>
      <dd className="shrink-0">
        <Money minor={minor} />
      </dd>
    </div>
  );
}
