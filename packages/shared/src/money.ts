/**
 * Money is ALWAYS an integer in the currency's smallest unit — poisha for taka,
 * cents for dollars, and *nothing* for yen, which has no minor unit at all. No
 * float ever touches an amount: not in the DB, not in JSON, not here. Parsing
 * goes through strings; arithmetic is integer-only.
 *
 * Every function that converts between a stored integer and a human-readable
 * amount now takes a currency. It defaults to taka, so the several hundred call
 * sites written when this was a Bangladesh-only product keep meaning exactly
 * what they meant — but a workspace on yen no longer has every figure on every
 * screen inflated a hundredfold.
 */
import { DEFAULT_CURRENCY, currencyOf, minorUnitsFor } from './currency.js';

/**
 * Taka's divisor, kept as a named constant because a great deal of code and a
 * great many tests refer to poisha directly.
 *
 * New code should call `minorUnitsFor(currency)` instead. This is not that
 * value for two dozen currencies.
 */
export const MINOR_UNITS_PER_MAJOR = 100;

const BENGALI_DIGITS = '০১২৩৪৫৬৭৮৯';
const ASCII_DIGITS = '0123456789';

/** Convert Bengali (and Arabic-Indic) numerals to ASCII so arithmetic works. */
export function toAsciiDigits(input: string): string {
  let out = '';
  for (const ch of input) {
    const bn = BENGALI_DIGITS.indexOf(ch);
    if (bn >= 0) {
      out += String(bn);
      continue;
    }
    const code = ch.codePointAt(0)!;
    // Arabic-Indic ٠-٩ and Extended Arabic-Indic ۰-۹
    if (code >= 0x0660 && code <= 0x0669) out += String(code - 0x0660);
    else if (code >= 0x06f0 && code <= 0x06f9) out += String(code - 0x06f0);
    else out += ch;
  }
  return out;
}

/** Convert ASCII numerals to Bengali numerals for display. */
export function toBengaliDigits(input: string): string {
  let out = '';
  for (const ch of input) {
    const i = ASCII_DIGITS.indexOf(ch);
    out += i >= 0 ? BENGALI_DIGITS[i] : ch;
  }
  return out;
}

export class MoneyParseError extends Error {
  constructor(readonly input: string) {
    super(`Cannot parse money value: ${JSON.stringify(input)}`);
    this.name = 'MoneyParseError';
  }
}

/**
 * Parse a human-typed amount into integer poisha.
 * Accepts "1,234.56", "১,২৩৪.৫৬", "৳ 1234", "Tk. 1234.5", "-45", "(45)".
 * Fractions beyond 2 digits are truncated (never rounded up silently).
 */
export function parseMoneyToMinor(raw: string | number, currency = DEFAULT_CURRENCY): number {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) throw new MoneyParseError(String(raw));
    // A bare number is interpreted as MAJOR units; go through string so no float math.
    return parseMoneyToMinor(raw.toFixed(6), currency);
  }

  let s = toAsciiDigits(raw).trim();
  if (s.length === 0) throw new MoneyParseError(raw);

  let negative = false;
  // Accounting-style negatives: (1,234.00)
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }

  /* Strip currency markers and spaces.
   *
   * The taka forms are kept whatever the workspace's currency is — somebody who
   * types "Tk 500" into a dollar workspace has made a mistake about the
   * currency, not about the number, and refusing to parse it would only lose
   * the entry. The active currency's own symbol and code are stripped too.
   *
   * The symbol is escaped before it reaches the pattern: several of them are
   * regex metacharacters (`$`, `.د.ب`, `S/`), and interpolating `$` unescaped
   * would build a pattern that matches nothing and silently leaves the marker
   * in the string, which then fails the digits check below. */
  const marker = currencyOf(currency);
  const escaped = [marker.symbol, marker.code]
    .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  s = s.replace(new RegExp(`(BDT|TK\\.?|Tk\\.?|tk\\.?|৳|${escaped}|\\s|\\u00A0)`, 'g'), '');

  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }

  // Thousands separators (either , or the Bengali comma usage) — drop them.
  s = s.replace(/,/g, '');

  if (!/^\d*(\.\d*)?$/.test(s) || s === '' || s === '.') throw new MoneyParseError(raw);

  const [intPart = '0', fracPartRaw = ''] = s.split('.');
  const { digits } = currencyOf(currency);
  const units = minorUnitsFor(currency);

  /* Padded then truncated to the currency's own precision. A yen has none, so
   * "500.7" is 500 yen and the fraction is dropped rather than rounded — the
   * same rule this function has always applied to a third decimal place in
   * taka, extended to currencies where the cut comes earlier. */
  const fracPart = digits === 0 ? '0' : (fracPartRaw + '0'.repeat(digits)).slice(0, digits);

  const minor = Number(intPart || '0') * units + Number(fracPart);
  if (!Number.isSafeInteger(minor)) throw new MoneyParseError(raw);

  return negative ? -minor : minor;
}

