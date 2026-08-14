/**
 * What the public pages say, in one file.
 *
 * Marketing copy drifts from the product faster than anything else in a
 * codebase, and the usual way it happens is that a claim lives inside the JSX
 * of a section nobody opens again. Keeping the claims as data makes the drift
 * visible: `SHIPPED` is a list somebody can read next to the route table, and
 * `COMING` is a list that has to shrink.
 *
 * The rule for this file: **nothing in `SHIPPED` may be something you cannot
 * do today on takatracker.com.** Every entry below names the screen it is
 * about. A feature that is half-built belongs in `COMING`, however close it is.
 */

export interface Feature {
  /** Bengali, because that is the language of the product. */
  title: string;
  /** English, because half of Bangladesh searches in it and so does Google. */
  titleEn: string;
  body: string;
  /** The route it is about — kept so a claim can be checked against the app. */
  route: string;
}

export interface FeatureGroup {
  id: string;
  heading: string;
  headingEn: string;
  blurb: string;
  features: Feature[];
}

/**
 * Everything a marketing page renders, in one language.
 *
 * The Bengali and English pages are the *same* components fed two of these, so
 * a section added to one cannot quietly be missing from the other — the type
 * would not compile. `content.en.ts` is the second one.
 */
export interface Hero {
  eyebrow: string;
  title: string;
  subtitle: string;
  /** A second line in the *other* language, for the search engine's benefit. */
  subtitleEn: string;
  primaryCta: string;
  secondaryCta: string;
}

export interface SiteContent {
  hero: Hero;
  proof: { value: string; label: string }[];
  steps: { title: string; body: string }[];
  groups: FeatureGroup[];
  coming: { title: string; body: string }[];
  faq: { q: string; a: string }[];
  nav: { href: string; label: string }[];
  ui: UiStrings;
}

/** The handful of strings that belong to the page furniture rather than a section. */
export interface UiStrings {
  featuresHeading: string;
  featuresBlurb: [string, string];
  stepsHeading: string;
  stepsBlurb: string;
  comingHeading: string;
  comingBlurb: string;
  faqHeading: string;
  ledgerHeading: string;
  ledgerBodyA: string;
  ledgerBodyB: string;
  ledgerResultHeading: string;
  ledgerResults: string[];
  ledgerFootnote: string;
  closingHeading: string;
  closingBody: string;
  closingSecondary: string;
  heroNote: string;
  proofLabel: string;
  login: string;
  startFree: string;
  otherLocaleLabel: string;
  otherLocaleHref: string;
}

/**
 * The pitch, in one sentence each, for the three things somebody decides in
 * the first ten seconds: what is it, who is it for, why not a spreadsheet.
 */
export const HERO: Hero = {
  eyebrow: 'বাংলাদেশের জন্য তৈরি ব্যক্তিগত হিসাবের সফটওয়্যার',
  title: 'আপনার টাকা কোথায় যায়, শেষ পয়সাটা পর্যন্ত',
  /* English rides in the subtitle rather than the headline. A Bengali speaker
     reading a Bengali product should meet Bengali first; the English line is
     for the same person searching "personal finance app bangladesh" an hour
     earlier, and for the crawler that read that search. */
  subtitle:
    'আয়, খরচ, ধার-দেনা, সঞ্চয় আর বীমা — সব এক খাতায়। ডাবল-এন্ট্রি হিসাবরক্ষণের উপর তৈরি, তাই যোগফল কখনো মেলে না এমন হয় না।',
  subtitleEn: 'A double-entry personal finance app for Bangladesh. Web and mobile, in Bangla.',
  primaryCta: 'ফ্রি অ্যাকাউন্ট খুলুন',
  secondaryCta: 'দাম দেখুন',
};

/**
 * Numbers a visitor can check, not numbers we wish were true.
 *
 * No download count, no star rating, no "trusted by 10,000 families" — the
 * product launched this month and every one of those would be a lie. What is
 * left is what the engineering actually guarantees, which is a better claim
 * anyway: the reference sites lead with 14M downloads because they cannot lead
 * with correctness.
 */
