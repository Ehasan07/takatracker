import { readZip, ZipError } from './zip.js';

/**
 * Reading a `.xlsx` into the same grid of strings a CSV produces.
 *
 * Bangladeshi banks hand out statements as Excel more often than as anything
 * else, and until now this app answered "save it as CSV" — which is a fine
 * answer if you own Excel on a laptop and no answer at all on a phone. So the
 * file is read here, server-side, and everything downstream (`guessMapping`,
 * `buildRows`, the duplicate check) carries on working on strings exactly as it
 * does for a CSV. One pipeline, four front doors.
 *
 * ## Three things that are easy to get wrong, and what is done about them
 *
 *  1. **A date in a spreadsheet is a number.** `31/07/2026` is stored as `46234`
 *     with a *style* that says to print it as a date. Miss that and the whole
 *     date column arrives as five-digit integers. So `xl/styles.xml` is read and
 *     any cell whose number format is a date format is converted to
 *     `YYYY-MM-DD` here — which has the happy side effect that an Excel import
 *     is never ambiguous about day-first versus month-first, because the
 *     spreadsheet already knew.
 *  2. **An amount must not become a float.** Money is integer poisha in this
 *     codebase and `parseMoneyToMinor` is the only thing allowed to do the
 *     conversion. So numeric cells are handed on as the literal text the file
 *     contains — `1250.5`, not `1250.5` rounded through anything — and the one
 *     exception is documented on `tidyNumber` below.
 *  3. **Strings live somewhere else.** Excel stores text once in
 *     `xl/sharedStrings.xml` and puts an index in the cell. A reader that
 *     ignores it gets a sheet full of `0`, `1`, `2`.
 *
 * ## What it will not do
 *
 * No formulas are evaluated: a cell with a formula is read as the value Excel
 * last cached for it, which is what the person saw on screen and therefore the
 * honest answer. Not `.xls` — that is a different, binary format from 1997 and
 * it gets a plain refusal rather than a bad guess. No charts, no images, no
 * merged-cell reconstruction beyond the value landing in the top-left cell,
 * which is where Excel itself puts it.
 */

export class XlsxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XlsxError';
  }
}

export interface XlsxSheet {
  name: string;
  /** Row-major, rectangular, every cell a string. Empty cells are `''`. */
  grid: string[][];
}

/** A guard against a corrupt `r="A1048576"` turning into a million empty rows. */
const MAX_ROWS = 20_000;
const MAX_COLUMNS = 256;

// --- tiny XML helpers --------------------------------------------------------

/*
 * A real XML parser is not needed and would be another dependency. The parts of
 * SpreadsheetML this reads are machine-written, flat, and namespace-stable:
 * `<c r="B7" t="s"><v>12</v></c>`. What *is* needed is correct entity decoding
 * and correct attribute reading, so those two have proper implementations
 * rather than a regex each.
 */

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? whole;
  });
}

