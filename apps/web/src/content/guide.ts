/**
 * What this app can do, in the order somebody would learn it.
 *
 * ## Why a page and not a marketing list
 *
 * The owner asked for it because the product had outgrown what one person could
 * hold in their head — screens exist that nobody has opened. So this is written
 * as instructions, not as selling: each entry says where the thing lives, what
 * it is for, and the one non-obvious fact about it. A feature nobody can find
 * is a feature nobody has.
 *
 * ## Why it is hand-written
 *
 * It could have been generated from the navigation model, and it would then
 * have listed thirteen destinations and taught nothing. The useful half of every
 * entry below — that only your own share of a shared bill reaches your
 * expenses, that a statement link expires, that revaluing land is not income —
 * is exactly the half no generator knows.
 *
 * ## Why the strings are data with keys beside them
 *
 * `t()` reads the locale from a module variable that `LocaleSync` fills in, so
 * a `t()` evaluated while a module is *imported* can resolve before the
 * workspace's language is known. Everything below is therefore the Bengali
 * source paired with its key, and the lookup happens during render, where the
 * locale has settled. The rest of the app never meets this because its `t()`
 * calls are already inside components.
 *
 * ## Why it is a module of its own and not part of `page.tsx`
 *
 * A `page.tsx` may only export the handful of things the router knows about, so
 * a table living there could not be read by anything else. It needs to be:
 * `t.test.ts` finds translation keys by scanning source for calls with a
 * literal key, and every key here is built from a stem instead, so the only way
 * the catalogue check can see them is by importing the table itself.
 */

export interface GuideEntry {
  /** Key stem; `.t`, `.w`, `.b` and `.n` hang off it in the catalogue. */
  key: string;
  title: string;
  where: string;
  body: string;
  /** The thing somebody gets wrong if nobody tells them. Optional. */
  note?: string;
}

export interface GuideGroup {
  /** Key stem; `.h` for the heading, `.s` for the line under it. */
  key: string;
  heading: string;
  blurb: string;
  entries: GuideEntry[];
}