export const PROOF: { value: string; label: string }[] = [
  { value: 'ডাবল-এন্ট্রি', label: 'প্রতিটি লেনদেনের দুই দিক, ডেবিট আর ক্রেডিট' },
  { value: '০.০০ পয়সা', label: 'সব হিসাব পূর্ণসংখ্যা পয়সায় — দশমিকের ভুল অসম্ভব' },
  { value: '১০০% বাংলা', label: 'পর্দা, রিপোর্ট, তারিখ, সংখ্যা — সবই বাংলায়' },
  { value: 'অফলাইনেও', label: 'নেট না থাকলে এন্ট্রি জমা থাকে, ফিরলে নিজেই যায়' },
];

/**
 * How it works, in three steps.
 *
 * Borrowed shape, not borrowed content: every reference site opens with a
 * three-step strip because somebody deciding whether to sign up wants to know
 * what the next ten minutes look like, not what the product is called.
 */
export const STEPS: { title: string; body: string }[] = [
  {
    title: 'টাকা কোথায় আছে বলুন',
    body: 'ব্যাংক, বিকাশ-নগদ-রকেট, হাতের নগদ, ক্রেডিট কার্ড — যেখানে যা আছে একবার বসিয়ে দিন। দুই মিনিটের কাজ।',
  },
  {
    title: 'খরচ লিখুন, যেভাবে সহজ',
    body: 'অ্যাপে টাইপ করুন, অথবা টেলিগ্রামে পাঠান। ব্যাংকের এসএমএস থেকে খসড়া তৈরি হয় — আপনি না বললে খাতায় ওঠে না।',
  },
  {
    title: 'মাস শেষে উত্তর পান',
    body: 'কোথায় গেল, কার কাছে পাব, কাকে দেব, গত মাসের চেয়ে কত বেশি — রিপোর্ট নিজেই বলে দেয়।',
  },
];

