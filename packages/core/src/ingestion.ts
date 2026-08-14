import { parseMoneyToMinor, toAsciiDigits } from '@hishab/shared';

/**
 * The ingestion core: everything that happens to an inbound message between it
 * arriving and a human being asked about it.
 *
 * What is here is the *pipeline* — deduplication, a parser registry, a
 * confidence model, and one generic fallback parser. What is deliberately **not**
 * here is a single bank-specific parser. Nobody has supplied real redacted
 * samples yet, and a regex written against a message format we have never seen
 * is a confident lie. Adding a real one later is one new file exporting a
 * `MessageParser` and one entry in the `createRegistry([...])` call; nothing in
 * this file changes.
 *
 * Three rules run through all of it:
 *
 *  1. **Nothing here writes to a ledger.** A `ParseResult` is a proposal. The
 *     only thing that turns one into a transaction is a person accepting it.
 *  2. **Every field carries the text it came from.** `evidence` maps a field
 *     name to the exact substring it was read out of, so a review screen can
 *     show its working. A draft nobody can check is a draft nobody should accept.
 *  3. **A field with no evidence entry was not read — it was inferred.** That is
 *     the whole rule `scoreConfidence` runs on, and it is why the scorer needs
 *     nothing beyond the fields and the evidence.
 *
 * Amounts are integer poisha throughout, parsed by `parseMoneyToMinor` from
 * @hishab/shared — the one money parser in the codebase, which already knows
 * about Bengali digits, `৳`, `Tk`, `BDT` and lakh-crore commas.
 *
 * No Node imports: the same code has to run in the API, in the browser, and on
 * the phone. The Android SMS forwarder has to compute the *same* `bodyHashOf`
 * offline in order to dedupe before it syncs, which is why the hash below is
 * written out rather than taken from `node:crypto`.
 */

export type IngestionChannel = 'SMS' | 'EMAIL' | 'WEBHOOK';

/** A message exactly as it arrived. The body is never cleaned up. */
export interface RawMessage {
  channel: IngestionChannel;
  /** Sender address, shortcode or webhook source. */
  sender?: string;
  /** Exactly what arrived, byte for byte. */
  body: string;
  /**
   * The calendar day the message arrived on in the *workspace's* timezone,
   * `YYYY-MM-DD`. Used only as the date fallback when the message itself does
   * not carry one. Passed in rather than derived so this module never has to
   * know about timezones — the caller has already resolved the workspace's.
   */
  receivedOn?: string;
}

export interface ParsedFields {
  /** `YYYY-MM-DD`. */
  date?: string;
  amountMinor?: number;
  direction?: 'IN' | 'OUT';
  payee?: string;
  /** The balance the message reports *after* the movement, poisha. */
  balanceMinor?: number;
  /** Whatever identifies the account: a masked tail, a card number's last four. */
  accountHint?: string;
}

export interface ParseResult {
  fields: ParsedFields;
  /** 0–100. See `scoreConfidence`. */
  confidence: number;
  /**
   * Field name → the exact substring of `body` it was read from. A field
   * present in `fields` but absent here was inferred, not read.
   */
  evidence: Record<string, string>;
  parserName: string;
}

export interface MessageParser {
  /** Stable identifier, stored on the message so a bad parse can be traced. */
  name: string;
  /** Cheap pre-filter: is this message this parser's business at all? */
  matches(msg: RawMessage): boolean;
  /** `null` means "I recognised the sender but not this message". */
  parse(msg: RawMessage): ParseResult | null;
}

export interface ParserRegistry {
  /** Never null — the generic parser is the floor. */
  parse(msg: RawMessage): ParseResult;
  /** Specific parsers in precedence order, with the generic one last. */
  readonly parsers: readonly MessageParser[];
}

// --- SHA-256 -----------------------------------------------------------------

/*
 * Written out rather than imported, because `packages/core` must stay runnable
 * in a browser and on a phone, and because `bodyHashOf` has to be synchronous
 * (WebCrypto's digest is not). Correctness is not taken on trust: the tests
 * check it against the published FIPS 180-4 vectors for "" and "abc", so a
 * mistyped round constant fails loudly rather than silently changing every
 * dedup key in the database.
 */

/** First 32 bits of the fractional parts of the cube roots of the first 64 primes. */
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/** First 32 bits of the fractional parts of the square roots of the first 8 primes. */
const H0 = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

