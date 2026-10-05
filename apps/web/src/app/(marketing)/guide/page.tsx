import { GUIDES } from './steps';
import { jsonLdScript, pageMetadata } from '../seo';
import { SITE } from '../content';
import { DeviceGuidePanel } from './device-guide';

/**
 * How to install Taka Tracker on a phone.
 *
 * Public, and indexed on purpose: "personal finance app" searches are answered
 * by app-store listings, and a web app with no store entry has to be able to
 * answer "how do I get it on my phone?" itself. It is also the page the FAQ's
 * offline answer links to, and the one to send somebody who says the app "is
 * just a website".
 *
 * Every device's steps are in the server HTML — the tabs only choose which is
 * on top. A crawler and a reader with JavaScript still loading both get the
 * whole thing.
 */
export const metadata = pageMetadata({
  title: 'ফোনে ইনস্টল করবেন যেভাবে — Taka Tracker | Install guide',
  description:
    'আইফোন, অ্যান্ড্রয়েড বা কম্পিউটারে Taka Tracker হোম স্ক্রিনে বসানোর ধাপে-ধাপে নির্দেশনা, ছবিসহ। ইনস্টল করলে অফলাইনেও চলে। Step-by-step guide to install the app on iPhone, Android or desktop.',
  path: '/guide',
  keywords: [
    'add to home screen iphone',
    'install web app android',
    'হোম স্ক্রিনে যোগ করুন',
    'অ্যাপ ইনস্টল',
  ],
});

/** `HowTo`, one per device, so a search result can carry the steps themselves. */
function howToJsonLd() {
  return {
    '@context': 'https://schema.org',
    '@graph': GUIDES.map((guide) => ({
      '@type': 'HowTo',
      name: `Install Taka Tracker on ${guide.labelEn}`,
      inLanguage: 'bn-BD',
      totalTime: 'PT1M',
      tool: [{ '@type': 'HowToTool', name: guide.browser }],
      step: guide.steps.map((step, index) => ({
        '@type': 'HowToStep',
        position: index + 1,
        name: step.title,
        text: step.body,
        url: `${SITE.url}/guide#${guide.kind.toLowerCase()}`,
      })),
    })),
  };
}

export default function GuidePage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLdScript(howToJsonLd()) }}
      />

      <section className="border-rule border-b">
        <div className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6 sm:py-16">
          <h1 className="text-ink text-[38px] font-extrabold leading-[1.12] tracking-[-0.015em] sm:text-[52px]">
            ফোনে বসাবেন যেভাবে
          </h1>
          <p className="text-ink-muted mt-3">
            Taka Tracker স্টোর থেকে নামাতে হয় না। ব্রাউজার থেকেই হোম স্ক্রিনে বসিয়ে নিলে অ্যাপের
            মতোই খোলে — এক মিনিটের কাজ, আর নেট না থাকলেও চলে।
          </p>
        </div>
      </section>

      <section className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6">
        <DeviceGuidePanel />
      </section>

      {/* Every device's steps, in the HTML, whatever the tabs are showing. A
          crawler reads this; a reader never sees it twice. */}
      <div className="sr-only">
        {GUIDES.map((guide) => (
          <section key={guide.kind} id={guide.kind.toLowerCase()}>
            <h2>{guide.label}</h2>
            <p>{guide.caveat}</p>
            <ol>
              {guide.steps.map((step) => (
                <li key={step.title}>
                  <h3>{step.title}</h3>
                  <p>{step.body}</p>
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>
    </>
  );
}
