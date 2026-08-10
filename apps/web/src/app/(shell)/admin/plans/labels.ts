import { DEFAULT_PLAN_CODE, DEFAULT_PLANS } from '@hishab/core';
import { bnCount, limitText, unitSuffix } from '../labels';

/**
 * The package screens' own vocabulary.
 *
 * Anything the panel already names — limits, units, counts, categories — comes
 * from `../labels`. What is added here is the language of *selling* a package:
 * intervals, visibility, retirement, and the four sentences an operator has to
 * read before they change something forty customers are sitting on.
 */

export const INTERVAL_LABEL: Record<string, string> = {
  MONTHLY: 'মাসিক',
  YEARLY: 'বার্ষিক',
};

export const intervalLabel = (interval: string): string => INTERVAL_LABEL[interval] ?? interval;

/** For a price line: "৪৯৯ / মাস". */
export const intervalSuffix = (interval: string): string =>
  interval === 'YEARLY' ? ' / বছর' : interval === 'MONTHLY' ? ' / মাস' : ` / ${interval}`;

export const INTERVAL_OPTIONS: readonly (readonly [string, string])[] = [
  ['MONTHLY', intervalLabel('MONTHLY')],
  ['YEARLY', intervalLabel('YEARLY')],
];

/**
 * Visibility, which is also retirement.
 *
 * The API keeps one flag: `retired` is `!isPublic`, computed, with no column
 * behind it. So a bespoke package created hidden and a tier withdrawn after
 * three years are the same row to the server, and the words here say so rather
 * than implying a distinction the data cannot carry.
 */
export const VISIBILITY_OPTIONS: readonly (readonly ['public' | 'private', string])[] = [
  ['public', 'বিক্রির তালিকায়'],
  ['private', 'তালিকার বাইরে'],
];

/** What a package outside the list is called, wherever one is shown. */
export const OFF_SALE = 'তালিকার বাইরে';

export const OFF_SALE_MEANS =
  'এপিআই-তে "অবসরপ্রাপ্ত" আর "গোপন" একই জিনিস — একটিই বোতাম, isPublic। তালিকার বাইরে থাকা প্যাকেজ দামের পাতায় আসে না, "প্ল্যান বসান" তালিকাতেও আসে না, কিন্তু কোড দিয়ে বসানো যায় এবং যাঁরা এতে আছেন তাঁদের কিছুই বদলায় না।';

// --- the three-and-a-half states of a ceiling -----------------------------------

/** A feature this package does not price at all. Not zero, not unlimited. */
export const NOT_PRICED = 'প্ল্যানে নেই';

/**
 * What "not priced" actually does, which is the part nobody guesses right.
 *
 * `resolveEntitlements` starts every workspace from the code's FREE definition
 * and then lays the plan's own rows on top. So a key a package omits is not
 * "off" — it is whatever FREE says, and only *then* off if FREE has never heard
 * of it either (`limitFor`'s `whenUnknown` is 0, deliberately, so that creating
 * a feature does not hand it to everybody unlimited).
 */
export const NOT_PRICED_MEANS =
  'এই প্যাকেজে সারিটিই নেই। তখন কার্যকর হয় ফ্রি প্ল্যানের ডিফল্ট মান, আর ফ্রি-তেও ফিচারটি না থাকলে এটি বন্ধ (০) ধরা হয় — শূন্য বসানোর সমান নয়।';

/**
 * A ceiling in words, with the fourth state the panel's `limitText` cannot
 * express: `undefined` is "this package does not price this feature".
 */
export function planLimitText(
  limitValue: number | null | undefined,
  kind: string,
  unit: string,
): string {
  if (limitValue === undefined) return NOT_PRICED;
  return limitText(limitValue, kind, unit);
}

/** "৩০০টি / মাস" — a bare quantity for a diff line. */
export const quantityText = (value: number, unit: string): string =>
  `${bnCount(value)}${unitSuffix(unit)}`;

// --- the packages the build still ships ------------------------------------------

/**
 * FREE and PRO, from the definitions the API seeds with, rather than two
 * strings typed here — a tier renamed in `packages/core` must not leave this
 * screen quietly making a claim about a package that no longer exists.
 */
export const SEEDED_PLAN_CODES: ReadonlySet<string> = new Set(DEFAULT_PLANS.map((p) => p.code));

export const isSeededPlan = (code: string): boolean => SEEDED_PLAN_CODES.has(code);

/** The package a new workspace lands on, and the fallback every limit starts from. */
export const FALLBACK_PLAN_CODE = DEFAULT_PLAN_CODE;

/**
 * The history an operator who has been here a while needs told.
 *
 * Until today the boot sequence upserted these two on every deploy and deleted
 * any feature row it did not recognise, so a limit changed by hand survived
 * until the next release and then silently reverted. The API now seeds only
 * what is absent. Anyone who learned the old behaviour will otherwise keep
 * routing round this screen.
 */
export const SEEDED_PLAN_HISTORY =
  'এটি বিল্ডের সঙ্গে আসা প্যাকেজ। আগে প্রতিটি ডিপ্লয়ে এর নাম, দাম ও সীমা কোড থেকে আবার বসত — হাতে করা যেকোনো বদল পরের রিলিজেই মুছে যেত। এখন আর নয়: প্যাকেজটি অনুপস্থিত থাকলে কেবল তখনই বসানো হয়, তাই এই পাতায় করা বদল টিকে থাকবে এবং ডেটাবেসই শেষ কথা।';