export const GROUPS: FeatureGroup[] = [
  {
    id: 'ledger',
    heading: 'খাতা, যেমন হওয়া উচিত',
    headingEn: 'Double-entry bookkeeping',
    blurb:
      'বেশিরভাগ খরচের অ্যাপ একটা তালিকা রাখে। এটা খাতা রাখে — প্রতিটি টাকা কোথা থেকে এল আর কোথায় গেল, দুই দিকই লেখা থাকে।',
    features: [
      {
        title: 'ডাবল-এন্ট্রি লেজার',
        titleEn: 'Double-entry ledger',
        body: 'প্রতিটি লেনদেনের ডেবিট আর ক্রেডিট সমান — এটা নিয়ম নয়, ডাটাবেজের শর্ত। অসমান কিছু লেখাই যায় না।',
        route: '/transactions',
      },
      {
        title: 'অ্যাকাউন্ট ও ব্যালেন্স',
        titleEn: 'Accounts and balances',
        body: 'ব্যাংক, মোবাইল ব্যাংকিং, নগদ, ক্রেডিট কার্ড। প্রারম্ভিক জের থেকে আজকের ব্যালেন্স, নিজে থেকেই।',
        route: '/accounts',
      },
      {
        title: 'সম্পদের পুনর্মূল্যায়ন',
        titleEn: 'Revaluing an asset',
        body: 'জমি বা স্বর্ণের এখনকার দাম বসিয়ে দিন, ইতিহাসসহ। এটা আয় নয় এবং নগদ প্রবাহেও যায় না — শুধু নিট সম্পদ বদলায়, কারণ কিছু বিক্রি হয়নি।',
        route: '/accounts',
      },
      {
        title: 'ক্যাটাগরি ও সাব-ক্যাটাগরি',
        titleEn: 'Categories and sub-categories',
        body: '২১টি খাত আগে থেকেই বসানো, নিচে যত ইচ্ছে সাব-ক্যাটাগরি। রিপোর্টে সাব-ক্যাটাগরি মূল খাতে যোগ হয়।',
        route: '/categories',
      },
      {
        title: 'ট্যাগ',
        titleEn: 'Tags',
        body: 'খাত বলে টাকা কীসে গেল, ট্যাগ বলে কার জন্য — পারিবারিক, ব্যবসা, রমজান। একটি লেনদেনে যতগুলো দরকার।',
        route: '/tags',
      },
      {
        title: 'অ্যাকাউন্টের বিবরণী',
        titleEn: 'Statement of account',
        body: 'ব্যাংকের স্টেটমেন্টের মতো — প্রারম্ভিক জের, ডেবিট-ক্রেডিট কলাম, প্রতি সারিতে চলতি জের, সমাপনী জের। প্রিন্ট করুন, এক্সেলে নামান, বা লিংক পাঠান।',
        route: '/accounts',
      },
      {
        title: 'ব্যাংক মেলানো',
        titleEn: 'Reconciliation',
        body: 'আসল ব্যালেন্স লিখে দিন, পার্থক্যটা সমন্বয় হিসেবে বসে যাবে। খাতা আর ব্যাংক আর আলাদা থাকবে না।',
        route: '/accounts',
      },
    ],
  },
  {
    id: 'loans',
    heading: 'ধার-দেনা, আন্তর্জাতিক নিয়মে',
    headingEn: 'Loans and party ledger',
    blurb:
      'কার কাছে পাবেন, কাকে দেবেন, কিস্তি কতটা বাকি। QuickBooks বা Zoho যেভাবে রাখে সেভাবেই — ধার আয়ও নয়, খরচও নয়।',
    features: [
      {
        title: 'ধার দেওয়া ও নেওয়া',
        titleEn: 'Money lent and borrowed',
        body: 'দুই দিক আলাদা রাখা। ধার নেওয়া টাকা দায়, ধার দেওয়া টাকা সম্পদ — কোনোটাই আয় বা খরচ নয়।',
        route: '/loans',
      },
      {
        title: 'কিস্তি ও চলমান জের',
        titleEn: 'Instalments with running balance',
        body: 'প্রতিটি কিস্তির পর কত বাকি, সুদ আলাদা করে। সুদ শোধের দিনেই থেমে যায়, পরদিন আবার বাড়ে না।',
        route: '/loans',
      },
      {
        title: 'পার্টি লেজার',
        titleEn: 'Party ledger',
        body: 'একজন মানুষের সব ঋণ এক পাতায়, এক চলমান জেরে। ফোন তোলার আগে "আমাদের মধ্যে কত" এক নম্বরে।',
        route: '/loans',
      },
      {
        title: 'বিবরণী ও এক্সপোর্ট',
        titleEn: 'Statements and CSV export',
        body: 'তারিখ ধরে কেটে নিন, CSV নামান — Excel বাংলা ঠিকঠাক পড়বে। ছাপালে কাগজেও পরিষ্কার।',
        route: '/loans',
      },
      {
        title: 'মানুষজন',
        titleEn: 'Contacts',
        body: 'নাম, ফোন, সম্পর্ক ঠিক করুন। একই মানুষ দুবার লেখা হলে মিলিয়ে দিন — হিসাব দুই ভাগে থাকবে না।',
        route: '/people',
      },
      {
        title: 'প্রত্যেকের নিজস্ব কোড',
        titleEn: 'A code per person',
        body: 'P-0001, P-0002 — একই নামের দুজন আলাদা থাকে। মোবাইল নম্বর দিলে একই মানুষ দুবার তৈরি হয় না, তাই তাঁর ধার আর ট্রিপের হিসাব এক জায়গাতেই থাকে।',
        route: '/people',
      },
    ],
  },
  {
    id: 'split',
    heading: 'ভাগাভাগি (ShareCost)',
    headingEn: 'Shared expenses — split a bill',
    blurb:
      'ট্রিপ, মেস, অফিস — একসাথে খরচ। কে কত দিয়েছে, কার ভাগ কত, শেষে কে কাকে কত দেবে। আর আপনার নিজের খাতায় ওঠে শুধু আপনার ভাগটুকু।',
    features: [
      {
        title: 'খরচ ভাগ করা',
        titleEn: 'Split an expense',
        body: 'সমান ভাগে, শতাংশে, নির্দিষ্ট টাকায় বা ভাগ অনুযায়ী। ৳৩,০০০-এর ডিনার চারজনে ভাগ করলে আপনার খরচে ওঠে ৳৭৫০ — ৳৩,০০০ নয়।',
        route: '/split',
      },
      {
        title: 'কে কাকে কত দেবে',
        titleEn: 'Settle up in the fewest payments',
        body: 'সাতজনের ট্রিপ শেষে সবাই সবাইকে টাকা দেয় না। সবচেয়ে কম কয়টা লেনদেনে হিসাব শেষ হয়, সেটা অ্যাপ বলে দেয়।',
        route: '/split',
      },
      {
        title: 'অগ্রিম দেওয়া টাকা',
        titleEn: 'Advances, adjusted automatically',
        body: 'খরচ হওয়ার আগেই কাউকে টাকা দিয়ে রাখলে সেটাও লেখা যায়। পরের বিলের ভাগ থেকে নিজে থেকেই কেটে যায়।',
        route: '/split',
      },
      {
        title: 'সবাই মিলে তহবিল',
        titleEn: 'A shared pot',
        body: 'পারিবারিক ফান্ড, অফিস সমিতি, ট্রিপের চাঁদা। সবাই চাঁদা দেয়, খরচ ওখান থেকেই যায় — আর অন্যের চাঁদা আপনার কাছে তাঁর পাওনা হয়েই থাকে।',
        route: '/split',
      },
      {
        title: 'ট্রিপের পাবলিক লিংক',
        titleEn: 'A public link for the trip',
        body: 'অ্যাকাউন্ট ছাড়াই সবাই দেখবে মোট খরচ, কে কত দিয়েছে, কার ভাগ কত। গ্রুপের বাইরের কিছুই যায় না।',
        route: '/split',
      },
    ],
  },
  {
    id: 'planning',
    heading: 'সঞ্চয়, বীমা, কার্ড',
    headingEn: 'Savings, insurance, cards',
    blurb: 'টাকা শুধু আসে-যায় না, জমেও। কবে কত দিতে হবে সেটা মনে রাখার দায়িত্ব সফটওয়্যারের।',
    features: [
      {
        title: 'ডিপিএস ও সঞ্চয় স্কিম',
        titleEn: 'DPS and savings schemes',
        body: 'কিস্তি, মেয়াদ, মুনাফা। কত জমেছে আর কত বাকি, প্রতিটি স্কিমের নিজের পাতায়।',
        route: '/savings',
      },
      {
        title: 'বীমা পলিসি',
        titleEn: 'Insurance policies',
        body: 'প্রিমিয়াম কবে, কত, কোনটা বাকি। পলিসি নম্বর আর মেয়াদ এক জায়গায়।',
        route: '/insurance',
      },
      {
        title: 'ক্রেডিট কার্ডের তাগাদা',
        titleEn: 'Credit-card due reminders',
        body: 'বিলের তারিখের আগে টেলিগ্রামে মনে করিয়ে দেয়। টাকা জমা দিলে ওই মাসের তাগাদা নিজেই থেমে যায়।',
        route: '/settings',
      },
    ],
  },
  {
    id: 'insight',
    heading: 'রিপোর্ট ও খোঁজ',
    headingEn: 'Reports and search',
    blurb: 'সংখ্যা জমা করা সহজ, প্রশ্নের উত্তর পাওয়া কঠিন। এই অংশটা উত্তরের জন্য।',
    features: [
      {
        title: 'আয়-ব্যয় ও নগদ প্রবাহ',
        titleEn: 'Income, expense and cash flow',
        body: 'মাস ধরে, খাত ধরে, অ্যাকাউন্ট ধরে। গত মাসের সাথে তুলনা এক ক্লিকে।',
        route: '/reports',
      },
      {
        title: 'স্থিতিপত্র, যেকোনো দিনের',
        titleEn: 'Balance sheet, as of any date',
        body: 'আজকের নিট সম্পদ, অথবা গত ৩০ জুনের। দুই তারিখের পার্থক্যও একই পাতায়।',
        route: '/reports',
      },
      {
        title: 'ট্যাগ ধরে রিপোর্ট',
        titleEn: 'Reporting by tag',
        body: 'শুধু পারিবারিক খরচ, শুধু ব্যবসার — যে ট্যাগে লিখেছেন সেই ট্যাগেই হিসাব।',
        route: '/reports',
      },
      {
        title: 'চারটি আর্থিক বিবৃতি',
        titleEn: 'The four financial statements',
        body: 'আয়-ব্যয় বিবরণী, স্থিতিপত্র, নগদ প্রবাহ বিবরণী আর নিট সম্পদের পরিবর্তন — যেকোনো তারিখ পরিসরের জন্য, এক পাতায়, প্রিন্টযোগ্য।',
        route: '/reports/statements',
      },
      {
        title: 'নগদ প্রবাহ, তিন ভাগে',
        titleEn: 'Cash flow in three sections',
        body: 'পরিচালন, বিনিয়োগ আর অর্থায়ন — IAS 7 যেভাবে বলে। বেতন আর ধার করা টাকা এক সংখ্যায় মেশে না।',
        route: '/reports/statements',
      },
      {
        title: 'চলতি ও অচলতি ভাগ',
        titleEn: 'Current and non-current',
        body: 'স্থিতিপত্রে সম্পদ আর দায় চলতি-অচলতিতে ভাগ করা, IAS 1 অনুসারে। চলতি মূলধনও তাই এক নজরে।',
        route: '/reports/statements',
      },
      {
        title: 'পরিমাণের হিসাব',
        titleEn: 'Quantities, not just amounts',
        body: 'কত কেজি চাল, কত লিটার তেল, কত ভরি স্বর্ণ। ৫৬টি একক — কেজি-লিটার থেকে মণ, ভরি, কাঠা, বিঘা। দাম বাড়ল না অভ্যাস বদলাল, এখানেই ধরা পড়ে।',
        route: '/reports',
      },
      {
        title: 'বিবরণী শেয়ার',
        titleEn: 'Share a statement by link',
        body: 'পাওনাদার, ব্যাংক বা বিমা কোম্পানিকে লিংক পাঠান — তাঁরা অ্যাকাউন্ট ছাড়াই দেখবেন ও ছাপাবেন। লিংকের মেয়াদ থাকে, যেকোনো সময় বাতিল করা যায়, আর কতবার খোলা হয়েছে দেখানো হয়।',
        route: '/loans',
      },
      {
        title: 'বাংলা-ইংরেজি-বাংলিশ খোঁজ',
        titleEn: 'Bangla, English and Banglish search',
        body: '"karim", "korim" বা "করিম" — তিনটেই একজনকে খুঁজে দেয়। "রিকশা" আর "rickshaw"-ও এক।',
        route: '/transactions',
      },
    ],
  },
  {
    id: 'input',
    heading: 'লেখার ঝামেলা কম',
    headingEn: 'Getting data in',
    blurb: 'হিসাব রাখা বন্ধ হয় লেখার ক্লান্তিতে, আগ্রহের অভাবে নয়।',
    features: [
      {
        title: 'টেলিগ্রাম থেকে এন্ট্রি',
        titleEn: 'Telegram entry',
        body: 'বটকে লিখলেই খসড়া তৈরি। বাসে বসে "রিকশা ৬০" — বাড়ি ফিরে এক ট্যাপে খাতায়।',
        route: '/settings',
      },
      {
        title: 'এসএমএস ইনবক্স',
        titleEn: 'Draft inbox',
        body: 'যা-ই আসুক, আগে খসড়া হয়ে বসে থাকে। আপনি না বললে কোনো কিছু খাতায় ওঠে না।',
        route: '/inbox',
      },
      {
        title: 'মেইলবক্স যুক্ত করা',
        titleEn: 'Mailbox connector',
        body: 'ব্যাংকের বিবরণী আর লেনদেনের চিঠি অ্যাপ থেকেই পড়ুন। শুধু পড়া — কিছু পাঠায় না, কিছু মোছে না।',
        route: '/mail',
      },
      {
        title: 'CSV ইমপোর্ট ও ব্যাকআপ',
        titleEn: 'CSV import and backup',
        body: 'পুরোনো এক্সেল থেকে লেনদেন আনুন, কলাম মিলিয়ে নিন। পুরো খাতা যেকোনো দিন নামিয়ে রাখুন।',
        route: '/import',
      },
      {
        title: 'রসিদের ছবি',
        titleEn: 'Receipt attachments',
        body: 'লেনদেনের সাথে রসিদ জুড়ে দিন। প্রিমিয়ামে সীমাহীন।',
        route: '/transactions',
      },
    ],
  },
  {
    id: 'trust',
    heading: 'আপনার তথ্য, আপনার',
    headingEn: 'Privacy and control',
    blurb: 'ব্যক্তিগত হিসাব মানে ব্যাংক স্টেটমেন্ট, বেতন, ধারের পরিমাণ। এগুলো নিয়ে ঢিলেমি চলে না।',
    features: [
      {
        title: 'আলাদা ওয়ার্কস্পেস',
        titleEn: 'Hard tenant isolation',
        /* The original sentence, less two words.
         *
         * It used to end "ব্যতিক্রম নেই" — no exception — and that clause is the
         * only part that is not true: the operator panel is the exception, by
         * design, and it can now read balances. Everything before it holds
         * exactly as written, so the claim is trimmed rather than rewritten.
         * The operator disclosure belongs on the privacy page the owner is
         * writing, not in a feature card. */
        body: 'প্রতিটি অ্যাকাউন্টের তথ্য নিজের ওয়ার্কস্পেসে। প্রতিটি প্রশ্ন ওয়ার্কস্পেস ধরেই করা হয়।',
        route: '/settings',
      },
      {
        title: 'কার্যবিবরণী',
        titleEn: 'Audit trail',
        body: 'কে কখন কী বদলেছে, সবটা লেখা থাকে — আপনি নিজেই পড়তে পারবেন।',
        route: '/audit',
      },
      {
        title: 'সাইন-ইন করা ডিভাইস',
        titleEn: 'Session control',
        body: 'কোন ডিভাইস থেকে ঢোকা আছে দেখুন, এক ট্যাপে বের করে দিন।',
        route: '/settings',
      },
      {
        title: 'রপ্তানি, বাধা ছাড়াই',
        titleEn: 'Your data, exportable',
        body: 'পুরো খাতা CSV-তে। কোনো দিন চলে যেতে চাইলে তথ্য আটকে রাখা হবে না।',
        route: '/import',
      },
    ],
  },
];

