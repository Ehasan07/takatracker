import Link from 'next/link';
import { SITE } from '../content';
import type { SmsContent } from './steps';

/**
 * The SMS guide, drawn once and fed either language.
 *
 * A server component with no state and no client JavaScript: every step of both
 * phones is in the HTML that arrives. Nothing is behind a tab, an accordion or
 * a "read more" — a person following instructions on one phone while holding
 * another does not want to hunt for the next step, and a crawler cannot click.
 *
 * Responsiveness is done by not fighting it: one column, `max-w-3xl`, and
 * `min-w-0` on every flex child so a long `Content-Type: application/json`
 * wraps instead of pushing the page sideways. The numbered markers are fixed at
 * 1.5rem and `shrink-0`, which is the one thing that has to be told not to
 * squash at 320px.
 */
export function SmsGuideView({ content, lang }: { content: SmsContent; lang: 'bn' | 'en' }) {
  const signupHref = '/signup';
  const inboxLabel = lang === 'bn' ? 'এসএমএস ইনবক্স' : 'SMS inbox';

  return (
    <>
      <section className="border-rule border-b">
        <div className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6 sm:py-16">
          <h1 className="text-ink text-balance text-[38px] font-extrabold leading-[1.12] tracking-[-0.015em] sm:text-[52px]">
            {content.title}
          </h1>
          <p className="text-ink-muted mt-4 text-base sm:text-lg">{content.intro}</p>
        </div>
      </section>

      {/* Before the steps, because somebody deciding whether to do this at all
          is asking whether it is safe long before they ask how it works. */}
      <section className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6">
        <h2 className="text-ink text-xl font-extrabold sm:text-2xl">{content.safetyHeading}</h2>
        <ul className="mt-4 flex flex-col gap-3">
          {content.safety.map((line) => (
            <li key={line} className="text-ink-muted flex min-w-0 gap-3 text-sm sm:text-base">
              <span aria-hidden className="text-income shrink-0">
                ✓
              </span>
              <span className="min-w-0">{line}</span>
            </li>
          ))}
        </ul>
      </section>

      {content.guides.map((guide) => (
        <section
          key={guide.kind}
          id={guide.kind.toLowerCase()}
          className="border-rule border-t"
          aria-labelledby={`${guide.kind.toLowerCase()}-heading`}
        >
          <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6">
            <h2
              id={`${guide.kind.toLowerCase()}-heading`}
              className="text-ink text-xl font-extrabold sm:text-2xl"
            >
              {guide.label}
            </h2>
            <p className="text-ink-muted mt-1 text-sm">{guide.tool}</p>
            <p className="text-ink-muted mt-3 text-sm sm:text-base">{guide.intro}</p>

            <ol className="mt-6 flex flex-col gap-5">
              {guide.steps.map((step, index) => (
                <li key={step.title} className="flex min-w-0 gap-3 sm:gap-4">
                  <span
                    aria-hidden
                    className="bg-greenbar text-ink flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
                  >
                    {index + 1}
                  </span>
                  <div className="min-w-0">
                    <h3 className="text-ink text-sm font-medium sm:text-base">{step.title}</h3>
                    <p className="text-ink-muted mt-1 break-words text-sm">{step.body}</p>
                  </div>
                </li>
              ))}
            </ol>

            <p className="border-rule bg-greenbar text-ink-muted mt-6 rounded-xl border p-3 text-sm">
              {guide.caveat}
            </p>
          </div>
        </section>
      ))}

      <section className="border-rule border-t">
        <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6">
          <h2 className="text-ink text-xl font-extrabold sm:text-2xl">{content.reviewHeading}</h2>
          <ul className="mt-4 flex flex-col gap-3">
            {content.review.map((line) => (
              <li key={line} className="text-ink-muted flex min-w-0 gap-3 text-sm sm:text-base">
                <span aria-hidden className="text-ink-muted shrink-0">
                  •
                </span>
                <span className="min-w-0">{line}</span>
              </li>
            ))}
          </ul>
          <p className="text-ink-muted mt-4 text-sm">
            {lang === 'bn' ? 'খসড়াগুলো জমা থাকে ' : 'Drafts wait for you in the '}
            <Link href="/inbox" className="text-income underline">
              {inboxLabel}
            </Link>
            {lang === 'bn' ? '-এ।' : '.'}
          </p>
        </div>
      </section>

      <section className="border-rule border-t">
        <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6">
          <h2 className="text-ink text-xl font-extrabold sm:text-2xl">{content.troubleHeading}</h2>
          <dl className="mt-4 flex flex-col gap-4">
            {content.trouble.map((item) => (
              <div key={item.q} className="border-rule min-w-0 rounded-xl border p-3">
                <dt className="text-ink text-sm font-medium">{item.q}</dt>
                <dd className="text-ink-muted mt-1 break-words text-sm">{item.a}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section className="border-rule border-t">
        <div className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6">
          <h2 className="text-ink text-xl font-extrabold sm:text-2xl">{content.ctaHeading}</h2>
          <p className="text-ink-muted mt-2 text-sm sm:text-base">{content.cta}</p>
          <Link
            href={signupHref}
            className="bg-brand text-brand-contrast press mt-5 inline-flex min-h-11 items-center justify-center rounded-xl px-5 text-sm font-semibold"
          >
            {content.ctaButton}
          </Link>
          <p className="text-ink-muted mt-4 text-xs">{SITE.url.replace('https://', '')}</p>
        </div>
      </section>
    </>
  );
}
