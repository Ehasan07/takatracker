import {
  buildRows,
  guessMapping,
  parseDelimited,
  type ColumnMapping,
  type DatePreference,
} from '@hishab/core';
import {
  dropRepeatedHeaders,
  gridFromTextItems,
  looksLikeLegacyXls,
  looksLikePdf,
  looksLikeZip,
  readXlsx,
  XlsxError,
  type PositionedText,
} from '@hishab/parsers';

/**
 * Reading a bank statement out of whatever the bank actually sent.
 *
 * Bangladeshi banks and wallets do not agree on a format. The same person's
 * three accounts hand out a CSV, an Excel workbook and a PDF, and a phone photo
 * of a printout is what arrives when the portal is down. The old answer to two
 * of those four was "open it in Excel and save it as CSV", which is not an
 * answer on a phone and is barely one on a laptop.
 *
 * So everything is turned into the same thing: **a grid of strings**, exactly
 * the shape `parseDelimited` already produces from a CSV. Every stage after
 * this one — the column guess, the row builder, the duplicate check, the
 * review screen — is unchanged and does not know or care which door the file
 * came in through. One pipeline, four front doors, and only the doors are new
 * code.
 *
 * ## What each format is actually worth
 *
 *  - **CSV / TSV / TXT** — exact. It was already exact.
 *  - **XLSX** — exact, and better than the CSV of the same data, because a date
 *    in a spreadsheet is a number with a format attached and therefore carries
 *    no day-first/month-first ambiguity at all.
 *  - **PDF** — good when the PDF contains text, which every bank portal's own
 *    download does. The table has to be reconstructed from ink positions (see
 *    `@hishab/parsers/pdf-table`), and it can get the columns wrong on a badly
 *    laid out statement. That is why the review screen shows every row before
 *    anything is written.
 *  - **Images** — not read. See `IMAGE_REFUSAL` below; the reasoning is there
 *    rather than here because it is the user who needs it.
 */

export type StatementFormat = 'CSV' | 'XLSX' | 'PDF';

export class StatementReadError extends Error {
  constructor(
    /** Bengali. This is shown to the person holding the file. */
    message: string,
    readonly kind: 'UNSUPPORTED' | 'UNREADABLE' = 'UNREADABLE',
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'StatementReadError';
  }
}

/** How many pages of a PDF are read. A year of monthly statements and then some. */
export const MAX_PDF_PAGES = 40;

/** How long the PDF reader gets before it is assumed to be stuck. */
const PDF_TIMEOUT_MS = 30_000;

/**
 * Pages are stacked into one coordinate space before the columns are found, so
 * every page shares one column model. This is the vertical gap between them —
 * far taller than any page, so no line of page two can ever be mistaken for a
 * line of page one.
 */
const PAGE_STRIDE = 100_000;

/**
 * Why a photograph of a statement is not read.
 *
 * Recognising text in an image is not the hard part; recognising *money* in an
 * image is. An OCR engine that reads `1,250.50` as `1.250.50` or drops the last
 * digit of `50,000` produces a row that looks completely ordinary on the review
 * screen and is wrong by a factor of ten. Every other format here either reads
 * a number exactly or fails visibly, and a silent decimal-point error in
 * somebody's books is worse than any amount of inconvenience.
 *
 * Running it offline on a shared VPS with no GPU makes it worse again: the
 * engines that are accurate enough to trust need either a model download at
 * runtime or hardware this app does not have, and Bengali script accuracy on a
 * phone photo is poor even with both.
 *
 * The honest answer is therefore a refusal with the two things that do work:
 * nearly every bank portal will email or download the same statement as a PDF,
 * and a handful of rows is quicker to type than to correct.
 */
const IMAGE_REFUSAL =
  'ছবি থেকে এখনো লেনদেন পড়া যায় না — ভুল অঙ্ক ধরে ফেলার ঝুঁকি অনেক বেশি। ' +
  'ব্যাংকের অ্যাপ বা ওয়েবসাইট থেকে একই স্টেটমেন্ট পিডিএফ, এক্সেল বা সিএসভি হিসেবে নামিয়ে দিন — ' +
  'অথবা কয়েকটি লেনদেন হলে হাতে যোগ করে নিন।';

