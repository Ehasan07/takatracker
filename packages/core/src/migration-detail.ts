/**
 * The facts the other product never held.
 *
 * ## Why this is filled in on the draft
 *
 * Wallet had no concept of a savings plan, so a DPS lived there as a category
 * with a name and nothing else — no instalment, no term, no rate. A credit card
 * was an account with a balance; when its statement closes and when the bill
 * falls due were never anywhere.
 *
 * Those are exactly the fields this product needs to do the things it exists to
 * do: remind somebody a card is due, project what a DPS matures to. Creating the
 * rows first and asking afterwards would mean a plan sitting in the books with
 * an invented twelve-month term, indistinguishable from a real one, until
 * somebody happened to look. So the questions are asked before anything is
 * created, and only of the rows that raise them — 28 rows out of 320 in the
 * migration this was built for.
 *
 * ## Everything here is optional
 *
 * A person who does not know their DPS rate today should still be able to
 * finish the migration. Missing fields mean the entity is created with what is
 * known and the screen keeps saying it is incomplete; they do not block. What
 * is never done is inventing one.
 */

import { parseMoneyToMinor } from '@hishab/shared';

/** Which questions a row raises, if any. */
export type DetailKind = 'CARD' | 'SAVINGS' | 'INSURANCE';

/* `null` and absent mean the same thing — not known — because the sheet clears
   a field by sending null and the spreadsheet clears it by leaving it blank.
   Every check below is a truthiness check for exactly that reason. */
export interface MigrationDetail {
  // --- credit card: what the reminder needs
  /** 1–31. The day the statement closes. */
  statementDay?: number | null;
  /** 1–31. The day the bill must be paid by. */
  dueDay?: number | null;
  /** How many days before the due date to say something. */
  reminderLeadDays?: number | null;

  // --- savings plan
  /** One instalment, in poisha. */
  installmentMinor?: number | null;
  /** A lump sum — an FDR or a Sanchayapatra — in poisha. */
  principalMinor?: number | null;
  termMonths?: number | null;
  /** Basis points: 9.5% is 950. The person types the rate their bank prints. */
  profitRateBps?: number | null;

  // --- insurance policy
  premiumMinor?: number | null;
  sumAssuredMinor?: number | null;

  /** Both plans and policies. `YYYY-MM-DD`. */
  startDate?: string | null;
}

/**
 * What, if anything, this row still needs to be asked about.
 *
 * A credit card is the only account type that raises questions — a bank account
 * or a wallet needs nothing beyond its name and type.
 */
export function detailKindOf(
  kind: 'ACCOUNT' | 'CATEGORY',
  decision: string,
  targetType: string | null | undefined,
): DetailKind | null {
  if (kind === 'ACCOUNT') {
    return decision === 'CREATE' && targetType === 'CREDIT_CARD' ? 'CARD' : null;
  }
  if (decision === 'SAVINGS') return 'SAVINGS';
  if (decision === 'INSURANCE') return 'INSURANCE';
  return null;
}

/**
 * Whether the questions this row raises have been answered.
 *
 * Deliberately lenient: a card needs both its days to be any use at all, but a
 * plan with an instalment and a term is worth creating even without a rate. The
 * point of the flag is to mark what is still worth a minute, not to gate.
 */
export function detailIsComplete(kind: DetailKind, detail: MigrationDetail | null): boolean {
  if (!detail) return false;
  if (kind === 'CARD') return Boolean(detail.statementDay && detail.dueDay);
  if (kind === 'SAVINGS') {
    return Boolean((detail.installmentMinor || detail.principalMinor) && detail.termMonths);
  }
  return Boolean(detail.premiumMinor || detail.sumAssuredMinor);
}

/* -------------------------------------------------------------------------
 * The spreadsheet columns
 * ---------------------------------------------------------------------- */

/**
 * Written in the units a person types, not the ones the database holds.
 *
 * Money goes out as taka and comes back through `parseMoneyToMinor`, which
 * reads the string form and is exact; the rate goes out as the percentage a
 * bank advertises rather than as basis points. Somebody filling in 28 rows in
 * Excel should be copying figures off a passbook, not converting them.
 */
