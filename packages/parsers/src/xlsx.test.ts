import { describe, expect, it } from 'vitest';
import { makeXlsx, makeZip, type FixtureCell } from './xlsx.fixture.js';
import {
  columnIndexOf,
  isDateFormat,
  looksLikeLegacyXls,
  looksLikePdf,
  looksLikeZip,
  readXlsx,
  serialToIsoDate,
  tidyNumber,
  XlsxError,
} from './xlsx.js';
import { readZip, ZipError } from './zip.js';

const s = (value: string): FixtureCell => ({ kind: 's', value });
const n = (value: string): FixtureCell => ({ kind: 'n', value });
const d = (value: string): FixtureCell => ({ kind: 'd', value });

describe('readZip', () => {
  it('reads back what it was given', () => {
    const zip = readZip(makeZip([{ name: 'a/b.xml', content: '<x>হ্যাঁ</x>' }]));
    expect(zip.get('a/b.xml')?.toString('utf8')).toBe('<x>হ্যাঁ</x>');
  });

  it('refuses something that is not a zip at all', () => {
    expect(() => readZip(Buffer.from('just some text, honestly'))).toThrow(ZipError);
  });
});

describe('readXlsx', () => {
  const STATEMENT = [
    [s('তারিখ'), s('বিবরণ'), s('জমা'), s('খরচ')],
    [d('46204'), s('বেতন'), n('50000'), n('')],
    [d('46206'), s('বাজার'), n(''), n('1250.5')],
  ];

  it('reads a sheet into a rectangular grid of strings', () => {
    const [sheet] = readXlsx(makeXlsx(STATEMENT));
    expect(sheet?.name).toBe('Statement');
    expect(sheet?.grid).toHaveLength(3);
    expect(sheet?.grid[0]).toEqual(['তারিখ', 'বিবরণ', 'জমা', 'খরচ']);
  });

  it('turns a date-styled serial into an ISO date rather than a five-digit number', () => {
    /* The single most valuable thing this reader does. Without it the whole
       date column arrives as `46204` and every row is rejected. */
    const [sheet] = readXlsx(makeXlsx(STATEMENT));
    expect(sheet?.grid[1]?.[0]).toBe('2026-07-01');
    expect(sheet?.grid[2]?.[0]).toBe('2026-07-03');
  });

  it('hands an amount on as text, so no float ever touches money', () => {
    const [sheet] = readXlsx(makeXlsx(STATEMENT));
    expect(sheet?.grid[2]?.[3]).toBe('1250.5');
  });

  it('resolves shared strings rather than showing their indexes', () => {
    const [sheet] = readXlsx(makeXlsx(STATEMENT));
    expect(sheet?.grid[1]?.[1]).toBe('বেতন');
  });

  it('keeps a row in its declared place when the table starts further down', () => {
    /* Bank exports put the account number and the period above the table. The
       row numbers have to survive that or an error says "row 3" about row 9. */
    const withPreamble = [
      [s('হিসাব নম্বর: ১২৩'), s(''), s(''), s('')],
      [s(''), s(''), s(''), s('')],
      ...STATEMENT,
    ];
    const [sheet] = readXlsx(makeXlsx(withPreamble));
    expect(sheet?.grid).toHaveLength(5);
    expect(sheet?.grid[2]).toEqual(['তারিখ', 'বিবরণ', 'জমা', 'খরচ']);
  });

  it('says plainly when the bytes are not a workbook', () => {
    expect(() => readXlsx(makeZip([{ name: 'hello.txt', content: 'hi' }]))).toThrow(XlsxError);
  });
});

describe('serialToIsoDate', () => {
  it('reads an ordinary modern date', () => {
    expect(serialToIsoDate(46_204, false)).toBe('2026-07-01');
  });

  it('honours the 1900 leap-year bug the format was born with', () => {
    // Serial 59 is 28 February 1900; 61 is 1 March. 60 is a day that never was.
    expect(serialToIsoDate(59, false)).toBe('1900-02-28');
    expect(serialToIsoDate(61, false)).toBe('1900-03-01');
  });

  it('reads the other epoch old Mac Excel used', () => {
    expect(serialToIsoDate(0, true)).toBe('1904-01-01');
  });
});

describe('tidyNumber', () => {
  it('leaves an integer exactly as written', () => {
    // A sixteen-digit account number must never go near a float.
    expect(tidyNumber('1234567890123456')).toBe('1234567890123456');
  });

  it('leaves an ordinary amount alone', () => {
    expect(tidyNumber('1250.5')).toBe('1250.5');
  });

  it('takes binary dust back out so a truncating parser is not a poisha short', () => {
    expect(tidyNumber('1250.4999999999999')).toBe('1250.50');
    expect(tidyNumber('4.7500000000000004')).toBe('4.75');
  });

  it('keeps a number that genuinely carries more precision', () => {
    expect(tidyNumber('0.3333333333333333')).toBe('0.3333333333333333');
  });
});

describe('small parts', () => {
  it('reads a column reference', () => {
    expect(columnIndexOf('A1')).toBe(0);
    expect(columnIndexOf('Z9')).toBe(25);
    expect(columnIndexOf('AB12')).toBe(27);
    expect(columnIndexOf('12')).toBeNull();
  });

  it('knows a date format from a money one', () => {
    expect(isDateFormat('dd/mm/yyyy')).toBe(true);
    expect(isDateFormat('#,##0.00')).toBe(false);
    // "Paid" is a literal, not four format letters — `d` in quotes means nothing.
    expect(isDateFormat('"Paid"\\ #,##0.00')).toBe(false);
    expect(isDateFormat('[$-409]d\\-mmm\\-yy')).toBe(true);
  });

  it('recognises each format from its first bytes', () => {
    expect(looksLikeZip(makeXlsx([[s('x')]]))).toBe(true);
    expect(looksLikePdf(Buffer.from('%PDF-1.4\n'))).toBe(true);
    expect(looksLikeLegacyXls(Buffer.from('d0cf11e0a1b11ae100', 'hex'))).toBe(true);
    expect(looksLikeLegacyXls(Buffer.from('%PDF-1.4\n'))).toBe(false);
  });
});
