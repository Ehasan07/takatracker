import { SITE } from '../../content';
import { jsonLdScript, pageMetadata } from '../../seo';
import { SMS_EN } from '../../sms/steps';
import { SmsGuideView } from '../../sms/view';
import { smsHowToJsonLd } from '../../sms/json-ld';

export const metadata = pageMetadata({
  title: 'Turn bank SMS into bookkeeping — Android and iPhone | Taka Tracker',
  description:
    'Step-by-step setup for turning bKash, Nagad and bank SMS into accounting entries, on Android and on iPhone. No banking password, no bank connection — every entry waits for you to approve it.',
  path: '/en/sms',
  keywords: [
    'sms to accounting entry',
    'bank sms expense tracker bangladesh',
    'sms forwarder webhook android setup',
    'iphone shortcuts sms automation webhook',
    'bkash nagad sms bookkeeping',
    'automatic expense tracking without bank login',
  ],
  locale: 'en',
  alternatePath: '/sms',
});

export default function SmsPageEn() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLdScript(smsHowToJsonLd(SMS_EN, 'en', SITE.url)) }}
      />
      <SmsGuideView content={SMS_EN} lang="en" />
    </>
  );
}