export const MIGRATION_DETAIL_COLUMNS = [
  'statementDay',
  'dueDay',
  'reminderLeadDays',
  'installment',
  'principal',
  'termMonths',
  'ratePercent',
  'premium',
  'sumAssured',
  'startDate',
] as const;

const dayOrNull = (value: number | null | undefined): string => (value ? String(value) : '');

/** Poisha as a plain decimal, by integer maths. Empty when there is nothing. */
function majorOf(minor: number | null | undefined): string {
  if (!minor) return '';
  const abs = Math.abs(minor);
  return `${minor < 0 ? '-' : ''}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export function detailToCells(detail: MigrationDetail | null): string[] {
  const d = detail ?? {};
  return [
    dayOrNull(d.statementDay),
    dayOrNull(d.dueDay),
    d.reminderLeadDays == null ? '' : String(d.reminderLeadDays),
    majorOf(d.installmentMinor),
    majorOf(d.principalMinor),
    d.termMonths ? String(d.termMonths) : '',
    /* Basis points back to the percentage the bank printed: 950 → 9.5. */
    d.profitRateBps ? String(d.profitRateBps / 100) : '',
    majorOf(d.premiumMinor),
    majorOf(d.sumAssuredMinor),
    d.startDate ?? '',
  ];
}

/**
 * The percentage a bank prints, as basis points — by integer maths on the
 * string.
 *
 * `9.5 * 100` is a float multiplication, and this codebase bans those on
 * anything that ends up stored as an integer for good reason: the same habit
 * that turns `601.66 * 100` into `60165.999…`. Reading the digits either side
 * of the point is exact and needs no rounding at all.
 *
 * More than two decimals is a rate nobody quotes, so the third onwards is
 * ignored rather than rounded — `9.499` is `949`, not `950`.
 */
export function bpsFromPercent(raw: string): number | undefined {
  const text = raw.trim();
  if (!/^\d{1,3}(\.\d+)?$/.test(text)) return undefined;
  const [whole, fraction = ''] = text.split('.');
  const bps = Number(whole) * 100 + Number(fraction.slice(0, 2).padEnd(2, '0'));
  return bps > 0 && bps <= 10_000 ? bps : undefined;
}

/** A whole number inside its range, or undefined. Never a guess. */
function intIn(raw: string, low: number, high: number): number | undefined {
  const value = Number(raw.trim());
  if (!Number.isFinite(value)) return undefined;
  const whole = Math.trunc(value);
  return whole >= low && whole <= high ? whole : undefined;
}

function minorFrom(raw: string): number | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  try {
    const minor = parseMoneyToMinor(text);
    return minor > 0 ? minor : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The detail columns, read back.
 *
 * Anything unreadable is left out rather than defaulted, and returns `null` when
 * nothing at all was filled in — so a spreadsheet that never touched these
 * columns cannot wipe answers already given on the screen.
 */
export function detailFromCells(at: (column: string) => string): MigrationDetail | null {
  const detail: MigrationDetail = {};

  const statementDay = intIn(at('statementDay'), 1, 31);
  if (statementDay) detail.statementDay = statementDay;
  const dueDay = intIn(at('dueDay'), 1, 31);
  if (dueDay) detail.dueDay = dueDay;
  const lead = intIn(at('reminderLeadDays'), 0, 30);
  if (lead !== undefined && at('reminderLeadDays').trim()) detail.reminderLeadDays = lead;

  const installment = minorFrom(at('installment'));
  if (installment) detail.installmentMinor = installment;
  const principal = minorFrom(at('principal'));
  if (principal) detail.principalMinor = principal;
  const term = intIn(at('termMonths'), 1, 600);
  if (term) detail.termMonths = term;

  const rate = bpsFromPercent(at('ratePercent'));
  if (rate) detail.profitRateBps = rate;

  const premium = minorFrom(at('premium'));
  if (premium) detail.premiumMinor = premium;
  const sumAssured = minorFrom(at('sumAssured'));
  if (sumAssured) detail.sumAssuredMinor = sumAssured;

  const startDate = at('startDate').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(startDate)) detail.startDate = startDate;

  return Object.keys(detail).length > 0 ? detail : null;
}