/**
 * What is not built yet, said plainly.
 *
 * A roadmap on a pricing page is a promise, so this list carries only what is
 * actually being worked towards, and it never appears above the fold. The
 * honest version sells better than the alternative anyway: somebody who signs
 * up for a feature that turns out not to exist does not stay.
 */
export const COMING: { title: string; body: string }[] = [
  {
    title: 'ব্যাংকের এসএমএস নিজে পড়া',
    body: 'বিকাশ, নগদ, ব্যাংকের বার্তা থেকে সরাসরি খসড়া। কাঠামোটা তৈরি, প্রতিটি ব্যাংকের ছাঁচ বসানো বাকি।',
  },
  {
    title: 'অ্যান্ড্রয়েড ও আইওএস অ্যাপ',
    body: 'আজই ফোনের ব্রাউজার থেকে হোম স্ক্রিনে বসানো যায় এবং অফলাইনে চলে। স্টোরের অ্যাপ তার পরের ধাপ।',
  },
  {
    title: 'AI দিয়ে মাসিক পর্যালোচনা',
    body: '"গত মাসে কোথায় বেশি গেল, কী কমানো যায়" — নিজের খাতার উপর, নিজের ভাষায়।',
  },
  {
    title: 'পুনরাবৃত্ত লেনদেন',
    body: 'ভাড়া, বেতন, কিস্তি — যেগুলো প্রতি মাসে একই, সেগুলো নিজে থেকেই বসবে।',
  },
  {
    title: 'পরিবারের সদস্য',
    body: 'একই খাতায় একাধিক মানুষ, আলাদা অনুমতি নিয়ে।',
  },
  {
    title: 'রসিদ থেকে লেখা পড়া (OCR)',
    body: 'রসিদের ছবি তুললেই টাকা আর তারিখ বসে যাবে।',
  },
];

