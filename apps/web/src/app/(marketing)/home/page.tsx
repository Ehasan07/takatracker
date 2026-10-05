import {
  ArrowUpRight,
  BanglaLetter,
  Check,
  ChevronDown,
  Clock,
  Coins,
  Ledger,
  PhoneOffline,
  ShoppingBag,
  Store,
  Wallet,
} from '@/components/icons';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { CONTENT_BN, type Doors, type Hero, type SiteContent, type UiStrings } from '../content';
import { FeatureTabs } from '../feature-tabs';
import { HeroPreview } from '../hero-preview';
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
      <Features groups={groups} ui={ui} home={home} locale={locale} />
      <LedgerNote ui={ui} isBn={isBn} />
      <Coming coming={coming} ui={ui} isBn={isBn} />
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
  /* The note under the buttons is one string with `·` between its promises.
     On screen each promise gets its own tick instead of a row of dots. */
  const promises = ui.heroNote
    .split('·')
    .map((part) => part.trim())
    .filter(Boolean);
  return (
    <div className="px-2 pt-2 sm:px-4 sm:pt-4">
      <section className="relative mx-auto flex max-w-[1408px] flex-wrap items-end gap-x-12 gap-y-4 overflow-hidden rounded-[28px] bg-[#1F6F4A] px-5 pt-11 sm:rounded-[40px] sm:px-10 sm:pt-16 lg:px-16 lg:pt-[72px]">
        <div className="relative min-w-0 flex-[1_1_460px] pb-10 sm:pb-16">
          <p className="text-[15px] font-medium text-white/80">{hero.eyebrow}</p>
          {/* The only `<h1>` on the page, and it carries the product's claim
              rather than its name — a crawler and a first-time reader both need
              the sentence, not the brand. */}
          <h1 className="mt-3 max-w-[12em] text-[38px] font-extrabold leading-[1.12] tracking-[-0.015em] text-white sm:text-5xl lg:text-[60px]">
            {hero.title}
          </h1>
          <span aria-hidden className="bg-gold mt-7 block h-[9px] w-[104px] rounded-full" />
          <p className="mt-6 max-w-[30em] text-lg leading-[1.75] text-white/90 sm:text-xl">
            {hero.subtitle}
          </p>
          <p lang="en" className="font-wordmark mt-2 text-[15px] text-white/75">
            {hero.subtitleEn}
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3.5">
            <Link
              href="/signup"
              className="press inline-flex min-h-14 items-center rounded-2xl bg-white px-7 text-lg font-bold text-[#154D33] shadow-[0_4px_0_#154D33]"
            >
              {hero.primaryCta}
            </Link>
            <Link
              href={isBn ? '/pricing' : '/en/pricing'}
              className="press inline-flex min-h-14 items-center rounded-2xl border-2 border-white/80 px-6 text-lg font-semibold text-white hover:bg-white/10"
            >
              {hero.secondaryCta}
            </Link>
          </div>
          <ul className="mt-5 flex flex-wrap gap-x-5 gap-y-2 text-[15px] text-white/90">
            {promises.map((promise) => (
              <li key={promise} className="flex items-center gap-2">
                <Check className="h-[18px] w-[18px] text-[#F1D9A8]" aria-hidden />
                {promise}
              </li>
            ))}
          </ul>

          {/* Two doors, named. The business one is a plain `<a>` to the trade
              site with the product's own words as its text — server-rendered and
              followable, so a crawler reads what is on the other side of it and
              credits the link to the thing it describes. */}
          <h2 id="doors" className="mb-3 mt-9 text-base font-bold text-white">
            {doors.heading}
          </h2>
          <div role="group" aria-labelledby="doors" className="flex flex-wrap gap-3">
            <Link
              href="/signup"
              className="press bg-surface text-ink flex min-w-0 flex-[1_1_220px] items-start gap-3.5 rounded-[20px] p-4"
            >
              <span className="bg-brand-tint text-brand flex h-11 w-11 shrink-0 items-center justify-center rounded-xl">
                <Wallet className="h-6 w-6" aria-hidden />
              </span>
              <span>
                <span className="block text-[17px] font-bold">{doors.personal.title}</span>
                <span className="text-ink-muted mt-0.5 block text-sm leading-relaxed">
                  {doors.personal.body}
                </span>
              </span>
            </Link>
            <a
              href={doors.business.href}
              hrefLang={isBn ? 'bn' : 'en'}
              className="press flex min-w-0 flex-[1.4_1_260px] items-start gap-3.5 rounded-[20px] border-[1.5px] border-white/35 bg-white/10 p-4 text-white hover:bg-white/15"
            >
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white/15">
                <Store className="h-6 w-6" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-start justify-between gap-2 text-[17px] font-bold">
                  {doors.business.title}
                  <ArrowUpRight className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
                </span>
                <span className="mt-0.5 block text-sm leading-relaxed text-white/80">
                  {doors.business.body}
                </span>
              </span>
            </a>
          </div>
        </div>

        <div className="relative min-w-0 flex-[1_1_440px]">
          <HeroPreview locale={isBn ? 'bn' : 'en'} />
        </div>
      </section>
    </div>
  );
}

