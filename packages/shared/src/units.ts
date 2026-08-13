/**
 * The units a quantity can be counted in.
 *
 * ## Why this list is short and not authoritative
 *
 * `Transaction.quantityUnit` is free text and always will be. A fixed enum is
 * wrong within a week — কেজি, লিটার, পিস, ডজন, হালি, বস্তা, গজ, স্ট্রিপ, ভরি
 * are all real, and the list a Bangladeshi household or shop needs is not one
 * anybody can finish writing in advance. So these eight are a *keyboard
 * shortcut*, nothing more: the ones almost every grocery entry uses, offered so
 * the common case is one tap.
 *
 * ## Why it lives in shared rather than in the web bundle
 *
 * A workspace can add its own units, and the API refuses one that duplicates a
 * shipped unit. That check has to read the same eight strings the client shows,
 * or somebody adds `কেজি` to their own list, sees it twice in the dropdown, and
 * the second one is unremovable through the screen that only manages theirs.
 */

/** Offered, never enforced. The field stays free text. */
export const COMMON_QUANTITY_UNITS = [
  'কেজি',
  'গ্রাম',
  'লিটার',
  'পিস',
  'ডজন',
  'হালি',
  'বস্তা',
  'প্যাকেট',
] as const;

/** As long as `quantityUnit` itself accepts; see `simpleTransactionSchema`. */
export const MAX_UNIT_LENGTH = 20;

/**
 * How many units one workspace may add.
 *
 * Not a storage limit — the whole array is a few hundred bytes. It is a limit on
 * the dropdown: a suggestion list longer than a screen has stopped being a
 * shortcut and become a second thing to search through, which is the problem the
 * free-text field already solves better.
 */
export const MAX_CUSTOM_UNITS = 30;

/**
 * One canonical spelling, for deciding whether two units are the same one.
 *
 * Whitespace and case only. Deliberately *not* transliteration: `kg` and `কেজি`
 * are the same unit to a person and two different strings to every report that
 * groups by unit, and quietly folding them here would make the report disagree
 * with the rows it summed. If somebody wants both spellings to add together,
 * that is a rename of the saved rows, not a display trick.
 */
export function normaliseUnit(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Clean a submitted list: trimmed, de-duplicated, shipped units dropped, capped.
 *
 * Order is preserved, because it is the order the dropdown shows and the person
 * who typed the list chose it.
 */
export function normaliseUnitList(raw: readonly string[]): string[] {
  const shipped = new Set(COMMON_QUANTITY_UNITS.map(normaliseUnit));
  const seen = new Set<string>();
  const out: string[] = [];

  for (const entry of raw) {
    const value = entry.trim().replace(/\s+/g, ' ');
    if (!value || value.length > MAX_UNIT_LENGTH) continue;
    const key = normaliseUnit(value);
    if (shipped.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= MAX_CUSTOM_UNITS) break;
  }

  return out;
}

/** What the quantity field should offer: the shipped eight, then this workspace's. */
export function unitSuggestions(custom: readonly string[] | null | undefined): string[] {
  return [...COMMON_QUANTITY_UNITS, ...normaliseUnitList(custom ?? [])];
}
