import { TUTORIAL_EN } from '../../tutorial/content';
import { Tutorial } from '../../tutorial/tutorial';
import { pageMetadata } from '../../seo';

/**
 * The English tutorial.
 *
 * Same component as `/tutorial`, a different content object — so the two can
 * differ in words and never in structure. `hreflang` points each at the other.
 */
export const metadata = pageMetadata({
  title: 'How to keep your books — rules, mistakes and every feature | Taka Tracker',
  description:
    'Six rules for keeping personal books, the seven mistakes almost everybody makes first (a loan booked as income, a card payment booked as an expense), and everything Taka Tracker does and does not do.',
  path: '/en/tutorial',
  locale: 'en',
  alternatePath: '/tutorial',
  keywords: [
    'personal bookkeeping rules',
    'how to track expenses properly',
    'double entry for personal finance',
    'a loan is not income',
    'cash flow vs profit',
    'reconcile bank statement',
  ],
});

export default function EnglishTutorialPage() {
  return <Tutorial content={TUTORIAL_EN} locale="en" />;
}