export interface ReadStatement {
  format: StatementFormat;
  /** Row-major strings, straight from the file. Header row not yet identified. */
  grid: string[][];
  /** Every sheet in a workbook, so the user can point at a different one. */
  sheetNames: string[];
  /** Which sheet this grid came from. */
  sheetName: string | null;
  /** Pages read out of a PDF. */
  pageCount: number | null;
  /** Bengali, when there is something about the reading the user should know. */
  note: string | null;
}

// --- format detection --------------------------------------------------------

const IMAGE_SIGNATURES: readonly { name: string; test: (bytes: Buffer) => boolean }[] = [
  { name: 'PNG', test: (b) => b.toString('hex', 0, 4) === '89504e47' },
  { name: 'JPEG', test: (b) => b.toString('hex', 0, 3) === 'ffd8ff' },
  { name: 'GIF', test: (b) => b.toString('latin1', 0, 3) === 'GIF' },
  { name: 'BMP', test: (b) => b.toString('latin1', 0, 2) === 'BM' },
  {
    name: 'WEBP',
    test: (b) => b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
  },
  /* HEIC — what an iPhone produces by default, and therefore what a screenshot
     of a statement most often is. */
  { name: 'HEIC', test: (b) => b.toString('latin1', 4, 8) === 'ftyp' },
];

/**
 * What this file is, from its first bytes.
 *
 * The magic number and not the extension or the `Content-Type`: a browser sends
 * `application/octet-stream` for a `.xlsx` about half the time, and people
 * rename files. The bytes at the front of a file are the one thing that does
 * not lie.
 */
export function detectFormat(bytes: Buffer): StatementFormat {
  for (const signature of IMAGE_SIGNATURES) {
    if (bytes.length >= 12 && signature.test(bytes)) {
      throw new StatementReadError(IMAGE_REFUSAL, 'UNSUPPORTED');
    }
  }

  if (looksLikeLegacyXls(bytes)) {
    throw new StatementReadError(
      'এটি পুরোনো ধরনের এক্সেল ফাইল (.xls)। এক্সেলে খুলে “.xlsx” বা “CSV UTF-8” হিসেবে সেভ করে আবার দিন।',
      'UNSUPPORTED',
    );
  }

  if (looksLikePdf(bytes)) return 'PDF';
  if (looksLikeZip(bytes)) return 'XLSX';
  return 'CSV';
}

// --- pdf ---------------------------------------------------------------------

/**
 * pdf.js, and the small dance needed to load it.
 *
 * `pdfjs-dist` ships as ES modules only; this application compiles to
 * CommonJS. Two things follow, and the specifier being a `const` rather than a
 * literal is what deals with both:
 *
 *  - TypeScript will not resolve `.mjs` type declarations under this project's
 *    `moduleResolution`, so a literal import of the path is a compile error
 *    over a module that loads perfectly well. A non-literal specifier is not
 *    resolved at compile time at all, and the shape is asserted below instead —
 *    against the four members actually used, which is a smaller and more honest
 *    contract than pulling in the library's whole type surface.
 *  - The emitted `require()` of an ES module needs Node 22.12 or newer.
 *    `package.json` asks for Node 22, so the failure is caught and turned into
 *    a sentence that names the cause rather than a stack trace about modules.
 *
 * Loaded once, lazily: it is a large module, and most uploads are spreadsheets.
 */
const PDFJS_SPECIFIER = 'pdfjs-dist/legacy/build/pdf.mjs';

interface PdfTextItem {
  str?: string;
  width?: number;
  height?: number;
  transform?: number[];
}

interface PdfPage {
  getViewport(options: { scale: number }): { transform: number[] };
  getTextContent(): Promise<{ items: PdfTextItem[] }>;
}

interface PdfDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPage>;
  destroy(): Promise<void>;
}

interface Pdfjs {
  getDocument(options: Record<string, unknown>): { promise: Promise<PdfDocument>; destroy(): void };
  Util: { transform(a: number[], b: number[]): number[] };
}

let pdfjsPromise: Promise<Pdfjs> | null = null;

