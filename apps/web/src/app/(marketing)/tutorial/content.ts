/**
 * The tutorial's own copy, in both languages.
 *
 * ## Why this page is public
 *
 * The feature list inside the app answers "where is it?"; this answers "how do
 * I keep books, and what happens if I keep them wrong?" — which is the question
 * somebody has *before* they open an account, not after. Putting it behind the
 * login is asking people to buy the manual with the product.
 *
 * ## Why the mistakes are here at all
 *
 * Every wrong entry below is one a real person makes in their first month, and
 * each has the same shape: something that moves cash is written as though it
 * changed wealth. A loan is not income. A card payment is not an expense. A
 * transfer is not both. Getting these four right is the difference between a
 * ledger and a list of numbers, and no amount of feature copy teaches it.
 *
 * The rules are ordinary double-entry bookkeeping — the same treatment IAS 1
 * and IAS 7 describe and the same one QuickBooks and Zoho Books apply. Nothing
 * here is this product's opinion.
 *
 * ## Why the limits are stated as plainly as the features
 *
 * "What you do not get" is the section that decides whether somebody trusts the
 * rest of the page. A visitor who signs up for something that turns out not to
 * exist does not stay, and they tell people.
 */

export interface Rule {
  title: string;
  body: string;
}

/** A wrong entry and the right one, side by side. */
export interface Mistake {
  /** What people write. */
  wrong: string;
  /** What it actually is. */
  right: string;
  /** Why — in the language of accounting, briefly. */
  why: string;
}

export interface TutorialContent {
  eyebrow: string;
  title: string;
  subtitle: string;
  rulesHeading: string;
  rulesBlurb: string;
  rules: Rule[];
  mistakesHeading: string;
  mistakesBlurb: string;
  mistakeLabels: { wrong: string; right: string };
  mistakes: Mistake[];
  featuresHeading: string;
  featuresBlurb: string;
  getsHeading: string;
  freeLabel: string;
  free: string[];
  premiumLabel: string;
  premium: string[];
  notHeading: string;
  notBlurb: string;
  not: string[];
  ctaHeading: string;
  ctaBody: string;
  ctaPrimary: string;
  ctaSecondary: string;
  /** Where each guide line says to look — the column heading above them. */
  whereLabel: string;
}

