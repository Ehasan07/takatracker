import { ArrowRight, Check, Minus } from 'lucide-react';
import Link from 'next/link';
import { formatMinor } from '@hishab/shared';
import { CONTACT, CONTENT_BN, PAYMENT_URL, type SiteContent } from '../content';
import { faqJsonLd, jsonLdScript, pageMetadata, softwareApplicationJsonLd } from '../seo';

/**
 * Pricing, read from the server that enforces it.
 *
 * The numbers on this page come from `GET /v1/entitlements/plans`, which reads
 * the same `Plan` and `PlanFeature` rows the API checks a request against. A
 * hardcoded table would be a second source of truth for the one page where
 * being wrong is a broken promise — and it would go stale the first time an
 * operator edits a limit in the admin panel, which is the whole reason the
 * catalogue is data.
 *
 * `FALLBACK` exists for the case where the API is unreachable at build or
 * request time. It is the shipped default from `@hishab/core`, so it is wrong
 * only if somebody has edited the catalogue *and* the API is down — and a
 * pricing page that renders slightly stale numbers beats one that 500s.
 */

export const metadata = pageMetadata({
  title: 'দাম ও প্যাকেজ — Taka Tracker | Pricing',
  description:
    'ফ্রি প্যাকেজ আজীবন ফ্রি — দুটি অ্যাকাউন্ট, সীমাহীন লেনদেন, সীমাহীন দেনা-পাওনা। প্রিমিয়াম মাসে ৳৩৫০ বা বছরে ৳৩৬০০, সব সীমাহীন। Free forever plan, or ৳350/month (৳3600/year) for everything unlimited.',
  path: '/pricing',
  locale: 'bn',
  alternatePath: '/en/pricing',
  keywords: [
    'personal finance app price bangladesh',
    'free expense tracker bangladesh',
    'হিসাব অ্যাপের দাম',
    'ফ্রি বাজেট অ্যাপ',
  ],
});

/* Revalidated rather than static: an operator can change a price in the admin
   panel without a deployment, and an hour is short enough that the page is
   never meaningfully wrong while still costing one request an hour. */
export const revalidate = 3600;

interface PlanFeature {
  key: string;
  label: string;
  limitValue: number | null;
}

interface PlanView {
  code: string;
  name: string;
  priceMinor: number;
  /** Null when the plan is sold monthly only. */
  priceYearlyMinor: number | null;
  interval: 'MONTHLY' | 'YEARLY';
  features: PlanFeature[];
}

const FALLBACK: PlanView[] = [
  {
    code: 'FREE',
    name: 'ফ্রি',
    priceMinor: 0,
    priceYearlyMinor: null,
    interval: 'MONTHLY',
    features: [
      { key: 'accounts.max', label: 'অ্যাকাউন্ট', limitValue: 2 },
      { key: 'transactions.monthly.max', label: 'মাসিক লেনদেন', limitValue: null },
      { key: 'attachments.storage.mb', label: 'সংযুক্তি স্টোরেজ', limitValue: 0 },
      { key: 'export.enabled', label: 'এক্সপোর্ট', limitValue: 0 },
    ],
  },
  {
    code: 'PREMIUM',
    name: 'প্রিমিয়াম',
    priceMinor: 35_000,
    priceYearlyMinor: 360_000,
    interval: 'MONTHLY',
    features: [
      { key: 'accounts.max', label: 'অ্যাকাউন্ট', limitValue: null },
      { key: 'transactions.monthly.max', label: 'মাসিক লেনদেন', limitValue: null },
      { key: 'attachments.storage.mb', label: 'সংযুক্তি স্টোরেজ', limitValue: null },
      { key: 'export.enabled', label: 'এক্সপোর্ট', limitValue: 1 },
    ],
  },
];

async function fetchPlans(): Promise<PlanView[]> {
  const base = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:4000';
  try {
    const res = await fetch(`${base}/v1/entitlements/plans`, { next: { revalidate } });
    if (!res.ok) return FALLBACK;
    const body = (await res.json()) as PlanView[];
    return Array.isArray(body) && body.length > 0 ? body : FALLBACK;
  } catch {
    return FALLBACK;
  }
}

/**
 * Features whose ceiling is worth printing, in the order somebody compares
 * them. Anything the catalogue carries that is not listed here is machinery,
 * not a selling point — printing all twelve rows would bury the four that
 * decide the purchase.
 */
