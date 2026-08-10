/**
 * Everything first run says, in one place.
 *
 * The account types are copied from `accounts/page.tsx` rather than imported:
 * that module is a route component and exports only its default, and reaching
 * into a page to borrow a constant would make the two files depend on each
 * other's shape for no benefit. The nine values themselves come from the API's
 * enum, which is the real source of truth for both.
 */

export type StepId = 'accounts' | 'entry' | 'next';

export interface Step {
  id: StepId;
  /** The stepper's accessible name, and the heading once the step is open. */
  title: string;
  /** One line under the heading saying why this step exists. */
  blurb: string;
}

/**
 * Three, and only the first one matters.
 *
 * A double-entry ledger cannot record a single expense until money has
 * somewhere to come from, so "where your money is" is not a nicety — it is the
 * one thing that has to happen before the app does anything at all. The other
 * two are there so the dashboard is not empty on arrival and so nobody has to
 * discover the rest of the product by accident.
 */
export const STEPS: Step[] = [
  {
    id: 'accounts',
    title: 'টাকা কোথায় আছে',
    blurb:
      'হাতের নগদ, ব্যাংক, বিকাশ — যেখানে যা আছে বলে দিন। খরচ লিখতে হলে টাকাটা কোথা থেকে যাচ্ছে তা জানা দরকার, তাই এই ধাপটাই আসল।',
  },
  {
    id: 'entry',
    title: 'প্রথম লেনদেন',
    blurb: 'একটা কিছু লিখে রাখলে কাল খাতা খুলে দেখার মতো কিছু থাকে। না লিখলেও চলবে।',
  },
  {
    id: 'next',
    title: 'এরপর কী আছে',
    blurb: 'এগুলো এখনকার ধাপ নয় — শুধু জেনে রাখুন কোথায় কী পাবেন।',
  },
];

export const STEP_ORDER: StepId[] = STEPS.map((step) => step.id);

/** Every account type the API accepts, grouped the way the accounts screen groups them. */
export const ACCOUNT_TYPES: { value: string; label: string; group: string }[] = [
  { value: 'CASH', label: 'নগদ', group: 'হাতে ও ব্যাংকে' },
  { value: 'BANK', label: 'ব্যাংক', group: 'হাতে ও ব্যাংকে' },
  { value: 'MOBILE_WALLET', label: 'মোবাইল ওয়ালেট', group: 'হাতে ও ব্যাংকে' },
  { value: 'SAVINGS', label: 'সঞ্চয় / ডিপিএস', group: 'হাতে ও ব্যাংকে' },
  { value: 'ASSET', label: 'সম্পদ (জমি, স্বর্ণ, গাড়ি)', group: 'সম্পদ' },
  { value: 'RECEIVABLE', label: 'পাওনা (যা আমি পাব)', group: 'সম্পদ' },
  { value: 'CREDIT_CARD', label: 'ক্রেডিট কার্ড', group: 'দায়' },
  { value: 'LIABILITY', label: 'ঋণ / দায়', group: 'দায়' },
  { value: 'PAYABLE', label: 'দেনা (যা আমি দেব)', group: 'দায়' },
];

export const TYPE_GROUPS = ['হাতে ও ব্যাংকে', 'সম্পদ', 'দায়'] as const;

export const typeLabel = (value: string): string =>
  ACCOUNT_TYPES.find((type) => type.value === value)?.label ?? value;

export interface AccountSuggestion {
  id: string;
  name: string;
  type: string;
}

/**
 * The accounts a household in Bangladesh actually has, in the order it would
 * name them.
 *
 * Only the asset side is offered. "How much is in it" is an unambiguous
 * question for cash, a wallet, a bank and a DPS, and a misleading one for a
 * credit card, where the balance a person quotes is what they owe. Cards,
 * loans, land and gold are all still reachable through অন্য কিছু below, which
 * asks for the type explicitly.
 *
 * "নগদ" is the wallet, not the cash — so the cash row is named হাতের নগদ. Two
 * rows called নগদ in the account picker would be worse than a longer label.
 */
export const ACCOUNT_SUGGESTIONS: AccountSuggestion[] = [
  { id: 'cash', name: 'হাতের নগদ', type: 'CASH' },
  { id: 'bkash', name: 'বিকাশ', type: 'MOBILE_WALLET' },
  { id: 'nagad', name: 'নগদ', type: 'MOBILE_WALLET' },
  { id: 'rocket', name: 'রকেট', type: 'MOBILE_WALLET' },
  { id: 'upay', name: 'উপায়', type: 'MOBILE_WALLET' },
  { id: 'bank', name: 'ব্যাংক অ্যাকাউন্ট', type: 'BANK' },
  { id: 'dps', name: 'সঞ্চয় / ডিপিএস', type: 'SAVINGS' },
];

export interface NextStep {
  href: string;
  title: string;
  body: string;
  /**
   * What has to be true somewhere else before this can work at all.
   *
   * Present on exactly the two features that cannot be finished from inside
   * this app, and printed in full. Listing SMS forwarding without saying that
   * it needs a forwarding app on the phone, or mail without saying that
   * Microsoft addresses are refused outright, would make first run a promise
   * the product does not keep.
   */
  caveat?: string;
}

export const NEXT_STEPS: NextStep[] = [
  {
    href: '/loans',
    title: 'ধার-দেনা',
    body: 'কাকে কত দিয়েছেন আর কার কাছে কত পাওনা — কিস্তি, সুদ আর ফেরতের তারিখসহ।',
  },
  {
    href: '/reports',
    title: 'রিপোর্ট',
    body: 'মাস ধরে টাকা কোন খাতে গেল, আর আয়-খরচের পার্থক্য কোথায় দাঁড়াল।',
  },
  {
    href: '/import',
    title: 'স্টেটমেন্ট আমদানি',
    body: 'ব্যাংক বা বিকাশের সিএসভি ফাইল থেকে পুরনো লেনদেন একসঙ্গে তোলা যায়।',
  },
  {
    href: '/settings',
    title: 'এসএমএস থেকে খসড়া',
    body: 'ব্যাংক ও ওয়ালেটের এসএমএস থেকে লেনদেনের খসড়া তৈরি হয়। আপনি না বললে কোনো খসড়া খাতায় ওঠে না।',
    caveat:
      'এখানে চালু হবে না — ফোনে একটি এসএমএস ফরোয়ার্ডিং অ্যাপ বসিয়ে তাতে সেটিংসের ঠিকানা ও গোপন কোড বসাতে হয়।',
  },
  {
    href: '/settings',
    title: 'মেইলবক্স যুক্ত করা',
    body: 'ব্যাংকের ইমেইল বিবরণী অ্যাপের ভেতরেই পড়া যায়।',
    caveat:
      'এখানে চালু হবে না — সেটিংসে গিয়ে মেইলবক্সের ঠিকানা ও পাসওয়ার্ড দিতে হয়। মাইক্রোসফটের ঠিকানা (Outlook, Hotmail, Live) এখনও কাজই করে না।',
  },
];