export const GUIDE: GuideGroup[] = [
  {
    key: 'guide.daily',
    heading: 'রোজকার হিসাব',
    blurb: 'যা প্রতিদিন লাগে',
    entries: [
      {
        key: 'guide.entry',
        title: 'আয় ও খরচ লেখা',
        where: 'নিচের + বোতাম, যেকোনো পর্দা থেকে',
        body: 'টাকার অঙ্ক, খাত, তারিখ — তিনটি ঘর। বাকি সব ঐচ্ছিক এবং ভাঁজ করা থাকে।',
        note: 'ইন্টারনেট না থাকলেও লেখা যায়। সংযোগ ফিরলে নিজে থেকেই চলে যাবে।',
      },
      {
        key: 'guide.transfer',
        title: 'ট্রান্সফার',
        where: 'নতুন লেনদেন → ট্রান্সফার',
        body: 'এক অ্যাকাউন্ট থেকে আরেকটিতে। খরচ হিসেবে গণ্য হয় না, কারণ টাকা আপনারই থেকে যায়।',
      },
      {
        key: 'guide.categories',
        title: 'খাত ও উপ-খাত',
        where: 'সেটিংস → খাত ব্যবস্থাপনা',
        body: 'বড় খাতের ভেতরে ছোট ভাগ। রিপোর্টে উপ-খাতগুলো নিজের বড় খাতের নিচে যোগ হয়ে দেখায়।',
      },
      {
        key: 'guide.tags',
        title: 'ট্যাগ',
        where: 'আরও → ট্যাগ',
        body: 'খাত বলে কীসে খরচ, ট্যাগ বলে কার জন্য — পরিবার, ব্যবসা, রমজান।',
        note: 'একটি খরচে একাধিক ট্যাগ থাকতে পারে, তাই ট্যাগের যোগফল মাসের মোট খরচের চেয়ে বেশি হতে পারে। রিপোর্টে সেটি আলাদা করে বলা থাকে।',
      },
      {
        key: 'guide.quantity',
        title: 'পরিমাণ ও একক',
        where: 'লেনদেনের ঘরে "পরিমাণ লিখবেন?"',
        /* Latin digits for money, because that is what `Money` renders — a
           manual that spells the amount differently from the screen is a
           manual people stop trusting. */
        body: '৳12,000 তেলে খরচ আর ৩৪০ লিটার তেল — দুটো আলাদা প্রশ্ন। ৫৬টি একক আছে: কেজি, লিটার থেকে মণ, ভরি, কাঠা, বিঘা, পাউন্ড, গ্যালন।',
        note: 'তালিকায় না থাকলে "অন্য একক লিখুন" — নিজের একক সেটিংসেও যোগ করা যায়।',
      },
    ],
  },
  {
    key: 'guide.money',
    heading: 'টাকা কোথায়',
    blurb: 'অ্যাকাউন্ট, সম্পদ, দায়',
    entries: [
      {
        key: 'guide.accounts',
        title: 'অ্যাকাউন্ট',
        where: 'আরও → অ্যাকাউন্ট',
        body: 'নগদ, ব্যাংক, মোবাইল ওয়ালেট, ক্রেডিট কার্ড, সঞ্চয়, আর সম্পদ (জমি, স্বর্ণ, গাড়ি) ও দায়।',
        note: 'ড্যাশবোর্ডে "হাতে ও ব্যাংকে" শুধু খরচযোগ্য টাকা; জমি-স্বর্ণ "নিট সম্পদ"-এ আলাদা করে গোনা হয়।',
      },
      {
        key: 'guide.accountStatement',
        title: 'অ্যাকাউন্টের বিবরণী',
        where: 'অ্যাকাউন্টের পাশে কাগজের আইকন',
        body: 'ব্যাংকের স্টেটমেন্টের মতো: প্রারম্ভিক জের, প্রতিটি লেনদেন ডেবিট-ক্রেডিট কলামে, প্রতি সারিতে চলতি জের, শেষে সমাপনী জের। প্রিন্ট, এক্সেল আর শেয়ার লিংক — তিনটাই আছে।',
        note: 'প্রতিটি সারিতে বিপরীত খাতও লেখা থাকে — তাই ৳5,000 তুলে নেওয়া আর ৳5,000 বাড়ি ভাড়া দেওয়া আলাদা করে চেনা যায়।',
      },
      {
        key: 'guide.reconcile',
        title: 'ব্যালেন্স মেলানো',
        where: 'অ্যাকাউন্টের পাশে দাঁড়িপাল্লার আইকন',
        body: 'আসল ব্যালেন্স লিখে দিন, পার্থক্যটা সমন্বয় হিসেবে বসে যাবে।',
      },
      {
        key: 'guide.revaluation',
        title: 'সম্পদের পুনর্মূল্যায়ন',
        where: 'সম্পদের পাশে ঊর্ধ্বমুখী তীর',
        body: 'জমির দাম বেড়েছে? এখনকার মূল্য লিখুন। ইতিহাস থাকে।',
        note: 'এটি আয় নয় এবং নগদ প্রবাহেও যায় না — শুধু নিট সম্পদ বদলায়। কারণ কিছু বিক্রি হয়নি।',
      },
      {
        key: 'guide.savings',
        title: 'সঞ্চয় ও ডিপিএস',
        where: 'আরও → সঞ্চয় ও ডিপিএস',
        body: 'কিস্তি, মেয়াদ, মুনাফার হার — মেয়াদপূর্তিতে কত হবে তা হিসাব করে দেখায়।',
      },
      {
        key: 'guide.insurance',
        title: 'বীমা',
        where: 'আরও → বীমা',
        body: 'পলিসি, প্রিমিয়ামের তারিখ, কোনটা বাকি।',
      },
    ],
  },
  {
    key: 'guide.people',
    heading: 'ধার-দেনা ও মানুষজন',
    blurb: 'কে কত পাবে, কে কত দেবে',
    entries: [
      {
        key: 'guide.loans',
        title: 'ঋণ দেওয়া ও নেওয়া',
        where: 'নিচের ট্যাব → ঋণ',
        body: 'সুদসহ বা সুদ ছাড়া, কিস্তিতে। প্রতিটি কিস্তি খাতায় ওঠে।',
        note: 'ঋণ দিলে টাকা অ্যাকাউন্ট থেকে কমে কিন্তু খরচ হয় না — ওটা পাওনা হয়ে থাকে।',
      },
      {
        key: 'guide.partyLedger',
        title: 'পার্টি লেজার',
        where: 'ঋণ → ব্যক্তির নাম',
        body: 'একজন মানুষের সব ঋণ আর ভাগাভাগির হিসাব এক চলমান জেরে।',
      },
      {
        key: 'guide.personCode',
        title: 'মানুষজন ও তাঁদের কোড',
        where: 'আরও → মানুষজন',
        body: 'প্রত্যেকের একটি কোড — P-0001, P-0002। একই নামের দুজনকে আলাদা রাখে।',
        note: 'মোবাইল নম্বর দিলে একই মানুষ দুবার তৈরি হয় না — ধার আর ট্রিপের হিসাব এক জায়গায় থাকে।',
      },
    ],
  },
  {
    key: 'guide.split',
    heading: 'ভাগাভাগি',
    blurb: 'একসাথে খরচ',
    entries: [
      {
        key: 'guide.groups',
        title: 'গ্রুপ ও খরচ ভাগ',
        where: 'আরও → ভাগাভাগি',
        body: 'ট্রিপ, মেস, অফিস। সমান ভাগে, শতাংশে, নির্দিষ্ট টাকায় বা ভাগ অনুযায়ী।',
        note: 'আপনার ভাগটুকুই আপনার খরচে যায়। ৳3,000-এর ডিনার চারজনে ভাগ করলে আপনার মাসিক খরচে ৳750 উঠবে, ৳3,000 নয়।',
      },
      {
        key: 'guide.settle',
        title: 'অগ্রিম ও পরিশোধ',
        where: 'গ্রুপ → টাকা দেওয়া-নেওয়া',
        body: 'খরচ হওয়ার আগেই কাউকে টাকা দিলে সেটাও লেখা যায়। পরের বিলের ভাগ থেকে নিজে থেকেই কেটে যাবে।',
      },
      {
        key: 'guide.pot',
        title: 'সবাই মিলে তহবিল',
        where: 'গ্রুপ → তহবিল খুলুন',
        body: 'পারিবারিক ফান্ড, অফিস সমিতি, ট্রিপের চাঁদা। সবাই চাঁদা দেয়, খরচ ওখান থেকে যায়।',
        note: 'অন্যের চাঁদা আপনার কাছে তাঁর পাওনা হয়ে থাকে — তহবিল আপনার হাতে থাকলেও টাকাটা তাঁর।',
      },
      {
        key: 'guide.groupLink',
        title: 'ট্রিপের পাবলিক লিংক',
        where: 'গ্রুপ → শেয়ার',
        body: 'যাকে পাঠাবেন তিনি অ্যাকাউন্ট ছাড়াই দেখবেন: মোট খরচ, কে কত দিয়েছে, কার ভাগ কত, কে কাকে কত দেবে।',
        note: 'গ্রুপের বাইরের কিছুই যায় না — আপনার অ্যাকাউন্ট, অন্য খরচ, কিছুই না।',
      },
      {
        key: 'guide.invite',
        title: 'যাঁর অ্যাকাউন্ট আছে তাঁকে আমন্ত্রণ',
        where: 'গ্রুপ → সদস্যের পাশে ব্যক্তি-যোগ আইকন',
        body: 'তিনি নিজের খাতায় খরচগুলো খসড়া হিসেবে পাবেন।',
        note: 'তাঁর অনুমতি ছাড়া তাঁর খাতায় কিছুই লেখা হয় না, আর তিনি আপনার খাতা দেখতে পান না।',
      },
    ],
  },
  {
    key: 'guide.reports',
    heading: 'রিপোর্ট',
    blurb: 'টাকা কোথায় গেল, আর আপনি কোথায় দাঁড়িয়ে',
    entries: [
      {
        key: 'guide.spendReports',
        title: 'খাত, ট্যাগ ও প্রবণতা',
        where: 'নিচের ট্যাব → রিপোর্ট',
        body: 'নিজের সময়সীমা বেছে নিন। খাতে চাপ দিলে ভেতরের লেনদেনগুলো দেখা যায়।',
      },
      {
        key: 'guide.statements',
        title: 'আর্থিক বিবৃতি',
        where: 'রিপোর্ট → আর্থিক বিবৃতি',
        body: 'আয়-ব্যয় বিবরণী, স্থিতিপত্র, নগদ প্রবাহ আর নিট সম্পদের পরিবর্তন — এক পাতায়, প্রিন্টযোগ্য।',
        note: 'নগদ প্রবাহ তিন ভাগে: পরিচালন, বিনিয়োগ, অর্থায়ন। বেতন আর ধার করা টাকা এক সংখ্যায় মেশে না।',
      },
      {
        key: 'guide.quantityReport',
        title: 'পরিমাণের রিপোর্ট',
        where: 'রিপোর্ট → পরিমাণ',
        body: 'কত কেজি চাল, কত লিটার তেল — দাম বাড়ল না অভ্যাস বদলাল, সেটা এখানেই ধরা পড়ে।',
      },
      {
        key: 'guide.share',
        title: 'বিবরণী শেয়ার',
        where: 'ব্যক্তি, ঋণ, সঞ্চয় বা বীমার পাতায় → শেয়ার',
        body: 'তারিখ বেছে লিংক বানান। পাওনাদার, ব্যাংক বা বিমা কোম্পানি অ্যাকাউন্ট ছাড়াই দেখবে ও প্রিন্ট করবে।',
        note: 'লিংকের মেয়াদ থাকে, যেকোনো সময় বাতিল করা যায়, আর কতবার খোলা হয়েছে দেখানো হয়।',
      },
    ],
  },
  {
    key: 'guide.data',
    heading: 'তথ্য আনা-নেওয়া',
    blurb: 'হাতে না লিখে',
    entries: [
      {
        key: 'guide.import',
        title: 'ফাইল থেকে আনা',
        where: 'আরও → ইমপোর্ট ও এক্সপোর্ট',
        body: 'ব্যাংকের CSV বা এক্সেল ফাইল। কোন কলাম কী, সেটা নিজে অনুমান করে নেয়; ভুল হলে বদলে দিন।',
        note: 'আগে যা এসেছে তা আবার আসে না। পুরো ব্যাচ এক চাপে ফিরিয়েও নেওয়া যায়।',
      },
      {
        key: 'guide.mailbox',
        title: 'মেইলবক্স যুক্ত করা',
        where: 'সেটিংস → ইমেইল থেকে স্টেটমেন্ট',
        body: 'ব্যাংকের চিঠি নিজে থেকেই পড়ে খসড়া বানায়।',
        note: 'খসড়া আপনি না দেখা পর্যন্ত খাতায় ওঠে না।',
      },
      {
        key: 'guide.telegram',
        title: 'টেলিগ্রাম',
        where: 'সেটিংস → টেলিগ্রাম',
        body: 'ক্রেডিট কার্ডের বিল কবে দিতে হবে, মনে করিয়ে দেবে।',
      },
    ],
  },
  {
    key: 'guide.app',
    heading: 'অ্যাপ ও নিরাপত্তা',
    blurb: '',
    entries: [
      {
        key: 'guide.install',
        title: 'ফোনে ইনস্টল',
        where: 'ব্রাউজারের মেনু → হোম স্ক্রিনে যোগ করুন',
        body: 'অ্যাপের মতোই চলে, ইন্টারনেট ছাড়াও খোলে।',
        note: 'নতুন সংস্করণ এলে নিজে থেকেই হালনাগাদ হয় — আবার ইনস্টল করতে হয় না।',
      },
      {
        key: 'guide.language',
        title: 'ভাষা',
        where: 'সেটিংস → ভাষা',
        body: 'বাংলা বা ইংরেজি। খাতার ভাষা, তাই রিপোর্ট আর শেয়ার করা বিবরণীও সেই ভাষায় যায়।',
      },
      {
        key: 'guide.sessions',
        title: 'সাইন-ইন করা ডিভাইস',
        where: 'সেটিংস → যেসব ডিভাইসে লগইন আছে',
        body: 'অচেনা কিছু দেখলে এক চাপে বের করে দিন।',
      },
      {
        key: 'guide.audit',
        title: 'কার্যবিবরণী',
        where: 'আরও → কার্যবিবরণী',
        body: 'কে কখন কী বদলেছে। মুছে ফেলার কোনো উপায় নেই — আমাদেরও নেই।',
      },
    ],
  },
];
