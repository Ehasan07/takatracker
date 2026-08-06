import { toAsciiDigits } from '@hishab/shared';

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

export interface NormalisedMessage {
  /** Exactly what arrived. */
  raw: string;
  /** Whitespace-collapsed, ASCII digits, unified currency markers. */
  normalised: string;
  /** Uppercased copy for case-insensitive template matching. */
  upper: string;
}

export function normaliseMessage(raw: string): NormalisedMessage {
  let s = raw.normalize('NFC');

  // Zero-width and directional marks that bank gateways love to inject.
  s = s.replace(/[\u200B-\u200F\u202A-\u202E\uFEFF]/g, '');

  s = toAsciiDigits(s);

  // Unify currency markers to "BDT " so one regex alternative covers all of them.
  s = s.replace(/(?:৳|\bTk\.?|\bTK\.?|\btk\.?|\bBDT\b)\s*/g, 'BDT ');

  // Collapse all whitespace (including newlines) to single spaces.
  s = s.replace(/\s+/g, ' ').trim();

  return { raw, normalised: s, upper: s.toUpperCase() };
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
