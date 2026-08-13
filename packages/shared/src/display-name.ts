/**
 * Which of a row's two names to show.
 *
 * Categories and tags each carry `name` (English) and `nameBn` (Bengali). Until
 * now every reader of that pair wrote `nameBn ?? name` — always Bengali, in
 * thirty-seven places across the API and the web app. The English column was
 * stored, seeded, searched against, and never once displayed.
 *
 * ## Why the fallback goes both ways
 *
 * A row can be missing either name. The seeded tree has both. A category the
 * user made has only what they typed — and until the sheet gained an optional
 * English box, the same Bengali string was written into *both* columns. So:
 *
 * - English reader, English name present → English
 * - English reader, no English name → the Bengali, rather than nothing
 *
 * The second line is the important one. A picker that renders an empty row is
 * worse than one that renders a name in the wrong language: the wrong language
 * is still the category they are looking for, and a blank is a row they cannot
 * identify or choose. Nothing here can produce an empty string that a name
 * exists for.
 *
 * ## What this is not for
 *
 * Not for audit entries. Those record what happened at the time and are written
 * once; resolving them at read time would let the log's account of the past
 * change with a settings toggle. They keep writing the name they always did.
 */

import type { Locale } from './enums.js';

export interface BilingualName {
  name: string;
  nameBn?: string | null;
}

export function displayName(row: BilingualName, locale: Locale): string {
  if (locale === 'en') return row.name || row.nameBn || '';
  return row.nameBn || row.name || '';
}

/**
 * Sort two rows the way a reader of `locale` would expect them.
 *
 * `localeCompare` with the matching tag, so Bengali collates in Bengali order
 * rather than by code point — যাতায়াত and য়- prefixed words are not otherwise
 * adjacent, and a list nobody can predict the order of reads as unsorted.
 */
export function compareByDisplayName(a: BilingualName, b: BilingualName, locale: Locale): number {
  return displayName(a, locale).localeCompare(displayName(b, locale), locale);
}
