import { parseMoneyToMinor, toAsciiDigits } from '@hishab/shared';

/**
 * Turning somebody's bank export into rows the ledger can accept.
 *
 * Framework-free on purpose: the same code runs in the API (to parse an upload)
 * and in the browser (to re-parse after the user corrects a column mapping),
 * and a preview that disagreed with what the server later wrote would be worse
 * than no preview at all.
 *
 * Four things make this hard, and each one gets a named function:
 *
 *  1. **The file format is a guess.** Bangladeshi bank portals emit CSV,
 *     semicolon-delimited CSV and tab-separated text under the same `.csv`
 *     extension, half of them with a UTF-8 BOM in front. `parseDelimited`
 *     works it out from the header row.
 *  2. **The columns are a guess.** Headers arrive in English, in Bengali, or in
 *     both. `guessMapping` proposes a mapping and says how sure it is, so the
 *     UI can pre-fill the confident ones and ask about the rest.
 *  3. **The dates are genuinely ambiguous.** `03/04/2026` is two different days
 *     and no amount of cleverness can tell which. `parseDateFlexible` therefore
 *     takes the caller's stated convention and *never* silently reads a row the
 *     other way round — see the comment on that function, it is the single
 *     easiest way to corrupt somebody's books.
 *  4. **The same statement gets imported twice.** People download January on
 *     the 5th and again on the 20th; the overlap must not double their books.
 *     `dedupeKey` states the rule.
 *
 * Money is integer poisha throughout, parsed by `parseMoneyToMinor` from
 * @hishab/shared — the one parser in the codebase that knows about Bengali
 * digits, `৳`, `Tk`, lakh-crore commas and accounting negatives. Nothing here
 * re-implements any part of it.
 *
 * Every message a user might read is Bengali. Code and comments are English.
 */

// --- delimited text ----------------------------------------------------------

export const IMPORT_DELIMITERS = [',', ';', '\t'] as const;
export type Delimiter = (typeof IMPORT_DELIMITERS)[number];

const BOM = '\uFEFF';

/** Zero-width and directional marks, which bank portals sprinkle everywhere. */
const INVISIBLES = /[\u200B-\u200F\u202A-\u202E\uFEFF]/g;

/**
 * Drop a leading UTF-8 BOM.
 *
 * Excel writes one on every CSV it saves, and it is invisible: without this the
 * first header reads `\uFEFFDate`, matches nothing, and the user is told their
 * file has no date column while looking straight at one.
 */
export function stripBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(1) : text;
}

function isDelimiter(ch: string): ch is Delimiter {
  return (IMPORT_DELIMITERS as readonly string[]).includes(ch);
}

/**
 * Which character separates the fields, judged from the header row alone.
 *
 * The header row and not the whole file, because data rows are full of commas
 * that are *not* separators — `1,25,000.00` in an unquoted amount column would
 * out-vote a perfectly good semicolon on every line. Headers are plain words.
 *
 * Ties go to the comma, and a header with no separator at all is a
 * single-column file, which is also a comma as far as anything downstream is
 * concerned.
 */
export function detectDelimiter(headerLine: string): Delimiter {
  const counts = new Map<Delimiter, number>(IMPORT_DELIMITERS.map((d) => [d, 0]));

  let inQuotes = false;
  for (const ch of headerLine) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (inQuotes) continue;
    if (isDelimiter(ch)) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }

  let best: Delimiter = ',';
  let bestCount = 0;
  for (const delimiter of IMPORT_DELIMITERS) {
    const count = counts.get(delimiter) ?? 0;
    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }
  return best;
}

/** Everything up to the first record separator that is not inside quotes. */
function firstRecordText(source: string): string {
  let inQuotes = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && (ch === '\n' || ch === '\r')) return source.slice(0, i);
  }
  return source;
}

function isBlankRecord(record: readonly string[]): boolean {
  return record.every((field) => field.trim() === '');
}