export const TUTORIAL_BN: TutorialContent = {
  eyebrow: 'শুরু করার আগে',
  title: 'কীভাবে হিসাব রাখবেন',
  subtitle:
    'ব্যক্তিগত হিসাব রাখার নিয়মগুলো ব্যবসার হিসাবের নিয়মের চেয়ে আলাদা নয় — শুধু ছোট। এই পাতায় নিয়মগুলো, সবচেয়ে বেশি হওয়া ভুলগুলো, আর অ্যাপে কী কী আছে ও কী নেই।',

  rulesHeading: 'ছয়টি নিয়ম',
  rulesBlurb:
    'এগুলো এই অ্যাপের নিয়ম নয়, হিসাববিজ্ঞানের নিয়ম। মানলে আপনার খাতা যেকোনো হিসাবরক্ষক পড়তে পারবেন।',
  rules: [
    {
      title: 'প্রারম্ভিক জের দিয়ে শুরু করুন',
      body: 'আজ ব্যাংকে, বিকাশে আর হাতে যা আছে সেটা প্রথমে বসান। এই সংখ্যাটা ভুল হলে পরের প্রতিটি ব্যালেন্স ভুল হবে — আর হিসাব শুরু করার সঠিক দিন হলো আজ, গত জানুয়ারি নয়।',
    },
    {
      title: 'প্রতিটি টাকার দুই দিক লিখুন',
      body: 'টাকা কোথা থেকে এল আর কোথায় গেল। অ্যাপ এটা নিজেই করে — আপনি খাত আর অ্যাকাউন্ট বাছলেই ডেবিট-ক্রেডিট বসে যায়। দুই দিক সমান না হলে ডাটাবেজ এন্ট্রিটাই নেয় না।',
    },
    {
      title: 'রোজ লিখুন, মাস শেষে নয়',
      body: 'তিন সপ্তাহ পর মনে করে লেখা মানে অনুমান করে লেখা। দিনে দুই মিনিট যথেষ্ট, আর নেট না থাকলেও লেখা যায়।',
    },
    {
      title: 'খাত আর ট্যাগ দুটোই ব্যবহার করুন',
      body: 'খাত বলে টাকা কীসে গেল — খাবার, যাতায়াত, চিকিৎসা। ট্যাগ বলে কার জন্য — পরিবার, ব্যবসা, রমজান। একই খরচ দুই প্রশ্নের উত্তর দেয়।',
    },
    {
      title: 'মাস শেষে ব্যাংকের সাথে মেলান',
      body: 'খাতার ব্যালেন্স আর ব্যাংকের ব্যালেন্স মিলিয়ে নিন। পার্থক্য থাকলে সেটাই বলে দেয় কোনো এন্ট্রি বাদ পড়েছে। এটাকেই হিসাববিজ্ঞানে reconciliation বলে, আর এটা বাদ দিলে বাকি সব পরিশ্রম অনুমান হয়ে যায়।',
    },
    {
      title: 'নগদ প্রবাহ আর মুনাফা এক জিনিস নয়',
      body: 'মাসে ৳৫০,০০০ ব্যাংকে ঢুকল মানে ৳৫০,০০০ আয় নয় — এর ভেতরে ধার করা টাকা থাকতে পারে। আয়-ব্যয় বিবরণী বলে আপনি কত কামালেন, নগদ প্রবাহ বিবরণী বলে টাকা কত এল-গেল। দুটোই দরকার।',
    },
  ],

  mistakesHeading: 'যেভাবে রাখবেন না',
  mistakesBlurb:
    'প্রতিটি ভুলের ধরন এক: যে টাকা শুধু হাতবদল হয়েছে, সেটাকে আয় বা খরচ লিখে ফেলা। এতে মাসের হিসাব ফুলে ওঠে আর নিট সম্পদ মিথ্যা বলে।',
  mistakeLabels: { wrong: 'যা মানুষ লেখে', right: 'যা আসলে' },
  mistakes: [
    {
      wrong: 'ধার দিলাম ৳২০,০০০ — খরচ',
      right: 'ঋণ প্রদান — সম্পদ (প্রাপ্য)',
      why: 'টাকাটা এখনো আপনারই, শুধু অন্যের হাতে। নগদ কমেছে, সম্পদ কমেনি। ফেরত পেলে সেটাও আয় নয়।',
    },
    {
      wrong: 'ধার নিলাম ৳৫০,০০০ — আয়',
      right: 'ঋণ গ্রহণ — দায়',
      why: 'নগদ বেড়েছে আর সমপরিমাণ দায়ও বেড়েছে, তাই নিট সম্পদ একচুলও বদলায়নি। শুধু সুদটুকু খরচ।',
    },
    {
      wrong: 'ব্যাংক থেকে বিকাশে ৳৫,০০০ — একদিকে খরচ, আরেকদিকে আয়',
      right: 'ট্রান্সফার',
      why: 'টাকা আপনারই দুই পকেটের মধ্যে ঘুরেছে। খরচ ও আয় দুটোই লিখলে মাসের দুটো সংখ্যাই ৳৫,০০০ করে ফুলে যায়।',
    },
    {
      wrong: 'ক্রেডিট কার্ডের বিল ৳১২,০০০ দিলাম — খরচ',
      right: 'দায় পরিশোধ',
      why: 'খরচটা হয়েছিল যেদিন কার্ড দিয়ে কিনেছিলেন, সেদিনই। বিল দেওয়ার দিন শুধু দায় কমছে। দুবার লিখলে একই খরচ দুবার গোনা হয়।',
    },
    {
      wrong: 'ডিপিএসের কিস্তি ৳৩,০০০ — খরচ',
      right: 'সঞ্চয় — সম্পদে স্থানান্তর',
      why: 'টাকা খরচ হয়নি, এক অ্যাকাউন্ট থেকে আরেকটায় গেছে। নিট সম্পদ অপরিবর্তিত। মুনাফা যেদিন জমা হবে, সেদিনটাই আয়।',
    },
    {
      wrong: 'জমির দাম ৳৫ লাখ বেড়েছে — আয়',
      right: 'পুনর্মূল্যায়ন',
      why: 'কিছু বিক্রি হয়নি, তাই নগদ প্রবাহও হয়নি। নিট সম্পদ বাড়ে, আয়-ব্যয় বিবরণী ছোঁয়াও হয় না। বিক্রির দিনই কেবল লাভ-ক্ষতি ধরা হয়।',
    },
    {
      wrong: 'চারজনে ডিনার ৳৩,০০০ — পুরোটা নিজের খরচ',
      right: 'নিজের ভাগ ৳৭৫০, বাকি ৳২,২৫০ প্রাপ্য',
      why: 'আপনি বিল দিয়েছেন, কিন্তু খরচ করেছেন এক-চতুর্থাংশ। বাকিটা তিনজনের কাছে আপনার পাওনা। পুরোটা খরচ লিখলে আপনার মাসিক খরচ চারগুণ দেখায়।',
    },
  ],

  featuresHeading: 'অ্যাপে যা যা আছে',
  featuresBlurb:
    'নিচের প্রতিটি জিনিস আজই কাজ করে। পাশে লেখা আছে কোন পর্দায় পাবেন, আর যেটা মানুষ সবচেয়ে বেশি ভুল বোঝে সেটা আলাদা করে বলা।',
  whereLabel: 'কোথায়',

  getsHeading: 'কী পাবেন',
  freeLabel: 'ফ্রি প্যাকেজে (আজীবন ফ্রি)',
  free: [
    'দুটি অ্যাকাউন্ট — যেমন একটি ব্যাংক আর হাতের নগদ',
    'সীমাহীন লেনদেন, মাসের কোনো কোটা নেই',
    'সীমাহীন দেনাদার-পাওনাদার, ঋণ ও কিস্তি',
    'চারটি আর্থিক বিবৃতি, যেকোনো তারিখ পরিসরে',
    'ভাগাভাগি (ShareCost) — গ্রুপ, তহবিল, পাবলিক লিংক',
    'ডিপিএস, সঞ্চয় ও বীমার হিসাব',
    'বিবরণী শেয়ার করার লিংক',
    'টেলিগ্রাম থেকে এন্ট্রি ও তাগাদা',
    'অফলাইনে লেখা, ফোনে ইনস্টল',
  ],
  premiumLabel: 'প্রিমিয়ামে বাড়তি (৳৩৫০/মাস)',
  premium: [
    'সীমাহীন অ্যাকাউন্ট',
    'রসিদের ছবি জুড়ে রাখা',
    'মেইলবক্স যুক্ত করে ব্যাংকের চিঠি পড়া',
    'পুরো খাতা CSV-তে রপ্তানি',
    'AI দিয়ে মাসিক পর্যালোচনা',
    'একই খাতায় একাধিক সদস্য',
  ],

  notHeading: 'কী পাবেন না',
  notBlurb: 'এগুলো এখানে নেই। জেনে সাইন আপ করা ভালো, পরে আবিষ্কার করার চেয়ে।',
  not: [
    'ব্যাংকের সাথে সরাসরি সংযোগ — কোনো ব্যাংকের API নেই, আপনার ব্যাংকের পাসওয়ার্ডও চাওয়া হয় না। তথ্য আসে আপনার লেখা থেকে, মেইলবক্স থেকে বা CSV থেকে।',
    'শেয়ারবাজার বা বিনিয়োগের পোর্টফোলিও — দাম নিজে থেকে হালনাগাদ হয় না। সম্পদ হিসেবে রাখা যায়, দাম আপনি বসাবেন।',
    'ব্যবসার চালান, ভ্যাট বা পে-রোল — এটা ব্যক্তিগত হিসাবের সফটওয়্যার, ERP নয়।',
    'গুগল প্লে বা অ্যাপ স্টোরের অ্যাপ — এখন ব্রাউজার থেকে হোম স্ক্রিনে বসে, অফলাইনেও চলে। স্টোরের অ্যাপ পরের ধাপ।',
    'ব্যাংকের এসএমএস নিজে পড়া — কাঠামো তৈরি, প্রতিটি ব্যাংকের ছাঁচ বসানো বাকি।',
    'অনলাইন পেমেন্ট — প্রিমিয়াম এখন হাতে চালু করা হয়, যোগাযোগ করলেই হবে।',
  ],

  ctaHeading: 'নিয়ম বোঝা হয়েছে, এবার লিখুন',
  ctaBody:
    'অ্যাকাউন্ট খুলতে এক মিনিট, প্রথম খরচ লিখতে দশ সেকেন্ড। কার্ড লাগবে না, আর যেকোনো দিন সব তথ্য নামিয়ে নিতে পারবেন।',
  ctaPrimary: 'ফ্রি অ্যাকাউন্ট খুলুন',
  ctaSecondary: 'দাম দেখুন',
};