/**
 * UTF-8 bytes of a JavaScript string.
 *
 * Written by hand because `TextEncoder` is a host global, not part of the
 * ES2022 library this package compiles against. Lone surrogates become U+FFFD,
 * exactly as `TextEncoder` would, so swapping in a native digest later cannot
 * change a single hash.
 */
function utf8Bytes(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        i += 1;
      }
    }
    if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd; // unpaired surrogate

    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return out;
}

/** SHA-256 of a string's UTF-8 bytes, lower-case hex. */
export function sha256Hex(text: string): string {
  const bytes = utf8Bytes(text);
  const bitLength = bytes.length * 8;

  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  // 64-bit big-endian bit length, high word first. Split by division rather
  // than by shifting: `>>>` wraps at 32 bits and a long body would silently
  // pad with the wrong length.
  const highWord = Math.floor(bitLength / 0x1_0000_0000);
  const lowWord = bitLength - highWord * 0x1_0000_0000;
  bytes.push(
    (highWord >>> 24) & 0xff,
    (highWord >>> 16) & 0xff,
    (highWord >>> 8) & 0xff,
    highWord & 0xff,
  );
  bytes.push(
    (lowWord >>> 24) & 0xff,
    (lowWord >>> 16) & 0xff,
    (lowWord >>> 8) & 0xff,
    lowWord & 0xff,
  );

  const h = Uint32Array.from(H0);
  const w = new Uint32Array(64);

  for (let block = 0; block < bytes.length; block += 64) {
    for (let i = 0; i < 16; i += 1) {
      const p = block + i * 4;
      w[i] =
        (((bytes[p] as number) << 24) |
          ((bytes[p + 1] as number) << 16) |
          ((bytes[p + 2] as number) << 8) |
          (bytes[p + 3] as number)) >>>
        0;
    }
    for (let i = 16; i < 64; i += 1) {
      const x = w[i - 15] as number;
      const y = w[i - 2] as number;
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) >>> 0;
    }

    let a = h[0] as number;
    let b = h[1] as number;
    let c = h[2] as number;
    let d = h[3] as number;
    let e = h[4] as number;
    let f = h[5] as number;
    let g = h[6] as number;
    let hh = h[7] as number;

    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = hh + s1 + ch + (K[i] as number) + (w[i] as number);
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = s0 + maj;

      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h[0] = ((h[0] as number) + a) >>> 0;
    h[1] = ((h[1] as number) + b) >>> 0;
    h[2] = ((h[2] as number) + c) >>> 0;
    h[3] = ((h[3] as number) + d) >>> 0;
    h[4] = ((h[4] as number) + e) >>> 0;
    h[5] = ((h[5] as number) + f) >>> 0;
    h[6] = ((h[6] as number) + g) >>> 0;
    h[7] = ((h[7] as number) + hh) >>> 0;
  }

  let hex = '';
  for (let i = 0; i < 8; i += 1) hex += (h[i] as number).toString(16).padStart(8, '0');
  return hex;
}

// --- deduplication -----------------------------------------------------------

/**
 * The normalisation applied to every part before hashing. **This is the whole
 * deduplication rule**, so it is spelled out rather than left to be inferred:
 *
 *  1. **NFC.** The same Bengali word can arrive in two byte sequences depending
 *     on which keyboard typed it; both mean the same message.
 *  2. **Every run of whitespace — spaces, tabs, newlines, no-break spaces —
 *     becomes a single space, and the ends are trimmed.** The same alert
 *     redelivered by a retrying forwarder routinely differs by a trailing space
 *     or by `\r\n` instead of `\n`. Without this, one alert becomes two drafts
 *     and somebody's books are doubled.
 *  3. **Lower case.** Some gateways upper-case the whole body on a retry. The
 *     trade-off is accepted knowingly: two genuinely different alerts that
 *     differ *only* in letter case would collide, and in a bank SMS that does
 *     not happen — the digits are what differ.
 *
 * Zero-width and directional marks are stripped for the same reason as (1):
 * gateways inject them, and they carry no meaning.
 */
