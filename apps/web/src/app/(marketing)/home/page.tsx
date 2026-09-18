import { ArrowRight, ArrowUpRight, Building2, Check, Wallet } from 'lucide-react';
import Link from 'next/link';
import { CONTENT_BN, type Doors, type Hero, type SiteContent, type UiStrings } from '../content';
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
  title: 'Taka Tracker — বাংলাদেশের ব্যক্তিগত হিসাবের সফটওয়্যার | Personal Finance App',
  description:
    'আয়, খরচ, ধার-দেনা, ডিপিএস ও বীমার হিসাব এক জায়গায় — সম্পূর্ণ বাংলায়। ডাবল-এন্ট্রি হিসাবরক্ষণের উপর তৈরি, অফলাইনেও চলে। ফ্রি প্যাকেজ আজীবন ফ্রি। A free double-entry personal finance app for Bangladesh, on web and mobile.',
  path: '/',
  locale: 'bn',
  alternatePath: '/en',
  /* The two queries this most wants to be found on are "personal accounting
     software" and "business accounting software" — people search for the
     *category*, not for a brand they have never heard of. Both are here in
     English and in Bengali, beside the narrower phrases that actually describe
     what makes this different: double entry, ধার-দেনা, DPS, bank SMS. A
     keyword list is a weak signal on its own; what carries it is that the page
     body genuinely says all of these things. */
  keywords: [
    'personal accounting software',
    'business accounting software',
    'accounting software bangladesh',
    'personal finance app',
    'personal finance app bangladesh',
    'ব্যক্তিগত হিসাবের সফটওয়্যার',
    'ব্যবসার হিসাবের সফটওয়্যার',
    'হিসাব রাখার সফটওয়্যার',
    'double entry accounting app bangla',
    'bank sms expense tracker',
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
  return <Landing content={CONTENT_BN} locale="bn" />;
}

/**
 * The landing page's body, fed a language.
 *
 * Rendered by `/` in Bengali and `/en` in English from the same components, so
 * a section can never exist on one page and quietly not on the other — the
 * `SiteContent` type would not compile.
 */
export function Landing({ content, locale }: { content: SiteContent; locale: 'bn' | 'en' }) {
  const { hero, doors, proof, steps, groups, coming, faq, ui } = content;
  const isBn = locale === 'bn';
  const home = isBn ? '/' : '/en';
  return (
    <>
      <script
        type="application/ld+json"
        // Static, server-rendered, and escaped in `jsonLdScript`.
        dangerouslySetInnerHTML={{ __html: jsonLdScript(softwareApplicationJsonLd(35_000)) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLdScript(faqJsonLd(faq)) }}
      />

      <Hero hero={hero} doors={doors} ui={ui} isBn={isBn} />
      <ProofStrip proof={proof} label={ui.proofLabel} />
      <Steps steps={steps} ui={ui} isBn={isBn} />
      <Features groups={groups} ui={ui} home={home} />
      <LedgerNote ui={ui} />
      <Coming coming={coming} ui={ui} />
      <Faq faq={faq} heading={ui.faqHeading} />
      <ClosingCta hero={hero} ui={ui} />
    </>
  );
}

