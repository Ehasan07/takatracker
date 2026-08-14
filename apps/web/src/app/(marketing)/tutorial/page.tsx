import { TUTORIAL_BN } from './content';
import { Tutorial } from './tutorial';
import { pageMetadata } from '../seo';

/**
 * How to keep books, in Bengali, for somebody who has not signed up.
 *
 * Public on purpose. The rules on this page are the ones that decide whether a
 * ledger is worth keeping at all, and they are the same rules whichever
 * software somebody ends up using — so putting them behind a login would be
 * withholding the part that is not ours to withhold. It is also, in practice,
 * the best argument the product has: a visitor who understands why a loan is
 * not income understands why a list of expenses was never going to be enough.
 */
export const metadata = pageMetadata({
  title: 'কীভাবে হিসাব রাখবেন — নিয়ম, ভুল ও পুরো ফিচার তালিকা | Taka Tracker',
  description:
    'ব্যক্তিগত হিসাব রাখার ছয়টি নিয়ম, সবচেয়ে বেশি হওয়া সাতটি ভুল (ধারকে খরচ লেখা, কার্ডের বিলকে খরচ লেখা), আর Taka Tracker-এ কী কী আছে ও কী নেই। How to keep personal books properly — rules, common mistakes, and the full feature list.',
  path: '/tutorial',
  locale: 'bn',
  alternatePath: '/en/tutorial',
  keywords: [
    'হিসাব রাখার নিয়ম',
    'ব্যক্তিগত হিসাব',
    'ডাবল এন্ট্রি',
    'খরচের হিসাব কিভাবে রাখব',
    'personal bookkeeping rules',
    'how to track expenses',
    'double entry for personal finance',
    'loan is not income',
  ],
});

export default function TutorialPage() {
  return <Tutorial content={TUTORIAL_BN} locale="bn" />;
}
