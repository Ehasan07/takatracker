import Link from 'next/link';
import { CONTACT } from '../content';
import { pageMetadata } from '../seo';

/**
 * How to have an account erased, on a page anybody can reach.
 *
 * ## Why it is public
 *
 * Google Play and the App Store both require a URL that explains the deletion
 * route and is reachable without signing in, and the URL goes in the console
 * form rather than in the app. But the requirement is the smaller reason: the
 * person most likely to need this page is the one who has already uninstalled,
 * or who cannot get back in — exactly the person a route inside the app cannot
 * serve.
 *
 * ## Why it names what survives
 *
 * Because the alternative is a promise that is not quite true. One row remains
 * after an erasure: a SHA-256 of the address and two dates, kept so the
 * question "was this dealt with?" has an answer when somebody asks a second
 * time. Saying so here costs nothing and buys the rest of the page its
 * credibility — a policy that claims everything vanishes, when something does
 * not, is the kind of small lie people find later.
 */
export const metadata = pageMetadata({
  title: 'অ্যাকাউন্ট ও তথ্য মুছে ফেলা — Taka Tracker | Delete your account',
  description:
    'Taka Tracker অ্যাকাউন্ট ও তার সব তথ্য কীভাবে স্থায়ীভাবে মুছবেন, কী কী মুছে যায়, কতদিন সময় লাগে। How to permanently delete your Taka Tracker account and all associated data.',
  path: '/delete-account',
  locale: 'bn',
  keywords: [
    'delete account',
    'অ্যাকাউন্ট মুছে ফেলা',
    'তথ্য মুছে ফেলা',
    'data deletion',
    'taka tracker delete',
  ],
});

const GONE = [
  'আপনার সব লেনদেন, খাত ও ট্যাগ',
  'সব অ্যাকাউন্ট, ব্যালেন্স ও প্রারম্ভিক জের',
  'ঋণ, কিস্তি, দেনাদার-পাওনাদারের তালিকা',
  'সঞ্চয়, ডিপিএস ও বীমার সব তথ্য',
  'ভাগাভাগির গ্রুপ, তহবিল ও শেয়ার করা লিংক',
  'ফোন বা মেইলবক্স থেকে আসা সব বার্তা ও খসড়া',
  'রসিদের ছবি ও যুক্ত করা ফাইল',
  'কার্যবিবরণী — কে কখন কী বদলেছিল, সেটাও',
  'আপনার নাম, ইমেইল, মোবাইল নম্বর ও পাসওয়ার্ড',
];

