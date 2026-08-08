import { describe, expect, it } from 'vitest';
import {
  buildRows,
  dedupeKey,
  dedupeKeysFor,
  detectDelimiter,
  guessDatePreference,
  guessMapping,
  markDuplicates,
  parseDateFlexible,
  parseDelimited,
  stripBom,
  type ColumnMapping,
  type DedupeSource,
  type ParsedRow,
} from './import.js';

/**
 * Every fixture below is a file somebody could actually download from a bank
 * portal, and every amount is written in taka in the comment beside the poisha
 * figure it should produce. ৳5,000.00 is 500_000 poisha.
 *
 * The BOM is written as an escape rather than pasted, because a literal one is
 * invisible in a diff and the next person would delete it by accident.
 */
const BOM = '\uFEFF';

/** The header row every Bengali export of ours writes; see the API's export. */
const OUR_EXPORT_HEADERS = [
  'তারিখ',
  'বিবরণ',
  'ক্যাটাগরি',
  'অ্যাকাউন্ট',
  'জমা',
  'খরচ',
  'রেফারেন্স',
  'ধরন',
  'মন্তব্য',
];

/**
 * A semicolon-delimited statement with a BOM, the shape a Bangladeshi bank
 * portal actually hands you. Two of the dates have a day above 12, which is
 * what proves the file is day-first.
 */
const BANK_STATEMENT =
  `${BOM}Txn Date;Particulars;Cheque No;Withdrawal;Deposit;Balance\r\n` +
  '05/01/2026;ATM CASH WITHDRAWAL DHANMONDI;;5,000.00;;45,000.00\r\n' +
  '07/01/2026;SALARY JANUARY 2026;TRX90011;;60,000.00;105,000.00\r\n' +
  '19/01/2026;BKASH SEND MONEY 01712xxxxxx;TRX90042;1,250.50;;103,749.50\r\n' +
  '22/01/2026;REFUND DUPLICATE CHARGE;TRX90055;-300.00;;104,049.50\r\n';

const dmy = { datePreference: 'DMY' } as const;

/** Build the mapping the way the API will: guess it from the header row. */
function mappingFor(grid: readonly (readonly string[])[]): ColumnMapping {
  return guessMapping(grid[0] ?? []);
}

// --- parseDelimited ----------------------------------------------------------

describe('stripBom', () => {
  it('removes a leading BOM', () => {
    expect(stripBom(`${BOM}Date`)).toBe('Date');
  });

  it('leaves a file without one alone', () => {
    expect(stripBom('Date')).toBe('Date');
  });

  it('only removes it from the front, never from inside a field', () => {
    expect(stripBom(`Date${BOM}`)).toBe(`Date${BOM}`);
  });
});

describe('detectDelimiter', () => {
  it('finds a comma', () => {
    expect(detectDelimiter('Date,Description,Amount')).toBe(',');
  });

  it('finds a semicolon, which is what half the local bank exports use', () => {
    expect(detectDelimiter('Date;Description;Amount')).toBe(';');
  });

  it('finds a tab', () => {
    expect(detectDelimiter('Date\tDescription\tAmount')).toBe('\t');
  });

  it('ignores a comma inside a quoted header', () => {
    /* "Date, posted" is one column name. Counting its comma would split the
     * header into two and the whole file would map to nothing. */
    expect(detectDelimiter('"Date, posted";Amount;Balance')).toBe(';');
  });

  it('calls a file with no separator at all a single comma-delimited column', () => {
    expect(detectDelimiter('Particulars')).toBe(',');
  });

  it('picks the one that appears most, not the first one it sees', () => {
    expect(detectDelimiter('a;b,c;d;e')).toBe(';');
  });
});