/** One icon per guarantee, in the order the content file lists them. */
const PROOF_ICONS = [Ledger, Coins, BanglaLetter, PhoneOffline] as const;

function ProofStrip({ proof, label }: { proof: SiteContent['proof']; label: string }) {
  return (
    <section aria-labelledby="proof" className="mx-auto w-full max-w-6xl px-4 pt-16 sm:px-6">
      <h2 id="proof" className="text-ink-muted text-base font-bold">
        {label}
      </h2>
      <ul className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {proof.map((item, i) => {
          const Icon = PROOF_ICONS[i] ?? Ledger;
          return (
            <li
              key={item.value}
              className="border-rule bg-surface flex items-start gap-3.5 rounded-[22px] border-[1.5px] p-[18px]"
            >
              <span className="bg-brand-tint text-brand flex h-12 w-12 shrink-0 items-center justify-center rounded-[14px]">
                <Icon className="h-[26px] w-[26px]" aria-hidden />
              </span>
              <span>
                <span className="text-ink block text-xl font-extrabold">{item.value}</span>
                <span className="text-ink-muted mt-0.5 block text-[15px] leading-relaxed">
                  {item.label}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** A section's title and the mark's gold rule beneath it. */
function SectionHeading({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <>
      <h2
        id={id}
        className="text-ink text-[32px] font-extrabold leading-[1.15] tracking-[-0.01em] sm:text-[44px]"
      >
        {children}
      </h2>
      <span aria-hidden className="bg-gold mt-5 block h-[7px] w-[72px] rounded-full" />
    </>
  );
}

function Steps({ steps, ui, isBn }: { steps: SiteContent['steps']; ui: UiStrings; isBn: boolean }) {
  const numerals = isBn ? ['১', '২', '৩'] : ['1', '2', '3'];
  return (
    <section className="mx-auto w-full max-w-6xl px-4 pt-24 sm:px-6 sm:pt-28">
      <SectionHeading>{ui.stepsHeading}</SectionHeading>
      <p className="text-ink-muted mt-5 max-w-[46em] text-lg leading-[1.75]">{ui.stepsBlurb}</p>
      <ol className="mt-11 grid gap-10 md:grid-cols-3">
        {steps.map((step, index) => (
          <li key={step.title} className="relative">
            {index < steps.length - 1 ? (
              <span
                aria-hidden
                className="bg-gold/40 absolute left-[72px] right-[-28px] top-[27px] hidden h-1 rounded-full md:block"
              />
            ) : null}
            <span
              aria-hidden
              className="bg-brand text-brand-contrast relative flex h-[58px] w-[58px] items-center justify-center rounded-[17px] text-[26px] font-extrabold"
            >
              {numerals[index]}
            </span>
            <h3 className="text-ink mt-5 text-[22px] font-bold leading-snug">{step.title}</h3>
            <p className="text-ink-muted mt-2 text-[17px] leading-[1.75]">{step.body}</p>
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
  locale,
}: {
  groups: SiteContent['groups'];
  ui: UiStrings;
  home: string;
  locale: 'bn' | 'en';
}) {
  return (
    <section
      id="features"
      className="mx-auto w-full max-w-6xl scroll-mt-20 px-4 pt-24 sm:px-6 sm:pt-28"
    >
      <SectionHeading>{ui.featuresHeading}</SectionHeading>
      <p className="text-ink-muted mt-5 max-w-[46em] text-lg leading-[1.75]">
        {ui.featuresBlurb[0]}
        <a href={`${home}#coming`} className="text-brand font-bold underline underline-offset-4">
          {ui.comingHeading}
        </a>
        {ui.featuresBlurb[1]}
      </p>
      <FeatureTabs groups={groups} locale={locale} />
    </section>
  );
}

/**
 * The one paragraph that explains why this is not another expense tracker.
 *
 * It earns its place on a landing page because "double-entry" is the single
 * claim a competitor cannot copy in a sprint, and because a visitor who does
 * not know the term will otherwise read it as jargon and skip the product.
 * Beside it, the ৳500 grocery entry from the second paragraph, drawn as the
 * two lines the ledger actually writes.
 */
function LedgerNote({ ui, isBn }: { ui: UiStrings; isBn: boolean }) {
  const t = isBn
    ? {
        title: '৫০০ টাকার বাজার',
        sub: 'একটা লেনদেন, দুটো লাইন',
        account: 'খাতা',
        dr: 'ডেবিট',
        cr: 'ক্রেডিট',
        food: 'খাবার খাত',
        cash: 'নগদ',
        equal: 'সমান',
        amount: '৫০০',
      }
    : {
        title: '৳500 of groceries',
        sub: 'One transaction, two lines',
        account: 'Account',
        dr: 'Debit',
        cr: 'Credit',
        food: 'Food',
        cash: 'Cash',
        equal: 'Balanced',
        amount: '500',
      };
  return (
    <section className="mx-auto w-full max-w-6xl px-4 pt-24 sm:px-6 sm:pt-28">
      <div className="flex flex-wrap items-start gap-12">
        <div className="min-w-0 flex-[1.2_1_440px]">
          <SectionHeading>{ui.ledgerHeading}</SectionHeading>
          <p className="text-ink-muted mt-5 text-lg leading-[1.75]">{ui.ledgerBodyA}</p>
          <p className="text-ink-muted mt-4 text-lg leading-[1.75]">{ui.ledgerBodyB}</p>
          <h3 className="text-ink mt-8 text-xl font-extrabold">{ui.ledgerResultHeading}</h3>
          <ul className="mt-3">
            {ui.ledgerResults.map((line) => (
              <li key={line} className="text-ink flex items-start gap-3 py-2.5 text-[17px]">
                <span className="bg-brand text-brand-contrast mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full">
                  <Check className="h-4 w-4" strokeWidth={2.4} aria-hidden />
                </span>
                {line}
              </li>
            ))}
          </ul>
          <p className="text-ink-muted mt-4 max-w-[44em] text-[15px] leading-relaxed">
            {ui.ledgerFootnote}
          </p>
        </div>

        <figure
          aria-label={t.title}
          className="bg-brand min-w-0 flex-[1_1_360px] rounded-[32px] p-2.5 sm:p-3.5"
        >
          <div className="bg-surface rounded-[24px] p-6">
            <div className="flex items-center gap-3">
              <span className="bg-expense/10 text-expense flex h-12 w-12 items-center justify-center rounded-[14px]">
                <ShoppingBag className="h-[26px] w-[26px]" aria-hidden />
              </span>
              <figcaption>
                <span className="text-ink block text-xl font-extrabold">{t.title}</span>
                <span className="text-ink-muted block text-sm">{t.sub}</span>
              </figcaption>
            </div>
            <table className="border-rule mt-5 w-full overflow-hidden rounded-2xl border-[1.5px] text-base">
              <thead className="bg-greenbar text-ink-muted text-[13px] font-bold">
                <tr>
                  <th scope="col" className="px-4 py-2.5 text-left">
                    {t.account}
                  </th>
                  <th scope="col" className="px-4 py-2.5 text-right">
                    {t.dr}
                  </th>
                  <th scope="col" className="px-4 py-2.5 text-right">
                    {t.cr}
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-rule border-t">
                  <td className="px-4 py-3">{t.food}</td>
                  <td className="px-4 py-3 text-right font-bold tabular-nums">{t.amount}</td>
                  <td className="text-ink-muted px-4 py-3 text-right">—</td>
                </tr>
                <tr className="border-rule border-t">
                  <td className="px-4 py-3">{t.cash}</td>
                  <td className="text-ink-muted px-4 py-3 text-right">—</td>
                  <td className="px-4 py-3 text-right font-bold tabular-nums">{t.amount}</td>
                </tr>
                <tr className="bg-brand-tint text-brand-strong border-ink border-t-[1.5px] font-extrabold">
                  <td className="px-4 py-3">
                    <span className="flex items-center gap-1.5">
                      <Check className="h-5 w-5" aria-hidden />
                      {t.equal}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right underline decoration-double underline-offset-4">
                    {t.amount}
                  </td>
                  <td className="px-4 py-3 text-right underline decoration-double underline-offset-4">
                    {t.amount}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </figure>
      </div>
    </section>
  );
}

function Coming({
  coming,
  ui,
  isBn,
}: {
  coming: SiteContent['coming'];
  ui: UiStrings;
  isBn: boolean;
}) {
  return (
    <section
      id="coming"
      className="mx-auto w-full max-w-6xl scroll-mt-20 px-4 pt-24 sm:px-6 sm:pt-28"
    >
      <SectionHeading>{ui.comingHeading}</SectionHeading>
      <p className="text-ink-muted mt-5 max-w-[46em] text-lg leading-[1.75]">{ui.comingBlurb}</p>
      <ul className="mt-9 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {coming.map((item) => (
          /* Dashed, because it is not built yet — the border says what the
             label says. */
          <li key={item.title} className="border-rule rounded-[22px] border-2 border-dashed p-5">
            <p className="text-brass flex items-center gap-2 text-[13px] font-bold">
              <Clock className="text-ink-muted h-[18px] w-[18px]" aria-hidden />
              {isBn ? 'এখনো তৈরি হয়নি' : 'Not built yet'}
            </p>
            <h3 className="text-ink mt-2.5 text-lg font-bold leading-snug">{item.title}</h3>
            <p className="text-ink-muted mt-2 text-[15px] leading-relaxed">{item.body}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Faq({ faq, heading }: { faq: SiteContent['faq']; heading: string }) {
  return (
    <section id="faq" className="mx-auto w-full max-w-6xl scroll-mt-20 px-4 pt-24 sm:px-6 sm:pt-28">
      <SectionHeading>{heading}</SectionHeading>
      <div className="mt-7 max-w-[860px]">
        {faq.map((item) => (
          /* `<details>`, not a JavaScript accordion: it opens with the script
             still loading, a crawler reads the answer whether or not it is
             expanded, and browser find-in-page reaches inside it. */
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
  );
}

function ClosingCta({ hero, ui }: { hero: Hero; ui: UiStrings }) {
  return (
    <div className="px-2 pt-24 sm:px-4 sm:pt-28">
      <section className="mx-auto flex max-w-[1408px] flex-wrap items-center justify-between gap-7 rounded-[28px] bg-[#C62828] px-6 py-10 sm:rounded-[40px] sm:px-16 sm:py-16">
        <div className="min-w-0 flex-[1_1_420px]">
          <h2 className="text-[32px] font-extrabold leading-[1.15] text-white sm:text-[44px]">
            {ui.closingHeading}
          </h2>
          <p className="mt-3.5 max-w-[36em] text-lg leading-[1.7] text-white/85">
            {ui.closingBody}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Link
            href="/signup"
            className="press inline-flex min-h-14 items-center rounded-2xl bg-white px-7 text-lg font-bold text-[#8E1F1F] shadow-[0_4px_0_#7A1A1A]"
          >
            {hero.primaryCta}
          </Link>
          <Link
            href="/login"
            className="press inline-flex min-h-14 items-center rounded-2xl border-2 border-white/75 px-6 text-[17px] font-semibold text-white hover:bg-white/10"
          >
            {ui.closingSecondary}
          </Link>
        </div>
      </section>
    </div>
  );
}
