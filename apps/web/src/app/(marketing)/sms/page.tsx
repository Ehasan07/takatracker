import { SITE } from '../content';
import { jsonLdScript, pageMetadata } from '../seo';
import { SMS_BN } from './steps';
import { SmsGuideView } from './view';
import { smsHowToJsonLd } from './json-ld';

/**
 * How to make bank SMS write your books, in Bengali.
 *
 * Indexed deliberately and separately from `/guide`, which is about installing
 * the app. Two different questions with two different searchers: one is already
 * a user, the other is deciding whether this app would save them any typing at
 * all. Answering the second on a page they can read before signing up is the
 * whole point.
 */
export const metadata = pageMetadata({
  title: 'ব্যাংকের এসএমএস থেকে হিসাব — অ্যান্ড্রয়েড ও আইফোনে | Taka Tracker',
  description:
    'বিকাশ, নগদ বা ব্যাংকের এসএমএস থেকে সরাসরি লেনদেন বসানোর ধাপে-ধাপে নির্দেশনা — অ্যান্ড্রয়েড ও আইফোন দুটোর জন্যই। ব্যাংকের পাসওয়ার্ড লাগে না, প্রতিটি এন্ট্রি আপনি দেখে অনুমোদন করেন। Turn bank SMS into accounting entries on Android and iPhone.',
  path: '/sms',
  keywords: [
    'এসএমএস থেকে হিসাব',
    'বিকাশ এসএমএস হিসাব',
    'sms to accounting entry',
    'bank sms auto expense tracker bangladesh',
    'sms forwarder webhook android',
    'iphone shortcuts sms automation',
    'bkash sms expense tracker',
  ],
  alternatePath: '/en/sms',
});

export default function SmsPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: jsonLdScript(smsHowToJsonLd(SMS_BN, 'bn-BD', SITE.url)),
        }}
      />
      <SmsGuideView content={SMS_BN} lang="bn" />
    </>
  );
}