function Hero({
  hero,
  doors,
  ui,
  isBn,
}: {
  hero: Hero;
  doors: Doors;
  ui: UiStrings;
  isBn: boolean;
}) {
  return (
    <section className="border-rule border-b">
      <div className="mx-auto w-full max-w-6xl px-4 py-14 sm:px-6 sm:py-20">
        <p className="text-brand text-xs font-medium sm:text-sm">{hero.eyebrow}</p>
        {/* The only `<h1>` on the page, and it carries the product's claim
            rather than its name — a crawler and a first-time reader both need
            the sentence, not the brand. */}
        <h1 className="text-ink mt-3 max-w-3xl text-3xl font-semibold leading-tight sm:text-4xl md:text-5xl">
          {hero.title}
        </h1>
        <p className="text-ink-muted mt-4 max-w-2xl text-base sm:text-lg">{hero.subtitle}</p>
        <p className="text-ink-muted mt-2 max-w-2xl text-sm">{hero.subtitleEn}</p>

        <div className="mt-7 flex flex-wrap items-center gap-3">
          <Link
            href="/signup"
            className="press bg-brand text-brand-contrast inline-flex min-h-12 items-center gap-2 rounded-md px-6 text-base font-medium hover:opacity-90"
          >
            {hero.primaryCta}
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
          <Link
            href={isBn ? '/pricing' : '/en/pricing'}
            className="press border-rule bg-surface text-ink hover:bg-brand-tint inline-flex min-h-12 items-center rounded-md border px-6 text-base font-medium"
          >
            {hero.secondaryCta}
          </Link>
        </div>
        <p className="text-ink-muted mt-3 text-sm">{ui.heroNote}</p>

        {/* Two doors, named. The business one is a plain `<a>` to the trade
            site with the product's own words as its text — server-rendered and
            followable, so a crawler reads what is on the other side of it and
            credits the link to the thing it describes. */}
        <h2 id="doors" className="text-ink mt-8 text-sm font-medium">
          {doors.heading}
        </h2>
        <div
          role="group"
          aria-labelledby="doors"
          className="mt-3 grid max-w-3xl gap-3 sm:grid-cols-2"
        >
          <Link
            href="/signup"
            className="press rounded-card border-rule bg-surface hover:border-brand hover:bg-brand-tint block border p-4"
          >
            <span className="text-ink flex items-center gap-2 text-sm font-semibold">
              <Wallet className="text-brand h-4 w-4 shrink-0" aria-hidden />
              {doors.personal.title}
            </span>
            <span className="text-ink-muted mt-1 block text-xs leading-relaxed">
              {doors.personal.body}
            </span>
          </Link>
          <a
            href={doors.business.href}
            hrefLang={isBn ? 'bn' : 'en'}
            className="press rounded-card border-rule bg-surface hover:border-brand hover:bg-brand-tint block border p-4"
          >
            <span className="text-ink flex items-center gap-2 text-sm font-semibold">
              <Building2 className="text-brand h-4 w-4 shrink-0" aria-hidden />
              {doors.business.title}
              <ArrowUpRight className="text-ink-muted ml-auto h-4 w-4 shrink-0" aria-hidden />
            </span>
            <span className="text-ink-muted mt-1 block text-xs leading-relaxed">
              {doors.business.body}
            </span>
          </a>
        </div>
      </div>
    </section>
  );
}