async function loadPdfjs(): Promise<Pdfjs> {
  pdfjsPromise ??= (async () => {
    const loaded: unknown = await import(PDFJS_SPECIFIER);
    const candidate = loaded as Partial<Pdfjs> & { default?: Partial<Pdfjs> };
    // Interop: the CommonJS side of the bridge can hand back a `default` wrapper.
    const pdfjs = typeof candidate.getDocument === 'function' ? candidate : candidate.default;
    if (!pdfjs || typeof pdfjs.getDocument !== 'function') {
      throw new Error('pdfjs-dist did not export getDocument');
    }
    return pdfjs as Pdfjs;
  })();

  try {
    return await pdfjsPromise;
  } catch (error) {
    // Do not cache the failure: a restart on a newer Node should just work.
    pdfjsPromise = null;
    throw new StatementReadError(
      'পিডিএফ পড়ার সুবিধাটি এই সার্ভারে চালু করা যায়নি। ফাইলটি এক্সেল বা সিএসভি হিসেবে দিন।',
      'UNSUPPORTED',
      { cause: error },
    );
  }
}

async function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new StatementReadError(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readPdf(bytes: Buffer): Promise<ReadStatement> {
  const pdfjs = await loadPdfjs();

  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    /* No fonts installed on a server, no `eval`, no network. The last of those
       matters most: a PDF must never be able to make this process fetch
       anything, and pdf.js will happily go looking for font data otherwise. */
    useSystemFonts: false,
    isEvalSupported: false,
    disableFontFace: true,
    useWorkerFetch: false,
    /* Errors only. Text extraction does not need the standard font metrics and
       works perfectly without them; the warning about it would otherwise be
       printed once per page into the server log. */
    verbosity: 0,
  });

  let doc: PdfDocument;
  try {
    doc = await withTimeout(task.promise, PDF_TIMEOUT_MS, 'পিডিএফটি পড়তে খুব বেশি সময় লাগছে');
  } catch (error) {
    if (error instanceof StatementReadError) {
      task.destroy();
      throw error;
    }
    throw new StatementReadError(
      'পিডিএফ ফাইলটি খোলা গেল না — এটি নষ্ট হয়ে থাকতে পারে, বা পাসওয়ার্ড দেওয়া আছে।',
    );
  }

  try {
    const pages = Math.min(doc.numPages, MAX_PDF_PAGES);
    const items: PositionedText[] = [];

    for (let pageNumber = 1; pageNumber <= pages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      /* Through the viewport, so a page saved sideways reads the right way up.
         The raw text matrix is in the page's own space, which for a rotated
         page has x running down the paper. */
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();

      for (const item of content.items) {
        if (typeof item.str !== 'string' || item.str === '' || !item.transform) continue;
        const placed = pdfjs.Util.transform(viewport.transform, item.transform);
        items.push({
          text: item.str,
          x: placed[4] ?? 0,
          /* Stacked page by page, and in viewport space y already increases
             downwards — which is the reading order `gridFromTextItems` wants. */
          y: (placed[5] ?? 0) + (pageNumber - 1) * PAGE_STRIDE,
          width: item.width ?? 0,
          height: item.height ?? undefined,
        });
      }
    }

    if (items.length === 0) {
      throw new StatementReadError(
        'এই পিডিএফের ভেতরে কোনো লেখা নেই — সম্ভবত এটি স্ক্যান করা ছবি। ' +
          'ব্যাংকের ওয়েবসাইট থেকে আসল পিডিএফ বা এক্সেল ফাইলটি নামিয়ে দিন।',
      );
    }

    const grid = dropRepeatedHeaders(gridFromTextItems(items));
    return {
      format: 'PDF',
      grid,
      sheetNames: [],
      sheetName: null,
      pageCount: pages,
      note:
        doc.numPages > pages
          ? `ফাইলটিতে ${doc.numPages}টি পাতা আছে, প্রথম ${pages}টি পড়া হয়েছে।`
          : null,
    };
  } finally {
    await doc.destroy().catch(() => undefined);
  }
}

// --- xlsx --------------------------------------------------------------------

/**
 * The sheet most likely to be the statement.
 *
 * A bank's workbook often opens on a cover sheet with the account holder's name
 * and the period, and the transactions are on the second tab. Picking the first
 * one and calling it a day would greet half of those users with an empty
 * preview, so the sheet with the most rows that look like data wins — and the
 * full list of names goes back with the response either way, because the guess
 * can be wrong and the user is the one who can see the tabs.
 */
function chooseSheet(sheets: readonly { name: string; grid: string[][] }[]): number {
  let best = 0;
  let bestScore = -1;
  sheets.forEach((sheet, index) => {
    const rows = sheet.grid.length;
    const filled = sheet.grid.filter((row) => row.some((cell) => cell.trim() !== '')).length;
    const score = filled * 10 + rows;
    if (score > bestScore) {
      bestScore = score;
      best = index;
    }
  });
  return best;
}