export default function DeleteAccountPage() {
  return (
    <>
      <section className="border-rule border-b">
        <div className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6 sm:py-16">
          <p className="text-brand text-xs font-medium sm:text-sm">অ্যাকাউন্ট</p>
          <h1 className="text-ink mt-3 text-3xl font-semibold leading-tight sm:text-4xl">
            অ্যাকাউন্ট ও তথ্য মুছে ফেলা
          </h1>
          <p className="text-ink-muted mt-4 text-base sm:text-lg">
            যেকোনো সময়, নিজে থেকেই, কাউকে না বলে। অনুরোধ করার সাত দিন পর সব স্থায়ীভাবে মুছে যায় —
            ফেরানোর কোনো উপায় থাকে না।
          </p>
        </div>
      </section>

      <section className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6 sm:py-16">
        <h2 className="text-ink text-2xl font-semibold">অ্যাপ থেকে যেভাবে করবেন</h2>
        <ol className="mt-6 flex flex-col gap-4">
          {[
            ['লগইন করুন', <>takatracker.com-এ নিজের অ্যাকাউন্টে ঢুকুন।</>],
            [
              'সেটিংসে যান',
              <>
                নিচে নেমে <strong>অ্যাকাউন্ট বন্ধ করা</strong> অংশটি খুঁজুন।
              </>,
            ],
            [
              'পাসওয়ার্ড দিয়ে নিশ্চিত করুন',
              <>
                পাসওয়ার্ড চাওয়া হয় একটি কারণেই — খোলা অবস্থায় পড়ে থাকা ফোন থেকে যেন কেউ আপনার
                হিসাব মুছে দিতে না পারে।
              </>,
            ],
            [
              'সাত দিন',
              <>
                এই সময়ের মধ্যে মত বদলালে কিছুই করতে হবে না — শুধু লগইন করলেই অনুরোধ বাতিল হয়ে
                যায়। সেটিংসে গিয়ে হাতেও বাতিল করা যায়।
              </>,
            ],
          ].map(([title, body], index) => (
            <li key={String(title)} className="flex min-w-0 gap-3">
              <span
                aria-hidden
                className="bg-brand-tint text-brand flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold"
              >
                {'১২৩৪'[index]}
              </span>
              <div className="min-w-0">
                <p className="text-ink font-medium">{title}</p>
                <p className="text-ink-muted mt-0.5 text-sm">{body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="border-rule border-y">
        <div className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6 sm:py-16">
          <h2 className="text-ink text-2xl font-semibold">কী কী মুছে যায়</h2>
          <p className="text-ink-muted mt-2">সবকিছু। নিচের প্রতিটি জিনিস, স্থায়ীভাবে।</p>
          <ul className="text-ink-muted mt-6 grid gap-2 sm:grid-cols-2">
            {GONE.map((item) => (
              <li key={item} className="rounded-card border-rule bg-surface border p-3 text-sm">
                {item}
              </li>
            ))}
          </ul>

          <h3 className="text-ink mt-10 text-lg font-semibold">কী থেকে যায়, আর কেন</h3>
          <p className="text-ink-muted mt-2 text-sm">
            একটি মাত্র সারি: আপনার ইমেইল ঠিকানার একটি <strong>SHA-256 হ্যাশ</strong> আর দুটি তারিখ —
            কবে অনুরোধ করেছিলেন আর কবে মোছা হয়েছিল। ঠিকানাটি নয়, তার হ্যাশ; ওটা থেকে ঠিকানা বের
            করা যায় না।
          </p>
          <p className="text-ink-muted mt-2 text-sm">
            রাখা হয় একটি কারণে — কেউ যদি পরে জানতে চান "আমার অনুরোধটা কি আসলেই কার্যকর হয়েছিল",
            তার উত্তর দেওয়ার জন্য। এটুকু না রাখলে ঐ প্রশ্নের কোনো উত্তর থাকত না।
          </p>
        </div>
      </section>

      <section className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6 sm:py-16">
        <h2 className="text-ink text-2xl font-semibold">লগইন করতে পারছেন না?</h2>
        <p className="text-ink-muted mt-2">
          অ্যাপ আনইনস্টল করে ফেলেছেন, পাসওয়ার্ড মনে নেই, বা ঢুকতেই পারছেন না — আমাদের জানান, আমরা
          মুছে দেব। যে ইমেইল বা মোবাইল নম্বর দিয়ে অ্যাকাউন্ট খুলেছিলেন সেটি থেকে যোগাযোগ করলে
          পরিচয় যাচাই করা সহজ হয়।
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <a
            href={CONTACT.hotlineHref}
            className="press bg-brand text-brand-contrast inline-flex min-h-12 items-center rounded-md px-6 text-base font-medium hover:opacity-90"
          >
            {CONTACT.hotline}
          </a>
          <a
            href={CONTACT.whatsapp}
            className="press border-rule bg-surface text-ink hover:bg-brand-tint inline-flex min-h-12 items-center rounded-md border px-6 text-base font-medium"
            rel="noopener noreferrer"
            target="_blank"
          >
            WhatsApp
          </a>
        </div>
        <p className="text-ink-muted mt-4 text-sm">
          অনুরোধ পাওয়ার ৩০ দিনের মধ্যে কাজটি সম্পন্ন করা হয়, সাধারণত অনেক আগেই।
        </p>

        <p className="text-ink-muted mt-8 text-sm">
          কে কী দেখতে পারে তার পুরো বিবরণ{' '}
          <Link href="/privacy" className="text-brand underline">
            গোপনীয়তার পাতায়
          </Link>{' '}
          আছে।
        </p>
      </section>
    </>
  );
}