/** Group an integer digit string the international way: 1,846,200. */
export function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Group an integer digit string the South Asian way: 18,46,200 (not 1,846,200). */
export function groupLakhCrore(digits: string): string {
  if (digits.length <= 3) return digits;
  const head = digits.slice(0, -3);
  const tail = digits.slice(-3);
  const grouped = head.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${grouped},${tail}`;
}

export interface FormatMoneyOptions {
  /** Prefix with the currency's symbol. Default true. */
  symbol?: boolean;
  /** ISO 4217 code. Decides the symbol, the divisor and the decimal places. */
  currency?: string;
  /**
   * Group the integer part the South Asian way (18,46,200) rather than the
   * international way (1,846,200). Defaults to true for BDT, INR, PKR, NPR and
   * LKR — the currencies whose speakers read lakh and crore — and false for
   * everything else, because a dollar figure grouped in lakhs is unreadable to
   * the person holding the dollars.
   */
  lakhGrouping?: boolean;
  /** Render digits in Bengali numerals. Default false. */
  bengaliNumerals?: boolean;
  /** Show the .00 part. Default true. */
  decimals?: boolean;
  /** Always show a leading + for positives. Default false. */
  signed?: boolean;
}

/** Currencies whose readers count in lakh and crore. */
const LAKH_CURRENCIES = new Set(['BDT', 'INR', 'PKR', 'NPR', 'LKR']);

/** Format an integer minor amount for display. Pure string work — no floats. */
export function formatMinor(minor: number, opts: FormatMoneyOptions = {}): string {
  const {
    symbol = true,
    bengaliNumerals = false,
    decimals = true,
    signed = false,
    currency = DEFAULT_CURRENCY,
  } = opts;

  if (!Number.isInteger(minor)) throw new TypeError('formatMinor expects an integer amount');

  const info = currencyOf(currency);
  const units = minorUnitsFor(currency);
  const lakh = opts.lakhGrouping ?? LAKH_CURRENCIES.has(info.code);

  const negative = minor < 0;
  const abs = Math.abs(minor);
  const intPart = String(Math.trunc(abs / units));

  let body = lakh ? groupLakhCrore(intPart) : groupThousands(intPart);
  /* A currency with no minor unit has no decimal point to show. Printing
   * "¥500.00" is not a formatting preference, it is a claim about a subdivision
   * of the yen that does not exist. */
  if (decimals && info.digits > 0) {
    body += `.${String(abs % units).padStart(info.digits, '0')}`;
  }
  if (bengaliNumerals) body = toBengaliDigits(body);

  const sign = negative ? '-' : signed ? '+' : '';
  return `${sign}${symbol ? info.symbol : ''}${body}`;
}

/** Integer-safe sum. Throws on non-integers so a stray float is caught loudly. */
export function sumMinor(values: readonly number[]): number {
  let total = 0;
  for (const v of values) {
    if (!Number.isInteger(v)) throw new TypeError(`Non-integer minor amount: ${v}`);
    total += v;
  }
  if (!Number.isSafeInteger(total)) throw new RangeError('Money sum exceeded safe integer range');
  return total;
}

/** Split `minor` into `parts` whole poisha, distributing the remainder deterministically. */
export function allocateMinor(minor: number, parts: number): number[] {
  if (!Number.isInteger(minor)) throw new TypeError('allocateMinor expects integer poisha');
  if (parts <= 0) throw new RangeError('parts must be positive');
  const base = Math.trunc(minor / parts);
  let remainder = minor - base * parts;
  const step = remainder >= 0 ? 1 : -1;
  const out: number[] = [];
  for (let i = 0; i < parts; i += 1) {
    if (remainder !== 0) {
      out.push(base + step);
      remainder -= step;
    } else {
      out.push(base);
    }
  }
  return out;
}