interface Copy {
  heading: string;
  blurb: string;
  alwaysHeading: string;
  always: string[];
  compared: { key: string; label: string; note?: string }[];
  unlimited: string;
  off: string;
  soon: string;
  perMonth: string;
  orYearly: string;
  freeName: string;
  freeNote: string;
  freeCta: string;
  premiumCta: string;
  premiumBadge: string;
  premiumNote: string;
  payNow: string;
  helpLabel: string;
  sideBySide: string;
  tableWhat: string;
  tableCaption: string;
  megabytes: string;
  bengaliNumerals: boolean;
}

const COMPARED: { key: string; label: string; note?: string }[] = [
  { key: 'accounts.max', label: 'অ্যাকাউন্ট (ব্যাংক, বিকাশ, নগদ, কার্ড)' },
  { key: 'transactions.monthly.max', label: 'লেনদেন' },
  { key: 'attachments.storage.mb', label: 'রসিদের ছবি', note: 'মেগাবাইট' },
  { key: 'export.enabled', label: 'CSV এক্সপোর্ট ও ব্যাকআপ' },
  { key: 'email.connections.max', label: 'মেইলবক্স যুক্ত করা' },
  { key: 'ingest.messages.monthly.max', label: 'মাসিক বার্তা (টেলিগ্রাম, এসএমএস)' },
  { key: 'members.max', label: 'সদস্য' },
  { key: 'ai.reports.enabled', label: 'AI পর্যালোচনা', note: 'আসছে' },
];

const COPY: Record<'bn' | 'en', Copy> = {
  bn: {
    heading: 'দাম',
    blurb:
      'দুটি প্যাকেজ, লুকানো কিছু নেই। ফ্রিটা সত্যিই ফ্রি — ট্রায়াল নয়, শেষে কার্ড চাওয়া হবে না।',
    alwaysHeading: 'দুই প্যাকেজেই আছে',
    always: [
      'ডাবল-এন্ট্রি খাতা ও স্থিতিপত্র',
      'সীমাহীন দেনাদার-পাওনাদার ও ঋণের হিসাব',
      'ডিপিএস, সঞ্চয় ও বীমা',
      'ক্যাটাগরি, সাব-ক্যাটাগরি ও ট্যাগ',
      'রিপোর্ট, খোঁজ ও কার্যবিবরণী',
      'অফলাইনে কাজ করা ও ফোনে ইনস্টল',
    ],
    compared: COMPARED,
    unlimited: 'সীমাহীন',
    off: 'নেই',
    soon: 'আসছে',
    perMonth: ' / মাস',
    orYearly: 'অথবা বছরে',
    freeName: 'ফ্রি',
    freeNote: 'আজীবন ফ্রি। কার্ড লাগবে না।',
    freeCta: 'ফ্রি শুরু করুন',
    premiumCta: 'ফ্রি দিয়ে শুরু করুন',
    premiumBadge: 'সব সীমাহীন',
    premiumNote:
      'পেমেন্টের পর আমরা আপনার অ্যাকাউন্টে প্রিমিয়াম চালু করে দেব — ইনভয়েসটি কে দিয়েছেন সেটি স্বয়ংক্রিয়ভাবে মিলিয়ে নেওয়ার ব্যবস্থা এখনো হয়নি, তাই কাজটি হাতে হয়।',
    payNow: 'বিকাশ / কার্ডে পেমেন্ট করুন',
    helpLabel: 'সাহায্য দরকার?',
    sideBySide: 'পাশাপাশি',
    tableWhat: 'কী',
    tableCaption: 'প্যাকেজ অনুযায়ী সীমা',
    megabytes: 'মেগাবাইট',
    bengaliNumerals: true,
  },
  en: {
    heading: 'Pricing',
    blurb:
      'Two plans, nothing hidden. The free one is genuinely free — not a trial, and no card at the end.',
    alwaysHeading: 'On both plans',
    always: [
      'Double-entry ledger and balance sheet',
      'Unlimited debtors, creditors and loans',
      'DPS, savings and insurance',
      'Categories, sub-categories and tags',
      'Reports, search and an audit trail',
      'Works offline, installs to your phone',
    ],
    compared: [
      { key: 'accounts.max', label: 'Accounts (bank, wallet, cash, card)' },
      { key: 'transactions.monthly.max', label: 'Transactions' },
      { key: 'attachments.storage.mb', label: 'Receipt photos', note: 'MB' },
      { key: 'export.enabled', label: 'CSV export and backup' },
      { key: 'email.connections.max', label: 'Connected mailboxes' },
      { key: 'ingest.messages.monthly.max', label: 'Messages a month (Telegram, SMS)' },
      { key: 'members.max', label: 'Members' },
      { key: 'ai.reports.enabled', label: 'AI review', note: 'soon' },
    ],
    unlimited: 'Unlimited',
    off: 'No',
    soon: 'Coming',
    perMonth: ' / month',
    orYearly: 'or yearly',
    freeName: 'Free',
    freeNote: 'Free for good. No card required.',
    freeCta: 'Start free',
    premiumCta: 'Start on the free plan',
    premiumBadge: 'Everything unlimited',
    premiumNote:
      'After paying we switch premium on for your account — matching an invoice to an account automatically is not built yet, so it is done by hand.',
    payNow: 'Pay by bKash or card',
    helpLabel: 'Need help?',
    sideBySide: 'Side by side',
    tableWhat: 'What',
    tableCaption: 'Limits by plan',
    megabytes: 'MB',
    bengaliNumerals: false,
  },
};

