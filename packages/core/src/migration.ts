/**
 * Bringing another product's chart of accounts across.
 *
 * ## The two hard parts, and they are both about people rather than data
 *
 * Pulling twenty accounts and two hundred categories out of an API is a loop.
 * What makes a migration succeed or get abandoned halfway is the two decisions
 * this module exists to support:
 *
 * **Which of these two hundred categories are actually categories.** Wallet had
 * no concept of a savings plan or an insurance policy, so a DPS became a
 * category and stayed one for years. Creating all two hundred here would take a
 * usable chart of accounts and make it unusable. So every row carries a
 * decision, and two of the five choices create something that is not a category
 * at all.
 *
 * **Which ones are worth deciding about.** Sorted by how many records used
 * them, because a category with four hundred entries deserves a minute and one
 * with two does not — and a list of two hundred in arbitrary order is a list
 * nobody finishes.
 *
 * ## Why the spreadsheet round trip
 *
 * Two hundred decisions are faster in a column in Excel than in two hundred web
 * form controls, and the person already knows which of these are their savings
 * plans. So the same rows go out as CSV and come back with a `decision` column
 * filled in. Everything here is written to survive that trip: the source id is
 * the key, the decision is a word rather than a code, and an unrecognised value
 * is refused with the row number rather than silently defaulted.
 */

/** What to do with one row. */
export const MIGRATION_DECISIONS = [
  /** Make it what it says it is. */
  'CREATE',
  /** Fold it into something that already exists here. */
  'MERGE',
  /** It was never a category — it is a savings plan. */
  'SAVINGS',
  /** …or an insurance policy. */
  'INSURANCE',
  /**
   * …or money owed, which is not a spending head at all.
   *
   * A policy loan, a car loan, a balance carried on a card the other product
   * had no account for — recorded there as a category because a category was
   * the only shape available. Left as one, every repayment reads as an expense
   * and the debt itself appears nowhere on the balance sheet.
   */
  'LIABILITY',
  /** Leave it behind. */
  'SKIP',
] as const;
export type MigrationDecision = (typeof MIGRATION_DECISIONS)[number];

export const MIGRATION_KINDS = ['ACCOUNT', 'CATEGORY'] as const;
export type MigrationKind = (typeof MIGRATION_KINDS)[number];

/**
 * Wallet's account types, mapped to this product's.
 *
 * A suggestion the person overrides, not a rule. The two that matter are
 * `SavingAccount` and `Loan`: getting those wrong puts a DPS in the spending
 * report and a car loan in the assets, and both are the kind of error that
 * hides for a year because the total still adds up.
 */
const WALLET_ACCOUNT_TYPES: Record<string, string> = {
  Cash: 'CASH',
  General: 'BANK',
  CurrentAccount: 'BANK',
  CreditCard: 'CREDIT_CARD',
  SavingAccount: 'SAVINGS',
  Investment: 'ASSET',
  Loan: 'LIABILITY',
};

/** `BANK` when the source says something nobody has seen before. */
export function accountTypeFromWallet(sourceType: string | null | undefined): string {
  if (!sourceType) return 'BANK';
  return WALLET_ACCOUNT_TYPES[sourceType] ?? 'BANK';
}

/**
 * Whether a category name looks like a savings plan or an insurance policy.
 *
 * Only ever a *suggestion* on the review screen — the person answers, and this
 * is what saves them scrolling to find the eight rows worth changing among two
 * hundred. It is deliberately narrow: a false suggestion costs one correction,
 * and a rule that guessed freely would have somebody accepting a page of them.
 */
export function suggestNonCategory(name: string): MigrationDecision | null {
  const text = name.toLowerCase();

  /* Two expressions per language, because `\b` is an ASCII word boundary and
     matches nothing useful beside a Bengali letter — `\bসঞ্চয়\b` never fires.
     The Latin half keeps its boundaries so `dps` does not match inside a longer
     word; the Bengali half is a plain substring, which is safe here because
     none of these syllables sit inside an unrelated word. */
  if (/\b(dps|deposit pension|savings? scheme|fdr|sanchay)\b/i.test(text)) return 'SAVINGS';
  if (/সঞ্চয়|সন্চয়|ডিপিএস/.test(name)) return 'SAVINGS';

  if (/\b(insurance|premium|policy|takaful)\b/i.test(text)) return 'INSURANCE';
  if (/বীমা|বিমা/.test(name)) return 'INSURANCE';

  return null;
}

