import { describe, expect, it } from 'vitest';
import {
  accountTypeFromWallet,
  migrationFromCsv,
  migrationToCsv,
  suggestNonCategory,
  type MigrationRow,
} from './migration.js';

/**
 * The spreadsheet round trip, and the two guesses that save somebody scrolling.
 *
 * The point of these is not that CSV can be written — it is that a file which
 * has been through Excel, on Windows, with Bengali names in it, comes back
 * meaning the same thing. Every case below is one of the ways that fails.
 */

const ROWS: MigrationRow[] = [
  {
    kind: 'ACCOUNT',
    sourceId: 'a-1',
    name: 'বিকাশ',
    usageCount: 412,
    decision: 'CREATE',
    targetType: 'MOBILE_WALLET',
    mergeInto: '',
    note: 'General, BDT',
  },
  {
    kind: 'CATEGORY',
    sourceId: 'c-1',
    name: 'Public transport, যাতায়াত',
    usageCount: 88,
    decision: 'MERGE',
    targetType: '',
    mergeInto: 'যাতায়াত',
    note: 'Transportation',
  },
  {
    kind: 'CATEGORY',
    sourceId: 'c-2',
    name: 'DPS "Sonali"',
    usageCount: 24,
    decision: 'SAVINGS',
    targetType: '',
    mergeInto: '',
    note: 'Investments',
  },
];

describe('the migration spreadsheet', () => {
  it('survives the trip out and back', () => {
    const parsed = migrationFromCsv(migrationToCsv(ROWS));
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toEqual(ROWS);
  });

  it('leads with a BOM, so Excel on Windows does not mangle the Bengali', () => {
    /* Without it Excel reads UTF-8 as the local code page and every name in the
       file becomes mojibake — and the names are the only reason somebody opens
       it. */
    expect(migrationToCsv(ROWS).startsWith('\uFEFF')).toBe(true);
  });

  it('keeps a comma and a quote inside a name intact', () => {
    /* `Public transport, যাতায়াত` has a comma; `DPS "Sonali"` has quotes. Either
       one unescaped shifts every later column by a field, and the decision
       column is what ends up wrong. */
    const parsed = migrationFromCsv(migrationToCsv(ROWS));
    expect(parsed.rows[1]?.name).toBe('Public transport, যাতায়াত');
    expect(parsed.rows[2]?.name).toBe('DPS "Sonali"');
    expect(parsed.rows[1]?.decision).toBe('MERGE');
  });

  it('reads the columns by name, so an added one changes nothing', () => {
    /* Somebody will add a column of their own notes in Excel. Reading by
       position would make that file import garbage. */
    const csv = [
      'note,decision,sourceId,kind,name,mine',
      'Transportation,SKIP,c-9,CATEGORY,Something,my own note',
    ].join('\n');
    const parsed = migrationFromCsv(csv);
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows[0]).toMatchObject({ sourceId: 'c-9', decision: 'SKIP', kind: 'CATEGORY' });
  });

  it('refuses a decision it does not recognise, and says which line', () => {
    /* The alternative is defaulting it — and a row that quietly does the wrong
       thing in a batch of two hundred is one nobody ever finds. */
    const csv = ['kind,sourceId,decision', 'CATEGORY,c-1,MAYBE'].join('\n');
    const parsed = migrationFromCsv(csv);
    expect(parsed.rows).toEqual([]);
    expect(parsed.errors[0]).toContain('লাইন 2');
    expect(parsed.errors[0]).toContain('MAYBE');
  });

  it('says which columns are missing rather than importing nothing quietly', () => {
    const parsed = migrationFromCsv(['name,usageCount', 'Something,4'].join('\n'));
    expect(parsed.errors[0]).toContain('kind');
    expect(parsed.errors[0]).toContain('decision');
  });

  it('takes the file back with Windows line endings', () => {
    const csv = 'kind,sourceId,decision\r\nCATEGORY,c-1,SKIP\r\n';
    expect(migrationFromCsv(csv).rows).toHaveLength(1);
  });
});

describe('the account type guess', () => {
  it('maps the types that matter', () => {
    /* `SavingAccount` and `Loan` are the two worth testing: getting them wrong
       puts a DPS in the spending report and a car loan among the assets, and
       both hide for a year because the totals still add up. */
    expect(accountTypeFromWallet('SavingAccount')).toBe('SAVINGS');
    expect(accountTypeFromWallet('Loan')).toBe('LIABILITY');
    expect(accountTypeFromWallet('CreditCard')).toBe('CREDIT_CARD');
    expect(accountTypeFromWallet('Cash')).toBe('CASH');
    expect(accountTypeFromWallet('General')).toBe('BANK');
    expect(accountTypeFromWallet('CurrentAccount')).toBe('BANK');
    expect(accountTypeFromWallet('Investment')).toBe('ASSET');
  });

  it('falls back to a bank account for anything new', () => {
    expect(accountTypeFromWallet('SomethingWalletAddedLater')).toBe('BANK');
    expect(accountTypeFromWallet(null)).toBe('BANK');
  });
});

describe('the savings and insurance guess', () => {
  it('spots the ones that were never categories', () => {
    expect(suggestNonCategory('DPS Sonali Bank')).toBe('SAVINGS');
    expect(suggestNonCategory('মাসিক সঞ্চয়')).toBe('SAVINGS');
    expect(suggestNonCategory('Life insurance premium')).toBe('INSURANCE');
    expect(suggestNonCategory('বীমা')).toBe('INSURANCE');
  });

  it('says nothing about an ordinary category', () => {
    /* Deliberately narrow. A suggestion costs one correction when wrong, and a
       rule that guessed freely would have somebody accepting a page of them. */
    expect(suggestNonCategory('খাবার ও বাজার')).toBeNull();
    expect(suggestNonCategory('Public transport')).toBeNull();
    expect(suggestNonCategory('Groceries')).toBeNull();
  });
});
