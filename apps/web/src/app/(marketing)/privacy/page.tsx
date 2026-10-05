import { CONTACT, SITE } from '../content';
import { pageMetadata } from '../seo';

/**
 * What we hold, who can see it, and what we do with it.
 *
 * ## Why this page names the operator
 *
 * A privacy policy that lists cookie categories and never mentions that a
 * member of staff can open your ledger is not a privacy policy, it is a
 * disclaimer. Taka Tracker's operator panel can read a workspace's balances —
 * deliberately, because somebody has to be able to answer "my numbers look
 * wrong" — and every such view is written to an audit log the customer can
 * read. Both halves of that belong on this page in plain Bengali, above the
 * boilerplate, not buried under it.
 *
 * The feature card on the landing page used to end "no exception" and had that
 * clause trimmed when the operator panel gained balance access; this is the
 * page that clause was trimmed in favour of.
 *
 * ## Why it is static
 *
 * No fetch, no revalidation, nothing that can be stale or fail. A privacy
 * statement that 500s is worse than one that is a week behind.
 */

export const metadata = pageMetadata({
  title: 'গোপনীয়তা — Taka Tracker | Privacy',
  description:
    'আপনার হিসাব কোথায় থাকে, কে দেখতে পারে, আর কী কারণে। Taka Tracker-এর গোপনীয়তা নীতি — সরল বাংলায়, লুকোছাপা ছাড়া। What we store, who can read it, and why.',
  path: '/privacy',
  locale: 'bn',
  keywords: ['privacy policy bangladesh finance app', 'গোপনীয়তা নীতি', 'ডেটা সুরক্ষা'],
});

const UPDATED = '১৪ আগস্ট ২০২৬';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-rule border-t pt-6">
      <h2 className="text-ink text-lg font-semibold">{title}</h2>
      <div className="text-ink-muted mt-2 space-y-3 text-sm leading-relaxed">{children}</div>
    </section>
  );
}

