/**
 * Money in Hishab is ALWAYS an integer in the smallest unit (poisha, 1/100 BDT).
 * No float ever touches an amount — not in the DB, not in JSON, not here.
 * Parsing goes through strings; arithmetic is integer-only.
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
export function parseMoneyToMinor(raw: string | number): number {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) throw new MoneyParseError(String(raw));
    // A bare number is interpreted as MAJOR units; go through string so no float math.
    return parseMoneyToMinor(raw.toFixed(6));
  }

  let s = toAsciiDigits(raw).trim();
  if (s.length === 0) throw new MoneyParseError(raw);

  let negative = false;
  // Accounting-style negatives: (1,234.00)
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }

  // Strip currency markers and spaces: ৳ Tk TK. BDT ৳
  s = s.replace(/(BDT|TK\.?|Tk\.?|tk\.?|৳|\s|\u00A0)/g, '');

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
  const fracPart = (fracPartRaw + '00').slice(0, 2);

  const minor = Number(intPart || '0') * MINOR_UNITS_PER_MAJOR + Number(fracPart);
  if (!Number.isSafeInteger(minor)) throw new MoneyParseError(raw);

  return negative ? -minor : minor;
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
  /** Prefix with ৳. Default true. */
  symbol?: boolean;
  /** Render digits in Bengali numerals. Default false. */
  bengaliNumerals?: boolean;
  /** Show the .00 part. Default true. */
  decimals?: boolean;
  /** Always show a leading + for positives. Default false. */
  signed?: boolean;
}

/** Format integer poisha for display. Pure string work — no float formatting. */
export function formatMinor(minor: number, opts: FormatMoneyOptions = {}): string {
  const { symbol = true, bengaliNumerals = false, decimals = true, signed = false } = opts;

  if (!Number.isInteger(minor)) throw new TypeError('formatMinor expects integer poisha');

  const negative = minor < 0;
  const abs = Math.abs(minor);
  const intPart = String(Math.trunc(abs / MINOR_UNITS_PER_MAJOR));
  const fracPart = String(abs % MINOR_UNITS_PER_MAJOR).padStart(2, '0');

  let body = groupLakhCrore(intPart);
  if (decimals) body += `.${fracPart}`;
  if (bengaliNumerals) body = toBengaliDigits(body);

  const sign = negative ? '-' : signed ? '+' : '';
  return `${sign}${symbol ? '৳' : ''}${body}`;
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