/** One attribute out of a start tag's text, `undefined` when it is absent. */
function attribute(tag: string, name: string): string | undefined {
  const pattern = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`);
  const found = pattern.exec(tag);
  if (!found) return undefined;
  return decodeEntities(found[2] ?? found[3] ?? '');
}

/** Every `<name …>…</name>` element, as `{ tag, inner }`. Self-closing included. */
function* elements(xml: string, name: string): Generator<{ tag: string; inner: string }> {
  const opening = new RegExp(`<${name}(\\s[^>]*?)?(/)?>`, 'g');
  let match: RegExpExecArray | null;
  while ((match = opening.exec(xml)) !== null) {
    const tag = match[0];
    if (match[2] === '/') {
      yield { tag, inner: '' };
      continue;
    }
    const closing = xml.indexOf(`</${name}>`, opening.lastIndex);
    if (closing < 0) return;
    yield { tag, inner: xml.slice(opening.lastIndex, closing) };
    opening.lastIndex = closing + name.length + 3;
  }
}

/** The text of every `<t>` in a fragment, run by run, joined. */
function textOf(fragment: string): string {
  /* `<rPh>` holds the furigana Excel keeps beside East Asian text. It is a
   * pronunciation guide, not content, and concatenating it doubles the cell. */
  const withoutPhonetics = fragment.replace(/<rPh[\s\S]*?<\/rPh>/g, '');
  let out = '';
  for (const { inner } of elements(withoutPhonetics, 't')) out += decodeEntities(inner);
  return out;
}

// --- numbers and dates -------------------------------------------------------

/**
 * `A1` → column 0, `AB7` → column 27. Returns `null` for anything else.
 */
export function columnIndexOf(reference: string): number | null {
  let index = 0;
  let seen = 0;
  for (const ch of reference) {
    const code = ch.charCodeAt(0);
    if (code >= 65 && code <= 90) {
      index = index * 26 + (code - 64);
      seen += 1;
      continue;
    }
    if (code >= 97 && code <= 122) {
      index = index * 26 + (code - 96);
      seen += 1;
      continue;
    }
    break;
  }
  return seen === 0 ? null : index - 1;
}

/** Built-in number formats that mean a date or a time. */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/**
 * Does this format code print a date?
 *
 * The literal parts of a format code have to come out first or `"Paid on "`
 * would make every currency format look like a date, and colour and condition
 * sections in square brackets do the same with `[$-409]`.
 */
export function isDateFormat(code: string): boolean {
  const stripped = code
    .replace(/"[^"]*"/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\\./g, '');
  return /[yd]/i.test(stripped);
}

/**
 * An Excel date serial as `YYYY-MM-DD`.
 *
 * Serial 1 is 1 January 1900, and serial 60 is 29 February 1900 — a day that
 * did not exist. Lotus 1-2-3 had the bug, Excel copied it for compatibility and
 * every spreadsheet since has kept it, so the epoch is 30 December 1899 for
 * everything after the phantom day and a day later for the sixty before it.
 * No statement is dated 1900, but a reader that quietly slips a day is exactly
 * the kind of thing nobody finds until a reconciliation fails.
 *
 * `date1904` is the other epoch, which Excel for Mac used until 2011.
 */
export function serialToIsoDate(serial: number, date1904: boolean): string | null {
  if (!Number.isFinite(serial) || serial < 0 || serial > 2_958_465) return null;

  const days = Math.trunc(serial);
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const shifted = date1904 || days > 60 ? days : days + 1;

  const at = new Date(epoch + shifted * 86_400_000);
  if (Number.isNaN(at.getTime())) return null;

  const pad = (value: number, width: number): string => String(value).padStart(width, '0');
  return `${pad(at.getUTCFullYear(), 4)}-${pad(at.getUTCMonth() + 1, 2)}-${pad(at.getUTCDate(), 2)}`;
}

/**
 * A numeric cell's literal text, with binary-float noise taken back out.
 *
 * A spreadsheet stores numbers as IEEE doubles and writes back the shortest
 * text that reproduces them, so a cell the user typed as `4.75` can arrive as
 * `4.7500000000000004`. `parseMoneyToMinor` truncates rather than rounds — the
 * right rule for a third decimal place a human typed, the wrong one for
 * arithmetic dust, and it would turn `1250.4999999999999` into ৳1250.49.
 *
 * So: integers are passed through byte for byte (an account number with sixteen
 * digits must not go anywhere near a float), and a value with a long fraction
 * that sits within a millionth of its own two-decimal form is snapped to that
 * form. A number genuinely carrying more precision than that — a quantity, an
 * exchange rate — is left exactly as the file wrote it.
 */
export function tidyNumber(raw: string): string {
  if (!/[.eE]/.test(raw)) return raw;

  const value = Number(raw);
  if (!Number.isFinite(value)) return raw;

  const fraction = raw.includes('.') ? (raw.split('.')[1] ?? '') : '';
  if (fraction.length <= 6 && !/[eE]/.test(raw)) return raw;

  const twoPlaces = value.toFixed(2);
  return Math.abs(value - Number(twoPlaces)) < 1e-6 ? twoPlaces : String(value);
}

// --- the workbook ------------------------------------------------------------

interface Styles {
  /** Number format id per `cellXfs` index — the `s` attribute on a cell. */
  formatByStyle: number[];
  /** Custom format codes, by id. */
  codeByFormat: Map<number, string>;
}

function readStyles(xml: string | undefined): Styles {
  const formatByStyle: number[] = [];
  const codeByFormat = new Map<number, string>();
  if (!xml) return { formatByStyle, codeByFormat };

  for (const { tag } of elements(xml, 'numFmt')) {
    const id = Number(attribute(tag, 'numFmtId') ?? '');
    const code = attribute(tag, 'formatCode');
    if (Number.isFinite(id) && code !== undefined) codeByFormat.set(id, code);
  }

  /* Only `cellXfs`. There is a second, near-identical `cellStyleXfs` block above
   * it holding named styles, and reading both would index the cell's `s` into
   * the wrong table — silently, and only for files that have named styles. */
  for (const { inner } of elements(xml, 'cellXfs')) {
    for (const { tag } of elements(inner, 'xf')) {
      formatByStyle.push(Number(attribute(tag, 'numFmtId') ?? '0') || 0);
    }
    break;
  }

  return { formatByStyle, codeByFormat };
}

function readSharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  const out: string[] = [];
  for (const { inner } of elements(xml, 'si')) out.push(textOf(inner));
  return out;
}

/** `worksheets/sheet1.xml` from a workbook-relative target. */
function resolveTarget(target: string): string {
  const cleaned = target.replace(/^\/+/, '');
  return cleaned.startsWith('xl/') ? cleaned : `xl/${cleaned}`;
}

interface SheetRef {
  name: string;
  path: string;
}

function readSheetRefs(entries: Map<string, Buffer>): SheetRef[] {
  const workbook = entries.get('xl/workbook.xml')?.toString('utf8');
  if (!workbook) throw new XlsxError('the file has no xl/workbook.xml — it is not an .xlsx');

  const relsXml = entries.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '';
  const targetById = new Map<string, string>();
  for (const { tag } of elements(relsXml, 'Relationship')) {
    const id = attribute(tag, 'Id');
    const target = attribute(tag, 'Target');
    if (id && target) targetById.set(id, target);
  }

  const refs: SheetRef[] = [];
  let fallbackIndex = 0;
  for (const { tag } of elements(workbook, 'sheet')) {
    fallbackIndex += 1;
    const name = attribute(tag, 'name') ?? `Sheet${fallbackIndex}`;
    /* The namespace prefix is `r:` in every file anybody has ever produced, but
       it is only a convention, so the plain form is accepted too. */
    const relId = attribute(tag, 'r:id') ?? attribute(tag, 'id');
    const target = relId ? targetById.get(relId) : undefined;
    refs.push({
      name,
      path: resolveTarget(target ?? `worksheets/sheet${fallbackIndex}.xml`),
    });
  }

  if (refs.length === 0) throw new XlsxError('the workbook lists no sheets');
  return refs;
}

function readSheet(xml: string, shared: string[], styles: Styles, date1904: boolean): string[][] {
  const grid: string[][] = [];
  let widest = 0;

  for (const { tag: rowTag, inner: rowInner } of elements(xml, 'row')) {
    const declared = Number(attribute(rowTag, 'r') ?? '');
    /* A row that declares its own number keeps its place, so a table starting
       at row 9 still reports "row 9" when a cell in it cannot be read. */
    const rowIndex = Number.isFinite(declared) && declared >= 1 ? declared - 1 : grid.length;
    if (rowIndex >= MAX_ROWS) continue;

    while (grid.length <= rowIndex) grid.push([]);
    const row = grid[rowIndex] as string[];

    let cursor = 0;
    for (const { tag: cellTag, inner: cellInner } of elements(rowInner, 'c')) {
      const reference = attribute(cellTag, 'r');
      const column = reference ? (columnIndexOf(reference) ?? cursor) : cursor;
      cursor = column + 1;
      if (column >= MAX_COLUMNS) continue;

      const value = cellValue(cellTag, cellInner, shared, styles, date1904);
      while (row.length <= column) row.push('');
      row[column] = value;
      if (row.length > widest) widest = row.length;
    }
  }

  // Rectangular, because everything downstream indexes by column number.
  for (const row of grid) while (row.length < widest) row.push('');
  return grid;
}

function cellValue(
  tag: string,
  inner: string,
  shared: string[],
  styles: Styles,
  date1904: boolean,
): string {
  const type = attribute(tag, 't') ?? 'n';

  if (type === 'inlineStr') return textOf(inner);
  /* An error cell (`#N/A`, `#DIV/0!`) prints its code, which is what the person
     looking at the spreadsheet saw. Blanking it would hide a broken column. */
  if (type === 'e' || type === 'str') {
    let text = '';
    for (const { inner: v } of elements(inner, 'v')) text += decodeEntities(v);
    return text;
  }

  let raw = '';
  for (const { inner: v } of elements(inner, 'v')) raw += decodeEntities(v);
  if (raw === '') return '';

  if (type === 's') {
    const index = Number(raw);
    return Number.isInteger(index) ? (shared[index] ?? '') : '';
  }
  if (type === 'b') return raw === '1' ? 'TRUE' : 'FALSE';

  const styleIndex = Number(attribute(tag, 's') ?? '');
  const formatId = Number.isInteger(styleIndex) ? styles.formatByStyle[styleIndex] : undefined;
  if (formatId !== undefined) {
    const custom = styles.codeByFormat.get(formatId);
    const looksLikeDate =
      BUILTIN_DATE_FORMATS.has(formatId) || (custom !== undefined && isDateFormat(custom));
    if (looksLikeDate) {
      const iso = serialToIsoDate(Number(raw), date1904);
      if (iso !== null) return iso;
    }
  }

  return tidyNumber(raw);
}