export default async function PricingPage() {
  return <Pricing content={CONTENT_BN} locale="bn" />;
}

export async function Pricing({ content, locale }: { content: SiteContent; locale: 'bn' | 'en' }) {
  const t = locale === 'en' ? COPY.en : COPY.bn;
  const plans = await fetchPlans();
  const premium = plans.find((p) => p.code !== 'FREE') ?? plans[plans.length - 1]!;

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: jsonLdScript(softwareApplicationJsonLd(premium.priceMinor)),
        }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLdScript(faqJsonLd()) }}
      />

      <section className="border-rule border-b">
        <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6 sm:py-16">
          <h1 className="text-ink text-3xl font-semibold sm:text-4xl">{t.heading}</h1>
          <p className="text-ink-muted mt-3 max-w-2xl">{t.blurb}</p>
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6">
        <div className="grid gap-4 lg:grid-cols-2">
          {plans.map((plan) => (
            <PlanCard
              key={plan.code}
              plan={plan}
              highlight={plan.code === premium.code}
              t={t}
              locale={locale}
            />
          ))}
        </div>

        <div className="rounded-card border-rule bg-brand-tint mt-6 border p-5">
          <h2 className="text-ink text-sm font-medium">{t.alwaysHeading}</h2>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {t.always.map((line) => (
              <li key={line} className="text-ink-muted flex items-start gap-2 text-sm">
                <Check className="text-brand mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                {line}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <ComparisonTable plans={plans} t={t} />

      <section className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6">
        <h2 className="text-ink text-2xl font-semibold">{content.ui.faqHeading}</h2>
        <div className="mt-6 space-y-3">
          {content.faq.map((item) => (
            <details key={item.q} className="rounded-card border-rule bg-surface border p-4">
              <summary className="text-ink press cursor-pointer text-sm font-medium">
                {item.q}
              </summary>
              <p className="text-ink-muted mt-3 text-sm">{item.a}</p>
            </details>
          ))}
        </div>
      </section>
    </>
  );
}

function PlanCard({
  plan,
  highlight,
  t,
  locale,
}: {
  plan: PlanView;
  highlight: boolean;
  t: Copy;
  locale: 'bn' | 'en';
}) {
  const free = plan.priceMinor === 0;
  const money = (minor: number) =>
    formatMinor(minor, { symbol: false, decimals: false, bengaliNumerals: t.bengaliNumerals });

  return (
    <div
      className={`rounded-card bg-surface border p-6 ${
        highlight ? 'border-brand shadow-sm' : 'border-rule'
      }`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-ink text-xl font-semibold">{free ? t.freeName : plan.name}</h2>
        {highlight ? (
          <span className="bg-brand-tint text-brand rounded-full px-2 py-0.5 text-xs font-medium">
            {t.premiumBadge}
          </span>
        ) : null}
      </div>

      <p className="text-ink mt-4 text-3xl font-semibold">
        {free ? t.freeName : `৳${money(plan.priceMinor)}`}
        {!free ? <span className="text-ink-muted text-base font-normal">{t.perMonth}</span> : null}
      </p>
      {free ? (
        <p className="text-ink-muted mt-1 text-sm">{t.freeNote}</p>
      ) : plan.priceYearlyMinor != null ? (
        <p className="text-ink-muted mt-1 text-sm">
          {t.orYearly}{' '}
          <strong className="text-ink font-medium">৳{money(plan.priceYearlyMinor)}</strong>
          {/* The saving is computed from the two prices, not written down: edit
              either in the admin panel and this sentence follows. */}
          {savingLine(plan, t, locale)}
        </p>
      ) : null}

      <ul className="mt-5 space-y-2">
        {t.compared.map((row) => {
          const value = plan.features.find((f) => f.key === row.key);
          const on = value ? value.limitValue === null || value.limitValue > 0 : false;
          return (
            <li key={row.key} className="flex items-start gap-2 text-sm">
              {on ? (
                <Check className="text-brand mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              ) : (
                <Minus className="text-ink-muted mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              )}
              <span className={on ? 'text-ink' : 'text-ink-muted'}>
                {row.label}
                {': '}
                <strong className="font-medium">{describe(value, t, row.note)}</strong>
              </span>
            </li>
          );
        })}
      </ul>

      <Link
        href="/signup"
        className={`press mt-6 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-md px-6 text-base font-medium ${
          highlight
            ? 'bg-brand text-brand-contrast hover:opacity-90'
            : 'border-rule bg-surface text-ink hover:bg-brand-tint border'
        }`}
      >
        {free ? t.freeCta : t.premiumCta}
        <ArrowRight className="h-4 w-4" aria-hidden />
      </Link>
      {highlight ? (
        <>
          {/* The invoice is hosted by SSLCommerz, so no card detail ever
              reaches this application and there is no PCI surface here to get
              wrong. What the link cannot do is tell us who paid — so the note
              says premium is switched on by hand rather than implying the plan
              flips itself the moment the payment clears. */}
          <a
            href={PAYMENT_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="press border-brand text-brand hover:bg-brand-tint mt-3 inline-flex min-h-12 w-full items-center justify-center rounded-md border text-sm font-medium"
          >
            {t.payNow}
          </a>
          <p className="text-ink-muted mt-2 text-center text-xs">{t.premiumNote}</p>
          <p className="text-ink-muted mt-1 text-center text-xs">
            {t.helpLabel}{' '}
            <a href={CONTACT.hotlineHref} className="text-brand underline">
              {CONTACT.hotline}
            </a>
          </p>
        </>
      ) : null}
    </div>
  );
}

/** " — ৳600 saved", or nothing when the yearly price is not a saving. */
function savingLine(plan: PlanView, t: Copy, locale: 'bn' | 'en'): string {
  const yearly = plan.priceYearlyMinor ?? 0;
  const twelve = plan.priceMinor * 12;
  if (plan.priceMinor <= 0 || yearly <= 0 || yearly >= twelve) return '';
  const saved = formatMinor(twelve - yearly, {
    symbol: false,
    decimals: false,
    bengaliNumerals: t.bengaliNumerals,
  });
  return locale === 'en' ? ` — ৳${saved} saved` : ` — ৳${saved} সাশ্রয়`;
}

/** `null` is unlimited, `0` is off, a number is a ceiling. Never a blank cell. */
function describe(feature: PlanFeature | undefined, t: Copy, note?: string): string {
  if (!feature) return '—';
  if (feature.limitValue === null) return t.unlimited;
  if (feature.limitValue === 0) return note === 'আসছে' || note === 'soon' ? t.soon : t.off;
  const n = formatMinor(feature.limitValue * 100, {
    symbol: false,
    decimals: false,
    bengaliNumerals: t.bengaliNumerals,
  });
  return note && note !== 'আসছে' && note !== 'soon' ? `${n} ${t.megabytes}` : n;
}

function ComparisonTable({ plans, t }: { plans: PlanView[]; t: Copy }) {
  return (
    <section className="border-rule border-y">
      <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6">
        <h2 className="text-ink text-2xl font-semibold">{t.sideBySide}</h2>
        {/* The table scrolls inside its own box rather than pushing the page
            sideways — a landing page that scrolls horizontally on a 320px
            phone is the fastest way to lose the visitor and the ranking. */}
        <div className="mt-6 overflow-x-auto">
          <table className="w-full min-w-[32rem] border-collapse text-sm">
            <caption className="sr-only">{t.tableCaption}</caption>
            <thead>
              <tr className="border-rule border-b">
                <th scope="col" className="text-ink-muted py-3 pr-4 text-left font-medium">
                  {t.tableWhat}
                </th>
                {plans.map((plan) => (
                  <th
                    key={plan.code}
                    scope="col"
                    className="text-ink px-4 py-3 text-left font-medium"
                  >
                    {plan.priceMinor === 0 ? t.freeName : plan.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {t.compared.map((row) => (
                <tr key={row.key} className="border-rule border-b last:border-b-0">
                  <th scope="row" className="text-ink py-3 pr-4 text-left font-normal">
                    {row.label}
                  </th>
                  {plans.map((plan) => (
                    <td key={plan.code} className="text-ink-muted px-4 py-3">
                      {describe(
                        plan.features.find((f) => f.key === row.key),
                        t,
                        row.note,
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