describe('parseDelimited', () => {
  it('reads a plain comma file', () => {
    expect(parseDelimited('a,b,c\n1,2,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('reads a semicolon file without being told', () => {
    expect(parseDelimited('a;b;c\n1;2;3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('reads a tab file', () => {
    expect(parseDelimited('a\tb\n1\t2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('strips the BOM Excel puts on every CSV it saves', () => {
    // Without it the first header carries an invisible BOM and matches nothing.
    const grid = parseDelimited(`${BOM}Date,Amount\n2026-01-01,10`);
    expect(grid[0]).toEqual(['Date', 'Amount']);
  });

  it('keeps a comma that lives inside a quoted field', () => {
    const grid = parseDelimited('Date,Description\n2026-01-01,"Rickshaw, tea, snacks"');
    expect(grid[1]).toEqual(['2026-01-01', 'Rickshaw, tea, snacks']);
  });

  it('keeps a newline that lives inside a quoted field', () => {
    const grid = parseDelimited('Date,Description\n2026-01-01,"Line one\nLine two"');
    expect(grid).toHaveLength(2);
    expect(grid[1]?.[1]).toBe('Line one\nLine two');
  });

  it('turns a doubled quote into one literal quote', () => {
    const grid = parseDelimited('Note\n"He said ""thanks"""');
    expect(grid[1]).toEqual(['He said "thanks"']);
  });

  it('handles a quoted field that is only a delimiter', () => {
    expect(parseDelimited('a,b\n",",x')).toEqual([
      ['a', 'b'],
      [',', 'x'],
    ]);
  });

  it('ends a record on CRLF, on LF, and on a bare CR', () => {
    expect(parseDelimited('a\r\nb\nc\rd')).toEqual([['a'], ['b'], ['c'], ['d']]);
  });

  it('does not invent a row out of the trailing newline every file ends with', () => {
    expect(parseDelimited('a,b\n1,2\n')).toHaveLength(2);
  });

  it('drops blank records at the very end, however many there are', () => {
    // Exports pad the end. Reporting "row 214 is empty" every time trains
    // people to stop reading the error list.
    expect(parseDelimited('a,b\n1,2\n\n\n')).toHaveLength(2);
  });

  it('keeps a blank record in the middle, because that is a real hole', () => {
    const grid = parseDelimited('a,b\n1,2\n\n3,4\n');
    expect(grid).toHaveLength(4);
    expect(grid[2]).toEqual(['']);
  });

  it('keeps empty fields, so the columns still line up', () => {
    expect(parseDelimited('a,b,c\n1,,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '', '3'],
    ]);
  });

  it('returns nothing for an empty file', () => {
    expect(parseDelimited('')).toEqual([]);
  });

  it('does not trim: that decision belongs to whoever reads the column', () => {
    expect(parseDelimited('a, b ')).toEqual([['a', ' b ']]);
  });

  it('keeps a ragged row ragged instead of padding it', () => {
    const grid = parseDelimited('a,b,c\n1,2');
    expect(grid[1]).toEqual(['1', '2']);
  });

  it('survives a quote that was never closed', () => {
    // A truncated download must give back what it can, not throw.
    expect(parseDelimited('a,b\n"unfinished,2')).toEqual([['a', 'b'], ['unfinished,2']]);
  });

  it('reads the whole bank statement fixture as 5 rows of 6 columns', () => {
    const grid = parseDelimited(BANK_STATEMENT);
    expect(grid).toHaveLength(5);
    expect(grid.every((row) => row.length === 6)).toBe(true);
  });
});

// --- guessMapping ------------------------------------------------------------

describe('guessMapping — English headers', () => {
  const mapping = guessMapping([
    'Txn Date',
    'Particulars',
    'Cheque No',
    'Withdrawal',
    'Deposit',
    'Balance',
  ]);

  it('finds every column of a real bank export', () => {
    expect(mapping.date?.index).toBe(0);
    expect(mapping.description?.index).toBe(1);
    expect(mapping.reference?.index).toBe(2);
    expect(mapping.debit?.index).toBe(3);
    expect(mapping.credit?.index).toBe(4);
    expect(mapping.balance?.index).toBe(5);
  });

  it('is fully confident about names it knows exactly', () => {
    expect(mapping.date?.confidence).toBe(100);
    expect(mapping.debit?.confidence).toBe(100);
  });

  it('reports the header text back as it was written, for the mapping UI', () => {
    expect(mapping.description?.header).toBe('Particulars');
  });

  it('has no amount column, because this file splits debit and credit', () => {
    expect(mapping.amount).toBeUndefined();
  });
});

describe('guessMapping — the awkward cases', () => {
  it('calls "Debit Amount" a debit, not an amount', () => {
    /* Both words are known. The specific one wins, or a file would map the
     * same money to two roles and count every row twice. */
    const mapping = guessMapping(['Date', 'Debit Amount', 'Credit Amount']);
    expect(mapping.debit?.index).toBe(1);
    expect(mapping.credit?.index).toBe(2);
    expect(mapping.amount).toBeUndefined();
  });

  it('reads decorated headers like "Amount (Tk.)"', () => {
    const mapping = guessMapping(['Date', 'Amount (Tk.)']);
    expect(mapping.amount?.index).toBe(1);
    expect(mapping.amount?.confidence).toBe(80);
  });

  it('accepts Dr and Cr as whole words', () => {
    const mapping = guessMapping(['Date', 'Dr', 'Cr']);
    expect(mapping.debit?.index).toBe(1);
    expect(mapping.credit?.index).toBe(2);
  });

  it('does not let a two-letter name match inside a longer word', () => {
    // "cr" must not claim "Description", and "dr" must not claim "Address".
    const mapping = guessMapping(['Description', 'Address']);
    expect(mapping.credit).toBeUndefined();
    expect(mapping.debit).toBeUndefined();
    expect(mapping.description?.index).toBe(0);
  });

  it('never gives one header to two columns', () => {
    const mapping = guessMapping(['Transaction Date', 'Transaction Amount']);
    const used = Object.values(mapping).map((m) => m.index);
    expect(new Set(used).size).toBe(used.length);
  });

  it('never gives one column two headers', () => {
    const mapping = guessMapping(['Date', 'Value Date', 'Amount']);
    expect(mapping.date?.index).toBe(0);
    // The second date-ish header is simply left unmapped, not fought over.
    expect(Object.values(mapping).filter((m) => m.index === 1)).toHaveLength(0);
  });

  it('admits it does not know rather than guessing', () => {
    /* An empty slot is easy for the user to fill. A confident mistake is not
     * even visible until the numbers are wrong. */
    expect(guessMapping(['Foo', 'Bar', 'Baz'])).toEqual({});
  });

  it('copes with an empty header cell', () => {
    const mapping = guessMapping(['', 'Date', '']);
    expect(mapping.date?.index).toBe(1);
  });

  it('ignores case and surrounding spaces', () => {
    const mapping = guessMapping(['  DATE  ', ' amount ']);
    expect(mapping.date?.index).toBe(0);
    expect(mapping.amount?.index).toBe(1);
  });
});

describe('guessMapping — Bengali headers', () => {
  const mapping = guessMapping(['তারিখ', 'বিবরণ', 'ডেবিট', 'ক্রেডিট', 'স্থিতি']);

  it('reads the plain Bengali names', () => {
    expect(mapping.date?.index).toBe(0);
    expect(mapping.description?.index).toBe(1);
    expect(mapping.debit?.index).toBe(2);
    expect(mapping.credit?.index).toBe(3);
    expect(mapping.balance?.index).toBe(4);
  });

  it('reads জমা as credit and খরচ as debit', () => {
    const money = guessMapping(['তারিখ', 'বিবরণ', 'জমা', 'খরচ']);
    expect(money.credit?.index).toBe(2);
    expect(money.debit?.index).toBe(3);
  });

  it('reads টাকা as a single amount column', () => {
    const single = guessMapping(['তারিখ', 'বিবরণ', 'টাকা']);
    expect(single.amount?.index).toBe(2);
  });

  it('reads a file with Bengali and English headers mixed', () => {
    const mixed = guessMapping(['Date', 'বিবরণ', 'Amount', 'রেফারেন্স']);
    expect(mixed.date?.index).toBe(0);
    expect(mixed.description?.index).toBe(1);
    expect(mixed.amount?.index).toBe(2);
    expect(mixed.reference?.index).toBe(3);
  });

  it('reads our own export back in, which is the point of exporting', () => {
    /* An export nobody can re-import is not an export. These are the exact
     * headers `GET /export/transactions` writes. */
    const ours = guessMapping(OUR_EXPORT_HEADERS);
    expect(ours.date?.index).toBe(0);
    expect(ours.description?.index).toBe(1);
    expect(ours.category?.index).toBe(2);
    expect(ours.account?.index).toBe(3);
    expect(ours.credit?.index).toBe(4);
    expect(ours.debit?.index).toBe(5);
    expect(ours.reference?.index).toBe(6);
  });

  it('leaves our type column unmapped rather than calling it a category', () => {
    // "ধরন" is INCOME/EXPENSE, and filing every row under the word খরচ would
    // be worse than leaving the column alone.
    const ours = guessMapping(OUR_EXPORT_HEADERS);
    expect(ours.category?.index).toBe(2);
    expect(Object.values(ours).some((m) => m.index === 7)).toBe(false);
  });
});

// --- parseDateFlexible -------------------------------------------------------

describe('parseDateFlexible — unambiguous shapes', () => {
  it('reads ISO', () => {
    expect(parseDateFlexible('2026-01-31', 'DMY')).toBe('2026-01-31');
    expect(parseDateFlexible('2026-01-31', 'MDY')).toBe('2026-01-31');
  });

  it('reads ISO with slashes or dots', () => {
    expect(parseDateFlexible('2026/01/31', 'DMY')).toBe('2026-01-31');
    expect(parseDateFlexible('2026.01.31', 'MDY')).toBe('2026-01-31');
  });

  it('reads a compact YYYYMMDD, which core banking systems love', () => {
    expect(parseDateFlexible('20260131', 'MDY')).toBe('2026-01-31');
  });

  it('reads 31-Jan-2026 whichever convention the caller prefers', () => {
    expect(parseDateFlexible('31-Jan-2026', 'DMY')).toBe('2026-01-31');
    expect(parseDateFlexible('31-Jan-2026', 'MDY')).toBe('2026-01-31');
  });

  it('reads a spelled-out month, day first or month first', () => {
    expect(parseDateFlexible('31 January 2026', 'DMY')).toBe('2026-01-31');
    expect(parseDateFlexible('Jan 31, 2026', 'DMY')).toBe('2026-01-31');
    expect(parseDateFlexible('September 9, 2026', 'MDY')).toBe('2026-09-09');
  });

  it('reads Bengali month names', () => {
    expect(parseDateFlexible('৩১ ডিসেম্বর ২০২৬', 'DMY')).toBe('2026-12-31');
    expect(parseDateFlexible('১ ফেব্রুয়ারি ২০২৬', 'MDY')).toBe('2026-02-01');
  });

  it('reads Bengali digits in a numeric date', () => {
    expect(parseDateFlexible('৩১/০১/২০২৬', 'DMY')).toBe('2026-01-31');
  });

  it('throws away a time stuck on the end', () => {
    expect(parseDateFlexible('31/01/2026 14:35', 'DMY')).toBe('2026-01-31');
    expect(parseDateFlexible('31/01/2026 02:05:09 PM', 'DMY')).toBe('2026-01-31');
    expect(parseDateFlexible('2026-01-31T09:15:00Z', 'DMY')).toBe('2026-01-31');
  });

  it('ignores surrounding whitespace', () => {
    expect(parseDateFlexible('  2026-01-31  ', 'DMY')).toBe('2026-01-31');
  });
});

describe('parseDateFlexible — the ambiguity, which is the whole problem', () => {
  it('reads 03/04/2026 as 3 April when the caller says day first', () => {
    expect(parseDateFlexible('03/04/2026', 'DMY')).toBe('2026-04-03');
  });

  it('reads the very same string as 4 March when the caller says month first', () => {
    expect(parseDateFlexible('03/04/2026', 'MDY')).toBe('2026-03-04');
  });

  it('refuses 31/01/2026 under a month-first preference instead of flipping it', () => {
    /* This is the defect the strictness exists for. A parser that quietly read
     * this one as 31 January — because month 31 is impossible — while reading
     * every 03/04 row as 4 March would produce a file where a dozen rows are
     * right, hundreds are silently months out, and nothing on screen suggests
     * anything went wrong. A null becomes a numbered error telling the user to
     * change one setting. */
    expect(parseDateFlexible('31/01/2026', 'MDY')).toBeNull();
  });

  it('refuses 01/31/2026 under a day-first preference for the same reason', () => {
    expect(parseDateFlexible('01/31/2026', 'DMY')).toBeNull();
  });

  it('reads each of those under its own convention', () => {
    expect(parseDateFlexible('31/01/2026', 'DMY')).toBe('2026-01-31');
    expect(parseDateFlexible('01/31/2026', 'MDY')).toBe('2026-01-31');
  });

  it('refuses a pair where neither number can be a month', () => {
    expect(parseDateFlexible('31/13/2026', 'DMY')).toBeNull();
    expect(parseDateFlexible('31/13/2026', 'MDY')).toBeNull();
  });

  it('applies the preference to dashes and dots too, not only slashes', () => {
    expect(parseDateFlexible('31-01-2026', 'DMY')).toBe('2026-01-31');
    expect(parseDateFlexible('31.01.2026', 'MDY')).toBeNull();
  });
});

describe('parseDateFlexible — two-digit years', () => {
  it('reads 26 as 2026, because a statement records money that already moved', () => {
    expect(parseDateFlexible('31/01/26', 'DMY')).toBe('2026-01-31');
  });

  it('pivots at 70, the convention every spreadsheet uses', () => {
    expect(parseDateFlexible('31/01/69', 'DMY')).toBe('2069-01-31');
    expect(parseDateFlexible('31/01/70', 'DMY')).toBe('1970-01-31');
  });

  it('leaves a four-digit year alone', () => {
    expect(parseDateFlexible('31/01/1998', 'DMY')).toBe('1998-01-31');
  });
});

describe('parseDateFlexible — refusals', () => {
  it('refuses a day that does not exist', () => {
    expect(parseDateFlexible('30/02/2026', 'DMY')).toBeNull();
    expect(parseDateFlexible('2026-02-30', 'DMY')).toBeNull();
  });

  it('knows 2028 is a leap year and 2026 is not', () => {
    expect(parseDateFlexible('29/02/2028', 'DMY')).toBe('2028-02-29');
    expect(parseDateFlexible('29/02/2026', 'DMY')).toBeNull();
  });

  it('refuses a month above twelve and a day of zero', () => {
    expect(parseDateFlexible('2026-13-01', 'DMY')).toBeNull();
    expect(parseDateFlexible('00/01/2026', 'DMY')).toBeNull();
  });

  it('refuses an empty cell and plain prose', () => {
    expect(parseDateFlexible('', 'DMY')).toBeNull();
    expect(parseDateFlexible('   ', 'DMY')).toBeNull();
    expect(parseDateFlexible('no date here', 'DMY')).toBeNull();
  });

  it('refuses a month name it does not recognise', () => {
    expect(parseDateFlexible('31-Xyz-2026', 'DMY')).toBeNull();
  });

  it('refuses a year outside the plausible range, which is a mis-parse', () => {
    expect(parseDateFlexible('31/01/1234', 'DMY')).toBeNull();
  });
});

describe('guessDatePreference', () => {
  it('proves day-first from a day above twelve', () => {
    const guess = guessDatePreference(['05/01/2026', '19/01/2026']);
    expect(guess.preference).toBe('DMY');
    expect(guess.confident).toBe(true);
    expect(guess.dmyEvidence).toBe(1);
  });

  it('proves month-first from a second number above twelve', () => {
    const guess = guessDatePreference(['01/05/2026', '01/19/2026']);
    expect(guess.preference).toBe('MDY');
    expect(guess.confident).toBe(true);
  });

  it('admits it cannot tell when every row is ambiguous', () => {
    const guess = guessDatePreference(['03/04/2026', '05/06/2026']);
    expect(guess.preference).toBe('DMY');
    expect(guess.confident).toBe(false);
  });

  it('refuses to average a file that contradicts itself', () => {
    // Two files stapled together, or a broken export. Either way, ask.
    const guess = guessDatePreference(['19/01/2026', '01/19/2026']);
    expect(guess.confident).toBe(false);
    expect(guess.dmyEvidence).toBe(1);
    expect(guess.mdyEvidence).toBe(1);
  });

  it('takes no evidence from ISO dates, which are not ambiguous', () => {
    const guess = guessDatePreference(['2026-01-31', '2026-02-28']);
    expect(guess.dmyEvidence).toBe(0);
    expect(guess.mdyEvidence).toBe(0);
    expect(guess.confident).toBe(false);
  });

  it('defaults to day-first for an empty column, this being a Bangladeshi ledger', () => {
    expect(guessDatePreference([]).preference).toBe('DMY');
  });

  it('reads Bengali digits as evidence too', () => {
    expect(guessDatePreference(['১৯/০১/২০২৬']).preference).toBe('DMY');
    expect(guessDatePreference(['১৯/০১/২০২৬']).confident).toBe(true);
  });
});

// --- buildRows ---------------------------------------------------------------

describe('buildRows — the real bank statement', () => {
  const grid = parseDelimited(BANK_STATEMENT);
  const mapping = mappingFor(grid);
  const { rows, errors } = buildRows(grid, mapping, dmy);

  it('accepts all four transactions and complains about none', () => {
    expect(rows).toHaveLength(4);
    expect(errors).toEqual([]);
  });

  it('numbers rows the way the spreadsheet does: the header is row 1', () => {
    expect(rows.map((r) => r.lineNumber)).toEqual([2, 3, 4, 5]);
  });

  it('reads the day-first dates', () => {
    expect(rows.map((r) => r.date)).toEqual([
      '2026-01-05',
      '2026-01-07',
      '2026-01-19',
      '2026-01-22',
    ]);
  });

  it('turns a withdrawal into ৳5,000 going out', () => {
    expect(rows[0]?.amountMinor).toBe(500_000);
    expect(rows[0]?.direction).toBe('OUT');
  });

  it('turns a deposit into ৳60,000 coming in', () => {
    expect(rows[1]?.amountMinor).toBe(6_000_000);
    expect(rows[1]?.direction).toBe('IN');
  });

  it('keeps the poisha on ৳1,250.50', () => {
    expect(rows[2]?.amountMinor).toBe(125_050);
    expect(rows[2]?.direction).toBe('OUT');
  });

  it('reads a negative withdrawal as a refund coming back in', () => {
    /* −৳300 in the withdrawal column is money returned, not money spent. The
     * two columns net into one signed amount, so this needs no special case. */
    expect(rows[3]?.amountMinor).toBe(30_000);
    expect(rows[3]?.direction).toBe('IN');
  });

  it('carries the bank reference and leaves it null when the file had none', () => {
    expect(rows[0]?.reference).toBeNull();
    expect(rows[1]?.reference).toBe('TRX90011');
  });

  it('carries the description', () => {
    expect(rows[0]?.description).toBe('ATM CASH WITHDRAWAL DHANMONDI');
  });

  it('never produces a fractional or negative poisha amount', () => {
    for (const row of rows) {
      expect(Number.isInteger(row.amountMinor)).toBe(true);
      expect(row.amountMinor).toBeGreaterThan(0);
    }
  });
});

describe('buildRows — a single signed amount column', () => {
  const csv =
    'Date,Description,Amount\n' +
    '2026-02-01,Grocery,"-1,250.00"\n' +
    '2026-02-02,Salary,"60,000.00"\n' +
    '2026-02-03,Refund,"(1,234.00)"\n';
  const grid = parseDelimited(csv);
  const { rows, errors } = buildRows(grid, mappingFor(grid), dmy);

  it('takes the direction from the sign', () => {
    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({ amountMinor: 125_000, direction: 'OUT' });
    expect(rows[1]).toMatchObject({ amountMinor: 6_000_000, direction: 'IN' });
  });

  it('reads an accounting negative in brackets as money going out', () => {
    // ৳(1,234.00) is how a spreadsheet writes −৳1,234.
    expect(rows[2]).toMatchObject({ amountMinor: 123_400, direction: 'OUT' });
  });

  it('can be told that positive means money out, for an expense export', () => {
    const flipped = buildRows(grid, mappingFor(grid), { ...dmy, positiveMeans: 'OUT' });
    expect(flipped.rows[1]).toMatchObject({ amountMinor: 6_000_000, direction: 'OUT' });
    expect(flipped.rows[0]).toMatchObject({ amountMinor: 125_000, direction: 'IN' });
  });

  it('reads a Dr/Cr marker glued to the amount, and lets it beat the sign', () => {
    const marked = parseDelimited(
      'Date,Description,Amount\n2026-02-01,Fee,500.00 Dr\n2026-02-02,Interest,120.00 CR\n',
    );
    const built = buildRows(marked, mappingFor(marked), dmy);
    expect(built.errors).toEqual([]);
    expect(built.rows[0]).toMatchObject({ amountMinor: 50_000, direction: 'OUT' });
    expect(built.rows[1]).toMatchObject({ amountMinor: 12_000, direction: 'IN' });
  });
});

describe('buildRows — Bengali headers and Bengali digits', () => {
  const csv =
    'তারিখ,বিবরণ,জমা,খরচ,স্থিতি,রেফারেন্স\n' +
    '২৫/০১/২০২৬,কাঁচাবাজার,,"৳১,২৫০.৫০","৳৪৮,৭৪৯.৫০",\n' +
    '২৮/০১/২০২৬,বেতন,"৫০,০০০.০০",,"৯৮,৭৪৯.৫০",বেতন-০১\n';
  const grid = parseDelimited(csv);
  const mapping = mappingFor(grid);
  const { rows, errors } = buildRows(grid, mapping, dmy);

  it('maps জমা to credit and খরচ to debit', () => {
    expect(mapping.credit?.index).toBe(2);
    expect(mapping.debit?.index).toBe(3);
  });

  it('reads Bengali numerals in the date', () => {
    expect(errors).toEqual([]);
    expect(rows.map((r) => r.date)).toEqual(['2026-01-25', '2026-01-28']);
  });

  it('reads ৳১,২৫০.৫০ as 125050 poisha going out', () => {
    expect(rows[0]).toMatchObject({ amountMinor: 125_050, direction: 'OUT' });
  });

  it('reads ৫০,০০০.০০ as ৳50,000 coming in', () => {
    expect(rows[1]).toMatchObject({ amountMinor: 5_000_000, direction: 'IN' });
  });

  it('keeps Bengali text intact in the description and the reference', () => {
    expect(rows[0]?.description).toBe('কাঁচাবাজার');
    expect(rows[1]?.reference).toBe('বেতন-০১');
  });
});

describe('buildRows — quoted fields', () => {
  const csv =
    'Date,Description,Amount\n' +
    '2026-03-01,"Rickshaw, tea, snacks",-250.00\n' +
    '2026-03-02,"Line one\nLine two",-99.00\n' +
    '2026-03-03,"He said ""thanks""",-10.00\n';
  const grid = parseDelimited(csv);
  const { rows, errors } = buildRows(grid, mappingFor(grid), dmy);

  it('keeps commas that were inside the quotes', () => {
    expect(errors).toEqual([]);
    expect(rows[0]?.description).toBe('Rickshaw, tea, snacks');
  });

  it('flattens an embedded newline into a single line', () => {
    /* One spreadsheet row is one ledger row; a description with a hard line
     * break in it wrecks every list view that shows it. */
    expect(rows[1]?.description).toBe('Line one Line two');
  });

  it('counts a record with an embedded newline as one row, as Excel does', () => {
    // Row 3 in the spreadsheet is row 3 here, even though it spans two lines.
    expect(rows[1]?.lineNumber).toBe(3);
    expect(rows[2]?.lineNumber).toBe(4);
  });

  it('unescapes a doubled quote', () => {
    expect(rows[2]?.description).toBe('He said "thanks"');
  });
});

describe('buildRows — blank and malformed rows', () => {
  const csv =
    'Date,Description,Amount\n' +
    '2026-03-01,Good one,100.00\n' +
    '\n' +
    '2026-03-32,Impossible day,50.00\n' +
    '2026-03-04,Not a number,abc\n' +
    ',Missing date,10.00\n' +
    '2026-03-06,Zero,0.00\n' +
    '2026-03-07,Also good,200.00\n';
  const grid = parseDelimited(csv);
  const { rows, errors } = buildRows(grid, mappingFor(grid), dmy);

  it('keeps the rows that are fine', () => {
    expect(rows.map((r) => r.lineNumber)).toEqual([2, 8]);
  });

  it('reports every bad row exactly once', () => {
    expect(errors).toHaveLength(5);
  });

  it('says which line each problem is on, which is the entire point', () => {
    /* "৫টি সারি বাদ পড়েছে" with no line numbers is useless — the person has
     * the spreadsheet open beside the screen. */
    expect(errors.map((e) => e.lineNumber)).toEqual([3, 4, 5, 6, 7]);
  });

  it('names the blank row as blank', () => {
    expect(errors[0]?.message).toContain('খালি সারি');
    expect(errors[0]?.column).toBeNull();
  });

  it('quotes the unreadable date back at the user', () => {
    expect(errors[1]?.column).toBe('date');
    expect(errors[1]?.value).toBe('2026-03-32');
    expect(errors[1]?.message).toContain('2026-03-32');
  });

  it('says which shape it was trying to read the date in', () => {
    expect(errors[1]?.message).toContain('দিন/মাস/বছর');
  });

  it('quotes the unreadable amount back at the user', () => {
    expect(errors[2]?.column).toBe('amount');
    expect(errors[2]?.value).toBe('abc');
  });

  it('reports a missing date rather than inventing today', () => {
    expect(errors[3]?.column).toBe('date');
    expect(errors[3]?.message).toBe('তারিখ নেই');
  });

  it('refuses a zero-taka row', () => {
    // Nothing moved, and the ledger would reject an entry for nothing anyway.
    expect(errors[4]?.column).toBe('amount');
    expect(errors[4]?.message).toContain('শূন্য');
  });

  it('writes every message in Bengali', () => {
    for (const error of errors) expect(/[ঀ-৿]/.test(error.message)).toBe(true);
  });
});

describe('buildRows — a date column in the wrong convention', () => {
  const csv = 'Date,Description,Amount\n03/04/2026,A,10.00\n31/01/2026,B,20.00\n';
  const grid = parseDelimited(csv);

  it('rejects only the rows that cannot be read, and names them', () => {
    const { rows, errors } = buildRows(grid, mappingFor(grid), { datePreference: 'MDY' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.date).toBe('2026-03-04');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.lineNumber).toBe(3);
    expect(errors[0]?.message).toContain('মাস/দিন/বছর');
  });

  it('takes both rows once the caller states the right convention', () => {
    const { rows, errors } = buildRows(grid, mappingFor(grid), dmy);
    expect(errors).toEqual([]);
    expect(rows.map((r) => r.date)).toEqual(['2026-04-03', '2026-01-31']);
  });
});

describe('buildRows — debit and credit columns', () => {
  const headers = 'Date,Details,Debit,Credit\n';
  const build = (body: string) => {
    const grid = parseDelimited(headers + body);
    return buildRows(grid, mappingFor(grid), dmy);
  };

  it('treats a dash as an empty cell, which is how banks write nothing', () => {
    const { rows, errors } = build('2026-04-01,Salary,-,"5,000.00"\n');
    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({ amountMinor: 500_000, direction: 'IN' });
  });

  it('treats N/A and nil the same way', () => {
    const { errors } = build('2026-04-01,Salary,N/A,100.00\n2026-04-02,Fee,nil,50.00\n');
    expect(errors).toEqual([]);
  });

  it('rejects a row with money in neither column', () => {
    const { rows, errors } = build('2026-04-01,Nothing here,,\n');
    expect(rows).toHaveLength(0);
    expect(errors[0]?.message).toBe('টাকার পরিমাণ নেই');
  });

  it('nets a row that fills both columns instead of throwing it away', () => {
    // ৳300 in and ৳100 out on one line is ৳200 in. No money is lost either way.
    const { rows } = build('2026-04-01,Partial refund,100.00,300.00\n');
    expect(rows[0]).toMatchObject({ amountMinor: 20_000, direction: 'IN' });
  });

  it('refuses a row where the two columns cancel out exactly', () => {
    /* Nothing moved, and there is no honest direction to file it under. */
    const { rows, errors } = build('2026-04-01,Wash,500.00,500.00\n');
    expect(rows).toHaveLength(0);
    expect(errors[0]?.message).toContain('কোন দিকে');
  });

  it('says which of the two columns it could not read', () => {
    const { errors } = build('2026-04-01,Bad,xyz,\n');
    expect(errors[0]?.column).toBe('debit');
    expect(errors[0]?.message).toContain('ডেবিট');
  });
});

describe('buildRows — mapping problems are reported once, not per row', () => {
  const grid = parseDelimited('Foo,Bar\n1,2\n3,4\n5,6\n');

  it('says the date column is missing, once', () => {
    const { rows, errors } = buildRows(
      grid,
      { amount: { index: 1, header: 'Bar', confidence: 50 } },
      dmy,
    );
    expect(rows).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.column).toBe('date');
  });

  it('says the money column is missing, once', () => {
    const { errors } = buildRows(grid, { date: { index: 0, header: 'Foo', confidence: 50 } }, dmy);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.column).toBe('amount');
  });

  it('says both when both are missing, and still not one per row', () => {
    // Five hundred identical errors would bury the one sentence that matters.
    const { errors } = buildRows(grid, {}, dmy);
    expect(errors).toHaveLength(2);
  });
});

describe('buildRows — other shapes', () => {
  it('skips more than one heading row when told to', () => {
    const grid = parseDelimited(
      'ACME BANK LIMITED,,\nDate,Description,Amount\n2026-05-01,Tea,-20.00\n',
    );
    const mapping = guessMapping(grid[1] ?? []);
    const { rows, errors } = buildRows(grid, mapping, { ...dmy, headerRows: 2 });
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.lineNumber).toBe(3);
  });

  it('accepts a file with a header and nothing else', () => {
    const grid = parseDelimited('Date,Description,Amount\n');
    expect(buildRows(grid, mappingFor(grid), dmy)).toEqual({ rows: [], errors: [] });
  });

  it('leaves the description empty rather than failing when there is no such column', () => {
    const grid = parseDelimited('Date,Amount\n2026-05-01,-20.00\n');
    const { rows, errors } = buildRows(grid, mappingFor(grid), dmy);
    expect(errors).toEqual([]);
    expect(rows[0]?.description).toBe('');
  });

  it('carries a category name through for the API to match', () => {
    const grid = parseDelimited(
      'Date,Description,Category,Amount\n2026-05-01,Bus,যাতায়াত,-30.00\n',
    );
    const { rows } = buildRows(grid, mappingFor(grid), dmy);
    expect(rows[0]?.categoryName).toBe('যাতায়াত');
  });

  it('survives a row that is short a few columns', () => {
    const grid = parseDelimited('Date,Description,Amount\n2026-05-01\n');
    const { rows, errors } = buildRows(grid, mappingFor(grid), dmy);
    expect(rows).toHaveLength(0);
    expect(errors[0]?.column).toBe('amount');
  });

  it('truncates a runaway description instead of rejecting the row', () => {
    // Rejecting somebody's transaction over a long memo would be absurd.
    const long = 'ক'.repeat(900);
    const grid = parseDelimited(`Date,Description,Amount\n2026-05-01,${long},-30.00\n`);
    const { rows } = buildRows(grid, mappingFor(grid), dmy);
    expect(rows[0]?.description).toHaveLength(500);
  });
});

// --- deduplication -----------------------------------------------------------

describe('dedupeKey', () => {
  const base: DedupeSource = {
    date: '2026-01-19',
    direction: 'OUT',
    amountMinor: 125_050,
    reference: 'TRX90042',
    description: 'BKASH SEND MONEY',
  };

  it('is stable for the same row', () => {
    expect(dedupeKey(base)).toBe(dedupeKey({ ...base }));
  });

  it('ignores the description entirely once there is a bank reference', () => {
    /* The bank's own id is unique. If the description mattered too, a portal
     * tidying up its wording would re-post the whole statement. */
    expect(dedupeKey({ ...base, description: 'bKash payment' })).toBe(dedupeKey(base));
  });

  it('falls back to the description when there is no reference', () => {
    const a = { ...base, reference: null };
    expect(dedupeKey(a)).not.toBe(dedupeKey({ ...a, description: 'Something else' }));
  });

  it('reads ৳500 and Tk 500 in a description as the same payment', () => {
    const a: DedupeSource = {
      date: '2026-01-19',
      direction: 'OUT',
      amountMinor: 50_000,
      description: '৳৫০০ BKASH',
    };
    const b: DedupeSource = {
      date: '2026-01-19',
      direction: 'OUT',
      amountMinor: 50_000,
      description: '৳500   bkash',
    };
    expect(dedupeKey(a)).toBe(dedupeKey(b));
  });

  it('separates two rows that differ by a single poisha', () => {
    // ৳500 and ৳500.01 at the same shop on the same day are two visits.
    expect(dedupeKey({ ...base, amountMinor: 125_051 })).not.toBe(dedupeKey(base));
  });

  it('separates money in from money out', () => {
    expect(dedupeKey({ ...base, direction: 'IN' })).not.toBe(dedupeKey(base));
  });

  it('separates two different days', () => {
    expect(dedupeKey({ ...base, date: '2026-01-20' })).not.toBe(dedupeKey(base));
  });

  it('separates the first occurrence from the second', () => {
    expect(dedupeKey(base, 2)).not.toBe(dedupeKey(base, 1));
  });

  it('treats occurrence 1 as the default', () => {
    expect(dedupeKey(base)).toBe(dedupeKey(base, 1));
  });
});

describe('markDuplicates', () => {
  const row = (
    lineNumber: number,
    date: string,
    amountMinor: number,
    direction: 'IN' | 'OUT',
    description: string,
    reference: string | null = null,
  ): ParsedRow => ({
    lineNumber,
    date,
    description,
    amountMinor,
    direction,
    reference,
    categoryName: null,
  });

  const january = [
    row(2, '2026-01-05', 500_000, 'OUT', 'ATM WITHDRAWAL'),
    row(3, '2026-01-07', 6_000_000, 'IN', 'SALARY', 'TRX90011'),
    row(4, '2026-01-19', 125_050, 'OUT', 'BKASH SEND MONEY', 'TRX90042'),
  ];

  it('marks nothing when the books are empty', () => {
    const marked = markDuplicates(january, new Set());
    expect(marked.every((r) => !r.isDuplicate)).toBe(true);
  });

  it('marks everything when the very same file is imported twice', () => {
    const existing = new Set(dedupeKeysFor(january));
    const marked = markDuplicates(january, existing);
    expect(marked.every((r) => r.isDuplicate)).toBe(true);
  });

  it('skips only the overlap when two statements share a fortnight', () => {
    /* January is already in. The user now downloads 15 Jan – 15 Feb. Only the
     * February half should land. */
    const existing = new Set(dedupeKeysFor(january));
    const overlapping = [
      row(2, '2026-01-19', 125_050, 'OUT', 'BKASH SEND MONEY', 'TRX90042'),
      row(3, '2026-02-02', 300_000, 'OUT', 'ELECTRICITY BILL', 'TRX91100'),
      row(4, '2026-02-05', 6_000_000, 'IN', 'SALARY', 'TRX91200'),
    ];
    const marked = markDuplicates(overlapping, existing);
    expect(marked.map((r) => r.isDuplicate)).toEqual([true, false, false]);
  });

  it('keeps both of two genuinely identical purchases on one day', () => {
    /* Two ৳50 cups of tea on the same Tuesday are two transactions with one
     * fingerprint. Dropping the second would quietly lose real money. */
    const tea = [
      row(2, '2026-01-06', 5_000, 'OUT', 'TEA'),
      row(3, '2026-01-06', 5_000, 'OUT', 'TEA'),
    ];
    const marked = markDuplicates(tea, new Set());
    expect(marked.map((r) => r.isDuplicate)).toEqual([false, false]);
    expect(marked[0]?.dedupeKey).not.toBe(marked[1]?.dedupeKey);
  });

  it('skips the first tea and imports the second when the books already have one', () => {
    const tea = [
      row(2, '2026-01-06', 5_000, 'OUT', 'TEA'),
      row(3, '2026-01-06', 5_000, 'OUT', 'TEA'),
    ];
    const existing = new Set(dedupeKeysFor([tea[0] as ParsedRow]));
    const marked = markDuplicates(tea, existing);
    expect(marked.map((r) => r.isDuplicate)).toEqual([true, false]);
  });

  it('skips both once both are in the books', () => {
    // Import the file, then import it again: nothing new the second time.
    const tea = [
      row(2, '2026-01-06', 5_000, 'OUT', 'TEA'),
      row(3, '2026-01-06', 5_000, 'OUT', 'TEA'),
    ];
    const existing = new Set(dedupeKeysFor(tea));
    expect(markDuplicates(tea, existing).map((r) => r.isDuplicate)).toEqual([true, true]);
  });

  it('does not confuse a repeat with an unrelated row of the same amount', () => {
    const existing = new Set(dedupeKeysFor(january));
    const different = [row(2, '2026-01-05', 500_000, 'OUT', 'SHOP PURCHASE')];
    expect(markDuplicates(different, existing)[0]?.isDuplicate).toBe(false);
  });

  it('hands back the key it matched on, for explaining a skip', () => {
    const marked = markDuplicates(january, new Set());
    expect(marked[0]?.dedupeKey).toContain('2026-01-05');
    expect(marked[0]?.dedupeKey).toContain('#1');
  });

  it('leaves the rest of the row untouched', () => {
    const marked = markDuplicates(january, new Set());
    expect(marked[1]?.lineNumber).toBe(3);
    expect(marked[1]?.reference).toBe('TRX90011');
  });

  it('numbers occurrences in file order, so the same file always dedupes the same way', () => {
    const tea = [
      row(2, '2026-01-06', 5_000, 'OUT', 'TEA'),
      row(3, '2026-01-06', 5_000, 'OUT', 'TEA'),
      row(4, '2026-01-06', 5_000, 'OUT', 'TEA'),
    ];
    const keys = markDuplicates(tea, new Set()).map((r) => r.dedupeKey);
    expect(new Set(keys).size).toBe(3);
    expect(dedupeKeysFor(tea)).toEqual(keys);
  });
});

describe('dedupeKeysFor', () => {
  const rows: DedupeSource[] = [
    { date: '2026-01-06', direction: 'OUT', amountMinor: 5_000, description: 'TEA' },
    { date: '2026-01-06', direction: 'OUT', amountMinor: 5_000, description: 'TEA' },
    { date: '2026-01-07', direction: 'IN', amountMinor: 6_000_000, reference: 'TRX90011' },
  ];

  it('numbers repeats and leaves unique rows at #1', () => {
    const keys = dedupeKeysFor(rows);
    expect(keys[0]?.endsWith('#1')).toBe(true);
    expect(keys[1]?.endsWith('#2')).toBe(true);
    expect(keys[2]?.endsWith('#1')).toBe(true);
  });

  it('produces exactly the keys markDuplicates will look for', () => {
    /* The two sides of the comparison must be built by the same code. Two
     * hand-rolled copies of the rule would drift, and the first symptom would
     * be a double-booked month. */
    const marked = markDuplicates(rows, new Set());
    expect(marked.map((r) => r.dedupeKey)).toEqual(dedupeKeysFor(rows));
  });
});

// --- the export/import seam --------------------------------------------------

describe('a file this workspace exported, imported back in', () => {
  /* The API writes the CSV; core reads it. This is the one place the two halves
   * of M6 meet, and it is the property that lets somebody pull a month into a
   * spreadsheet, fix forty categories by hand, and put it straight back.
   *
   * The escaping below mirrors `ExportService` exactly: formula guard first,
   * then quote anything that needs it, amounts as plain decimals with no
   * grouping separators.
   */
  const FORMULA_TRIGGERS = ['=', '+', '-', '@', '\t', '\r'];

  const field = (value: string): string => {
    let text = value;
    if (text !== '' && FORMULA_TRIGGERS.includes(text.charAt(0))) text = `'${text}`;
    return /["\n\r,;\t]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  const takaPlain = (minor: number): string =>
    `${Math.trunc(Math.abs(minor) / 100)}.${String(Math.abs(minor) % 100).padStart(2, '0')}`;

  const line = (cells: readonly string[]): string => cells.map(field).join(',');

  const exported =
    BOM +
    [
      line(OUR_EXPORT_HEADERS),
      line([
        '2026-01-19',
        'BKASH, SEND MONEY',
        'যাতায়াত',
        'ব্র্যাক ব্যাংক',
        '',
        takaPlain(125_050),
        'TRX90042',
        'EXPENSE',
        '',
      ]),
      line([
        '2026-01-07',
        'SALARY "JANUARY"',
        'বেতন',
        'ব্র্যাক ব্যাংক',
        takaPlain(6_000_000),
        '',
        'TRX90011',
        'INCOME',
        '',
      ]),
      line([
        '2026-01-22',
        '=cmd|/c calc',
        'অন্যান্য',
        'ব্র্যাক ব্যাংক',
        '',
        takaPlain(30_000),
        '',
        'EXPENSE',
        '',
      ]),
    ].join('\r\n') +
    '\r\n';

  const grid = parseDelimited(exported);
  const mapping = guessMapping(grid[0] ?? []);
  const { rows, errors } = buildRows(grid, mapping, dmy);

  it('comes back with every row and no complaints', () => {
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(3);
  });

  it('recovers the amounts to the poisha, both directions', () => {
    expect(rows[0]).toMatchObject({ amountMinor: 125_050, direction: 'OUT' });
    expect(rows[1]).toMatchObject({ amountMinor: 6_000_000, direction: 'IN' });
  });

  it('recovers the description through the comma and the quotes', () => {
    expect(rows[0]?.description).toBe('BKASH, SEND MONEY');
    expect(rows[1]?.description).toBe('SALARY "JANUARY"');
  });

  it('recovers the reference and the Bengali category name', () => {
    expect(rows[0]?.reference).toBe('TRX90042');
    expect(rows[0]?.categoryName).toBe('যাতায়াত');
  });

  it('leaves the formula guard as harmless text rather than reviving it', () => {
    /* The export prefixed an apostrophe so Excel would not run this. Reading it
     * back keeps the apostrophe: a defused payee stays defused, and no import
     * ever turns a guarded cell back into a live formula. */
    expect(rows[2]?.description).toBe("'=cmd|/c calc");
  });
});

// --- end to end --------------------------------------------------------------

describe('a statement imported twice over', () => {
  /* The whole pipeline, the way the API drives it: parse, guess, build, dedupe.
   * This is the case the module exists to get right. */
  const grid = parseDelimited(BANK_STATEMENT);
  const mapping = guessMapping(grid[0] ?? []);
  const dateColumn = grid.slice(1).map((r) => r[mapping.date?.index ?? 0] ?? '');
  const preference = guessDatePreference(dateColumn);
  const { rows } = buildRows(grid, mapping, { datePreference: preference.preference });

  it('works out day-first from the file itself', () => {
    expect(preference).toMatchObject({ preference: 'DMY', confident: true });
  });

  it('lands all four rows the first time', () => {
    const marked = markDuplicates(rows, new Set());
    expect(marked.filter((r) => !r.isDuplicate)).toHaveLength(4);
  });

  it('lands none of them the second time', () => {
    const booked = new Set(dedupeKeysFor(rows));
    const marked = markDuplicates(rows, booked);
    expect(marked.filter((r) => !r.isDuplicate)).toHaveLength(0);
  });

  it('still lands a genuinely new row alongside the repeats', () => {
    const booked = new Set(dedupeKeysFor(rows));
    const withNewRow: ParsedRow[] = [
      ...rows,
      {
        lineNumber: 6,
        date: '2026-01-25',
        description: 'ELECTRICITY BILL',
        amountMinor: 300_000,
        direction: 'OUT',
        reference: 'TRX90099',
        categoryName: null,
      },
    ];
    const marked = markDuplicates(withNewRow, booked);
    expect(marked.filter((r) => !r.isDuplicate).map((r) => r.reference)).toEqual(['TRX90099']);
  });
});