/**
 * Why the default package has no retire button.
 *
 * The API refuses outright — `assertHideable` answers 400 — because every new
 * signup is put on this code and because a feature no package prices falls back
 * to its limits. Showing the button and letting the server say no would turn a
 * rule into an error message.
 */
export const FALLBACK_PLAN_WARNING =
  'নতুন প্রতিটি ওয়ার্কস্পেস এই প্যাকেজেই বসে, আর কোনো প্যাকেজে যে ফিচারের দাম বসানো নেই তার কার্যকর মানও এখান থেকেই আসে। তাই এপিআই এটিকে তালিকার বাইরে নিতে দেয় না — দাম, নাম ও সীমা বদলানো যায়, লুকানো যায় না।';

// --- what the operator must read before pressing anything ---------------------------

/** Why there is no delete button, said once so nobody goes hunting for it. */
export const NO_DELETE =
  'প্যাকেজ মুছে ফেলার কোনো উপায় রাখা হয়নি। ওয়ার্কস্পেসগুলো সরাসরি এই সারিটির দিকে তাকিয়ে থাকে, তাই সারিটি চলে গেলে তাদের সীমা কোনো বার্তা ছাড়াই হারিয়ে যেত। বদলে অবসর দিন — নতুন কেউ এটি নিতে পারবে না, যারা আছেন তাঁদের কিছুই বদলাবে না।';

/** What happens to a tenant who ends up above a new ceiling. Say it plainly. */
export const OVER_LIMIT_MEANS =
  'যাঁরা নতুন সীমার বাইরে পড়বেন তাঁদের এখনকার সারিগুলো থেকেই যাবে — কিছু মুছবে না, কাউকে লগআউটও করা হবে না। কেবল নতুন কিছু যোগ করতে গেলে তা ফিরিয়ে দেওয়া হবে (৪০২), যতক্ষণ না তাঁরা সীমার নিচে নামেন বা তাঁদের জন্য আলাদা ওভাররাইড বসানো হয়।';

/** Pricing is not billing, and an operator changing a price should know that. */
export const PRICING_IS_NOT_BILLING =
  'এখনো কোথাও টাকা কাটা হয় না — বিলিং আসেনি। দাম বদলালে তা দামের পাতায় ও এই পর্দায় দেখা যাবে, কারও কার্ডে নয়।';

/** Making a package private takes it out of two lists, and only two. */
export const PRIVATE_MEANS =
  'তালিকার বাইরে রাখলে প্যাকেজটি দামের পাতায় আসবে না এবং ওয়ার্কস্পেসের "প্ল্যান বসান" তালিকাতেও আর দেখা যাবে না। কোড হাতে লিখে তখনো বসানো যাবে, আর যাঁরা আগে থেকেই এতে আছেন তাঁদের কিছু বদলাবে না। এপিআই এই অবস্থাকেই "অবসরপ্রাপ্ত" বলে।';

/** Retirement, in one line, for the button that does it. */
export const RETIRE_MEANS =
  'অবসর দিলে প্যাকেজটি বিক্রির তালিকা থেকে সরে যায় — এপিআই-তে এটি isPublic বন্ধ করার সমান। যাঁরা এতে আছেন তাঁরা এতেই থাকেন: তাঁদের সীমা, তথ্য ও সেশন অপরিবর্তিত।';

/** Only the edit sheet needs this: the visibility switch lives somewhere else. */
export const VISIBILITY_LIVES_ELSEWHERE =
  'এখান থেকে দৃশ্যমানতা বদলানো যায় না। "অবসরে পাঠান" আর "ফিরিয়ে আনুন" — ওই দুটিই এপিআই-র isPublic বোতাম, আর সেগুলো কী হবে তা নাম ধরে বলে।';

/** The dry run skips tenants whose ceiling comes from an override. Say so. */
export const OVERRIDES_NOT_COUNTED =
  'যাঁদের নিজস্ব ওভাররাইড আছে তাঁদের গোনা হয়নি — তাঁদের সীমা প্ল্যান থেকে আসে না, তাই প্ল্যানের বদল তাঁদের ছোঁয় না।';

/** A lowered ceiling nobody measures is still enforced the day a counter lands. */
export const UNMEASURED_CUT =
  'এই ফিচারগুলোর ব্যবহার এখনো কেউ গোনে না, তাই কতজন সীমার বাইরে পড়বেন তা বলা যাচ্ছে না। শূন্য নয় — অজানা। কাউন্টার যোগ হওয়ার দিন থেকেই সীমাটি কার্যকর হবে।';

/** The sweep has a cap. Past it, every count is a floor. */
export const SWEEP_TRUNCATED =
  'প্যাকেজে এত বেশি ওয়ার্কস্পেস যে সবাইকে গোনা যায়নি — নিচের সংখ্যাগুলো সর্বনিম্ন, প্রকৃত সংখ্যা এর চেয়ে বেশি হতে পারে।';

/** When a limit changes, when does the tenant feel it? */
export const APPLIES_NEXT_REQUEST =
  'নতুন সীমা তাঁদের পরবর্তী অনুরোধ থেকেই কার্যকর — কোনো ডিপ্লয় বা লগআউট লাগে না। হাতে দেওয়া ওভাররাইড এর উপরেই বসে থাকবে, তাই যাঁদের ওভাররাইড আছে তাঁদের কিছু বদলাবে না।';
