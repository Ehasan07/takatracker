import { ArrowRight, Check } from 'lucide-react';
import Link from 'next/link';
import { COMING, FAQ, GROUPS, HERO, PROOF, STEPS } from '../content';
import { faqJsonLd, jsonLdScript, pageMetadata, softwareApplicationJsonLd } from '../seo';

/**
 * The landing page.
 *
 * Served at `/` by the middleware rewrite for anybody without a session, and
 * at `/home` directly; both canonicalise to `/`. A signed-in visitor at `/`
 * gets their dashboard instead, which is what they came for.
 *
 * Shape borrowed from the reference sites the owner sent — hero, three steps,
 * feature grid, proof, FAQ, closing CTA — because that order matches the order
 * a person makes the decision in. What is *not* borrowed is their social
 * proof: BudgetBakers leads with 14M downloads and MoneyLover with 100K
 * five-star reviews, and this product launched this month. Inventing either
 * would be the one mistake a finance app cannot recover from, so the proof
 * strip carries engineering guarantees instead — which are checkable, and are
 * the actual reason to choose this over a spreadsheet.
 */

export const metadata = pageMetadata({
  title: 'হিসাব — বাংলাদেশের ব্যক্তিগত হিসাবের সফটওয়্যার | Personal Finance App',
  description:
    'আয়, খরচ, ধার-দেনা, ডিপিএস ও বীমার হিসাব এক জায়গায় — সম্পূর্ণ বাংলায়। ডাবল-এন্ট্রি হিসাবরক্ষণের উপর তৈরি, অফলাইনেও চলে। ফ্রি প্যাকেজ আজীবন ফ্রি। A free double-entry personal finance app for Bangladesh, on web and mobile.',
  path: '/',
  keywords: [
    'personal finance app',
    'personal finance app bangladesh',
    'expense tracker bangladesh',
    'money manager app',
    'budget app bangla',
    'double entry personal accounting',
    'loan tracker app',
    'dps tracker',
    'হিসাব রাখার অ্যাপ',
    'খরচের হিসাব',
    'দেনা পাওনা হিসাব',
    'বাজেট অ্যাপ',
    'টাকা ট্র্যাকার',
  ],
});

export default function LandingPage() {
  return (
    <>
      <script
        type="application/ld+json"
        // Static, server-rendered, and escaped in `jsonLdScript`.
        dangerouslySetInnerHTML={{ __html: jsonLdScript(softwareApplicationJsonLd(120_000)) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLdScript(faqJsonLd()) }}
      />

      <Hero />
      <ProofStrip />
      <Steps />
      <Features />
      <LedgerNote />
      <Coming />
      <Faq />
      <ClosingCta />
    </>
  );
}

function Hero() {
  return (
    <section className="border-rule border-b">
      <div className="mx-auto w-full max-w-6xl px-4 py-14 sm:px-6 sm:py-20">
        <p className="text-income text-xs font-medium sm:text-sm">{HERO.eyebrow}</p>
        {/* The only `<h1>` on the page, and it carries the product's claim
            rather than its name — a crawler and a first-time reader both need
            the sentence, not the brand. */}
        <h1 className="text-ink mt-3 max-w-3xl text-3xl font-semibold leading-tight sm:text-4xl md:text-5xl">
          {HERO.title}
        </h1>
        <p className="text-ink-muted mt-4 max-w-2xl text-base sm:text-lg">{HERO.subtitle}</p>
        <p className="text-ink-muted mt-2 max-w-2xl text-sm">{HERO.subtitleEn}</p>

        <div className="mt-7 flex flex-wrap items-center gap-3">
          <Link
            href="/signup"
            className="press bg-income inline-flex min-h-12 items-center gap-2 rounded-md px-6 text-base font-medium text-white hover:opacity-90"
          >
            {HERO.primaryCta}
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
          <Link
            href="/pricing"
            className="press border-rule bg-surface text-ink hover:bg-greenbar inline-flex min-h-12 items-center rounded-md border px-6 text-base font-medium"
          >
            {HERO.secondaryCta}
          </Link>
        </div>
        <p className="text-ink-muted mt-3 text-sm">
          কার্ড লাগবে না · ফ্রি প্যাকেজ আজীবন ফ্রি · যেকোনো সময় সব তথ্য নামিয়ে নিতে পারবেন
        </p>
      </div>
    </section>
  );
}

