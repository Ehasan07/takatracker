import { CONTENT_EN } from '../../content.en';
import { Pricing } from '../../pricing/page';
import { pageMetadata } from '../../seo';

export const metadata = pageMetadata({
  title: 'Pricing — Taka Tracker',
  description:
    'Free forever: two accounts, unlimited transactions, unlimited debtors and creditors. Premium is ৳350 a month or ৳3600 a year for everything unlimited.',
  path: '/en/pricing',
  locale: 'en',
  alternatePath: '/pricing',
  keywords: ['personal finance app pricing', 'free expense tracker', 'budget app price bangladesh'],
});

/* Same revalidation as the Bengali page: both read the prices the API enforces
   rather than carrying their own copy. */
export const revalidate = 3600;

export default function EnglishPricingPage() {
  return <Pricing content={CONTENT_EN} locale="en" />;
}
