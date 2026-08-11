import { CONTENT_EN } from '../content.en';
import { Landing } from '../home/page';
import { pageMetadata } from '../seo';

/**
 * The English landing page.
 *
 * Same components as `/`, different content object — so the two pages cannot
 * drift apart in structure, only in words. `hreflang` points each at the other
 * and names Bengali as the default, which is what stops a crawler treating them
 * as duplicates and keeping whichever it saw first.
 */
export const metadata = pageMetadata({
  title: 'Taka Tracker — Double-entry personal finance app for Bangladesh',
  description:
    'Track income, expenses, loans given and taken, DPS savings and insurance in one double-entry ledger. Free forever plan, works offline, 140+ currencies. Built for Bangladesh, in Bangla and English.',
  path: '/en',
  locale: 'en',
  alternatePath: '/',
  keywords: [
    'personal finance app bangladesh',
    'double entry personal accounting',
    'expense tracker app',
    'money manager bangladesh',
    'loan tracker app',
    'dps savings tracker',
    'free budgeting app',
    'offline expense tracker',
  ],
});

export default function EnglishLandingPage() {
  return <Landing content={CONTENT_EN} locale="en" />;
}