/**
 * CSV / semicolon-CSV / TSV into a grid of raw strings.
 *
 * RFC 4180 rules, plus the concessions reality demands:
 *
 *  - a leading BOM is dropped;
 *  - the delimiter is detected rather than assumed;
 *  - `\r\n`, `\n` and a bare `\r` all end a record;
 *  - a field that *starts* with `"` is quoted: it may contain the delimiter,
 *    line breaks, and `""` for a literal quote;
 *  - the final record is not invented out of a trailing newline, and any
 *    entirely blank records at the very end are dropped — nearly every export
 *    ends with one and reporting "row 214 is empty" on every import would train
 *    people to ignore the error list.
 *
 * Blank records *between* data are kept: those are real holes in the file and
 * `buildRows` says so, with a line number.
 *
 * Fields are returned exactly as they appeared, untrimmed. Trimming is a
 * decision about meaning and belongs to whoever reads the column, not to the
 * lexer — and `parseMoneyToMinor` trims for itself anyway.
 */
export function parseDelimited(text: string): string[][] {
  const source = stripBom(text);
  if (source === '') return [];

  const delimiter = detectDelimiter(firstRecordText(source));
  const rows: string[][] = [];

  let record: string[] = [];
  let field = '';
  let fieldStart = true;
  let inQuotes = false;
  let i = 0;

  const endField = (): void => {
    record.push(field);
    field = '';
    fieldStart = true;
  };

  const endRecord = (): void => {
    endField();
    rows.push(record);
    record = [];
  };

  while (i < source.length) {
    const ch = source[i] as string;

    if (inQuotes) {
      if (ch === '"') {
        // A doubled quote is one literal quote; a single one closes the field.
        if (source[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (fieldStart && ch === '"') {
      inQuotes = true;
      fieldStart = false;
      i += 1;
      continue;
    }

    if (ch === delimiter) {
      endField();
      i += 1;
      continue;
    }

    if (ch === '\r' || ch === '\n') {
      endRecord();
      i += ch === '\r' && source[i + 1] === '\n' ? 2 : 1;
      continue;
    }

    field += ch;
    fieldStart = false;
    i += 1;
  }

  /* Only a record that actually has content left in it. A file ending in a
   * newline has already flushed its last record; inventing another would add a
   * phantom empty row to every well-formed export. */
  if (field !== '' || record.length > 0) endRecord();

  while (rows.length > 0 && isBlankRecord(rows[rows.length - 1] as string[])) rows.pop();

  return rows;
}

// --- column mapping ----------------------------------------------------------

export type ImportColumn =
  | 'date'
  | 'description'
  | 'debit'
  | 'credit'
  | 'amount'
  | 'balance'
  | 'reference'
  | 'category'
  | 'account';

export interface ColumnMatch {
  /** Zero-based index into the header row. */
  index: number;
  /** The header exactly as it appeared, for showing back to the user. */
  header: string;
  /** 0–100. 100 is an exact match on a known name. */
  confidence: number;
}

export type ColumnMapping = { [K in ImportColumn]?: ColumnMatch };

/**
 * Header names we recognise, English and Bengali side by side.
 *
 * Bengali matters more than it looks: a workspace exports its own data with
 * Bengali headers (see the export in `apps/api/src/import`), and an export that
 * cannot be read back in is not an export. The English half covers what the
 * banks actually send.
 *
 * Synonyms shorter than three characters — `dr`, `cr`, `tk` — only ever match a
 * whole word, never a substring, or `cr` would claim "description".
 */
const HEADER_SYNONYMS: Record<ImportColumn, readonly string[]> = {
  date: [
    'date',
    'txn date',
    'transaction date',
    'trans date',
    'value date',
    'posting date',
    'post date',
    'booking date',
    'তারিখ',
    'লেনদেনের তারিখ',
  ],
  description: [
    'description',
    'details',
    'particulars',
    'narration',
    'remarks',
    'remark',
    'memo',
    'note',
    'notes',
    'payee',
    'merchant',
    'বিবরণ',
    'বিস্তারিত',
    'বর্ণনা',
    'মন্তব্য',
    'নোট',
    'প্রাপক',
  ],
  debit: [
    'debit',
    'debit amount',
    'withdrawal',
    'withdrawals',
    'withdrawal amount',
    'paid out',
    'money out',
    'outflow',
    'expense',
    'spent',
    'dr',
    'ডেবিট',
    'খরচ',
    'উত্তোলন',
    'ব্যয়',
    'জমাখরচ',
  ],
  credit: [
    'credit',
    'credit amount',
    'deposit',
    'deposits',
    'deposit amount',
    'paid in',
    'money in',
    'inflow',
    'income',
    'received',
    'cr',
    'ক্রেডিট',
    'জমা',
    'আয়',
    'আমানত',
  ],
  amount: [
    'amount',
    'amt',
    'value',
    'transaction amount',
    'taka',
    'tk',
    'bdt',
    'টাকা',
    'পরিমাণ',
    'অঙ্ক',
  ],
  balance: [
    'balance',
    'running balance',
    'closing balance',
    'available balance',
    'balance after',
    'স্থিতি',
    'ব্যালেন্স',
    'জের',
    'অবশিষ্ট',
  ],
  reference: [
    'reference',
    'reference no',
    'ref',
    'ref no',
    'transaction id',
    'transaction no',
    'txn id',
    'trx id',
    'cheque',
    'cheque no',
    'voucher',
    'voucher no',
    'রেফারেন্স',
    'চেক',
    'চেক নম্বর',
    'লেনদেন নম্বর',
  ],
  /* Not 'ধরন': that is "type", the INCOME/EXPENSE column our own export writes,
   * and mapping it to a category would file every row under the word "খরচ". */
  category: ['category', 'head', 'expense head', 'ক্যাটাগরি', 'খাত'],
  account: ['account', 'account name', 'a c', 'bank', 'wallet', 'অ্যাকাউন্ট', 'হিসাব', 'ব্যাংক'],
};

/**
 * Which column wins when two of them score the same on one header.
 *
 * "Debit Amount" scores identically for `debit` and for `amount`; it is a debit
 * column. The specific beats the general, every time.
 */
const COLUMN_PRIORITY: readonly ImportColumn[] = [
  'date',
  'debit',
  'credit',
  'balance',
  'amount',
  'reference',
  'category',
  'account',
  'description',
];

/** Punctuation banks use to decorate headers: `Amount (Tk.)`, `Ref_No`, `A/C`. */
const HEADER_PUNCTUATION = /[.()[\]{}<>_\-/\\|#:*"'`,;+]+/g;

function normaliseHeader(raw: string): string {
  return toAsciiDigits(raw.normalize('NFC'))
    .replace(INVISIBLES, '')
    .replace(HEADER_PUNCTUATION, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * How well one header matches one known name.
 *
 * Exact is exact. A whole-word hit is nearly as good — "Transaction Date" is a
 * date column beyond argument. A bare substring is a guess, and only allowed
 * for names long enough that the coincidence is unlikely.
 */
function scoreHeader(header: string, synonym: string): number {
  if (header === '') return 0;
  if (header === synonym) return 100;

  const words = header.split(' ');
  if (words.includes(synonym)) return 80;
  if (synonym.includes(' ') && header.includes(synonym)) return 80;

  if (synonym.length >= 4 && header.includes(synonym)) return 60;
  return 0;
}

/**
 * Best guess at what each column holds, with a confidence for each.
 *
 * Greedy and one-to-one: the strongest (column, header) pair is settled first,
 * then the next, and neither side is ever used twice. That is what stops a file
 * with both "Debit" and "Debit Amount" from mapping the same idea to two
 * columns and double-counting every row.
 *
 * A column nobody recognises is simply absent from the result. Guessing wrong
 * is worse than admitting ignorance: the user is being shown this mapping and
 * can fix an empty slot far more easily than a confident mistake.
 */
export function guessMapping(headers: readonly string[]): ColumnMapping {
  const normalised = headers.map(normaliseHeader);

  interface Candidate {
    column: ImportColumn;
    index: number;
    confidence: number;
  }
  const candidates: Candidate[] = [];

  for (const column of COLUMN_PRIORITY) {
    const synonyms = HEADER_SYNONYMS[column];
    normalised.forEach((header, index) => {
      let best = 0;
      for (const synonym of synonyms) {
        const score = scoreHeader(header, synonym);
        if (score > best) best = score;
      }
      if (best > 0) candidates.push({ column, index, confidence: best });
    });
  }

  candidates.sort((a, b) => {
    if (a.confidence !== b.confidence) return b.confidence - a.confidence;
    const byPriority = COLUMN_PRIORITY.indexOf(a.column) - COLUMN_PRIORITY.indexOf(b.column);
    if (byPriority !== 0) return byPriority;
    return a.index - b.index;
  });

  const mapping: ColumnMapping = {};
  const takenColumns = new Set<ImportColumn>();
  const takenHeaders = new Set<number>();

  for (const candidate of candidates) {
    if (takenColumns.has(candidate.column) || takenHeaders.has(candidate.index)) continue;
    takenColumns.add(candidate.column);
    takenHeaders.add(candidate.index);
    mapping[candidate.column] = {
      index: candidate.index,
      header: (headers[candidate.index] ?? '').trim(),
      confidence: candidate.confidence,
    };
  }

  return mapping;
}

// --- dates -------------------------------------------------------------------

export type DatePreference = 'DMY' | 'MDY';

const MONTH_NAMES: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
  জানুয়ারি: 1,
  জানু: 1,
  ফেব্রুয়ারি: 2,
  ফেব: 2,
  মার্চ: 3,
  এপ্রিল: 4,
  মে: 5,
  জুন: 6,
  জুলাই: 7,
  আগস্ট: 8,
  সেপ্টেম্বর: 9,
  সেপ্ট: 9,
  অক্টোবর: 10,
  নভেম্বর: 11,
  ডিসেম্বর: 12,
};

/**
 * Two-digit years: 00–69 are this century, 70–99 the last one.
 *
 * A statement is a record of money that has already moved, so a `26` is 2026
 * and never 1926. The 1970 pivot is the Unix-era convention and the one every
 * spreadsheet uses, which matters more than where exactly the line falls.
 */
const TWO_DIGIT_YEAR_PIVOT = 70;

const pad = (value: number, width: number): string => String(value).padStart(width, '0');

/** `YYYY-MM-DD`, or null when those three numbers are not a real day. */
function isoIfReal(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // A statement outside this range is a mis-parse, not a very old bank account.
  if (year < 1900 || year > 2999) return null;

  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null; // 31 February and friends
  }
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

function expandYear(raw: string): number {
  const value = Number(raw);
  if (raw.length > 2) return value;
  return value < TWO_DIGIT_YEAR_PIVOT ? 2000 + value : 1900 + value;
}

function monthFromName(raw: string): number | null {
  const key = raw.normalize('NFC').toLowerCase();
  return MONTH_NAMES[key] ?? null;
}

const ISO_LIKE = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/;
const COMPACT = /^(\d{8})$/;
const DAY_MONTHNAME_YEAR = /^(\d{1,2})[-\s/.]+([\p{L}\p{M}]+)[-\s/.,]+(\d{2,4})$/u;
const MONTHNAME_DAY_YEAR = /^([\p{L}\p{M}]+)[-\s/.]+(\d{1,2})[-\s/.,]+(\d{2,4})$/u;
const NUMERIC_TRIPLE = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/;
const TRAILING_TIME =
  /[ T]\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\s*([AaPp]\.?[Mm]\.?)?\s*(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * A date in whatever shape the bank felt like, as `YYYY-MM-DD`, or null.
 *
 * Handles `2026-01-31`, `31/01/2026`, `01/31/2026`, `31-Jan-2026`,
 * `Jan 31, 2026`, `৩১/০১/২০২৬`, `20260131`, and any of them with a time stuck
 * on the end.
 *
 * **The ambiguity is the whole problem.** `03/04/2026` is 3 April to everyone
 * in Dhaka and 4 March to an American bank, and nothing in the string says
 * which. So the caller states its convention and this function honours it
 * *without exception*: given `MDY`, `13/01/2026` returns null rather than
 * quietly reading it the other way round.
 *
 * That strictness is the point. A parser that flips convention on the rows it
 * cannot otherwise explain produces the worst possible outcome — a file where
 * the twelve rows with a day above 12 are right and every other row is silently
 * off by months, with nothing on screen to suggest anything went wrong. A null
 * becomes a visible, numbered error telling the user to switch the setting, and
 * `guessDatePreference` exists so the setting is usually right to begin with.
 *
 * ISO and month-name forms carry their own meaning and ignore the preference
 * entirely — there is nothing to be ambiguous about.
 */
export function parseDateFlexible(raw: string, preferred: DatePreference): string | null {
  if (typeof raw !== 'string') return null;

  const text = toAsciiDigits(raw.normalize('NFC'))
    .replace(INVISIBLES, '')
    .trim()
    .replace(TRAILING_TIME, '')
    .trim();

  if (text === '') return null;

  const iso = ISO_LIKE.exec(text);
  if (iso) return isoIfReal(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const compact = COMPACT.exec(text);
  if (compact) {
    const digits = compact[1] as string;
    return isoIfReal(
      Number(digits.slice(0, 4)),
      Number(digits.slice(4, 6)),
      Number(digits.slice(6, 8)),
    );
  }

  const dmn = DAY_MONTHNAME_YEAR.exec(text);
  if (dmn) {
    const month = monthFromName(dmn[2] as string);
    if (month === null) return null;
    return isoIfReal(expandYear(dmn[3] as string), month, Number(dmn[1]));
  }

  const mnd = MONTHNAME_DAY_YEAR.exec(text);
  if (mnd) {
    const month = monthFromName(mnd[1] as string);
    if (month === null) return null;
    return isoIfReal(expandYear(mnd[3] as string), month, Number(mnd[2]));
  }

  const numeric = NUMERIC_TRIPLE.exec(text);
  if (numeric) {
    const first = Number(numeric[1]);
    const second = Number(numeric[2]);
    const year = expandYear(numeric[3] as string);
    // No fallback, no flip: `isoIfReal` returns null on a month above 12.
    return preferred === 'DMY' ? isoIfReal(year, second, first) : isoIfReal(year, first, second);
  }

  return null;
}

export interface DatePreferenceGuess {
  preference: DatePreference;
  /** True only when the file itself proves it; false means "this is a default". */
  confident: boolean;
  /** Rows whose first number is above 12, so it can only be a day. */
  dmyEvidence: number;
  /** Rows whose second number is above 12, so the first can only be a month. */
  mdyEvidence: number;
}

/**
 * Read the convention off the file where the file gives it away.
 *
 * A `31/01/2026` anywhere in the column settles it as day-first; a `01/31/2026`
 * settles it as month-first. Only the all-numeric rows can prove anything, and
 * a column of nothing but `03/04/2026` proves nothing at all — which is exactly
 * when `confident` is false and the UI has to ask.
 *
 * The default is DMY: this is a Bangladeshi ledger and everything local is
 * written day-first. A file carrying evidence for both conventions is broken
 * (or two files stapled together) and is reported as not confident, never
 * quietly averaged.
 */
export function guessDatePreference(samples: readonly string[]): DatePreferenceGuess {
  let dmyEvidence = 0;
  let mdyEvidence = 0;

  for (const sample of samples) {
    const text = toAsciiDigits(String(sample ?? '').normalize('NFC'))
      .replace(INVISIBLES, '')
      .trim()
      .replace(TRAILING_TIME, '')
      .trim();

    const numeric = NUMERIC_TRIPLE.exec(text);
    if (!numeric) continue;

    const first = Number(numeric[1]);
    const second = Number(numeric[2]);
    if (first > 12 && second <= 12) dmyEvidence += 1;
    else if (second > 12 && first <= 12) mdyEvidence += 1;
  }

  if (dmyEvidence > 0 && mdyEvidence === 0) {
    return { preference: 'DMY', confident: true, dmyEvidence, mdyEvidence };
  }
  if (mdyEvidence > 0 && dmyEvidence === 0) {
    return { preference: 'MDY', confident: true, dmyEvidence, mdyEvidence };
  }
  return { preference: 'DMY', confident: false, dmyEvidence, mdyEvidence };
}

// --- rows --------------------------------------------------------------------

export type ImportDirection = 'IN' | 'OUT';

export interface ParsedRow {
  /**
   * The row number the user sees in their spreadsheet: the header is 1, the
   * first transaction is 2. Records are counted, not physical lines, because a
   * quoted field containing a newline is still one row in Excel — and Excel is
   * where the user will go to look.
   */
  lineNumber: number;
  /** `YYYY-MM-DD`. */
  date: string;
  description: string;
  /** Always positive integer poisha; `direction` carries the sign. */
  amountMinor: number;
  direction: ImportDirection;
  reference: string | null;
  /** Free text from a category column, matched to a real category by the API. */
  categoryName: string | null;
}

export interface RowError {
  /** Same numbering as `ParsedRow.lineNumber`. */
  lineNumber: number;
  column: ImportColumn | null;
  /** What was actually in the cell, so the message can quote it back. */
  value: string;
  /** Bengali. This is read by the person who has to fix the file. */
  message: string;
}

export interface BuildRowsOptions {
  /**
   * How to read `03/04/2026`. Deliberately required: there is no safe default
   * for a question the data cannot answer.
   */
  datePreference: DatePreference;
  /** How many rows at the top are headings. Default 1. */
  headerRows?: number;
  /**
   * With a single amount column, does a positive number mean money arriving?
   * Bank statements say yes; some expense trackers export spending as positive.
   */
  positiveMeans?: ImportDirection;
}

/** Field length caps, matching what the API's transaction columns accept. */
const MAX_DESCRIPTION = 500;
const MAX_REFERENCE = 200;
const MAX_CATEGORY = 120;

/**
 * Placeholders that mean "nothing here" in a money column.
 *
 * A dash in the debit column of a credit row is universal in bank exports, and
 * treating it as an unreadable amount would reject half of every statement.
 */
const BLANK_AMOUNT = /^(?:[-–—.\s]*|n\/?a|nil|null|none|শূন্য)$/i;

/**
 * `1,234.00 Dr` / `500 CR` / `900(Dr)` — a direction marker glued to the
 * amount, which is how most South Asian bank statements print a single amount
 * column. No word boundary in front of it: `5000Dr` with no space is common and
 * would otherwise reach `parseMoneyToMinor` as unreadable text.
 */
const AMOUNT_MARKER = /\s*\(?(dr|cr|db|debit|credit)\)?\.?\s*$/i;

interface AmountCell {
  minor: number;
  /** 'OUT' for Dr, 'IN' for Cr, null when the cell carried no marker. */
  marker: ImportDirection | null;
}

function trimCell(record: readonly string[], match: ColumnMatch | undefined): string {
  if (!match) return '';
  return (record[match.index] ?? '').replace(INVISIBLES, '').trim();
}

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function clamp(value: string, max: number): string | null {
  const text = collapse(value);
  if (text === '') return null;
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * One money cell. `null` means the cell was empty or a placeholder; `false`
 * means there was something there and it was not a number.
 */
function readAmountCell(raw: string): AmountCell | null | false {
  if (BLANK_AMOUNT.test(raw)) return null;

  let text = raw;
  let marker: ImportDirection | null = null;

  const markerMatch = AMOUNT_MARKER.exec(text);
  if (markerMatch) {
    const token = (markerMatch[1] as string).toLowerCase();
    marker = token === 'cr' || token === 'credit' ? 'IN' : 'OUT';
    text = text.slice(0, markerMatch.index);
  }

  try {
    return { minor: parseMoneyToMinor(text), marker };
  } catch {
    return false;
  }
}

const DATE_SHAPE_LABEL: Record<DatePreference, string> = {
  DMY: 'দিন/মাস/বছর',
  MDY: 'মাস/দিন/বছর',
};

/**
 * The grid, plus a mapping, into rows the ledger could accept — and a numbered
 * complaint about every row it could not.
 *
 * Nothing is dropped in silence. "১২টি সারি বাদ পড়েছে" with no list of which
 * ones is useless: the person has a spreadsheet open beside the screen and
 * needs to be told the row number and what was wrong with it.
 *
 * A debit column and a credit column collapse into one signed amount by
 * subtraction, which also handles the awkward real cases for free: a negative
 * debit is a refund and comes out as money in, and a row that fills both
 * columns nets off instead of being rejected.
 */
export function buildRows(
  grid: readonly (readonly string[])[],
  mapping: ColumnMapping,
  options: BuildRowsOptions,
): { rows: ParsedRow[]; errors: RowError[] } {
  const headerRows = options.headerRows ?? 1;
  const positiveMeans = options.positiveMeans ?? 'IN';
  const rows: ParsedRow[] = [];
  const errors: RowError[] = [];

  /* A missing column is one problem with the mapping, not one problem per row.
   * Five hundred identical errors would bury the one sentence that matters. */
  if (!mapping.date) {
    errors.push({
      lineNumber: 1,
      column: 'date',
      value: '',
      message: 'তারিখের কলাম বেছে নেওয়া হয়নি — কলাম মিলিয়ে দিন',
    });
  }
  if (!mapping.amount && !mapping.debit && !mapping.credit) {
    errors.push({
      lineNumber: 1,
      column: 'amount',
      value: '',
      message:
        'টাকার কলাম বেছে নেওয়া হয়নি — একটি অ্যামাউন্ট কলাম, বা ডেবিট ও ক্রেডিট কলাম মিলিয়ে দিন',
    });
  }
  if (errors.length > 0) return { rows, errors };

  for (let index = headerRows; index < grid.length; index += 1) {
    const record = grid[index] as readonly string[];
    const lineNumber = index + 1;

    if (isBlankRecord(record)) {
      errors.push({
        lineNumber,
        column: null,
        value: '',
        message: 'খালি সারি — বাদ দেওয়া হয়েছে',
      });
      continue;
    }

    const rawDate = trimCell(record, mapping.date);
    if (rawDate === '') {
      errors.push({ lineNumber, column: 'date', value: '', message: 'তারিখ নেই' });
      continue;
    }

    const date = parseDateFlexible(rawDate, options.datePreference);
    if (date === null) {
      errors.push({
        lineNumber,
        column: 'date',
        value: rawDate,
        message: `তারিখ "${rawDate}" পড়া গেল না (${DATE_SHAPE_LABEL[options.datePreference]} ছকে)`,
      });
      continue;
    }

    const amount = resolveAmount(record, mapping, positiveMeans);
    if ('error' in amount) {
      errors.push({ lineNumber, ...amount.error });
      continue;
    }

    rows.push({
      lineNumber,
      date,
      description: clamp(trimCell(record, mapping.description), MAX_DESCRIPTION) ?? '',
      amountMinor: amount.amountMinor,
      direction: amount.direction,
      reference: clamp(trimCell(record, mapping.reference), MAX_REFERENCE),
      categoryName: clamp(trimCell(record, mapping.category), MAX_CATEGORY),
      /* `mapping.account` is recognised so the guesser does not hand that
       * column to something else, but it is not carried: a commit imports into
       * one chosen account, and silently routing rows elsewhere on the strength
       * of a text match is not a thing an import should do behind someone. */
    });
  }

  return { rows, errors };
}

type AmountOutcome =
  { amountMinor: number; direction: ImportDirection } | { error: Omit<RowError, 'lineNumber'> };

function resolveAmount(
  record: readonly string[],
  mapping: ColumnMapping,
  positiveMeans: ImportDirection,
): AmountOutcome {
  if (mapping.debit || mapping.credit) {
    const rawDebit = trimCell(record, mapping.debit);
    const rawCredit = trimCell(record, mapping.credit);

    const debit = readAmountCell(rawDebit);
    if (debit === false) {
      return {
        error: {
          column: 'debit',
          value: rawDebit,
          message: `ডেবিটের অঙ্ক "${rawDebit}" পড়া গেল না`,
        },
      };
    }
    const credit = readAmountCell(rawCredit);
    if (credit === false) {
      return {
        error: {
          column: 'credit',
          value: rawCredit,
          message: `ক্রেডিটের অঙ্ক "${rawCredit}" পড়া গেল না`,
        },
      };
    }

    if (debit === null && credit === null) {
      return { error: { column: 'amount', value: '', message: 'টাকার পরিমাণ নেই' } };
    }

    // One signed number out of two columns. A refund posted as a negative
    // debit comes back as money in, which is what actually happened.
    const net = (credit?.minor ?? 0) - (debit?.minor ?? 0);
    if (net === 0) {
      return {
        error: {
          column: 'amount',
          value: `${rawDebit} / ${rawCredit}`,
          message: 'ডেবিট ও ক্রেডিট সমান — টাকা কোন দিকে গেছে বোঝা যাচ্ছে না',
        },
      };
    }
    return { amountMinor: Math.abs(net), direction: net > 0 ? 'IN' : 'OUT' };
  }

  const rawAmount = trimCell(record, mapping.amount);
  const amount = readAmountCell(rawAmount);
  if (amount === false) {
    return {
      error: {
        column: 'amount',
        value: rawAmount,
        message: `টাকার অঙ্ক "${rawAmount}" পড়া গেল না`,
      },
    };
  }
  if (amount === null) {
    return { error: { column: 'amount', value: rawAmount, message: 'টাকার পরিমাণ নেই' } };
  }
  if (amount.minor === 0) {
    return {
      error: { column: 'amount', value: rawAmount, message: 'শূন্য টাকার সারি আমদানি করা যায় না' },
    };
  }

  /* An explicit Dr/Cr marker beats the sign: a statement that writes
   * "5,000.00 Dr" means money out however it punctuates the number. */
  if (amount.marker) return { amountMinor: Math.abs(amount.minor), direction: amount.marker };

  const positive = amount.minor > 0;
  const direction: ImportDirection = positive
    ? positiveMeans
    : positiveMeans === 'IN'
      ? 'OUT'
      : 'IN';
  return { amountMinor: Math.abs(amount.minor), direction };
}

// --- deduplication -----------------------------------------------------------

export interface DedupeSource {
  /** `YYYY-MM-DD`. */
  date: string;
  direction: ImportDirection;
  /** Positive integer poisha. */
  amountMinor: number;
  reference?: string | null;
  description?: string | null;
}

export interface DuplicateMark {
  /** The key this row was matched on, worth showing when explaining a skip. */
  dedupeKey: string;
  isDuplicate: boolean;
}

function normaliseKeyText(value: string): string {
  return collapse(toAsciiDigits(value.normalize('NFC')).replace(INVISIBLES, '')).toLowerCase();
}

/**
 * **The rule.** Two rows are the same transaction when they share:
 *
 *   day + direction + exact amount + (bank reference, or else description)
 *
 * and are the *same occurrence* of that combination.
 *
 * Taking each part in turn:
 *
 *  - **The reference wins when there is one.** A bank's transaction id is
 *    unique by construction, so once it is present the description is ignored
 *    entirely — otherwise re-importing a statement after the bank tidied up its
 *    wording would post every row a second time.
 *  - **Without a reference, the description carries the weight**, normalised to
 *    ASCII digits, single spaces and lower case, because `৳500 BKASH` and
 *    `Tk 500  bkash` are one payment described twice.
 *  - **The amount is exact, to the poisha.** Nothing about a near-match is
 *    safe: ৳500 and ৳500.50 on the same day to the same shop are two visits.
 *  - **The day, not the timestamp.** A statement downloaded twice can time-shift
 *    a row by hours; it never moves it to another day.
 *  - **Occurrence is part of the key.** Buying two ৳50 cups of tea on the same
 *    Tuesday is two transactions with one identical fingerprint, and an import
 *    that silently dropped the second would quietly lose real money. So the
 *    first is `…|#1`, the second `…|#2`, and a re-import of that same file
 *    matches both and skips both. This is the difference between deduplicating
 *    and merely deleting repeats.
 *
 * Which way it errs: towards **skipping**. A row wrongly skipped is visible —
 * it is reported, and the user can add it by hand in ten seconds. A row wrongly
 * imported twice is invisible, silently overstates spending, and is found weeks
 * later when a balance will not reconcile.
 *
 * Both sides of the comparison must be built by this function — see
 * `dedupeKeysFor` for the set that comes out of the database. Two hand-rolled
 * copies of this rule would drift, and the first symptom would be a double-
 * booked month.
 */
export function dedupeKey(row: DedupeSource, occurrence = 1): string {
  const reference = normaliseKeyText(row.reference ?? '');
  const tail = reference !== '' ? `r:${reference}` : `d:${normaliseKeyText(row.description ?? '')}`;
  const nth = Number.isFinite(occurrence) ? Math.max(1, Math.trunc(occurrence)) : 1;
  return `${row.date}|${row.direction}|${row.amountMinor}|${tail}|#${nth}`;
}

/** Keys for a list of rows already in the books, numbered in the order given. */
export function dedupeKeysFor(rows: readonly DedupeSource[]): string[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const base = dedupeKey(row, 1);
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    return dedupeKey(row, occurrence);
  });
}

/**
 * Flag every incoming row that the workspace already has.
 *
 * `existingKeys` comes from `dedupeKeysFor` over what is already in the books.
 * Rows are numbered in file order, so an overlapping statement skips exactly
 * the overlap and imports the rest.
 */
export function markDuplicates<T extends DedupeSource>(
  rows: readonly T[],
  existingKeys: ReadonlySet<string>,
): (T & DuplicateMark)[] {
  const seen = new Map<string, number>();

  return rows.map((row) => {
    const base = dedupeKey(row, 1);
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    const key = dedupeKey(row, occurrence);
    return { ...row, dedupeKey: key, isDuplicate: existingKeys.has(key) };
  });
}
