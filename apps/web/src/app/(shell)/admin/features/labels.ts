import { DEFAULT_FEATURES } from '@hishab/core';
import { CATEGORY_LABEL, PERIOD_LABEL } from '../labels';

/**
 * The catalogue's own vocabulary.
 *
 * Everything the tenant screens already name — categories, periods, unit
 * suffixes — is imported from `../labels` rather than copied, so a category
 * renamed there cannot read as a raw key here.
 */

export const KIND_LABEL: Record<string, string> = {
  LIMIT: 'সীমা',
  FLAG: 'চালু / বন্ধ',
  QUOTA: 'কোটা',
};

export const kindLabel = (kind: string): string => KIND_LABEL[kind] ?? kind;

/** One line each, shown under the picker: the whole decision in a sentence. */
export const KIND_HELP: Record<string, string> = {
  LIMIT: 'একটি ছাদ — যেমন ৫টি হিসাব। শূন্য মানে বন্ধ, ফাঁকা (সীমাহীন) মানে কোনো ছাদ নেই।',
  FLAG: 'শুধু চালু বা বন্ধ। ০ বন্ধ, ১ চালু — মাঝখানে কিছু নেই।',
  QUOTA: 'যে ছাদ প্রতি মাসে বা প্রতিদিন আবার ভরে যায়। কোন সময়ে ভরবে তা নিচের "সময়কাল"।',
};

export const kindHelp = (kind: string): string => KIND_HELP[kind] ?? '';

export const KIND_OPTIONS: readonly (readonly [string, string])[] = [
  ['LIMIT', kindLabel('LIMIT')],
  ['FLAG', kindLabel('FLAG')],
  ['QUOTA', kindLabel('QUOTA')],
];

/**
 * The units the shipped catalogue uses. The column is a plain string on
 * purpose — a feature invented this afternoon must be able to pick a unit this
 * build has never seen — so the form offers these and a free-text escape.
 */
export const UNIT_LABEL: Record<string, string> = {
  count: 'সংখ্যা',
  'per-month': 'সংখ্যা / মাস',
  megabytes: 'মেগাবাইট',
  tokens: 'টোকেন',
};

export const unitLabel = (unit: string): string => UNIT_LABEL[unit] ?? unit;

export const UNIT_OPTIONS: readonly (readonly [string, string])[] = Object.entries(UNIT_LABEL);

export const CATEGORY_OPTIONS: readonly (readonly [string, string])[] =
  Object.entries(CATEGORY_LABEL);

export const PERIOD_OPTIONS: readonly (readonly [string, string])[] = Object.entries(PERIOD_LABEL);

/** The sentence a new feature needs beside it, because nothing else says it. */
export const NEW_FEATURE_DEFAULT =
  'নতুন ফিচার কোনো প্ল্যানেই চালু হয় না। যে প্যাকেজে দাম বসাবেন কেবল সেখানেই এটি কাজ করবে — বাকি সব ওয়ার্কস্পেসে এটি বন্ধ (০) হিসেবে ধরা হবে।';

/**
 * Why the period is frozen too.
 *
 * `PATCH /admin/features/:key` is `.strict()` and leaves it out, so it is not
 * offered rather than offered and rejected. Moving a quota from monthly to
 * daily changes which bucket the meter counts into, and yesterday's usage would
 * be read out of a bucket nothing ever wrote to.
 */
export const PERIOD_IS_FROZEN =
  'সময়কালও বদলানো যায় না। কোটার মিটার কোন বালতিতে গোনা হয় তা এটিই ঠিক করে — বদলালে আগের গোনা ব্যবহার এমন এক বালতিতে খোঁজা হতো যেখানে কিছু লেখাই হয়নি।';

/** Why the kind is a create-time decision and never an edit. */
export const KIND_IS_FROZEN =
  'ধরন বদলানো যায় না। প্রতিটি প্যাকেজে ও ওভাররাইডে এই ফিচারের বিপরীতে যে সংখ্যাগুলো জমা আছে, ধরন বদলালে সেগুলোর মানেই বদলে যেত — ৫ মানে "৫টি" থেকে "চালু" হয়ে যেত। এপিআই তাই এটি ফিরিয়ে দেয়।';

/**
 * The features the build ships with, from the definitions the API seeds from
 * rather than a list typed here — a key renamed in `packages/core` must not
 * leave this screen making a claim about a feature that no longer exists.
 */
export const SEEDED_FEATURE_KEYS: ReadonlySet<string> = new Set(DEFAULT_FEATURES.map((f) => f.key));

export const isSeededFeature = (key: string): boolean => SEEDED_FEATURE_KEYS.has(key);

/**
 * What a deploy does to a shipped feature, which is much less than it used to.
 *
 * The boot seed now writes the labels, unit, category, order and active flag
 * only when it creates the row; the one thing it re-asserts every time is the
 * pair this screen cannot edit anyway. So an operator's corrections survive a
 * release, and it is worth saying, because until today they did not.
 */
export const SEEDED_FEATURE_HISTORY =
  'এটি বিল্ডের সঙ্গে আসা ফিচার। নাম, একক, বিভাগ, ক্রম ও চালু/অবসর — এখান থেকে করা এই বদলগুলো ডিপ্লয়ে আর মুছে যায় না, সারিটি না থাকলে কেবল তখনই কোড থেকে বসানো হয়। প্রতিটি ডিপ্লয়ে কেবল ধরন ও সময়কাল কোড থেকে আবার বসে, আর সে দুটি এখান থেকে বদলানোও যায় না।';

/** Why there is no delete here either. */
export const NO_FEATURE_DELETE =
  'ফিচার মোছা যায় না — প্যাকেজ ও ওভাররাইডের সারি এই কী-এর দিকে তাকিয়ে আছে। বদলে অবসর দিন: যারা এটি পেয়ে আছেন তাঁদের কিছু বদলাবে না, নতুন করে কোথাও বিক্রি হবে না।';
