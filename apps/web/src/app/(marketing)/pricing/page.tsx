import { Check, ChevronDown, Minus } from '@/components/icons';
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

/**
 * Rendered per request, not prerendered.
 *
 * This page's entire content is the plan catalogue, and the catalogue is a
 * table an operator edits in the admin panel. It was `revalidate = 3600`, which
 * sounds harmless and is not: the static prerender happens during the build,
 * the build runs *before* the new API is listening, so every deploy baked the
 * `FALLBACK` list below into the live page — and served it for an hour. The
 * fallback has two plans; the catalogue has three. প্রো shipped, was priced, and
 * was invisible on the page that sells it.
 *
 * A render per view is the right price for that: the API is on localhost, the
 * page is small, and a pricing page that is quietly a deploy-old is worse than
 * one that costs a request. `FALLBACK` stays for the case it was written for —
 * the API being down when somebody actually asks.
 */
export const dynamic = 'force-dynamic';

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
    /* A minute of cache, not an hour: long enough that a burst of visitors is
       one request, short enough that an operator who just changed a price sees
       it. The page itself is dynamic — see the note at the top — so this is the
       only thing deciding how stale a figure can be. */
    const res = await fetch(`${base}/v1/entitlements/plans`, { next: { revalidate: 60 } });
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
    /* `{plan}` is filled in per card — the note used to say “প্রিমিয়াম” on
       every tier, which on the প্রো card promised the wrong package. */
    premiumNote:
      'পেমেন্টের সময় প্যাকেজের নাম লিখে দিন। পেমেন্টের পর আমরা আপনার অ্যাকাউন্টে {plan} চালু করে দেব — ইনভয়েসটি কে দিয়েছেন সেটি স্বয়ংক্রিয়ভাবে মিলিয়ে নেওয়ার ব্যবস্থা এখনো হয়নি, তাই কাজটি হাতে হয়।',
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
      'Write the plan name on the invoice. After paying we switch {plan} on for your account — matching an invoice to an account automatically is not built yet, so it is done by hand.',
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

      <section className="mx-auto w-full max-w-6xl px-4 pt-14 sm:px-6 sm:pt-20">
        <h1 className="text-ink text-[44px] font-extrabold leading-[1.1] tracking-[-0.015em] sm:text-[60px]">
          {t.heading}
        </h1>
        <span aria-hidden className="bg-gold mt-6 block h-[9px] w-24 rounded-full" />
        <p className="text-ink-muted mt-6 max-w-[38em] text-lg leading-[1.75] sm:text-xl">
          {t.blurb}
        </p>
      </section>

      <section className="mx-auto w-full max-w-6xl px-4 pt-12 sm:px-6">
        {/* One column per plan on a wide screen, rather than a fixed two.
            With three plans the fixed grid dropped প্রো onto a second row on
            its own, beside an empty half — which reads as an afterthought
            rather than as the top tier it is. Below `lg` they stack, which is
            the only honest way to compare three feature lists on a phone. */}
        <div
          className={`grid gap-6 ${
            plans.length >= 3 ? 'md:grid-cols-2 lg:grid-cols-3' : 'lg:grid-cols-2'
          }`}
        >
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

        <div className="bg-greenbar mt-8 rounded-[28px] p-6 sm:p-8">
          <h2 className="text-ink text-xl font-extrabold">{t.alwaysHeading}</h2>
          <ul className="mt-4 grid gap-x-8 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
            {t.always.map((line) => (
              <li key={line} className="text-ink flex items-start gap-3 text-base">
                <span className="bg-brand text-brand-contrast mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full">
                  <Check className="h-4 w-4" strokeWidth={2.4} aria-hidden />
                </span>
                {line}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <ComparisonTable plans={plans} t={t} />

      <section className="mx-auto w-full max-w-6xl px-4 pt-24 sm:px-6">
        <h2 className="text-ink text-[32px] font-extrabold leading-[1.15] sm:text-[40px]">
          {content.ui.faqHeading}
        </h2>
        <span aria-hidden className="bg-gold mt-5 block h-[7px] w-[72px] rounded-full" />
        <div className="mt-7 max-w-[860px]">
          {content.faq.map((item) => (
            <details key={item.q} className="border-rule group border-t">
              <summary className="press text-ink flex min-h-16 cursor-pointer list-none items-center justify-between gap-4 py-4 text-lg font-bold marker:hidden">
                {item.q}
                <span
                  aria-hidden
                  className="bg-greenbar text-ink group-open:bg-brand group-open:text-brand-contrast flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-transform duration-200 group-open:rotate-180"
                >
                  <ChevronDown className="h-5 w-5" />
                </span>
              </summary>
              <p className="text-ink-muted tt-answer pb-6 text-[17px] leading-[1.75]">{item.a}</p>
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
    /* The suggested plan wears the mark's frame: a white tile inside the green
       square. The others are the tile alone. */
    <div
      className={
        highlight
          ? 'rounded-[32px] bg-[#1F6F4A] p-2.5 sm:p-3'
          : 'border-rule bg-surface rounded-[32px] border-[1.5px]'
      }
    >
      <div className="bg-surface flex h-full flex-col rounded-[24px] p-6 sm:p-7">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-ink text-[26px] font-extrabold">{free ? t.freeName : plan.name}</h2>
          {highlight ? (
            <span className="bg-gold/15 text-brass rounded-full px-3.5 py-1 text-sm font-bold">
              {t.premiumBadge}
            </span>
          ) : null}
        </div>

        <p className="text-ink mt-5 text-[48px] font-extrabold tabular-nums leading-none">
          `৳${money(plan.priceMinor)}`
          {!free ? (
            <span className="text-ink-muted ml-1 text-lg font-medium">{t.perMonth}</span>
          ) : null}
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

        <ul className="mb-7 mt-6">
          {t.compared.map((row) => {
            const value = plan.features.find((f) => f.key === row.key);
            const on = value ? value.limitValue === null || value.limitValue > 0 : false;
            return (
              <li
                key={row.key}
                className="border-rule flex items-start gap-2.5 border-t py-3 text-[15px]"
              >
                {on ? (
                  <Check className="text-brand mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                ) : (
                  <Minus className="text-ink-muted mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                )}
                <span className={on ? 'text-ink' : 'text-ink-muted'}>
                  {row.label}
                  {': '}
                  <strong className="font-bold">{describe(value, t, row.note)}</strong>
                </span>
              </li>
            );
          })}
        </ul>

        <Link
          href="/signup"
          className="press border-ink text-ink hover:bg-greenbar mt-auto inline-flex min-h-14 w-full items-center justify-center rounded-2xl border-2 px-6 text-lg font-bold"
        >
          {free ? t.freeCta : t.premiumCta}
        </Link>
        {/* Every paid tier, not only the recommended one. প্রো had a price, a
          feature list and no way to buy it — a reader who wanted the top tier
          had to guess that the button on the card beside it would somehow do.
          `highlight` marks which plan is suggested; it was never meant to mark
          which one takes money. */}
        {!free ? (
          <>
            {/* The invoice is hosted by SSLCommerz, so no card detail ever
              reaches this application and there is no PCI surface here to get
              wrong. What the link cannot do is tell us who paid — so the note
              says the plan is switched on by hand rather than implying it flips
              itself the moment the payment clears. */}
            <a
              href={PAYMENT_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="press bg-brand text-brand-contrast hover:bg-brand-soft mt-3 inline-flex min-h-14 w-full items-center justify-center rounded-2xl text-lg font-bold shadow-[0_4px_0_var(--hishab-brand-strong)]"
            >
              {t.payNow}
            </a>
            <p className="text-ink-muted mt-3 text-center text-[13px] leading-relaxed">
              {t.premiumNote.replace('{plan}', plan.name)}
            </p>
            <p className="text-ink-muted mt-1 text-center text-[13px]">
              {t.helpLabel}{' '}
              <a href={CONTACT.hotlineHref} className="text-brand underline">
                {CONTACT.hotline}
              </a>
            </p>
          </>
        ) : null}
      </div>
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
    <section>
      <div className="mx-auto w-full max-w-6xl px-4 pt-24 sm:px-6">
        <h2 className="text-ink text-[32px] font-extrabold leading-[1.15] sm:text-[40px]">
          {t.sideBySide}
        </h2>
        <span aria-hidden className="bg-gold mt-5 block h-[7px] w-[72px] rounded-full" />
        {/* The table scrolls inside its own box rather than pushing the page
            sideways — a landing page that scrolls horizontally on a 320px
            phone is the fastest way to lose the visitor and the ranking. */}
        <div className="border-rule bg-surface mt-8 overflow-x-auto rounded-[24px] border-[1.5px]">
          <table className="w-full min-w-[32rem] border-collapse text-[15px]">
            <caption className="sr-only">{t.tableCaption}</caption>
            <thead>
              <tr className="border-rule bg-greenbar border-b">
                <th scope="col" className="text-ink-muted px-5 py-3.5 text-left font-bold">
                  {t.tableWhat}
                </th>
                {plans.map((plan) => (
                  <th
                    key={plan.code}
                    scope="col"
                    className="text-ink px-5 py-3.5 text-left font-extrabold"
                  >
                    {plan.priceMinor === 0 ? t.freeName : plan.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {t.compared.map((row) => (
                <tr key={row.key} className="border-rule border-b last:border-b-0">
                  <th scope="row" className="text-ink px-5 py-3.5 text-left font-medium">
                    {row.label}
                  </th>
                  {plans.map((plan) => (
                    <td key={plan.code} className="text-ink px-5 py-3.5 font-semibold">
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
