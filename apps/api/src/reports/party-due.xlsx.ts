import ExcelJS from 'exceljs';
import type { Locale } from '@hishab/shared';
import type { PartyDueReport, PartyDueRow, PartyDueSide } from '../loans/loans.service';

/**
 * The party due report as a workbook.
 *
 * Two sheets rather than one with a "type" column, because the two questions
 * are asked on different days by different people: chasing what customers owe
 * is Saturday morning, and knowing what is owed to suppliers is the night
 * before a payment run. A single sheet makes both of those a filter somebody
 * has to remember to apply.
 *
 * **No advert here, on purpose.** Sponsored footers print on PDF and paper. A
 * spreadsheet is sorted, filtered and pasted into somebody else's workbook, and
 * a line of advertising copy in row 412 is a row that breaks their formulas and
 * their totals. The margin of a printed page is borrowed space; a cell is not.
 *
 * No formula guard either, and that is not an omission: an XLSX cell holds a
 * string as a string, so a supplier called `=cmd|'/c calc'!A1` arrives as those
 * characters and nothing else. The CSV export needs its apostrophe because a
 * CSV has no types to tell a spreadsheet apart from a program.
 */

/** Indian grouping — ১২,৩৪,৫৬৭.৮৯, not 1,234,567.89. The books are in taka. */
const MONEY_FORMAT = '#,##,##0.00';

const HEADERS: Record<Locale, Record<'customer' | 'supplier', readonly string[]>> = {
  bn: {
    customer: [
      'কোড',
      'নাম',
      'ফোন',
      'মোট বাকিতে দেওয়া',
      'মোট জমা',
      'বাকি আছে',
      'মেয়াদোত্তীর্ণ',
      'শেষ লেনদেন',
      'মন্তব্য',
    ],
    supplier: [
      'কোড',
      'নাম',
      'ফোন',
      'মোট বাকিতে কেনা',
      'মোট শোধ',
      'বাকি আছে',
      'মেয়াদোত্তীর্ণ',
      'শেষ লেনদেন',
      'মন্তব্য',
    ],
  },
  en: {
    customer: [
      'Code',
      'Name',
      'Phone',
      'Total on credit',
      'Total received',
      'Outstanding',
      'Overdue',
      'Last activity',
      'Notes',
    ],
    supplier: [
      'Code',
      'Name',
      'Phone',
      'Total purchased on credit',
      'Total paid',
      'Outstanding',
      'Overdue',
      'Last activity',
      'Notes',
    ],
  },
};

const SHEET_NAMES: Record<Locale, Record<'customer' | 'supplier', string>> = {
  bn: { customer: 'ক্রেতা', supplier: 'সাপ্লায়ার' },
  en: { customer: 'Customers', supplier: 'Suppliers' },
};

const TOTAL_LABEL: Record<Locale, string> = { bn: 'মোট', en: 'Total' };
const ARCHIVED_LABEL: Record<Locale, string> = { bn: 'মুছে ফেলা', en: 'Deleted' };
const TITLE: Record<Locale, string> = { bn: 'বাকির খাতা', en: 'Party dues' };
const AS_OF: Record<Locale, string> = { bn: 'তারিখ', en: 'As of' };

/** Poisha to taka. Excel wants a number it can sum, never a formatted string. */
const taka = (minor: number): number => minor / 100;

const COLUMN_WIDTHS = [10, 30, 16, 18, 16, 16, 14, 14, 14];

interface WorkbookOptions {
  workspaceName: string;
  locale: Locale;
}

function addSheet(
  book: ExcelJS.Workbook,
  side: 'customer' | 'supplier',
  rows: readonly PartyDueRow[],
  totals: PartyDueSide,
  report: PartyDueReport,
  options: WorkbookOptions,
): void {
  const { locale } = options;
  const sheet = book.addWorksheet(SHEET_NAMES[locale][side], {
    /* Landscape and fit-to-width: nine columns on A4 portrait wraps the phone
     * number onto its own line, and a due list somebody cannot read down a
     * column is a due list they will retype. */
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  sheet.addRow([`${options.workspaceName} — ${TITLE[locale]}`]);
  sheet.addRow([`${AS_OF[locale]}: ${report.asOf}`]);
  sheet.addRow([]);
  sheet.getRow(1).font = { bold: true, size: 14 };
  sheet.getRow(2).font = { color: { argb: 'FF666666' } };

  const headerRow = sheet.addRow([...HEADERS[locale][side]]);
  headerRow.font = { bold: true };
  headerRow.border = { bottom: { style: 'thin' } };

  for (const row of rows) {
    const figures = row[side];
    sheet.addRow([
      row.code,
      row.name,
      row.phone ?? '',
      taka(figures.totalMinor),
      taka(figures.paidMinor),
      taka(figures.outstandingMinor),
      taka(figures.overdueMinor),
      figures.lastActivity ?? '',
      row.archived ? ARCHIVED_LABEL[locale] : '',
    ]);
  }

  const totalRow = sheet.addRow([
    TOTAL_LABEL[locale],
    `${rows.length}`,
    '',
    taka(totals.totalMinor),
    taka(totals.paidMinor),
    taka(totals.outstandingMinor),
    taka(totals.overdueMinor),
    '',
    '',
  ]);
  totalRow.font = { bold: true };
  totalRow.border = { top: { style: 'double' } };

  COLUMN_WIDTHS.forEach((width, index) => {
    sheet.getColumn(index + 1).width = width;
  });
  for (const index of [4, 5, 6, 7]) {
    sheet.getColumn(index).numFmt = MONEY_FORMAT;
    sheet.getColumn(index).alignment = { horizontal: 'right' };
  }

  /* The four rows above the header scroll away otherwise, and a shop reading
   * row 300 needs to know which column is "বাকি আছে" more than it needs to know
   * whose workbook it is. */
  sheet.views = [{ state: 'frozen', ySplit: 4 }];
  sheet.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: 9 } };
}

export async function partyDuesWorkbook(
  report: PartyDueReport,
  options: WorkbookOptions,
): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  book.created = new Date();

  addSheet(book, 'customer', report.customers, report.customerTotals, report, options);
  addSheet(book, 'supplier', report.suppliers, report.supplierTotals, report, options);

  const buffer = await book.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