function ProofStrip({ proof, label }: { proof: SiteContent['proof']; label: string }) {
  return (
    <section aria-label={label} className="border-rule bg-brand-tint border-b">
      <div className="mx-auto grid w-full max-w-6xl grid-cols-2 gap-6 px-4 py-8 sm:px-6 lg:grid-cols-4">
        {proof.map((item) => (
          <div key={item.value}>
            <p className="text-brand text-lg font-semibold sm:text-xl">{item.value}</p>
            <p className="text-ink-muted mt-1 text-xs sm:text-sm">{item.label}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function Steps({ steps, ui, isBn }: { steps: SiteContent['steps']; ui: UiStrings; isBn: boolean }) {
  const numerals = isBn ? ['১', '২', '৩'] : ['1', '2', '3'];
  return (
    <section className="mx-auto w-full max-w-6xl px-4 py-14 sm:px-6 sm:py-16">
      <h2 className="text-ink text-2xl font-semibold sm:text-3xl">{ui.stepsHeading}</h2>
      <p className="text-ink-muted mt-2 max-w-2xl">{ui.stepsBlurb}</p>
      <ol className="mt-8 grid gap-4 md:grid-cols-3">
        {steps.map((step, index) => (
          <li key={step.title} className="rounded-card border-rule bg-surface border p-5">
            <span
              aria-hidden
              className="bg-brand-tint text-brand flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold"
            >
              {numerals[index]}
            </span>
            <h3 className="text-ink mt-3 font-medium">{step.title}</h3>
            <p className="text-ink-muted mt-1 text-sm">{step.body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Features({
  groups,
  ui,
  home,
}: {
  groups: SiteContent['groups'];
  ui: UiStrings;
  home: string;
}) {
  return (
    <section id="features" className="border-rule scroll-mt-16 border-y">
      <div className="mx-auto w-full max-w-6xl px-4 py-14 sm:px-6 sm:py-16">
        <h2 className="text-ink text-2xl font-semibold sm:text-3xl">{ui.featuresHeading}</h2>
        <p className="text-ink-muted mt-2 max-w-2xl">
          {ui.featuresBlurb[0]}
          <a href={`${home}#coming`} className="text-brand underline">
            {ui.comingHeading}
          </a>
          {ui.featuresBlurb[1]}
        </p>

        <div className="mt-10 space-y-12">
          {groups.map((group) => (
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
                      <Check className="text-brand mt-0.5 h-4 w-4 shrink-0" aria-hidden />
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
function LedgerNote({ ui }: { ui: UiStrings }) {
  return (
    <section className="mx-auto w-full max-w-6xl px-4 py-14 sm:px-6 sm:py-16">
      <div className="rounded-card border-brand/30 bg-brand-tint border p-6 sm:p-8">
        <h2 className="text-ink text-2xl font-semibold sm:text-3xl">{ui.ledgerHeading}</h2>
        <div className="mt-4 grid gap-6 md:grid-cols-2">
          <div>
            <p className="text-ink-muted text-sm">{ui.ledgerBodyA}</p>
            <p className="text-ink-muted mt-3 text-sm">{ui.ledgerBodyB}</p>
          </div>
          <div>
            <p className="text-ink text-sm font-medium">{ui.ledgerResultHeading}</p>
            <ul className="mt-2 space-y-2">
              {ui.ledgerResults.map((line) => (
                <li key={line} className="text-ink-muted flex items-start gap-2 text-sm">
                  <Check className="text-brand mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  {line}
                </li>
              ))}
            </ul>
            <p className="text-ink-muted mt-3 text-xs">{ui.ledgerFootnote}</p>
          </div>
        </div>
      </div>
    </section>
  );
}

function Coming({ coming, ui }: { coming: SiteContent['coming']; ui: UiStrings }) {
  return (
    <section id="coming" className="border-rule scroll-mt-16 border-y">
      <div className="mx-auto w-full max-w-6xl px-4 py-14 sm:px-6 sm:py-16">
        <h2 className="text-ink text-2xl font-semibold sm:text-3xl">{ui.comingHeading}</h2>
        <p className="text-ink-muted mt-2 max-w-2xl">{ui.comingBlurb}</p>
        <ul className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {coming.map((item) => (
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

function Faq({ faq, heading }: { faq: SiteContent['faq']; heading: string }) {
  return (
    <section id="faq" className="mx-auto w-full max-w-3xl scroll-mt-16 px-4 py-14 sm:px-6 sm:py-16">
      <h2 className="text-ink text-2xl font-semibold sm:text-3xl">{heading}</h2>
      <div className="mt-8 space-y-3">
        {faq.map((item) => (
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

function ClosingCta({ hero, ui }: { hero: Hero; ui: UiStrings }) {
  return (
    <section className="border-rule bg-brand-tint border-t">
      <div className="mx-auto w-full max-w-3xl px-4 py-16 text-center sm:px-6">
        <h2 className="text-ink text-2xl font-semibold sm:text-3xl">{ui.closingHeading}</h2>
        <p className="text-ink-muted mx-auto mt-3 max-w-xl">{ui.closingBody}</p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Link
            href="/signup"
            className="press bg-brand text-brand-contrast inline-flex min-h-12 items-center gap-2 rounded-md px-6 text-base font-medium hover:opacity-90"
          >
            {hero.primaryCta}
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
          <Link
            href="/login"
            className="press border-rule bg-surface text-ink hover:bg-brand-tint inline-flex min-h-12 items-center rounded-md border px-6 text-base font-medium"
          >
            {ui.closingSecondary}
          </Link>
        </div>
      </div>
    </section>
  );
}
