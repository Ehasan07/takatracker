/**
 * The shapes `apps/api/src/tags` actually returns, and the one rule this whole
 * feature exists to keep visible.
 *
 * **A category is not a tag.** The category answers *what the money went on* —
 * খাবার ও বাজার, যাতায়াত — and there is exactly one per transaction, because
 * every spending report in this product divides money up that way and would
 * stop meaning anything if a taka could be counted under two headings. A tag
 * answers *who it was for* or *what project it belonged to* — পারিবারিক,
 * শ্বশুরবাড়ি, রমজান, গাড়ি — and a transaction may carry as many as the truth
 * needs, because the same grocery bill really is a family expense one week and
 * a business one the next.
 *
 * If a user cannot tell why both exist they will use tags as a second set of
 * categories, and then neither report answers anything. That is why the
 * sentence below is repeated on the screen rather than only in this comment.
 *
 * Amounts are integer poisha exactly as the API sends them; nothing here turns
 * one into taka except `<Money>`.
 */

/** The one-line explanation, in one place, so every screen says the same thing. */
export const TAG_VS_CATEGORY =
  'ক্যাটাগরি বলে কীসে খরচ হলো — খাবার, যাতায়াত। ট্যাগ বলে কার জন্য বা কোন কাজে — পারিবারিক, শ্বশুরবাড়ি, রমজান। একটি লেনদেনে ক্যাটাগরি একটাই, ট্যাগ যত খুশি।';

/** `GET /v1/tags?q=` — one row per tag, with what has moved under it. */
export interface TagDto {
  id: string;
  name: string;
  nameBn: string | null;
  color: string | null;
  icon: string | null;
  sortOrder: number;
  /** Extra words that also find this tag. Returned on every response. */
  searchAliases: string[];
  /** Live transactions carrying the tag, of every type — transfers included. */
  transactionCount: number;
  incomeMinor: number;
  expenseMinor: number;
  /** `incomeMinor − expenseMinor`. The one figure to print when there is room for one. */
  netMinor: number;
}

/**
 * A tag as it rides along on a transaction (`TransactionView.tags`).
 *
 * Declared here rather than on `TransactionDto` in `@/lib/api` because that file
 * belongs to another change; the ledger screen intersects it in, the same way it
 * already intersects `attachmentIds`.
 */
export interface TransactionTagDto {
  id: string;
  name: string;
  color: string | null;
  icon: string | null;
}

/** `DELETE /v1/tags/:id` — states out loud that nothing was destroyed. */
export interface DeleteTagResult {
  id: string;
  name: string;
  detachedTransactionCount: number;
  deletedTransactionCount: number;
  message: string;
}

/** `POST /v1/tags/:id/merge` */
export interface MergeTagResult {
  from: { id: string; name: string };
  into: { id: string; name: string };
  movedTransactionCount: number;
  /** Rows that already carried both tags, so nothing moved for them. */
  alreadyTaggedCount: number;
  /**
   * How many of the dead tag's words actually landed on the survivor. Can be
   * zero when the survivor's alias list is already full — in which case the
   * promise "the old name keeps finding it" is not true and must not be made.
   */
  aliasesAdded: number;
  message: string;
}

/** Display name: the Bengali one when there is one. */
export const tagName = (tag: { name: string; nameBn?: string | null }): string =>
  tag.nameBn ?? tag.name;

/**
 * The colours a tag may be given.
 *
 * The same ledger palette the report slices use, so a tag keeps its colour
 * between the picker, the khata and the report, and neighbouring swatches stay
 * apart in both themes and for the commonest colour-vision deficiencies.
 */
export const TAG_COLOURS: readonly (readonly [string, string])[] = [
  ['#1F6F4A', 'সবুজ'],
  ['#4C7BA6', 'নীল'],
  ['#8E6C18', 'সোনালি'],
  ['#A8342A', 'লাল'],
  ['#6B5B95', 'বেগুনি'],
  ['#2E8B75', 'ফিরোজা'],
  ['#B4553F', 'কমলা'],
  ['#5C6B73', 'ধূসর'],
];

export const DEFAULT_TAG_COLOUR = TAG_COLOURS[0]![0];

const HEX = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/**
 * A colour safe to hand to `style`.
 *
 * The column is a free-text `varchar(20)` the API does not validate, so a value
 * written by an older client — or by a script — reaches this screen unchecked.
 * Anything that is not a plain hex triple is dropped rather than interpolated
 * into a style attribute.
 */
export function safeColour(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return HEX.test(trimmed) ? trimmed : null;
}