import {
  detailFromCells,
  detailToCells,
  MIGRATION_DETAIL_COLUMNS,
  type MigrationDetail,
} from './migration-detail.js';

/** One row of the spreadsheet, in the order the columns appear. */
export interface MigrationRow {
  kind: MigrationKind;
  sourceId: string;
  name: string;
  usageCount: number;
  decision: MigrationDecision;
  /** For an account: the `AccountType`. Empty for a category. */
  targetType: string;
  /** For `MERGE`: the name of the row here to fold into. */
  mergeInto: string;
  /** Whatever the source said about it, for a person deciding later. */
  note: string;
  /** The card days, the DPS instalment — only where the row raises them. */
  detail?: MigrationDetail | null;
}

export const MIGRATION_CSV_COLUMNS = [
  'kind',
  'sourceId',
  'name',
  'usageCount',
  'decision',
  'targetType',
  'mergeInto',
  'note',
  /* Last, and empty on most rows: they are only asked of credit cards, savings
     plans and policies, and a person scrolling the file should meet the
     decision columns first. */
  ...MIGRATION_DETAIL_COLUMNS,
] as const;

/** U+FEFF. A literal one in the source is an invisible character in a diff. */
const BOM = '\uFEFF';
const BOM_AT_START = /^\uFEFF/;

