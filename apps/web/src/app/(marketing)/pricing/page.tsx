import { ArrowRight, Check, Minus } from 'lucide-react';
import Link from 'next/link';
import { allocateMinor, formatMinor } from '@hishab/shared';
import { FAQ } from '../content';
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
  title: 'দাম ও প্যাকেজ — হিসাব | Pricing',
  description:
    'ফ্রি প্যাকেজ আজীবন ফ্রি — দুটি অ্যাকাউন্ট, সীমাহীন লেনদেন, সীমাহীন দেনা-পাওনা। প্রিমিয়াম বছরে ৳১২০০, সব সীমাহীন। Free forever plan and a ৳1200/year premium plan.',
  path: '/pricing',
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
  interval: 'MONTHLY' | 'YEARLY';
  features: PlanFeature[];
}

const FALLBACK: PlanView[] = [
  {
    code: 'FREE',
    name: 'ফ্রি',
    priceMinor: 0,
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
    priceMinor: 120_000,
    interval: 'YEARLY',
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

/** ৳১,২০০ — a price is read, not reconciled, so no decimals and no symbol here. */
const takaFrom = (minor: number): string =>
  formatMinor(minor, { symbol: false, decimals: false, bengaliNumerals: true });

/**
 * Features whose ceiling is worth printing, in the order somebody compares
 * them. Anything the catalogue carries that is not listed here is machinery,
 * not a selling point — printing all twelve rows would bury the four that
 * decide the purchase.
 */
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

/** Everything, on every plan, whatever the tier says. */
const ALWAYS: string[] = [
  'ডাবল-এন্ট্রি খাতা ও স্থিতিপত্র',
  'সীমাহীন দেনাদার-পাওনাদার ও ঋণের হিসাব',
  'ডিপিএস, সঞ্চয় ও বীমা',
  'ক্যাটাগরি, সাব-ক্যাটাগরি ও ট্যাগ',
  'রিপোর্ট, খোঁজ ও কার্যবিবরণী',
  'অফলাইনে কাজ করা ও ফোনে ইনস্টল',
];

export default async function PricingPage() {
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
          <h1 className="text-ink text-3xl font-semibold sm:text-4xl">দাম</h1>
          <p className="text-ink-muted mt-3 max-w-2xl">
            দুটি প্যাকেজ, লুকানো কিছু নেই। ফ্রিটা সত্যিই ফ্রি — ট্রায়াল নয়, শেষে কার্ড চাওয়া হবে
            না।
          </p>
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6">
        <div className="grid gap-4 lg:grid-cols-2">
          {plans.map((plan) => (
            <PlanCard key={plan.code} plan={plan} highlight={plan.code === premium.code} />
          ))}
        </div>

        <div className="rounded-card border-rule bg-greenbar mt-6 border p-5">
          <h2 className="text-ink text-sm font-medium">দুই প্যাকেজেই আছে</h2>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {ALWAYS.map((line) => (
              <li key={line} className="text-ink-muted flex items-start gap-2 text-sm">
                <Check className="text-income mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                {line}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <ComparisonTable plans={plans} />

      <section className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6">
        <h2 className="text-ink text-2xl font-semibold">প্রশ্ন</h2>
        <div className="mt-6 space-y-3">
          {FAQ.map((item) => (
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

function PlanCard({ plan, highlight }: { plan: PlanView; highlight: boolean }) {
  const free = plan.priceMinor === 0;
  return (
    <div
      className={`rounded-card bg-surface border p-6 ${
        highlight ? 'border-income shadow-sm' : 'border-rule'
      }`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-ink text-xl font-semibold">{plan.name}</h2>
        {highlight ? (
          <span className="bg-greenbar text-income rounded-full px-2 py-0.5 text-xs font-medium">
            সব সীমাহীন
          </span>
        ) : null}
      </div>

      <p className="text-ink mt-4 text-3xl font-semibold">
        {free ? 'ফ্রি' : `৳${takaFrom(plan.priceMinor)}`}
        {!free ? (
          <span className="text-ink-muted text-base font-normal">
            {plan.interval === 'YEARLY' ? ' / বছর' : ' / মাস'}
          </span>
        ) : null}
      </p>
      <p className="text-ink-muted mt-1 text-sm">
        {free
          ? 'আজীবন ফ্রি। কার্ড লাগবে না।'
          : /* `allocateMinor` rather than a divide: it splits integer poisha
               into twelve whole shares and distributes the remainder, so the
               figure quoted is one twelfth of what is actually charged. */
            `মাসে প্রায় ৳${formatMinor(allocateMinor(plan.priceMinor, 12)[0] ?? 0, {
              symbol: false,
              decimals: false,
              bengaliNumerals: true,
            })} — বছরে একবার।`}
      </p>

      <ul className="mt-5 space-y-2">
        {COMPARED.map((row) => {
          const value = plan.features.find((f) => f.key === row.key);
          const on = value ? value.limitValue === null || value.limitValue > 0 : false;
          return (
            <li key={row.key} className="flex items-start gap-2 text-sm">
              {on ? (
                <Check className="text-income mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              ) : (
                <Minus className="text-ink-muted mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              )}
              <span className={on ? 'text-ink' : 'text-ink-muted'}>
                {row.label}
                {': '}
                <strong className="font-medium">{describe(value, row.note)}</strong>
              </span>
            </li>
          );
        })}
      </ul>

      <Link
        href="/signup"
        className={`press mt-6 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-md px-6 text-base font-medium ${
          highlight
            ? 'bg-income text-white hover:opacity-90'
            : 'border-rule bg-surface text-ink hover:bg-greenbar border'
        }`}
      >
        {free ? 'ফ্রি শুরু করুন' : 'ফ্রি দিয়ে শুরু করুন'}
        <ArrowRight className="h-4 w-4" aria-hidden />
      </Link>
      {highlight ? (
        <p className="text-ink-muted mt-2 text-center text-xs">
          সবাই ফ্রি দিয়েই শুরু করেন। প্রিমিয়ামে যেতে চাইলে অ্যাপ থেকে যোগাযোগ করুন — অনলাইন
          পেমেন্ট এখনো চালু হয়নি।
        </p>
      ) : null}
    </div>
  );
}

/** `null` is unlimited, `0` is off, a number is a ceiling. Never a blank cell. */
function describe(feature: PlanFeature | undefined, note?: string): string {
  if (!feature) return '—';
  if (feature.limitValue === null) return 'সীমাহীন';
  if (feature.limitValue === 0) return note === 'আসছে' ? 'আসছে' : 'নেই';
  const n = formatMinor(feature.limitValue * 100, {
    symbol: false,
    decimals: false,
    bengaliNumerals: true,
  });
  return note && note !== 'আসছে' ? `${n} ${note}` : n;
}

function ComparisonTable({ plans }: { plans: PlanView[] }) {
  return (
    <section className="border-rule border-y">
      <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6">
        <h2 className="text-ink text-2xl font-semibold">পাশাপাশি</h2>
        {/* The table scrolls inside its own box rather than pushing the page
            sideways — a landing page that scrolls horizontally on a 320px
            phone is the fastest way to lose the visitor and the ranking. */}
        <div className="mt-6 overflow-x-auto">
          <table className="w-full min-w-[32rem] border-collapse text-sm">
            <caption className="sr-only">প্যাকেজ অনুযায়ী সীমা</caption>
            <thead>
              <tr className="border-rule border-b">
                <th scope="col" className="text-ink-muted py-3 pr-4 text-left font-medium">
                  কী
                </th>
                {plans.map((plan) => (
                  <th
                    key={plan.code}
                    scope="col"
                    className="text-ink px-4 py-3 text-left font-medium"
                  >
                    {plan.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {COMPARED.map((row) => (
                <tr key={row.key} className="border-rule border-b last:border-b-0">
                  <th scope="row" className="text-ink py-3 pr-4 text-left font-normal">
                    {row.label}
                  </th>
                  {plans.map((plan) => (
                    <td key={plan.code} className="text-ink-muted px-4 py-3">
                      {describe(
                        plan.features.find((f) => f.key === row.key),
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