function ProofStrip() {
  return (
    <section aria-label="কেন বিশ্বাস করবেন" className="border-rule bg-greenbar border-b">
      <div className="mx-auto grid w-full max-w-6xl grid-cols-2 gap-6 px-4 py-8 sm:px-6 lg:grid-cols-4">
        {PROOF.map((item) => (
          <div key={item.value}>
            <p className="text-income text-lg font-semibold sm:text-xl">{item.value}</p>
            <p className="text-ink-muted mt-1 text-xs sm:text-sm">{item.label}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function Steps() {
  return (
    <section className="mx-auto w-full max-w-6xl px-4 py-14 sm:px-6 sm:py-16">
      <h2 className="text-ink text-2xl font-semibold sm:text-3xl">শুরু করতে তিনটি ধাপ</h2>
      <p className="text-ink-muted mt-2 max-w-2xl">
        প্রথম দিনেই পুরো বছরের হিসাব বসাতে হবে না। আজ থেকে লিখতে শুরু করলেই যথেষ্ট।
      </p>
      <ol className="mt-8 grid gap-4 md:grid-cols-3">
        {STEPS.map((step, index) => (
          <li key={step.title} className="rounded-card border-rule bg-surface border p-5">
            <span
              aria-hidden
              className="bg-greenbar text-income flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold"
            >
              {['১', '২', '৩'][index]}
            </span>
            <h3 className="text-ink mt-3 font-medium">{step.title}</h3>
            <p className="text-ink-muted mt-1 text-sm">{step.body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Features() {
  return (
    <section id="features" className="border-rule scroll-mt-16 border-y">
      <div className="mx-auto w-full max-w-6xl px-4 py-14 sm:px-6 sm:py-16">
        <h2 className="text-ink text-2xl font-semibold sm:text-3xl">যা যা আছে</h2>
        <p className="text-ink-muted mt-2 max-w-2xl">
          নিচের প্রতিটি জিনিস আজই ব্যবহার করা যায়। যেগুলো এখনো তৈরি হয়নি সেগুলো{' '}
          <a href="#coming" className="text-income underline">
            আসছে
          </a>{' '}
          অংশে আলাদা করে রাখা।
        </p>

        <div className="mt-10 space-y-12">
          {GROUPS.map((group) => (
            <div key={group.id}>
              <h3 className="text-ink text-lg font-semibold sm:text-xl">
                {group.heading}
                <span className="text-ink-muted ml-2 text-sm font-normal">{group.headingEn}</span>
              </h3>
              <p className="text-ink-muted mt-1 max-w-3xl text-sm">{group.blurb}</p>
              <ul className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {group.features.map((feature) => (
                  <li
                    key={feature.title}
                    className="rounded-card border-rule bg-surface border p-4"
                  >
                    <h4 className="text-ink flex items-start gap-2 text-sm font-medium">
                      <Check className="text-income mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                      <span>
                        {feature.title}
                        <span className="text-ink-muted block text-xs font-normal">
                          {feature.titleEn}
                        </span>
                      </span>
                    </h4>
                    <p className="text-ink-muted mt-2 text-sm">{feature.body}</p>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/**
 * The one paragraph that explains why this is not another expense tracker.
 *
 * It earns its place on a landing page because "double-entry" is the single
 * claim a competitor cannot copy in a sprint, and because a visitor who does
 * not know the term will otherwise read it as jargon and skip the product.
 */
function LedgerNote() {
  return (
    <section className="mx-auto w-full max-w-6xl px-4 py-14 sm:px-6 sm:py-16">
      <div className="rounded-card border-income/30 bg-greenbar border p-6 sm:p-8">
        <h2 className="text-ink text-2xl font-semibold sm:text-3xl">
          কেন এটা আর দশটা খরচের অ্যাপ নয়
        </h2>
        <div className="mt-4 grid gap-6 md:grid-cols-2">
          <div>
            <p className="text-ink-muted text-sm">
              বেশিরভাগ অ্যাপ একটা তালিকা রাখে: তারিখ, টাকা, খাত। তালিকা যোগ করলে যা পাওয়া যায় সেটা
              মোট খরচ — কিন্তু "আমার হাতে এখন কত আছে" বা "নিট সম্পদ কত" এর উত্তর ওখানে নেই, কারণ
              টাকাটা <em>কোথা থেকে</em> এল সেটা লেখা হয়নি।
            </p>
            <p className="text-ink-muted mt-3 text-sm">
              হিসাব প্রতিটি লেনদেনের দুই দিকই লেখে। ৫০০ টাকার বাজার মানে খাবার খাতে ৫০০ ডেবিট আর নগদ
              থেকে ৫০০ ক্রেডিট। দুই দিক সমান না হলে ডাটাবেজ লেখাটাই নেয় না।
            </p>
          </div>
          <div>
            <p className="text-ink text-sm font-medium">এর ফলে যা হয়</p>
            <ul className="mt-2 space-y-2">
              {[
                'প্রতিটি অ্যাকাউন্টের ব্যালেন্স নিজে থেকেই ঠিক থাকে',
                'স্থিতিপত্র বানানো যায় — সম্পদ, দায়, নিট সম্পদ',
                'ধার আয় বা খরচে ঢুকে রিপোর্ট নষ্ট করে না',
                'টাকা কোথাও হারায় না — গেলে কোথায় গেল সেটা লেখা আছে',
              ].map((line) => (
                <li key={line} className="text-ink-muted flex items-start gap-2 text-sm">
                  <Check className="text-income mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  {line}
                </li>
              ))}
            </ul>
            <p className="text-ink-muted mt-3 text-xs">
              QuickBooks আর Zoho Books ব্যবসার জন্য এই নিয়মেই চলে। পার্থক্য হলো, এখানে আপনাকে
              ডেবিট-ক্রেডিট দেখতেই হবে না — পর্দায় শুধু আয়, খরচ আর ট্রান্সফার।
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

function Coming() {
  return (
    <section id="coming" className="border-rule scroll-mt-16 border-y">
      <div className="mx-auto w-full max-w-6xl px-4 py-14 sm:px-6 sm:py-16">
        <h2 className="text-ink text-2xl font-semibold sm:text-3xl">আসছে</h2>
        <p className="text-ink-muted mt-2 max-w-2xl">
          এগুলো এখনো তৈরি হয়নি। এই তালিকা এখানে আছে যাতে সাইন আপ করার সময় আপনি জানেন কোনটা পাচ্ছেন
          আর কোনটা পাচ্ছেন না।
        </p>
        <ul className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {COMING.map((item) => (
            <li key={item.title} className="rounded-card border-rule border border-dashed p-4">
              <h3 className="text-ink text-sm font-medium">{item.title}</h3>
              <p className="text-ink-muted mt-1 text-sm">{item.body}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function Faq() {
  return (
    <section id="faq" className="mx-auto w-full max-w-3xl scroll-mt-16 px-4 py-14 sm:px-6 sm:py-16">
      <h2 className="text-ink text-2xl font-semibold sm:text-3xl">সাধারণ প্রশ্ন</h2>
      <div className="mt-8 space-y-3">
        {FAQ.map((item) => (
          /* `<details>`, not a JavaScript accordion: it opens with the script
             still loading, a crawler reads the answer whether or not it is
             expanded, and browser find-in-page reaches inside it. */
          <details
            key={item.q}
            className="rounded-card border-rule bg-surface group border p-4 open:pb-5"
          >
            <summary className="text-ink press cursor-pointer list-none text-sm font-medium marker:hidden">
              <span className="flex items-start justify-between gap-3">
                {item.q}
                <span aria-hidden className="text-ink-muted shrink-0 group-open:hidden">
                  +
                </span>
                <span aria-hidden className="text-ink-muted hidden shrink-0 group-open:inline">
                  −
                </span>
              </span>
            </summary>
            <p className="text-ink-muted mt-3 text-sm">{item.a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

function ClosingCta() {
  return (
    <section className="border-rule bg-greenbar border-t">
      <div className="mx-auto w-full max-w-3xl px-4 py-16 text-center sm:px-6">
        <h2 className="text-ink text-2xl font-semibold sm:text-3xl">আজ থেকেই শুরু হোক</h2>
        <p className="text-ink-muted mx-auto mt-3 max-w-xl">
          অ্যাকাউন্ট খুলতে এক মিনিট। প্রথম খরচটা লিখতে দশ সেকেন্ড। মাস শেষে টাকা কোথায় গেছে তার
          উত্তরটা আপনার কাছে থাকবে।
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Link
            href="/signup"
            className="press bg-income inline-flex min-h-12 items-center gap-2 rounded-md px-6 text-base font-medium text-white hover:opacity-90"
          >
            ফ্রি অ্যাকাউন্ট খুলুন
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
          <Link
            href="/login"
            className="press border-rule bg-surface text-ink hover:bg-greenbar inline-flex min-h-12 items-center rounded-md border px-6 text-base font-medium"
          >
            আগের অ্যাকাউন্টে ঢুকুন
          </Link>
        </div>
      </div>
    </section>
  );
}
