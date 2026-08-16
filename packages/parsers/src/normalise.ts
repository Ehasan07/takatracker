import { toAsciiDigits } from '@hishab/shared';
import { findCurrencyAmounts } from './currency.js';

/**
 * Stage 1 of the ingestion pipeline (spec §4.5): normalise an inbound message
 * so template regexes and the LLM fallback see one consistent shape.
 *
 * The original text is never mutated in place — callers keep `raw` for display
 * and use `normalised` for matching.
 *
 * Stages 2–7 (templates, LLM fallback, enrichment, confidence, dedupe,
 * learning) land in M8–M10.
 */

/* The ISO-code reader is re-exported from here rather than added to
 * `index.ts`, so the package's public surface grows without that file being
 * touched. `export *` is transitive: `index.ts` already re-exports this module
 * wholesale, so `findCurrencyAmounts` and `currencyForAmount` come out of
 * `@hishab/parsers` exactly as `normaliseMessage` does. */
export * from './currency.js';

export interface NormalisedMessage {
  /** Exactly what arrived. */
  raw: string;
  /** Whitespace-collapsed, ASCII digits, unified taka markers. */
  normalised: string;
  /** Uppercased copy for case-insensitive template matching. */
  upper: string;
  /**
   * The currency this message names against its first figure, or null when it
   * names none. `BDT` for `Tk 500`, `৳500`, `Taka 5,000` or `৫০০ টাকা`; `USD`
   * for a card charge abroad; null for a bare number.
   *
   * It is a field rather than something the fold below could carry, because
   * folding is lossy by design: eight spellings of the taka become one marker,
   * and the marker is the string `BDT`. A dollar amount must never go through
   * that door — the number that came out the other side would be a taka figure
   * nobody ever wrote.
   */
  currency: string | null;
}

export function normaliseMessage(raw: string): NormalisedMessage {
  let s = raw.normalize('NFC');

  // Zero-width and directional marks that bank gateways love to inject.
  s = s.replace(/[\u200B-\u200F\u202A-\u202E\uFEFF]/g, '');

  s = toAsciiDigits(s);

  /* Unify every Latin spelling of the *taka* to "BDT " so one regex alternative
   * covers all of them.
   *
   * `Taka 5,000 debited` is a real message from a real bank and used to carry no
   * marker anything here recognised — the figure was found, the currency was
   * not. The trailing `\.?` takes `Tk.` and `BDT.`; the closing `(?![A-Za-z])`
   * is what keeps `Takaful` — insurance, and a category name in this product —
   * from being rewritten as "BDTful", and `TKS` from becoming money.
   *
   * Only the taka, and the restriction is the whole point. This replacement
   * rewrites a marker into the literal `BDT`, so sending `USD` or `EUR` through
   * it would relabel somebody's dollars as taka in the very string every
   * downstream regex reads. `$4.60` is not `৳4.60` — it is about a hundred and
   * twenty times more money — and a normaliser is the last place that should be
   * deciding otherwise. What currency a foreign message is in is reported on
   * `currency` below, read out of the untouched text. */
  s = s.replace(/(?<![A-Za-z])(?:BDT|Tk|TK|tk|Taka|TAKA|taka)\.?(?![A-Za-z])\s*/g, 'BDT ');

  /* The same fold for Bengali, and it has to be its own expression.
   *
   * `\b` is an ASCII word boundary and matches nothing useful beside a Bengali
   * letter, so `\bটাকা\b` never fires — putting these two into the alternation
   * above would look right in a diff and silently never match, which is a
   * mistake this repository has made before. `৳` needs no boundary at all and
   * `টাকা` is a plain substring, which is safe because it is a whole word in
   * every form it takes: টাকা, টাকার, টাকায়.
   *
   * bKash and Nagad send messages with no Latin character in them at all —
   * `৫০০ টাকা কাটা হয়েছে` — and until this line existed the only marker they
   * carried that anything here recognised was the `৳` some of them omit. */
  s = s.replace(/(?:৳|টাকা)\s*/g, 'BDT ');

  // Collapse all whitespace (including newlines) to single spaces.
  s = s.replace(/\s+/g, ' ').trim();

  /* Read from `raw`, not from `s`. By this point every taka spelling has become
     the literal `BDT ` and every figure has been folded to ASCII, so the only
     copy of the message that still knows what the bank actually wrote is the
     one that arrived — and the quotation this produces is shown to a person,
     who has to be able to recognise their own SMS in it. */
  const stated = findCurrencyAmounts(raw)[0];

  return { raw, normalised: s, upper: s.toUpperCase(), currency: stated?.currency ?? null };
}

/** Mask anything that looks like an account or card number: keep the last 4. */
export function maskAccountNumbers(text: string): string {
  // Must start and end on a digit so a trailing space is never swallowed.
  return text.replace(/\b[Xx*]*\d[\d\s-]{4,}\d\b/g, (match) => {
    const digits = match.replace(/\D/g, '');
    if (digits.length < 6) return match;
    return `****${digits.slice(-4)}`;
  });
}

/** Mask Bangladeshi mobile numbers, keeping the last 3 digits. */
export function maskPhoneNumbers(text: string): string {
  return text.replace(/\b(?:\+?880|0)1[3-9]\d{8}\b/g, (m) => `01******${m.slice(-3)}`);
}

/**
 * The only form of a message body that may ever be sent to an LLM.
 * Spec §4.7: a test asserts an unredacted body cannot reach the LLM client.
 */
export function redactForLlm(text: string): string {
  return maskAccountNumbers(maskPhoneNumbers(text));
}