/**
 * The questions a Bangladeshi visitor actually has before signing up.
 *
 * Also the page's structured data: these become `FAQPage` JSON-LD, which is
 * how a search result gets the expandable questions under it. So each answer
 * has to stand alone — a crawler shows it with no page around it.
 */
export const FAQ: { q: string; a: string }[] = [
  {
    q: 'Taka Tracker কি সত্যিই ফ্রি?',
    a: 'হ্যাঁ। ফ্রি প্যাকেজ আজীবন ফ্রি — কোনো ট্রায়াল নয়, শেষে কার্ড চাওয়া হয় না। দুটি অ্যাকাউন্ট, সীমাহীন লেনদেন, সীমাহীন দেনাদার-পাওনাদার। শুধু রসিদের ছবি প্রিমিয়ামে।',
  },
  {
    q: 'ডাবল-এন্ট্রি মানে কী, আমার কি এটা লাগবে?',
    a: 'ডাবল-এন্ট্রি মানে প্রতিটি টাকার দুই দিক লেখা — কোথা থেকে এল আর কোথায় গেল। আপনাকে ডেবিট-ক্রেডিট শিখতে হবে না, পর্দায় সেটা দেখাবেই না। লাভটা হলো, হিসাব কখনো নিজের সাথে অমিল হতে পারে না।',
  },
  {
    q: 'আমার ব্যাংকের তথ্য কি আপনারা দেখতে পান?',
    a: 'আমরা কোনো ব্যাংকের সাথে যুক্ত নই, আপনার ব্যাংকের পাসওয়ার্ড চাই না, আর পুরো অ্যাকাউন্ট নম্বরও কখনো চাই না। আপনি নিজে যা লেখেন বা যে মেইলবক্স নিজে যুক্ত করেন, শুধু সেটুকুই। প্রতিটি ওয়ার্কস্পেসের তথ্য আলাদা, আর কে কখন কী দেখেছে তার পূর্ণ তালিকা রাখা হয়।',
  },
  {
    q: 'নেট না থাকলে চলবে?',
    a: 'চলবে। ফোনের হোম স্ক্রিনে বসিয়ে নিলে অ্যাপের মতোই খোলে, আর নেট না থাকলে এন্ট্রি জমা থাকে — সংযোগ ফিরলে নিজে থেকেই চলে যায়। কীভাবে বসাবেন তার ধাপে-ধাপে নির্দেশনা takatracker.com/guide পাতায় আছে, আইফোন আর অ্যান্ড্রয়েডের জন্য আলাদা করে।',
  },
  {
    q: 'ধার দেওয়া-নেওয়ার টাকা কি আয়-ব্যয়ে যোগ হয়?',
    a: 'না, কখনো না। ধার নেওয়া টাকা দায়, ধার দেওয়া টাকা সম্পদ — নগদ প্রবাহে দেখাবে, কিন্তু আয় বা খরচে নয়। সুদটাই কেবল আয় বা খরচ। QuickBooks আর Zoho Books একই নিয়ম মানে।',
  },
  {
    q: 'পুরোনো এক্সেলের হিসাব আনা যাবে?',
    a: 'যাবে। CSV ইমপোর্টে কলাম মিলিয়ে নিন, ভুল হলে পুরো ব্যাচ একসাথে ফিরিয়ে নেওয়া যায়।',
  },
  {
    q: 'টাকা কীভাবে দেব?',
    a: 'প্রিমিয়াম মাসে ৳৩৫০, অথবা বছরে ৳৩৬০০ (৳৬০০ সাশ্রয়)। এই মুহূর্তে অনলাইন পেমেন্ট চালু হয়নি — প্রিমিয়াম নিতে চাইলে যোগাযোগ করুন, আমরা আপনার অ্যাকাউন্টে চালু করে দেব।',
  },
];

