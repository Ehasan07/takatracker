import { ArrowRight, Check, Minus, X } from 'lucide-react';
import Link from 'next/link';
import { GUIDE } from '@/content/guide';
import { EN } from '@/i18n/en';
import type { TutorialContent } from './content';

/**
 * The public tutorial, in one language at a time.
 *
 * Same shape as `Landing`: one component, fed a `TutorialContent`, rendered by
 * `/tutorial` in Bengali and `/en/tutorial` in English — so a section cannot
 * exist on one and quietly be missing from the other.
 *
 * ## No client JavaScript
 *
 * Every section is static markup. No tabs, no accordions, no reveal-on-scroll.
 * A person deciding whether to trust a finance app is often on a phone on a
 * slow connection, and a page about clarity that arrives as a spinner has
 * argued against itself. It also means the whole thing is in the server HTML,
 * which is what a crawler indexes and what a reader with JavaScript still
 * loading can already read.
 *
 * ## Where the feature list comes from
 *
 * `@/content/guide` — the same table the in-app manual renders. One list, two
 * audiences: a signed-in reader gets it at `/help`, a visitor gets it here. A
 * feature added to the app appears on this page without anybody remembering to
 * copy it across, which is the only way marketing copy stays true.
 */
export function Tutorial({ content, locale }: { content: TutorialContent; locale: 'bn' | 'en' }) {
  const isBn = locale === 'bn';

  /* The guide table stores the Bengali beside a key; the English lives in the
     app's catalogue. This is what `t()` does, minus the module-level locale —
     which a server component rendering two languages in one build cannot use. */
  const say = (key: string, bengali: string): string => (isBn ? bengali : (EN[key] ?? bengali));

  return (
    <>
      <section className="border-rule border-b">
        <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6 sm:py-16">
          <p className="text-brand text-xs font-medium sm:text-sm">{content.eyebrow}</p>
          <h1 className="text-ink mt-3 max-w-3xl text-3xl font-semibold leading-tight sm:text-4xl md:text-5xl">
            {content.title}
          </h1>
          <p className="text-ink-muted mt-4 max-w-3xl text-base sm:text-lg">{content.subtitle}</p>
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6 sm:py-16">
        <h2 className="text-ink text-2xl font-semibold sm:text-3xl">{content.rulesHeading}</h2>
        <p className="text-ink-muted mt-2 max-w-3xl">{content.rulesBlurb}</p>
        <ol className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {content.rules.map((rule, index) => (
            <li key={rule.title} className="rounded-card border-rule bg-surface border p-5">
              <span
                aria-hidden
                className="bg-brand-tint text-brand flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold"
              >
                {isBn ? '১২৩৪৫৬'[index] : index + 1}
              </span>
              <h3 className="text-ink mt-3 font-medium">{rule.title}</h3>
              <p className="text-ink-muted mt-1 text-sm">{rule.body}</p>
              {rule.standard ? (
                <Standard label={content.standardLabel} name={rule.standard} />
              ) : null}
            </li>
          ))}
        </ol>
      </section>

      {/* The section that earns the page. Two columns on a tablet and up; on a
          phone the wrong line sits directly above the right one, which is the
          comparison, so it survives the stack. */}
      <section id="mistakes" className="border-rule scroll-mt-16 border-y">
        <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6 sm:py-16">
          <h2 className="text-ink text-2xl font-semibold sm:text-3xl">{content.mistakesHeading}</h2>
          <p className="text-ink-muted mt-2 max-w-3xl">{content.mistakesBlurb}</p>

          <ul className="mt-8 grid gap-4 lg:grid-cols-2">
            {content.mistakes.map((mistake) => (
              <li
                key={mistake.wrong}
                className="rounded-card border-rule bg-surface border p-4 sm:p-5"
              >
                <p className="text-ink-muted flex items-start gap-2 text-sm">
                  <X className="text-expense mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  <span>
                    <span className="text-ink-muted block text-xs">
                      {content.mistakeLabels.wrong}
                    </span>
                    <span className="text-ink line-through decoration-1">{mistake.wrong}</span>
                  </span>
                </p>
                <p className="text-ink mt-3 flex items-start gap-2 text-sm">
                  <Check className="text-income mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  <span>
                    <span className="text-ink-muted block text-xs">
                      {content.mistakeLabels.right}
                    </span>
                    <span className="font-medium">{mistake.right}</span>
                  </span>
                </p>
                <p className="text-ink-muted border-rule mt-3 border-t pt-3 text-sm">
                  {mistake.why}
                </p>
                {mistake.standard ? (
                  <Standard label={content.standardLabel} name={mistake.standard} />
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section
        id="features"
        className="mx-auto w-full max-w-6xl scroll-mt-16 px-4 py-12 sm:px-6 sm:py-16"
      >
        <h2 className="text-ink text-2xl font-semibold sm:text-3xl">{content.featuresHeading}</h2>
        <p className="text-ink-muted mt-2 max-w-3xl">{content.featuresBlurb}</p>

        <div className="mt-8 space-y-10">
          {GUIDE.map((group) => (
            <div key={group.key}>
              <h3 className="text-ink text-lg font-semibold sm:text-xl">
                {say(`${group.key}.h`, group.heading)}
              </h3>
              {group.blurb ? (
                <p className="text-ink-muted mt-1 text-sm">{say(`${group.key}.s`, group.blurb)}</p>
              ) : null}

              <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {group.entries.map((entry) => (
                  <li key={entry.key} className="rounded-card border-rule bg-surface border p-4">
                    <h4 className="text-ink flex items-start gap-2 text-sm font-medium">
                      <Check className="text-brand mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                      <span>{say(`${entry.key}.t`, entry.title)}</span>
                    </h4>
                    <p className="text-ink-muted mt-1 text-xs">
                      <span className="sr-only">{content.whereLabel}: </span>
                      {say(`${entry.key}.w`, entry.where)}
                    </p>
                    <p className="text-ink-muted mt-2 text-sm">
                      {say(`${entry.key}.b`, entry.body)}
                    </p>
                    {entry.note ? (
                      <p className="text-ink-muted border-brand/40 mt-2 border-l-2 pl-2 text-xs">
                        {say(`${entry.key}.n`, entry.note)}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <section id="limits" className="border-rule scroll-mt-16 border-y">
        <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6 sm:py-16">
          <h2 className="text-ink text-2xl font-semibold sm:text-3xl">{content.getsHeading}</h2>

          <div className="mt-8 grid gap-4 lg:grid-cols-2">
            <div className="rounded-card border-rule bg-surface border p-5">
              <h3 className="text-ink font-medium">{content.freeLabel}</h3>
              <ul className="mt-3 space-y-2">
                {content.free.map((item) => (
                  <li key={item} className="text-ink-muted flex items-start gap-2 text-sm">
                    <Check className="text-income mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="rounded-card border-brand/40 bg-brand-tint border p-5">
              <h3 className="text-ink font-medium">{content.premiumLabel}</h3>
              <ul className="mt-3 space-y-2">
                {content.premium.map((item) => (
                  <li key={item} className="text-ink-muted flex items-start gap-2 text-sm">
                    <Check className="text-brand mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <h2 className="text-ink mt-12 text-2xl font-semibold sm:text-3xl">
            {content.notHeading}
          </h2>
          <p className="text-ink-muted mt-2 max-w-3xl">{content.notBlurb}</p>
          <ul className="mt-6 grid gap-3 sm:grid-cols-2">
            {content.not.map((item) => (
              <li
                key={item}
                className="rounded-card border-rule bg-surface text-ink-muted flex items-start gap-2 border p-4 text-sm"
              >
                <Minus className="text-ink-muted mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl px-4 py-14 sm:px-6 sm:py-16">
        <h2 className="text-ink text-2xl font-semibold sm:text-3xl">{content.ctaHeading}</h2>
        <p className="text-ink-muted mt-2 max-w-2xl">{content.ctaBody}</p>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Link
            href="/signup"
            className="press bg-brand text-brand-contrast inline-flex min-h-12 items-center gap-2 rounded-md px-6 text-base font-medium hover:opacity-90"
          >
            {content.ctaPrimary}
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
          <Link
            href={isBn ? '/pricing' : '/en/pricing'}
            className="press border-rule bg-surface text-ink hover:bg-brand-tint inline-flex min-h-12 items-center rounded-md border px-6 text-base font-medium"
          >
            {content.ctaSecondary}
          </Link>
        </div>
      </section>
    </>
  );
}

/**
 * Which standard a treatment comes from, in small print under the box.
 *
 * A citation, not a claim. "Treatment per IAS 7" says where the rule is written
 * down and invites the reader to go and read it; "IFRS compliant" would say
 * something about this product that no auditor has ever examined. The first is
 * true and checkable, the second would put every other sentence on the page
 * under suspicion — so the label is fixed in the content file and this
 * component has no way to render the other kind.
 */
function Standard({ label, name }: { label: string; name: string }) {
  return (
    <p className="text-ink-muted mt-2 text-xs">
      <span className="border-rule bg-brand-tint text-ink-muted inline-flex rounded border px-1.5 py-0.5">
        {label}: {name}
      </span>
    </p>
  );
}