export const TUTORIAL_EN: TutorialContent = {
  eyebrow: 'Before you start',
  title: 'How to keep your books',
  subtitle:
    'Keeping personal books follows the same rules as keeping business books — there are just fewer of them. Here are the rules, the mistakes almost everybody makes first, and what this app does and does not do.',

  rulesHeading: 'Six rules',
  rulesBlurb:
    'These are not this app’s rules; they are bookkeeping’s. Follow them and any accountant can read your ledger.',
  rules: [
    {
      title: 'Start with an opening balance',
      body: 'Enter what is in the bank, in the wallet and in your pocket today. Get this number wrong and every balance after it is wrong — and the right day to start keeping books is today, not last January.',
    },
    {
      title: 'Write both sides of every amount',
      body: 'Where it came from and where it went. The app does this for you: pick a category and an account and the debit and credit follow. An entry whose sides do not agree cannot be saved at all.',
    },
    {
      title: 'Write it daily, not monthly',
      body: 'Reconstructing three weeks from memory is guessing. Two minutes a day is enough, and it works with no connection.',
    },
    {
      title: 'Use categories and tags together',
      body: 'A category says what the money went on — food, transport, medical. A tag says who it was for — family, business, Ramadan. One expense, two questions answered.',
    },
    {
      title: 'Reconcile with the bank each month',
      body: 'Compare your ledger balance with the bank’s. A difference is the ledger telling you an entry is missing. Skip reconciliation and everything else you did becomes an estimate.',
    },
    {
      title: 'Cash flow is not profit',
      body: '৳50,000 arriving in your account is not ৳50,000 of income — some of it may be borrowed. The income statement says what you earned; the cash flow statement says what moved. You need both.',
    },
  ],

  mistakesHeading: 'How not to keep them',
  mistakesBlurb:
    'Every mistake below has one shape: money that only changed hands is recorded as though it changed your wealth. The month inflates and net worth starts lying.',
  mistakeLabels: { wrong: 'What people write', right: 'What it actually is' },
  mistakes: [
    {
      wrong: 'Lent ৳20,000 — expense',
      right: 'A loan given — an asset (receivable)',
      why: 'The money is still yours, just in somebody else’s hands. Cash fell; your wealth did not. Getting it back is not income either.',
    },
    {
      wrong: 'Borrowed ৳50,000 — income',
      right: 'A loan taken — a liability',
      why: 'Cash rose and a liability rose by the same amount, so net worth did not move at all. Only the interest is an expense.',
    },
    {
      wrong: 'Bank to mobile wallet, ৳5,000 — an expense and an income',
      right: 'A transfer',
      why: 'The money went from one of your pockets to another. Recording both sides as income and expense inflates two figures for the month by ৳5,000 each.',
    },
    {
      wrong: 'Paid the ৳12,000 card bill — expense',
      right: 'Settling a liability',
      why: 'The expense happened on the day you used the card. Paying the bill only reduces what you owe. Record both and you have counted one purchase twice.',
    },
    {
      wrong: 'DPS instalment ৳3,000 — expense',
      right: 'Saving — a move between assets',
      why: 'Nothing was spent; money moved from one account to another and net worth is unchanged. The profit, on the day it is credited, is the income.',
    },
    {
      wrong: 'The land is worth ৳500,000 more — income',
      right: 'A revaluation',
      why: 'Nothing was sold, so no cash moved. Net worth rises and the income statement is not touched. The gain is realised on the day of sale, not before.',
    },
    {
      wrong: 'Dinner for four, ৳3,000 — all of it your expense',
      right: 'Your share ৳750; ৳2,250 is receivable',
      why: 'You paid the bill but consumed a quarter of it. The rest is owed to you by three people. Book the lot and your monthly spending reads four times what it was.',
    },
  ],

  featuresHeading: 'Everything the app does',
  featuresBlurb:
    'All of it works today. Each line says which screen it lives on, and calls out the part people most often read the wrong way.',
  whereLabel: 'Where',

  getsHeading: 'What you get',
  freeLabel: 'On the free plan (free forever)',
  free: [
    'Two accounts — a bank and your cash, say',
    'Unlimited transactions, no monthly quota',
    'Unlimited people, loans and instalments',
    'All four financial statements, for any date range',
    'Splitting (ShareCost) — groups, pots, public links',
    'DPS, savings and insurance tracking',
    'Shareable statement links',
    'Telegram entry and reminders',
    'Offline entry, installable on a phone',
  ],
  premiumLabel: 'Premium adds (৳350/month)',
  premium: [
    'Unlimited accounts',
    'Receipt attachments',
    'A connected mailbox that reads bank letters',
    'Full CSV export of the ledger',
    'An AI monthly review',
    'More than one member on the same books',
  ],

  notHeading: 'What you do not get',
  notBlurb: 'None of this exists here. Better to know before signing up than to find out after.',
  not: [
    'A direct bank connection — there is no bank API and we never ask for your banking password. Data arrives from what you type, a mailbox you connect, or a CSV.',
    'A stock or investment portfolio — prices do not update themselves. You can hold the asset; you set its value.',
    'Business invoicing, VAT or payroll — this is personal accounting software, not an ERP.',
    'A Play Store or App Store app — today it installs to your home screen from the browser and runs offline. A store app comes later.',
    'Automatic reading of bank SMS — the plumbing is built, the per-bank patterns are not.',
    'Online payment — premium is switched on by hand for now; get in touch and we will enable it.',
  ],

  ctaHeading: 'That is the theory. Now write one down.',
  ctaBody:
    'A minute to open an account, ten seconds for the first expense. No card, and you can download everything any day you like.',
  ctaPrimary: 'Start free',
  ctaSecondary: 'See pricing',
};