/** Used by the header, the footer and the sitemap, so they cannot disagree. */
export const NAV: { href: string; label: string }[] = [
  { href: '/#features', label: 'ফিচার' },
  { href: '/pricing', label: 'দাম' },
  { href: '/tutorial', label: 'কীভাবে রাখবেন' },
  { href: '/guide', label: 'ইনস্টল' },
  { href: '/#coming', label: 'আসছে' },
  { href: '/#faq', label: 'প্রশ্ন' },
];

/** The Bengali page's furniture. `content.en.ts` holds the English one. */
export const UI_BN: UiStrings = {
  featuresHeading: 'যা যা আছে',
  featuresBlurb: [
    'নিচের প্রতিটি জিনিস আজই ব্যবহার করা যায়। যেগুলো এখনো তৈরি হয়নি সেগুলো ',
    ' অংশে আলাদা করে রাখা।',
  ],
  stepsHeading: 'শুরু করতে তিনটি ধাপ',
  stepsBlurb: 'প্রথম দিনেই পুরো বছরের হিসাব বসাতে হবে না। আজ থেকে লিখতে শুরু করলেই যথেষ্ট।',
  comingHeading: 'আসছে',
  comingBlurb:
    'এগুলো এখনো তৈরি হয়নি। এই তালিকা এখানে আছে যাতে সাইন আপ করার সময় আপনি জানেন কোনটা পাচ্ছেন আর কোনটা পাচ্ছেন না।',
  faqHeading: 'সাধারণ প্রশ্ন',
  ledgerHeading: 'কেন এটা আর দশটা খরচের অ্যাপ নয়',
  ledgerBodyA:
    'বেশিরভাগ অ্যাপ একটা তালিকা রাখে: তারিখ, টাকা, খাত। তালিকা যোগ করলে যা পাওয়া যায় সেটা মোট খরচ — কিন্তু "আমার হাতে এখন কত আছে" বা "নিট সম্পদ কত" এর উত্তর ওখানে নেই, কারণ টাকাটা কোথা থেকে এল সেটা লেখা হয়নি।',
  ledgerBodyB:
    'Taka Tracker প্রতিটি লেনদেনের দুই দিকই লেখে। ৫০০ টাকার বাজার মানে খাবার খাতে ৫০০ ডেবিট আর নগদ থেকে ৫০০ ক্রেডিট। দুই দিক সমান না হলে ডাটাবেজ লেখাটাই নেয় না।',
  ledgerResultHeading: 'এর ফলে যা হয়',
  ledgerResults: [
    'প্রতিটি অ্যাকাউন্টের ব্যালেন্স নিজে থেকেই ঠিক থাকে',
    'স্থিতিপত্র বানানো যায় — সম্পদ, দায়, নিট সম্পদ',
    'ধার আয় বা খরচে ঢুকে রিপোর্ট নষ্ট করে না',
    'টাকা কোথাও হারায় না — গেলে কোথায় গেল সেটা লেখা আছে',
  ],
  ledgerFootnote:
    'QuickBooks আর Zoho Books ব্যবসার জন্য এই নিয়মেই চলে। পার্থক্য হলো, এখানে আপনাকে ডেবিট-ক্রেডিট দেখতেই হবে না — পর্দায় শুধু আয়, খরচ আর ট্রান্সফার।',
  closingHeading: 'আজ থেকেই শুরু হোক',
  closingBody:
    'অ্যাকাউন্ট খুলতে এক মিনিট। প্রথম খরচটা লিখতে দশ সেকেন্ড। মাস শেষে টাকা কোথায় গেছে তার উত্তরটা আপনার কাছে থাকবে।',
  closingSecondary: 'আগের অ্যাকাউন্টে ঢুকুন',
  heroNote: 'কার্ড লাগবে না · ফ্রি প্যাকেজ আজীবন ফ্রি · যেকোনো সময় সব তথ্য নামিয়ে নিতে পারবেন',
  proofLabel: 'কেন বিশ্বাস করবেন',
  login: 'লগইন',
  startFree: 'ফ্রি শুরু করুন',
  otherLocaleLabel: 'English',
  otherLocaleHref: '/en',
};

