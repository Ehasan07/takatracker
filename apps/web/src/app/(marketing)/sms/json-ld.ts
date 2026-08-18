import type { SmsContent } from './steps';

/**
 * One `HowTo` per phone, plus the troubleshooting as an `FAQPage`.
 *
 * Both are on the same page, which is why they are wrapped in a `@graph`: two
 * separate `<script>` blocks describing one document is legal and is read as
 * two documents by some consumers.
 *
 * `HowTo` earns the step-by-step treatment in a search result, and it is also
 * the shape an assistant reads when somebody asks it "how do I get my bank SMS
 * into my accounts app" — which is increasingly how this page will be found at
 * all. The step text is the same prose a human reads: writing a summary for
 * machines and a different one for people is how the two drift apart.
 */
export function smsHowToJsonLd(
  content: SmsContent,
  language: string,
  siteUrl: string,
): Record<string, unknown> {
  const path = language === 'en' ? '/en/sms' : '/sms';
  return {
    '@context': 'https://schema.org',
    '@graph': [
      ...content.guides.map((guide) => ({
        '@type': 'HowTo',
        name: `${content.title} — ${guide.label}`,
        description: guide.intro,
        inLanguage: language,
        totalTime: 'PT5M',
        tool: [{ '@type': 'HowToTool', name: guide.tool }],
        supply: [],
        step: guide.steps.map((step, index) => ({
          '@type': 'HowToStep',
          position: index + 1,
          name: step.title,
          text: step.body,
          url: `${siteUrl}${path}#${guide.kind.toLowerCase()}`,
        })),
      })),
      {
        '@type': 'FAQPage',
        inLanguage: language,
        mainEntity: content.trouble.map((item) => ({
          '@type': 'Question',
          name: item.q,
          acceptedAnswer: { '@type': 'Answer', text: item.a },
        })),
      },
    ],
  };
}