/**
 * Every sheet in the workbook, in the order Excel shows its tabs.
 *
 * All of them, not just the first: bank exports routinely put a cover sheet in
 * front of the transactions, and the caller wants to be able to offer the list
 * so the person can point at the right one.
 */
export function readXlsx(buffer: Buffer): XlsxSheet[] {
  let entries: Map<string, Buffer>;
  try {
    entries = readZip(buffer);
  } catch (error) {
    if (error instanceof ZipError) throw new XlsxError(error.message);
    throw error;
  }

  const workbookXml = entries.get('xl/workbook.xml')?.toString('utf8') ?? '';
  /* Excel for Mac up to 2011 counted from 1904. Written into the workbook, so
     there is no need to guess — and a two-line check beats being 1,462 days
     wrong on somebody's older file. */
  const date1904 = /date1904\s*=\s*"(1|true)"/i.test(workbookXml);

  const shared = readSharedStrings(entries.get('xl/sharedStrings.xml')?.toString('utf8'));
  const styles = readStyles(entries.get('xl/styles.xml')?.toString('utf8'));

  return readSheetRefs(entries).map((ref) => {
    const xml = entries.get(ref.path)?.toString('utf8');
    return { name: ref.name, grid: xml ? readSheet(xml, shared, styles, date1904) : [] };
  });
}

/** True when the bytes begin with a ZIP local header — the `.xlsx` magic. */
export function looksLikeZip(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer.readUInt32LE(0) === 0x04034b50;
}

/** True when the bytes begin with `%PDF`. */
export function looksLikePdf(buffer: Buffer): boolean {
  return buffer.length >= 5 && buffer.toString('latin1', 0, 5) === '%PDF-';
}

/**
 * True for the 1997–2003 binary `.xls`, which this does not read.
 *
 * Worth recognising precisely so the refusal can name the problem: an OLE2
 * compound document opens with a fixed eight-byte signature, and telling
 * somebody "this is the old Excel format, re-save it as .xlsx" is a usable
 * instruction where "the file could not be read" is not.
 */
export function looksLikeLegacyXls(buffer: Buffer): boolean {
  if (buffer.length < 8) return false;
  return buffer.toString('hex', 0, 8) === 'd0cf11e0a1b11ae1';
}