export const CONTENT_BN: SiteContent = {
  hero: HERO,
  proof: [...PROOF],
  steps: [...STEPS],
  groups: GROUPS,
  coming: [...COMING],
  faq: [...FAQ],
  nav: [...NAV],
  ui: UI_BN,
};

/**
 * Where to find the company, and how to reach a person.
 *
 * A finance product that lists no phone number and no address is one a
 * Bangladeshi visitor will not put their bank statements into — the hotline is
 * not decoration, it is the single strongest trust signal on the page. The
 * channels are here for the same reason: an audience that lives on WhatsApp and
 * Telegram reads "support" as "a channel I can join", not "a form".
 */
export const CONTACT = {
  hotline: '09642500400',
  /** `tel:` needs no spaces or dashes; the label carries the readable form. */
  hotlineHref: 'tel:09642500400',
  telegram: 'https://t.me/mydupno',
  whatsapp: 'https://whatsapp.com/channel/0029Vad8kdII1rccGZGzcD1G',
} as const;

export const SOCIAL: { label: string; href: string }[] = [
  { label: 'Facebook', href: 'https://www.facebook.com/mydupno' },
  { label: 'X', href: 'https://twitter.com/mydupno' },
  { label: 'Instagram', href: 'https://instagram.com/mydupno' },
  { label: 'LinkedIn', href: 'https://www.linkedin.com/company/13453653' },
];

/**
 * The SSLCommerz invoice a premium subscription is paid through.
 *
 * A hosted invoice link rather than an integration: no card details reach this
 * application, there is no PCI surface to get wrong, and the page that takes
 * the money is the payment provider's own. What it does *not* do is tell us who
 * paid — so premium is still enabled by hand from the admin panel, and the
 * pricing page says so rather than implying the plan switches itself on.
 */
export const PAYMENT_URL = 'https://invoice.sslcommerz.com/invoice-form?refer=5EB8FA123F7FD';

export const SITE = {
  /* The product's name, not the Bengali word. `হিসাব` still appears all over
     this file meaning "accounts" or "reckoning" — that is the language, and it
     is the reason the name works. The brand itself is the domain. */
  name: 'Taka Tracker',
  nameEn: 'Taka Tracker',
  url: 'https://takatracker.com',
  tagline: 'বাংলাদেশের জন্য ডাবল-এন্ট্রি ব্যক্তিগত হিসাবের সফটওয়্যার',
} as const;