export default function PrivacyPage() {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6">
      <header>
        <p className="text-ink-muted text-xs font-semibold">Taka Tracker</p>
        <h1 className="text-ink mt-1 text-[28px] font-extrabold leading-tight sm:text-[38px]">
          গোপনীয়তা
        </h1>
        <p className="text-ink-muted mt-2 text-sm">
          সর্বশেষ হালনাগাদ: {UPDATED}. এই পাতাটা আইনজীবীর জন্য নয়, আপনার জন্য লেখা।
        </p>
      </header>

      <div className="mt-8 space-y-6">
        {/* First, because it is the thing nobody else tells you. */}
        <Section title="আমাদের কেউ কি আপনার হিসাব দেখতে পারে?">
          <p>
            <strong className="text-ink">পারে — এবং কখন পারে সেটা এখানে লেখা আছে।</strong> Taka
            Tracker-এর অপারেটর প্যানেল থেকে আমরা কোনো ওয়ার্কস্পেসের{' '}
            <strong className="text-ink">অ্যাকাউন্টের ব্যালেন্স ও সারসংক্ষেপ</strong> দেখতে পারি।
            এটা ইচ্ছাকৃত: “আমার হিসাব মিলছে না” বললে কাউকে তো দেখতে হবে।
          </p>
          <p>
            যা আমরা <strong className="text-ink">দেখি না</strong> — আপনার পাসওয়ার্ড (সেটা আর্গন-টু
            দিয়ে হ্যাশ করা, ফেরত পড়ার উপায় নেই) আর আপনার সংযুক্ত মেইলবক্সের চিঠি, যেগুলো আপনার
            নিজের ওয়ার্কস্পেসেই থাকে।
          </p>
          <p>
            <strong className="text-ink">প্রতিবার দেখলে তার রেকর্ড থাকে।</strong> অপারেটর কখন কোন
            ওয়ার্কস্পেসের টাকার হিসাব খুলেছে, সেটা আলাদা করে লেখা হয় — “প্ল্যান দেখেছে” আর “টাকা
            দেখেছে” দুটো আলাদা সারি। আপনি নিজের <strong className="text-ink">কার্যবিবরণী</strong>{' '}
            পাতায় সেটা পড়তে পারবেন। আমরা মুছতে পারি না; ওই তালিকায় কিছু বদলানোর কোনো পথ কোডে নেই।
          </p>
        </Section>

        <Section title="কী কী রাখা হয়">
          <ul className="list-disc space-y-1 pl-5">
            <li>আপনার নাম, ইমেইল আর মোবাইল নম্বর — অ্যাকাউন্ট চেনার জন্য।</li>
            <li>আপনার লেনদেন, অ্যাকাউন্ট, খাত, ট্যাগ, ধার-দেনা, সঞ্চয় ও বীমার তথ্য।</li>
            <li>যেসব ডিভাইস থেকে সাইন-ইন করেছেন — সেটিংসে তালিকা আছে, চাইলে সরাতে পারেন।</li>
            <li>সংযুক্ত করলে: টেলিগ্রাম আইডি, মেইলবক্সের চিঠি, আপলোড করা রসিদ।</li>
          </ul>
          <p>
            টাকার অঙ্ক পূর্ণসংখ্যা পয়সায় রাখা হয় আর প্রতিটি লেনদেন ডাবল-এন্ট্রিতে লেখা — এটা
            গোপনীয়তার কথা নয়, নির্ভুলতার কথা, কিন্তু জেনে রাখা ভালো।
          </p>
        </Section>

        <Section title="কোথায় থাকে">
          <p>
            জার্মানিতে একটি ভাড়া করা সার্ভারে, PostgreSQL ডাটাবেসে। যাওয়া-আসার পথ HTTPS দিয়ে
            এনক্রিপ্টেড। প্রতিদিন ব্যাকআপ নেওয়া হয় এবং প্রতিটি হালনাগাদের আগে আলাদা করে একটা
            ব্যাকআপ রাখা হয়।
          </p>
          <p>
            প্রতিটি ওয়ার্কস্পেসের তথ্য নিজের ওয়ার্কস্পেসে, আর প্রতিটি প্রশ্ন ওয়ার্কস্পেস ধরেই করা
            হয় — উপরের অপারেটর প্যানেলই এর একমাত্র ব্যতিক্রম।
          </p>
        </Section>

        <Section title="কাকে দেওয়া হয়">
          <p>
            <strong className="text-ink">
              বিজ্ঞাপনদাতাকে নয়। কোনো ডেটা ব্রোকারকে নয়। বিক্রি করা হয় না।
            </strong>{' '}
            যাদের ছাড়া অ্যাপটা চলে না, শুধু তাদের কাছে যতটুকু দরকার ততটুকু যায়:
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>ইমেইল পাঠানোর সেবা — আপনার ইমেইল ঠিকানা আর চিঠির লেখা।</li>
            <li>এসএমএস গেটওয়ে — শুধু বাংলাদেশি নম্বর আর কোডটুকু, কখনো তিনবারের বেশি নয়।</li>
            <li>টেলিগ্রাম — আপনি নিজে যুক্ত করলে, রিমাইন্ডার পাঠাতে।</li>
          </ul>
          <p>
            আদালতের বৈধ আদেশ ছাড়া আর কাউকে নয়। এমন কিছু ঘটলে, আইনে নিষেধ না থাকলে, আপনাকে জানানো
            হবে।
          </p>
        </Section>

        <Section title="আপনি যেসব লিংক শেয়ার করেন">
          <p>
            বিবরণী শেয়ারের লিংক <strong className="text-ink">লিংকটাই চাবি</strong> — যার কাছে লিংক
            আছে সে অ্যাকাউন্ট ছাড়াই দেখতে পাবে। তাই লিংকের মেয়াদ থাকে (সর্বোচ্চ এক বছর), আপনি
            যেকোনো সময় বাতিল করতে পারেন, আর কতবার খোলা হয়েছে সেটা আপনাকে দেখানো হয়।
          </p>
          <p>
            সার্চ ইঞ্জিন যাতে না পায় সে জন্য ওই পাতাগুলোতে <code>noindex</code> দেওয়া থাকে, আর
            ক্যাশে রাখা বারণ করা থাকে। তবু: লিংকটা যাকে পাঠাচ্ছেন তাকেই পাঠান।
          </p>
        </Section>

        <Section title="আপনার অধিকার">
          <ul className="list-disc space-y-1 pl-5">
            <li>নিজের সব তথ্য নামিয়ে নিতে পারেন — সেটিংস থেকে।</li>
            <li>অ্যাকাউন্ট মুছে দিতে বললে ওয়ার্কস্পেসসহ সব মুছে যাবে।</li>
            <li>ভুল তথ্য যেকোনো সময় নিজে ঠিক করতে পারেন।</li>
            <li>কে কী দেখেছে, কার্যবিবরণীতে পড়তে পারেন।</li>
          </ul>
        </Section>

        <Section title="কুকি">
          <p>
            শুধু সাইন-ইন রাখার জন্য দুটি কুকি। কোনো বিজ্ঞাপনের ট্র্যাকার নেই, তৃতীয় পক্ষের
            অ্যানালিটিক্স নেই, ফেসবুক পিক্সেল নেই।
          </p>
        </Section>

        <Section title="প্রশ্ন থাকলে">
          <p>
            হটলাইন{' '}
            <a className="text-brand underline" href={CONTACT.hotlineHref}>
              {CONTACT.hotline}
            </a>
            , অথবা{' '}
            <a className="text-brand underline" href={CONTACT.telegram}>
              টেলিগ্রামে
            </a>
            . {SITE.name} বাংলাদেশ থেকে পরিচালিত।
          </p>
        </Section>
      </div>
    </div>
  );
}