/** One CSV cell, quoted only when it has to be. */
function cell(value: string | number): string {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * The rows as a spreadsheet.
 *
 * A UTF-8 BOM leads, because Excel on Windows reads a BOM-less UTF-8 file as
 * the local code page and turns every Bengali name into mojibake — and the
 * names are the whole reason somebody opens this file.
 */
export function migrationToCsv(rows: readonly MigrationRow[]): string {
  const header = MIGRATION_CSV_COLUMNS.join(',');
  const body = rows.map((row) =>
    [
      row.kind,
      row.sourceId,
      row.name,
      row.usageCount,
      row.decision,
      row.targetType,
      row.mergeInto,
      row.note,
      ...detailToCells(row.detail ?? null),
    ]
      .map(cell)
      .join(','),
  );
  return `${BOM}${[header, ...body].join('\n')}\n`;
}

export interface CsvParseResult {
  rows: MigrationRow[];
  /** Human-readable, with the line number, for a person fixing a spreadsheet. */
  errors: string[];
}

/** Split one CSV line, honouring quotes and doubled quotes inside them. */
function splitLine(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out;
}

/**
 * The spreadsheet, back.
 *
 * Refuses rather than guesses. A `decision` nobody recognises is reported with
 * its line number and its value, because the alternative — defaulting it to
 * `SKIP` or `CREATE` — is a row that quietly does the wrong thing in a batch of
 * two hundred, and the person has no way to find it afterwards.
 *
 * Unknown columns are ignored and column order is read from the header, so a
 * spreadsheet somebody has added a note column to still imports.
 */
export function migrationFromCsv(text: string): CsvParseResult {
  const clean = text.replace(BOM_AT_START, '').replace(/\r\n/g, '\n').trim();
  if (!clean) return { rows: [], errors: ['ফাইলটি খালি'] };

  const lines = clean.split('\n');
  const header = splitLine(lines[0] as string).map((h) => h.trim());
  const index = (name: string): number => header.indexOf(name);

  const missing = ['kind', 'sourceId', 'decision'].filter((c) => index(c) === -1);
  if (missing.length > 0) {
    return { rows: [], errors: [`কলাম পাওয়া যায়নি: ${missing.join(', ')}`] };
  }

  const rows: MigrationRow[] = [];
  const errors: string[] = [];

  for (let i = 1; i < lines.length; i += 1) {
    const raw = lines[i] as string;
    if (!raw.trim()) continue;
    const cells = splitLine(raw);
    const at = (name: string): string => (cells[index(name)] ?? '').trim();

    const kind = at('kind').toUpperCase() as MigrationKind;
    const decision = at('decision').toUpperCase() as MigrationDecision;

    if (!MIGRATION_KINDS.includes(kind)) {
      errors.push(`লাইন ${i + 1}: kind চেনা যায়নি — "${at('kind')}"`);
      continue;
    }
    if (!MIGRATION_DECISIONS.includes(decision)) {
      errors.push(`লাইন ${i + 1}: decision চেনা যায়নি — "${at('decision')}"`);
      continue;
    }
    if (!at('sourceId')) {
      errors.push(`লাইন ${i + 1}: sourceId খালি`);
      continue;
    }

    rows.push({
      kind,
      sourceId: at('sourceId'),
      name: at('name'),
      usageCount: Number(at('usageCount')) || 0,
      decision,
      targetType: at('targetType'),
      mergeInto: at('mergeInto'),
      note: at('note'),
      detail: detailFromCells(at),
    });
  }

  return { rows, errors };
}

/**
 * A chart of accounts somebody typed themselves.
 *
 * The other entry point. `migrationFromCsv` reads a file this product produced,
 * so every row already carries the id it had in the source; a person moving in
 * from a bank statement, a notebook or a product with no API has no such id and
 * should not be asked to invent one.
 *
 * So `sourceId` is optional here and filled in from the row's position, and
 * `decision` defaults to `CREATE` — the only two differences. Everything else,
 * including the detail columns, is read exactly as it is above.
 *
 * `name` is the one column that cannot be missing: a row with no name is not a
 * row, and creating "নামহীন খাত" fourteen times helps nobody.
 */
export function migrationStartFromCsv(text: string): CsvParseResult {
  const clean = text.replace(BOM_AT_START, '').replace(/\r\n/g, '\n').trim();
  if (!clean) return { rows: [], errors: ['ফাইলটি খালি'] };

  const lines = clean.split('\n');
  const header = splitLine(lines[0] as string).map((h) => h.trim());
  const index = (name: string): number => header.indexOf(name);

  if (index('name') === -1) {
    return { rows: [], errors: ['কলাম পাওয়া যায়নি: name'] };
  }

  const rows: MigrationRow[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  for (let i = 1; i < lines.length; i += 1) {
    const raw = lines[i] as string;
    if (!raw.trim()) continue;
    const cells = splitLine(raw);
    const at = (name: string): string => (cells[index(name)] ?? '').trim();

    const name = at('name');
    if (!name) {
      errors.push(`লাইন ${i + 1}: নাম খালি`);
      continue;
    }

    /* Default `CATEGORY`, because a list somebody types is nearly always their
       spending headings — accounts are few and they name them deliberately. */
    const kindText = at('kind').toUpperCase();
    const kind = (
      MIGRATION_KINDS.includes(kindText as MigrationKind) ? kindText : 'CATEGORY'
    ) as MigrationKind;

    const decisionText = at('decision').toUpperCase();
    if (decisionText && !MIGRATION_DECISIONS.includes(decisionText as MigrationDecision)) {
      errors.push(`লাইন ${i + 1}: decision চেনা যায়নি — "${at('decision')}"`);
      continue;
    }
    const decision = (decisionText || 'CREATE') as MigrationDecision;

    /* The row's own id if it has one, otherwise its position — which is stable
       for one file and unique within it, and that is all a staging key needs. */
    const sourceId = at('sourceId') || `row-${i}`;
    const key = `${kind}:${sourceId}`;
    if (seen.has(key)) {
      errors.push(`লাইন ${i + 1}: "${sourceId}" আগেও এসেছে`);
      continue;
    }
    seen.add(key);

    rows.push({
      kind,
      sourceId,
      name,
      usageCount: Number(at('usageCount')) || 0,
      decision,
      targetType: at('targetType'),
      mergeInto: at('mergeInto'),
      note: at('note'),
      detail: detailFromCells(at),
    });
  }

  return { rows, errors };
}

/**
 * The file to hand somebody who has never seen this screen.
 *
 * A blank template teaches nothing: the columns that matter here are the ones
 * whose *values* are not obvious — that `decision` takes one of five words,
 * that a DPS is not a category, that a credit card's two dates are what make a
 * reminder possible at all. So the sample is filled in, one row per case, and
 * the cases are ordered the way somebody meets them.
 *
 * It is deliberately importable as it stands. Whatever is demonstrated here has
 * to keep working, which is why a test round-trips this exact file through the
 * parser rather than trusting that it looks right.
 */
export function sampleMigrationRows(): MigrationRow[] {
  return [
    {
      kind: 'ACCOUNT',
      sourceId: 'a-1',
      name: 'ব্র্যাক ব্যাংক সেভিংস',
      usageCount: 0,
      decision: 'CREATE',
      targetType: 'BANK',
      mergeInto: '',
      note: 'ধরন: BANK, CASH, MOBILE_WALLET, CREDIT_CARD, SAVINGS, ASSET, LIABILITY',
      detail: null,
    },
    {
      kind: 'ACCOUNT',
      sourceId: 'a-2',
      name: 'বিকাশ',
      usageCount: 0,
      decision: 'CREATE',
      targetType: 'MOBILE_WALLET',
      mergeInto: '',
      note: '',
      detail: null,
    },
    {
      kind: 'ACCOUNT',
      sourceId: 'a-3',
      name: 'সিটি ব্যাংক ক্রেডিট কার্ড',
      usageCount: 0,
      decision: 'CREATE',
      targetType: 'CREDIT_CARD',
      mergeInto: '',
      /* The one row whose extra columns are the whole point: without both days
         there is no bill reminder, and nothing else on the screen says so. */
      note: 'কার্ড হলে statementDay ও dueDay দিন — না দিলে বিলের রিমাইন্ডার হবে না',
      detail: { statementDay: 20, dueDay: 8, reminderLeadDays: 3 },
    },
    {
      kind: 'ACCOUNT',
      sourceId: 'a-4',
      name: 'হাতের নগদ',
      usageCount: 0,
      decision: 'MERGE',
      targetType: 'CASH',
      mergeInto: 'নগদ',
      note: 'আগে থেকে থাকা অ্যাকাউন্টের নাম mergeInto-তে লিখুন',
      detail: null,
    },
    {
      kind: 'CATEGORY',
      sourceId: 'c-1',
      name: 'খাবার ও বাজার',
      usageCount: 0,
      decision: 'CREATE',
      targetType: 'EXPENSE',
      mergeInto: '',
      note: 'খাতের ধরন: EXPENSE বা INCOME',
      detail: null,
    },
    {
      kind: 'CATEGORY',
      sourceId: 'c-2',
      name: 'বেতন',
      usageCount: 0,
      decision: 'CREATE',
      targetType: 'INCOME',
      mergeInto: '',
      note: '',
      detail: null,
    },
    {
      kind: 'CATEGORY',
      sourceId: 'c-3',
      name: 'সোনালী ডিপিএস',
      usageCount: 0,
      decision: 'SAVINGS',
      targetType: '',
      mergeInto: '',
      note: 'ডিপিএস বা এফডিআর খাত নয় — SAVINGS দিলে সঞ্চয় প্ল্যান তৈরি হবে',
      detail: {
        installmentMinor: 1_000_000,
        termMonths: 60,
        profitRateBps: 950,
        startDate: '2025-01-15',
      },
    },
    {
      kind: 'CATEGORY',
      sourceId: 'c-4',
      name: 'জীবন বীমা',
      usageCount: 0,
      decision: 'INSURANCE',
      targetType: '',
      mergeInto: '',
      note: 'বীমাও খাত নয় — INSURANCE দিলে পলিসি তৈরি হবে',
      detail: { premiumMinor: 350_000, sumAssuredMinor: 50_000_000, termMonths: 240 },
    },
    {
      kind: 'CATEGORY',
      sourceId: 'c-5',
      name: 'গাড়ির ঋণ',
      usageCount: 0,
      decision: 'LIABILITY',
      targetType: '',
      mergeInto: '',
      note: 'যে টাকা আপনি দেবেন — LIABILITY দিলে দায়ের অ্যাকাউন্ট তৈরি হবে, খাত নয়',
      detail: null,
    },
    {
      kind: 'CATEGORY',
      sourceId: 'c-6',
      name: 'পুরনো একটা খাত',
      usageCount: 0,
      decision: 'SKIP',
      targetType: 'EXPENSE',
      mergeInto: '',
      note: 'SKIP দিলে এই সারিটা আনা হবে না',
      detail: null,
    },
  ];
}

/** The sample, as the file a person downloads. */
export function sampleMigrationCsv(): string {
  return migrationToCsv(sampleMigrationRows());
}