function readWorkbook(bytes: Buffer, wanted: string | undefined): ReadStatement {
  let sheets: { name: string; grid: string[][] }[];
  try {
    sheets = readXlsx(bytes);
  } catch (error) {
    if (error instanceof XlsxError) {
      throw new StatementReadError(`এক্সেল ফাইলটি পড়া গেল না (${error.message})`);
    }
    throw error;
  }

  const names = sheets.map((sheet) => sheet.name);
  const askedFor = wanted ? names.indexOf(wanted) : -1;
  const index = askedFor >= 0 ? askedFor : chooseSheet(sheets);
  const chosen = sheets[index];
  if (!chosen) throw new StatementReadError('এক্সেল ফাইলটিতে কোনো শিট নেই');

  return {
    format: 'XLSX',
    grid: chosen.grid,
    sheetNames: names,
    sheetName: chosen.name,
    pageCount: null,
    note:
      names.length > 1
        ? `ফাইলটিতে ${names.length}টি শিট আছে — “${chosen.name}” পড়া হয়েছে।`
        : null,
  };
}

// --- the door ----------------------------------------------------------------

/**
 * Bytes in, grid out.
 *
 * `sheet` is the tab the user picked on a second pass; on the first pass there
 * is nothing to pick from yet and the guess above applies.
 */
export async function readStatement(
  bytes: Buffer,
  options: { sheet?: string } = {},
): Promise<ReadStatement> {
  const format = detectFormat(bytes);

  if (format === 'PDF') return readPdf(bytes);
  if (format === 'XLSX') return readWorkbook(bytes, options.sheet);

  const text = bytes.toString('utf8');
  return {
    format: 'CSV',
    grid: parseDelimited(text),
    sheetNames: [],
    sheetName: null,
    pageCount: null,
    note: null,
  };
}

// --- finding the table inside the page ---------------------------------------

/**
 * How far down a file the heading row is looked for.
 *
 * A PDF statement's letterhead, address block and account summary run to twenty
 * lines before the table starts. Past forty, whatever we are looking at is not
 * a statement with a heading.
 */
const MAX_HEADER_SEARCH = 40;

export interface TableStart {
  /** Index into the grid of the heading row, or `null` when none was found. */
  headerRow: number | null;
  mapping: ColumnMapping;
  /** How many rows below it actually parsed — the evidence for the choice. */
  parsedRows: number;
}

/**
 * Which row is the heading.
 *
 * A CSV starts with it. Nothing else does: an Excel export has a title and an
 * account number above the table, and a PDF has the whole letterhead. Assuming
 * row zero would hand `guessMapping` the bank's address and then report that
 * every row in the file is missing a date.
 *
 * The test is not "does this row look like a heading" but **"does treating this
 * row as the heading actually produce transactions"** — the mapping is guessed
 * from the candidate and then the rows below it are really built, and the
 * candidate that yields the most usable rows wins. That is a far stronger
 * signal than any amount of matching on words, and it costs one extra pass over
 * a file that is at most a few thousand rows.
 *
 * Ties go to the earliest row, because a repeated heading further down the file
 * would otherwise win by having the same rows below it minus the first few.
 */
export function findTableStart(
  grid: readonly (readonly string[])[],
  datePreference: DatePreference,
): TableStart {
  let best: TableStart = { headerRow: null, mapping: {}, parsedRows: 0 };

  const limit = Math.min(grid.length, MAX_HEADER_SEARCH);
  for (let index = 0; index < limit; index += 1) {
    const candidate = (grid[index] ?? []).map((cell) => cell.trim());
    if (candidate.every((cell) => cell === '')) continue;

    const mapping = guessMapping(candidate);
    const hasMoney = Boolean(mapping.amount ?? mapping.debit ?? mapping.credit);
    if (!mapping.date || !hasMoney) continue;

    const { rows } = buildRows(grid.slice(index), mapping, { datePreference });
    if (rows.length > best.parsedRows) {
      best = { headerRow: index, mapping, parsedRows: rows.length };
    }
  }

  return best;
}

/** The lines above the table, kept so the review screen can show the context. */
export function preambleOf(grid: readonly (readonly string[])[], headerRow: number): string[] {
  return grid
    .slice(0, headerRow)
    .map((row) =>
      row
        .map((cell) => cell.trim())
        .filter((cell) => cell !== '')
        .join('  '),
    )
    .filter((line) => line !== '');
}
