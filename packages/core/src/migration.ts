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
    });
  }

  return { rows, errors };
}