function normaliseForHash(part: string): string {
  return part
    .normalize('NFC')
    .replace(/[\u200B-\u200F\u202A-\u202E\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * The deduplication key: SHA-256 over the normalised channel, sender and body.
 *
 * The three parts are joined with a newline, which no part can itself contain
 * after normalisation — so "sms" + "bank: hi" can never hash the same as
 * "sms\nbank" + "hi". A missing sender is the empty string rather than being
 * omitted, so the shape of the input never changes.
 *
 * Sender is in the key on purpose: the identical text from two different
 * shortcodes is two different alerts, and merging them across channels is a
 * separate decision (spec §4.5 stage 6) that belongs to a human-visible merge,
 * not to a silent hash collision.
 */
export function bodyHashOf(
  channel: IngestionChannel | string,
  sender: string | null | undefined,
  body: string,
): string {
  const parts = [normaliseForHash(channel), normaliseForHash(sender ?? ''), normaliseForHash(body)];
  return sha256Hex(parts.join('\n'));
}

// --- confidence --------------------------------------------------------------

/**
 * At or above this, every field the ledger needs was actually read out of the
 * message, so the review screen may offer a one-tap accept. Below it, the
 * screen has to highlight what is missing and make the person supply it.
 *
 * 80 rather than some rounder number because it is where spec §4.5 draws the
 * line (0.8 on its 0–1 scale), and because the weights below are chosen so that
 * amount-plus-direction-plus-date — the three things a transaction cannot exist
 * without — is exactly the cheapest way to reach it.
 *
 * It is a *presentation* threshold, not a permission. The accept endpoint
 * validates the merged fields whatever the score; a low-confidence draft is
 * perfectly acceptable once a human has filled in the gaps.
 */
export const REVIEW_THRESHOLD = 80;

/** A currency marker in an evidence span is the difference between reading an amount and finding a number. */
const MARKED_AMOUNT = /৳|BDT|TK\.?/i;

/**
 * How much of this message did we actually understand? 0–100.
 *
 *   amount, with a `৳`/`Tk`/`BDT` marker  +45
 *   amount, a bare number we picked out   +30
 *   direction (credited / debited / জমা)  +25
 *   date read from the text               +15
 *   closing balance                        +8
 *   payee                                  +7
 *   account hint                           +5
 *
 * Two hard rules override the arithmetic:
 *
 *  - **No amount, no confidence.** A draft with no figure is not a 20%-certain
 *    transaction, it is not a transaction at all. Returning a number above zero
 *    would invite a bulk-accept to sweep it up.
 *  - **A guessed direction or a guessed date caps the score at 40**, well below
 *    `REVIEW_THRESHOLD`. Getting the direction wrong books money the wrong way
 *    round, and a date defaulted to the day the SMS was forwarded lands the
 *    entry in the wrong month. Neither may ever look like a confident parse,
 *    however much else was read.
 *
 * Everything is derived from `evidence`: a field present in `fields` but absent
 * from `evidence` was inferred rather than read.
 */
export function scoreConfidence(fields: ParsedFields, evidence: Record<string, string>): number {
  const amountEvidence = evidence.amountMinor;
  if (fields.amountMinor === undefined || amountEvidence === undefined) return 0;

  let score = MARKED_AMOUNT.test(amountEvidence) ? 45 : 30;

  const directionRead = evidence.direction !== undefined && fields.direction !== undefined;
  const dateRead = evidence.date !== undefined && fields.date !== undefined;

  if (directionRead) score += 25;
  if (dateRead) score += 15;
  if (evidence.balanceMinor !== undefined) score += 8;
  if (evidence.payee !== undefined) score += 7;
  if (evidence.accountHint !== undefined) score += 5;

  if (!directionRead || !dateRead) score = Math.min(score, 40);
  return Math.min(100, Math.max(0, Math.trunc(score)));
}

// --- the generic parser ------------------------------------------------------

/*
 * A deliberately format-agnostic reader. It looks for the three things every
 * money alert on earth contains somewhere — an amount, a date, and a word
 * saying which way the money went — plus a closing balance and an account tail
 * when they are there, and it reports honestly that it is guessing.
 *
 * All matching happens on `toAsciiDigits(body)`, which maps Bengali and
 * Arabic-Indic digits to ASCII **one character to one character**, so an index
 * into the scanned string is the same index into the original. Evidence is
 * always sliced out of the original, which is why a Bengali alert's evidence
 * reads "৳১,২৫০.৫০" and not "৳1,250.50" — the person checking it has to see
 * what their bank actually sent.
 */

/** `৳`, `Tk`, `TK.`, `BDT` — never as the tail of a longer word. */
const CURRENCY_MARK = String.raw`(?:৳|BDT|TK\.?)`;

/** `1234`, `1,234`, `1,23,456.78` — lakh-crore or thousands grouping, at most two decimals. */
const NUMBER = String.raw`\d+(?:,\d{2,3})*(?:\.\d{1,2})?`;

/**
 * A number with an optional currency marker on either side.
 *
 * The trailing marker refuses to attach when another number follows it, because
 * in "Cash In from 01712345678 Tk 300.00" the `Tk` belongs to the 300, not to
 * the phone number in front of it. Swallowing it there would turn a mobile
 * number into a ৳1.7 billion deposit.
 */
const MONEY_RE = new RegExp(
  String.raw`(?:(?<![A-Za-z0-9])(${CURRENCY_MARK})\s*)?(${NUMBER})(?:\s*(${CURRENCY_MARK})(?![A-Za-z])(?!\s*\d))?`,
  'gi',
);

const ISO_DATE_RE = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/;
const NUMERIC_DATE_RE = /(?<![\d/.-])(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(?!\d)/;
const NAMED_DATE_RE =
  /(?<![A-Za-z0-9])(\d{1,2})[\s-]?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*,?[\s-]?(\d{2,4})(?!\d)/i;

const MONTH_NAMES = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
];

/** `14:32`, `2:05:11 pm` — excluded from the amount hunt so a clock is never money. */
const TIME_RE = /(?<![\d:])\d{1,2}:\d{2}(?::\d{2})?(?:\s?[ap]\.?m\.?)?/i;

const BALANCE_RE = new RegExp(
  String.raw`(?:avail(?:able)?\.?\s*)?(?<![A-Za-z])(?:bal(?:ance)?|ব্যালেন্স|ব্যালান্স|স্থিতি|অবশিষ্ট)\.?\s*(?:is|:|-)?\s*(?:${CURRENCY_MARK}\s*)?(${NUMBER})`,
  'i',
);

/** `**4521`, `xxxx1234` — a masked tail on its own. */
const MASKED_TAIL_RE = /[xX*]{2,}[\s-]?\d{2,6}/;

/** `A/C no. 1234`, `Card ending 4521`, `অ্যাকাউন্ট 1234`. */
const LABELLED_ACCOUNT_RE =
  /(?:A\/C|Acct?|Account|Card|Wallet|অ্যাকাউন্ট|হিসাব)\.?\s*(?:no\.?|number|ending|ends?|#)?\s*[:-]?\s*((?:[xX*]{2,}[\s-]?)?\d{3,20})/i;

/**
 * Money moving in and money moving out, longest spelling first so `credited`
 * wins over `credit` at the same position.
 *
 * `credit`/`debit` refuse to match when the next word is `card`: "your debit
 * card has been credited" must not read as OUT, and in Bangladesh the card type
 * is named in the alert far more often than not. `payment received` is listed
 * as an inbound phrase before the outbound bare `payment` for the same reason.
 */
const IN_WORDS = [
  'credited',
  String.raw`credit(?!\s*card)`,
  'deposited',
  'deposit',
  String.raw`payment\s+received`,
  'received',
  String.raw`refund(?:ed)?`,
  String.raw`cash\s?in`,
  String.raw`add\s?money`,
  'জমা',
  'পেয়েছেন',
  'গ্রহণ',
  'ফেরত',
];

const OUT_WORDS = [
  'debited',
  String.raw`debit(?!\s*card)`,
  'withdrawn',
  'withdrawal',
  String.raw`purchase(?:d)?`,
  'payment',
  'paid',
  'spent',
  'charged',
  String.raw`transferred\s+to`,
  String.raw`send\s?money`,
  String.raw`cash\s?out`,
  'উত্তোলন',
  'খরচ',
  'পরিশোধ',
  'কর্তন',
  'প্রদান',
];

const DIRECTION_RE = new RegExp(
  `(?<![A-Za-z])(?:(${IN_WORDS.join('|')})|(${OUT_WORDS.join('|')}))`,
  'i',
);

/**
 * `to BADHON STORE`, `from CITY BANK`. Every word has to start with a capital,
 * which is what keeps ordinary sentence text ("credited to your account") out,
 * and the run stops before a currency word so the amount is not swallowed.
 */
const PAYEE_RE =
  /(?<![A-Za-z])(?:to|from|at)\s+([A-Z][A-Za-z&.'-]{1,}(?:\s+(?!Tk\b|TK\b|BDT\b|Taka\b)[A-Z0-9][A-Za-z0-9&.'-]*){0,4})/;

/** How far back to look for a word that changes what a number means. */
const LOOKBACK = 24;

/**
 * A fee is an amount, but it is never *the* amount. Only the text before the
 * number is checked: "Fee Tk 5.00" and "চার্জ ৳৫" are how these are written.
 * A trailing "…including a Tk 5 fee" is not caught, and is left for a real
 * bank parser that knows the format.
 */
const FEE_BEFORE_RE = /(?:fee|charge|vat|tax|comm(?:ission)?|চার্জ|ফি|ভ্যাট|কর)\W{0,6}$/i;

const AMOUNT_LABEL_BEFORE_RE = /(?:amount|amt|পরিমাণ)\W{0,4}$/i;

interface Span {
  start: number;
  end: number;
}

const overlaps = (span: Span, others: readonly Span[]): boolean =>
  others.some((other) => span.start < other.end && other.start < span.end);

/** A found value together with the exact span of text it was read from. */
interface Read<T> extends Span {
  value: T;
}

function readMoney(text: string): number | null {
  try {
    const minor = parseMoneyToMinor(text);
    return Number.isSafeInteger(minor) ? minor : null;
  } catch {
    // Not a number after all — say so rather than fabricating a figure.
    return null;
  }
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  // Day 0 of the next month is the last day of this one, whatever its length.
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isoOrNull(year: number, month: number, day: number): string | null {
  return isRealDate(year, month, day)
    ? `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`
    : null;
}

/**
 * A date out of the message text, `YYYY-MM-DD`.
 *
 * ISO first, then `DD/MM/YYYY`, then `07 Aug 2026`. Two decisions worth stating:
 *
 *  - **`07/08/2026` is 7 August, not 8 July.** Day-first is how dates are written
 *    in Bangladesh, on bank statements and everywhere else. Where the numbers
 *    settle it — a first component above 12 — that wins over the convention, and
 *    a second component above 12 forces the other reading.
 *  - **A two-digit year is 20xx.** There are no bank alerts from 1998.
 */
function findDate(scan: string): Read<string> | null {
  const iso = ISO_DATE_RE.exec(scan);
  if (iso) {
    const value = isoOrNull(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    if (value) return { value, start: iso.index, end: iso.index + iso[0].length };
  }

  const numeric = NUMERIC_DATE_RE.exec(scan);
  if (numeric) {
    const a = Number(numeric[1]);
    const b = Number(numeric[2]);
    const rawYear = Number(numeric[3]);
    const year = rawYear < 100 ? 2000 + rawYear : rawYear;
    const [day, month] = a > 12 ? [a, b] : b > 12 ? [b, a] : [a, b];
    const value = isoOrNull(year, month, day);
    if (value) return { value, start: numeric.index, end: numeric.index + numeric[0].length };
  }

  const named = NAMED_DATE_RE.exec(scan);
  if (named) {
    const day = Number(named[1]);
    const month = MONTH_NAMES.indexOf((named[2] as string).toLowerCase()) + 1;
    const rawYear = Number(named[3]);
    const year = rawYear < 100 ? 2000 + rawYear : rawYear;
    const value = isoOrNull(year, month, day);
    if (value) return { value, start: named.index, end: named.index + named[0].length };
  }

  return null;
}

function findBalance(scan: string): Read<number> | null {
  const match = BALANCE_RE.exec(scan);
  if (!match) return null;
  const minor = readMoney(match[1] as string);
  if (minor === null) return null;
  return { value: minor, start: match.index, end: match.index + match[0].length };
}

function findAccountHint(scan: string): Read<string> | null {
  const masked = MASKED_TAIL_RE.exec(scan);
  const labelled = LABELLED_ACCOUNT_RE.exec(scan);

  // Whichever appears first: a masked tail on its own is as good a hint as a
  // labelled one, and messages carry either.
  const first =
    masked && labelled
      ? masked.index <= labelled.index
        ? masked
        : labelled
      : (masked ?? labelled);
  if (!first) return null;

  const digits = (first[1] ?? first[0]).replace(/\D/g, '');
  if (digits.length < 2) return null;
  // The tail is the identifying part, and it is all we are entitled to keep.
  const value = digits.length > 4 ? digits.slice(-4) : digits;
  return { value, start: first.index, end: first.index + first[0].length };
}

function findDirection(scan: string): Read<'IN' | 'OUT'> | null {
  const match = DIRECTION_RE.exec(scan);
  if (!match) return null;
  return {
    value: match[1] !== undefined ? 'IN' : 'OUT',
    start: match.index,
    end: match.index + match[0].length,
  };
}

function findTime(scan: string): Span | null {
  const match = TIME_RE.exec(scan);
  return match ? { start: match.index, end: match.index + match[0].length } : null;
}

interface AmountCandidate extends Span {
  minor: number;
  marked: boolean;
  labelled: boolean;
}

/**
 * The transaction amount, or null.
 *
 * Everything already understood as something else — the date, a clock time, the
 * account tail, the closing balance — is off limits, so a message whose only
 * figure is its balance yields no amount at all rather than booking the balance
 * as a payment. Of what is left: a number with a currency marker beats a
 * labelled one, which beats the first bare number in the message.
 */
function findAmount(scan: string, excluded: readonly Span[]): AmountCandidate | null {
  const candidates: AmountCandidate[] = [];

  for (const match of scan.matchAll(MONEY_RE)) {
    const start = match.index;
    const end = start + match[0].length;
    if (overlaps({ start, end }, excluded)) continue;

    // Glued to letters or digits on either side, so it is a reference or an id
    // rather than a sum of money: `TXN9F2K1A`, `1234567890123`.
    const before = start > 0 ? scan.charAt(start - 1) : '';
    const after = end < scan.length ? scan.charAt(end) : '';
    if (/[A-Za-z0-9]/.test(before) || /[A-Za-z0-9]/.test(after)) continue;

    const marked = match[1] !== undefined || match[3] !== undefined;
    const digits = (match[2] as string).replace(/\D/g, '');
    // An unmarked run of nine or more digits is a phone number or an account
    // number, not a sum. A marked one is whatever the bank says it is.
    if (!marked && digits.length >= 9) continue;

    const minor = readMoney(match[2] as string);
    if (minor === null || minor <= 0) continue;

    const preceding = scan.slice(Math.max(0, start - LOOKBACK), start);
    if (FEE_BEFORE_RE.test(preceding)) continue;

    candidates.push({
      minor,
      marked,
      labelled: AMOUNT_LABEL_BEFORE_RE.test(preceding),
      start,
      end,
    });
  }

  return (
    candidates.find((c) => c.marked) ?? candidates.find((c) => c.labelled) ?? candidates[0] ?? null
  );
}

function findPayee(scan: string): Span | null {
  const match = PAYEE_RE.exec(scan);
  if (!match) return null;
  const group = match[1] as string;
  const start = match.index + match[0].length - group.length;
  return { start, end: start + group.length };
}

/**
 * The fallback that runs when no bank-specific parser recognises a message.
 *
 * It matches everything, by definition — it is the floor of the registry, not a
 * competitor to a real parser. Its ceiling is low on purpose: with an amount, a
 * direction and a date all genuinely read it reaches 85, and short of any of
 * those it cannot exceed 40.
 */
export const genericParser: MessageParser = {
  name: 'generic',

  matches(): boolean {
    return true;
  },

  parse(msg: RawMessage): ParseResult {
    const body = msg.body;
    /* One character in, one character out — see the note above `CURRENCY_MARK`.
     * Every index below is therefore valid in `body` as well as in `scan`. */
    const scan = toAsciiDigits(body);

    const fields: ParsedFields = {};
    const evidence: Record<string, string> = {};
    const claimed: Span[] = [];

    const date = findDate(scan);
    if (date) {
      fields.date = date.value;
      evidence.date = body.slice(date.start, date.end);
      claimed.push(date);
    } else if (msg.receivedOn) {
      /* The day it reached us, which is usually but not always the day it
       * happened. Deliberately left out of `evidence`: it was not read from the
       * message, so `scoreConfidence` must treat it as the guess it is. */
      fields.date = msg.receivedOn;
    }

    const time = findTime(scan);
    if (time) claimed.push(time);

    const account = findAccountHint(scan);
    if (account) {
      fields.accountHint = account.value;
      evidence.accountHint = body.slice(account.start, account.end);
      claimed.push(account);
    }

    const balance = findBalance(scan);
    if (balance) {
      fields.balanceMinor = balance.value;
      evidence.balanceMinor = body.slice(balance.start, balance.end);
      claimed.push(balance);
    }

    const payee = findPayee(scan);
    if (payee) {
      const text = body.slice(payee.start, payee.end).trim();
      if (text.length >= 3) {
        fields.payee = text.slice(0, 120);
        evidence.payee = text;
        claimed.push(payee);
      }
    }

    const amount = findAmount(scan, claimed);
    if (amount) {
      fields.amountMinor = amount.minor;
      evidence.amountMinor = body.slice(amount.start, amount.end);
    }

    /* Never inferred. A direction nobody wrote down is a coin toss between
     * income and expense, and the review screen asking is infinitely better
     * than the ledger guessing. */
    const direction = findDirection(scan);
    if (direction) {
      fields.direction = direction.value;
      evidence.direction = body.slice(direction.start, direction.end);
    }

    return {
      fields,
      confidence: scoreConfidence(fields, evidence),
      evidence,
      parserName: genericParser.name,
    };
  },
};

// --- the registry ------------------------------------------------------------

/**
 * Ordered parsers with the generic one underneath.
 *
 * A specific parser is tried only when its own `matches` says the message is
 * its business, and the first one to return a result wins outright — it knows
 * the format, and second-guessing it from here would mean this file needed to
 * know the format too. Returning `null` is how a parser says "that sender is
 * mine but that message is not", and the next candidate gets a turn.
 *
 * Adding bKash or a bank (M8) is one new file exporting a `MessageParser` and
 * one more entry in this array. Nothing in the pipeline changes.
 */
export function createRegistry(parsers: readonly MessageParser[] = []): ParserRegistry {
  // The generic parser matches everything, so a caller who passes it in would
  // otherwise shadow every parser listed after it.
  const specific = parsers.filter((parser) => parser !== genericParser);

  return {
    parsers: [...specific, genericParser],

    parse(msg: RawMessage): ParseResult {
      for (const parser of specific) {
        if (!parser.matches(msg)) continue;
        const result = parser.parse(msg);
        if (result) return result;
      }
      return (
        genericParser.parse(msg) ?? {
          fields: {},
          confidence: 0,
          evidence: {},
          parserName: genericParser.name,
        }
      );
    },
  };
}

// --- is this worth a decision? ------------------------------------------------

/**
 * What makes a message worth raising a draft for.
 *
 * ## What this decides, and what it does not
 *
 * Nothing is discarded here. Every message a phone forwards is stored and shown
 * to its owner whatever this returns; the only question is whether a *draft*
 * joins it — whether somebody is asked to make a decision about it.
 *
 * ## Why the rule is this wide
 *
 * It began narrower: three currency codes and the shape of an amount, two
 * decimal places or a grouped thousand. That was chosen to keep one-time codes
 * out of the review queue, and it failed on the first real test — `500 taka
 * twst`, typed by the owner in the words a person actually uses, was filed as
 * not-money and vanished from the queue.
 *
 * The lesson generalises past that one word. A rule that only knows how *banks*
 * write about money does not know how *people* do, and the messages this
 * product exists to catch are written by both. So the test is now: a currency
 * marker, or any digit at all.
 *
 * ## What that costs, stated plainly
 *
 * Nearly every SMS contains a digit, so nearly every SMS raises a draft — a
 * delivery notice, an appointment reminder, a one-time code. The queue fills
 * with things nobody needs to answer, and each one is charged against
 * `ingest.messages.monthly.max`.
 *
 * That is the owner's call and it is a defensible one while the parsers are
 * being taught: a draft nobody wanted is dismissed in a tap, a transaction that
 * never arrived is invisible. It is written down here because the day somebody
 * wonders why the inbox is full of codes, this comment is the answer, and
 * narrowing the list back down is a one-line change.
 */
const MONEY_MARKERS: readonly RegExp[] = [
  /\bBDT\b/i,
  /\bUSD\b/i,
  /\bTk\b/i,
  /৳/,
  /টাকা/,
  /\btaka\b/i,
  /* Any digit. Deliberately the widest possible test, and the reason almost
     everything now raises a draft — see the note above. */
  /\d/,
];

/**
 * Whether a message is worth putting a decision in front of somebody.
 *
 * Deliberately generous, and now about as generous as a test can be. A false
 * positive costs one draft dismissed in a tap; a false negative costs a
 * transaction that never reaches the books and that nobody knows to look for.
 * When the two errors are that unequal, the test leans towards yes.
 */
export function looksFinancial(body: string): boolean {
  return MONEY_MARKERS.some((marker) => marker.test(body));
}
