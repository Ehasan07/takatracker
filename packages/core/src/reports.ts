import { sumMinor, type AccountType, type AssetKind, type TransactionType } from '@hishab/shared';
import { clampDayToMonth } from './card-reminders.js';

/**
 * Report assembly. The database does the grouping; this decides what the groups
 * *mean* — which account is an asset, what counts as cash, how a trend is
 * filled in — because those are the parts worth testing against numbers a human
 * worked out on paper.
 *
 * Pure functions, integer poisha throughout.
 */

export type BalanceClass = 'ASSET' | 'LIABILITY' | 'NOMINAL';

/**
 * Where each account type sits on a balance sheet.
 *
 * EQUITY is nominal: the three hidden system accounts absorb the other side of
 * every entry, so counting them would double everything.
 */
export const ACCOUNT_CLASS: Record<AccountType, BalanceClass> = {
  CASH: 'ASSET',
  BANK: 'ASSET',
  MOBILE_WALLET: 'ASSET',
  SAVINGS: 'ASSET',
  RECEIVABLE: 'ASSET',
  ASSET: 'ASSET',
  CREDIT_CARD: 'LIABILITY',
  PAYABLE: 'LIABILITY',
  LIABILITY: 'LIABILITY',
  EQUITY: 'NOMINAL',
};

/** Money you could spend today, as opposed to land or a receivable. */
export const LIQUID_TYPES: readonly AccountType[] = ['CASH', 'BANK', 'MOBILE_WALLET'];

export interface AccountBalanceRow {
  id: string;
  name: string;
  type: AccountType;
  /** Signed the way a human reads it: positive means the account holds value. */
  balanceMinor: number;
  /**
   * `ASSET` rows only: land, a car, gold, a share account.
   *
   * Optional because most rows are not assets and because the column was added
   * late — a caller that has not been updated still gets a correct sheet, just
   * without the sub-totals.
   */
  assetKind?: AssetKind | null;
}

export interface BalanceSheetLine {
  id: string;
  name: string;
  type: AccountType;
  amountMinor: number;
  assetKind?: AssetKind | null;
}

/**
 * Non-current assets, split the way IAS 1.54 splits them.
 *
 * The standard puts property, plant and equipment on one line and financial
 * investments on another, and it is not a formatting preference: a flat and a
 * share portfolio behave differently, are valued differently, and answer
 * different questions. One combined "সম্পদ" total answers neither.
 *
 * Empty groups are dropped by the caller rather than reported as zero — a
 * household that owns no gold should not read a line saying it owns no gold.
 */
export interface AssetGroup {
  kind: AssetKind;
  amountMinor: number;
  count: number;
}

/**
 * What is owed, folded by the kind of obligation it is.
 *
 * "কত দায় আছে" is one number and three unrelated answers. A credit card is
 * revolving, priced at thirty-odd percent, and settled monthly; a car loan is
 * amortising over years at a rate that was fixed when it was signed; a shop
 * account is neither, and is owed to somebody the household will see again.
 * Somebody deciding what to pay down first cannot use a combined figure, and
 * the combined figure is the only one this application used to give them.
 *
 * `amountMinor` is positive when money is owed, the same way `liabilities` is —
 * see `buildBalanceSheet`. A group is only present when the workspace has an
 * account of that type on the books, so nobody reads a line telling them they
 * have no credit cards.
 */
export interface LiabilityGroup {
  type: AccountType;
  /** Positive means money is owed. Negative would mean the lender owes you. */
  amountMinor: number;
  count: number;
}

/**
 * Money that could be spent today, folded by where it is sitting.
 *
 * The same three types `LIQUID_TYPES` names, and never more: this is a
 * breakdown of `liquidMinor`, so anything that would not have been counted in
 * that total must not appear here either, or the parts would exceed the whole.
 */
export interface LiquidGroup {
  type: AccountType;
  amountMinor: number;
  count: number;
}

export interface BalanceSheet {
  assetsMinor: number;
  liabilitiesMinor: number;
  netWorthMinor: number;
  liquidMinor: number;
  assets: BalanceSheetLine[];
  liabilities: BalanceSheetLine[];
  /**
   * The `ASSET` rows grouped by what they actually are. Present even when the
   * caller supplied no kinds, in which case everything lands under `OTHER`,
   * which is the truthful answer to "what kind is it" when nobody has said.
   */
  assetGroups: AssetGroup[];
  /**
   * What `assetGroups` adds up to, stated rather than left to be summed.
   *
   * Deliberately **not** `nonCurrentAssetsMinor`, which the two agree with only
   * by accident. Non-current is a statement about time and takes in a DPS;
   * this is the total of the `ASSET` rows — the things owned rather than the
   * money held — and it is what the groups are a breakdown *of*. A screen that
   * printed one as the header over the other's rows would be showing a total
   * that its own lines do not reach, which is the single failure a breakdown
   * exists to prevent.
   */
  groupedAssetsMinor: number;
  /** What is owed, folded by kind of obligation. Sums to `liabilitiesMinor`. */
  liabilityGroups: LiabilityGroup[];
  /** What could be spent today, folded by where it sits. Sums to `liquidMinor`. */
  liquidGroups: LiquidGroup[];
  /**
   * The same lines again, split the way IAS 1.60 requires.
   *
   * Current is what turns into cash within a year — money in hand, in a bank, in
   * a wallet, and what somebody owes you. Non-current is what does not: land,
   * gold, a car, a savings scheme with a term on it.
   *
   * This is not presentation fussiness. The dashboard used to add a
   * ৳10,00,000 plot of land to ৳3,600 of cash and call the total a balance, and
   * the reason a balance sheet is *required* to separate the two is exactly that
   * mistake. Both totals are here so a reader never has to add a column to find
   * out what is actually available.
   */
  currentAssetsMinor: number;
  nonCurrentAssetsMinor: number;
  currentLiabilitiesMinor: number;
  nonCurrentLiabilitiesMinor: number;
  /**
   * Current assets less current liabilities: what is left after the next year's
   * obligations. Negative is the signal a lender looks for first.
   */
  workingCapitalMinor: number;
}

/**
 * Which side of the one-year line an account type sits on.
 *
 * `RECEIVABLE` is current and `SAVINGS` is not, which is the one pair worth
 * arguing about. A loan to a relative is expected back in months and is
 * routinely collected on demand; a DPS has a fixed term measured in years and
 * cannot be drawn early without breaking it. Where a particular instrument
 * genuinely disagrees, the honest fix is a field on the account, not a different
 * default here.
 */
export function isCurrent(type: AccountType): boolean {
  switch (type) {
    case 'CASH':
    case 'BANK':
    case 'MOBILE_WALLET':
    case 'RECEIVABLE':
    case 'CREDIT_CARD':
    case 'PAYABLE':
      return true;
    default:
      return false;
  }
}

/**
 * Net worth = assets − liabilities, always with the breakdown (spec §3.6:
 * never a bare number).
 *
 * A liability's balance is negative when money is owed, because the ledger
 * signs every account the same way. The sheet reports what is owed as a
 * positive figure, which is how anyone reads a balance sheet — and then
 * subtracts it.
 */
export function buildBalanceSheet(rows: readonly AccountBalanceRow[]): BalanceSheet {
  const assets: BalanceSheetLine[] = [];
  const liabilities: BalanceSheetLine[] = [];

  for (const row of rows) {
    const line = {
      id: row.id,
      name: row.name,
      type: row.type,
      amountMinor: row.balanceMinor,
      assetKind: row.assetKind ?? null,
    };
    switch (ACCOUNT_CLASS[row.type]) {
      case 'ASSET':
        assets.push(line);
        break;
      case 'LIABILITY':
        liabilities.push({ ...line, amountMinor: -row.balanceMinor });
        break;
      default:
        break; // nominal: already reflected in the accounts above
    }
  }

  const assetsMinor = sumMinor(assets.map((a) => a.amountMinor));
  const liabilitiesMinor = sumMinor(liabilities.map((l) => l.amountMinor));
  const liquidMinor = sumMinor(
    rows.filter((r) => LIQUID_TYPES.includes(r.type)).map((r) => r.balanceMinor),
  );

  const currentAssetsMinor = sumMinor(
    assets.filter((a) => isCurrent(a.type)).map((a) => a.amountMinor),
  );
  const currentLiabilitiesMinor = sumMinor(
    liabilities.filter((l) => isCurrent(l.type)).map((l) => l.amountMinor),
  );

  const assetGroups = groupAssets(assets);

  return {
    assetsMinor,
    liabilitiesMinor,
    netWorthMinor: assetsMinor - liabilitiesMinor,
    liquidMinor,
    currentAssetsMinor,
    nonCurrentAssetsMinor: assetsMinor - currentAssetsMinor,
    currentLiabilitiesMinor,
    nonCurrentLiabilitiesMinor: liabilitiesMinor - currentLiabilitiesMinor,
    workingCapitalMinor: currentAssetsMinor - currentLiabilitiesMinor,
    assets: assets.sort((a, b) => b.amountMinor - a.amountMinor),
    liabilities: liabilities.sort((a, b) => b.amountMinor - a.amountMinor),
    assetGroups,
    /* Summed from the groups themselves, not from `assets` again. Two routes to
       one figure is two chances to disagree, and the header over a list of
       parts is precisely where a disagreement would be believed. */
    groupedAssetsMinor: sumMinor(assetGroups.map((g) => g.amountMinor)),
    liabilityGroups: groupLiabilities(liabilities),
    liquidGroups: groupLiquid(assets),
  };
}

/**
 * Rows folded by their account type, biggest first, with a count.
 *
 * Shared by the liability and the liquid split because they are the same fold
 * over the same shape, and writing it twice is how the two would eventually
 * come to sort differently or drop an empty group on only one side.
 */
function groupByType<T extends { type: AccountType; amountMinor: number }>(
  lines: readonly T[],
): { type: AccountType; amountMinor: number; count: number }[] {
  const totals = new Map<AccountType, { amountMinor: number; count: number }>();

  for (const line of lines) {
    const current = totals.get(line.type) ?? { amountMinor: 0, count: 0 };
    totals.set(line.type, {
      amountMinor: current.amountMinor + line.amountMinor,
      count: current.count + 1,
    });
  }

  return [...totals.entries()]
    .map(([type, value]) => ({ type, ...value }))
    .sort((a, b) => b.amountMinor - a.amountMinor);
}

/**
 * The liability lines folded into kinds of debt.
 *
 * Takes the lines `buildBalanceSheet` has already flipped to positive rather
 * than the raw rows, so a group can never disagree in sign with the line it was
 * built from. Every liability line lands in exactly one group and none is
 * dropped, which is what makes the groups sum to `liabilitiesMinor`.
 */
export function groupLiabilities(lines: readonly BalanceSheetLine[]): LiabilityGroup[] {
  return groupByType(lines);
}

/**
 * The liquid part of the asset lines, folded by where the money sits.
 *
 * The filter is `LIQUID_TYPES` — the same list `liquidMinor` is summed over —
 * so these groups add up to that total exactly. A DPS is an asset and is not
 * money you can spend this afternoon, which is the whole distinction, and the
 * one thing that must not leak into this list.
 */
export function groupLiquid(lines: readonly BalanceSheetLine[]): LiquidGroup[] {
  return groupByType(lines.filter((line) => LIQUID_TYPES.includes(line.type)));
}

/**
 * `ASSET` rows folded into their kinds, biggest first.
 *
 * Only `type === 'ASSET'`: a bank balance is an asset and is not the kind of
 * thing IAS 1.54 is asking to be separated out. A row with no kind counts as
 * `OTHER`, which is what "nobody has said" honestly is.
 */
export function groupAssets(lines: readonly BalanceSheetLine[]): AssetGroup[] {
  const totals = new Map<AssetKind, { amountMinor: number; count: number }>();

  for (const line of lines) {
    if (line.type !== 'ASSET') continue;
    const kind: AssetKind = line.assetKind ?? 'OTHER';
    const current = totals.get(kind) ?? { amountMinor: 0, count: 0 };
    totals.set(kind, {
      amountMinor: current.amountMinor + line.amountMinor,
      count: current.count + 1,
    });
  }

  return [...totals.entries()]
    .map(([kind, value]) => ({ kind, ...value }))
    .sort((a, b) => b.amountMinor - a.amountMinor);
}

/**
 * The calendar day after `YYYY-MM-DD`, as a date key.
 *
 * A balance sheet "as at" a day needs that day's *exclusive* upper bound, and
 * the honest way to reach it is the next day's local midnight — not
 * `+86_400_000`, which is only a day where the offset never moves. So the shift
 * happens on the key, in whole days, and the caller turns the key into an
 * instant with `fromLocalDateString`; that is the same two-step
 * `startOfNextMonth` uses, and it stays correct through a DST change.
 *
 * `Date.UTC` normalises the overflow — 2026-01-32 is 2026-02-01, 2026-12-32 is
 * 2027-01-01 — so month ends and year ends need no special case.
 */
export function nextDateKey(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new TypeError(`Expected YYYY-MM-DD, got ${JSON.stringify(date)}`);
  const [, year, month, day] = m;
  const next = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day) + 1));
  return next.toISOString().slice(0, 10);
}

// --- credit card statement periods -------------------------------------------

/**
 * The window one credit-card statement covers.
 *
 * Both ends are date keys in the workspace's own calendar; the caller turns
 * them into instants with `fromLocalDateString`, the same two-step every other
 * dated report on this page uses. The period is **`(previousDate,
 * statementDate]`** — the previous bill's closing balance is this one's
 * opening balance, so the day itself belongs to the earlier statement and
 * counting it twice would overstate every card in the workspace.
 */
export interface StatementPeriod {
  /** The most recent statement day on or before the day asked about. */
  statementDate: string;
  /** The statement day before that one. Exclusive lower bound. */
  previousDate: string;
}

/** `YYYY-MM-DD` from three numbers, zero-padded. */
function dateKey(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * The statement day inside one `YYYY-MM`, clamped to that month's length.
 *
 * `clampDayToMonth` comes from `card-reminders.ts` rather than being written
 * again here, and that is not tidiness: a card billed on the 31st is billed on
 * the 28th in February, and the reminder that goes out and the figure this
 * report shows have to be talking about the same day. Two implementations of
 * one clamp is two answers to "when did February's bill close".
 */
function dayInMonth(monthKey: string, dayOfMonth: number): string {
  const [year, month] = monthKey.split('-').map(Number) as [number, number];
  return dateKey(year, month, clampDayToMonth(year, month, dayOfMonth));
}

/**
 * The statement period in force on `today`, for a card billed on
 * `statementDayOfMonth`.
 *
 * On the statement day itself the bill that closes *that evening* is the
 * current one — a reader looking at their books on the 5th, for a card that
 * cuts on the 5th, is asking about the statement that has just been drawn, not
 * last month's.
 */
export function statementPeriodFor(today: string, statementDayOfMonth: number): StatementPeriod {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(today);
  if (!match) throw new TypeError(`Expected YYYY-MM-DD, got ${JSON.stringify(today)}`);
  const [, year, month, day] = match;

  const thisMonth = `${year}-${month}`;
  const cutThisMonth = clampDayToMonth(Number(year), Number(month), statementDayOfMonth);
  const closed = Number(day) >= cutThisMonth ? thisMonth : shiftMonthKey(thisMonth, -1);

  return {
    statementDate: dayInMonth(closed, statementDayOfMonth),
    previousDate: dayInMonth(shiftMonthKey(closed, -1), statementDayOfMonth),
  };
}

/**
 * The first `dayOfMonth` strictly after `date` — when a bill closed on `date`
 * falls due.
 *
 * Strictly after, because a card whose statement and payment fall on the same
 * day of the month is not asking to be paid the instant the bill is drawn; it
 * is asking a month later. Same clamp as everything else, so a payment due on
 * the 31st is due on the 28th in February.
 */
export function nextDayOfMonthAfter(date: string, dayOfMonth: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new TypeError(`Expected YYYY-MM-DD, got ${JSON.stringify(date)}`);
  const [, year, month, day] = match;

  const thisMonth = `${year}-${month}`;
  const dueThisMonth = clampDayToMonth(Number(year), Number(month), dayOfMonth);
  return dueThisMonth > Number(day)
    ? dateKey(Number(year), Number(month), dueThisMonth)
    : dayInMonth(shiftMonthKey(thisMonth, 1), dayOfMonth);
}

/** The four figures a reader compares between two balance sheets. */
export interface BalanceSheetTotals {
  assetsMinor: number;
  liabilitiesMinor: number;
  netWorthMinor: number;
  liquidMinor: number;
}

/**
 * An earlier balance sheet's totals, and the movement since.
 *
 * The earlier figures ride along rather than only the difference: "নিট সম্পদ
 * ৳১২,০০০ বেড়েছে" is a claim about two numbers, and a screen that has been
 * handed only the delta cannot show what it grew *from* without asking again.
 */
export interface BalanceSheetComparison extends BalanceSheetTotals {
  /** Current minus earlier, line by line. Negative means it went down. */
  changeMinor: BalanceSheetTotals;
  /**
   * Net worth movement as a percentage of the earlier figure, one decimal.
   * `null` when there is nothing to be a percentage of.
   */
  netWorthChangePercent: number | null;
}

/**
 * What moved between two balance sheets. Both must already be built; this does
 * no summing of its own, so the two sides can only disagree if the queries did.
 *
 * The percentage divides by the **absolute** value of the earlier net worth.
 * Signed, a recovery from −৳১০,০০০ to −৳৫,০০০ would read as −50% — the number
 * went up and the label would say it fell. `null` at zero rather than a
 * fabricated 100%: growth from nothing has no percentage, and inventing one
 * puts an infinity on somebody's first month.
 */
export function compareBalanceSheets(
  current: BalanceSheetTotals,
  earlier: BalanceSheetTotals,
): BalanceSheetComparison {
  const changeMinor: BalanceSheetTotals = {
    assetsMinor: current.assetsMinor - earlier.assetsMinor,
    liabilitiesMinor: current.liabilitiesMinor - earlier.liabilitiesMinor,
    netWorthMinor: current.netWorthMinor - earlier.netWorthMinor,
    liquidMinor: current.liquidMinor - earlier.liquidMinor,
  };

  const base = Math.abs(earlier.netWorthMinor);
  return {
    assetsMinor: earlier.assetsMinor,
    liabilitiesMinor: earlier.liabilitiesMinor,
    netWorthMinor: earlier.netWorthMinor,
    liquidMinor: earlier.liquidMinor,
    changeMinor,
    // `Math.floor(x + 0.5)`, not `Math.round`, which is banned repo-wide —
    // same arithmetic as `withShares` so both report the same way.
    netWorthChangePercent:
      base === 0 ? null : Math.floor((changeMinor.netWorthMinor / base) * 1000 + 0.5) / 10,
  };
}

/**
 * Signed effect of one entry on its own account, for cash-flow work.
 * Debits add, credits subtract — see `signedEffect` in `ledger.ts` for why the
 * sign does not depend on the account type.
 */
export function signedEffectFor(
  _type: AccountType,
  direction: 'DEBIT' | 'CREDIT',
  amountMinor: number,
): number {
  return direction === 'DEBIT' ? amountMinor : -amountMinor;
}

// --- trend ------------------------------------------------------------------

export interface MonthTotals {
  month: string; // YYYY-MM
  incomeMinor: number;
  expenseMinor: number;
}

export interface TrendPoint extends MonthTotals {
  netMinor: number;
}

export function shiftMonthKey(month: string, delta: number): string {
  const [year, m] = month.split('-').map(Number) as [number, number];
  const zero = year * 12 + (m - 1) + delta;
  return `${String(Math.floor(zero / 12)).padStart(4, '0')}-${String((zero % 12) + 1).padStart(2, '0')}`;
}

/**
 * A contiguous series ending at `endMonth`. Months with no activity are filled
 * with zeros rather than omitted — a chart that silently skips an empty month
 * draws a straight line across it and invents a trend that never happened.
 */
export function buildTrend(
  rows: readonly MonthTotals[],
  endMonth: string,
  months: number,
): TrendPoint[] {
  const byMonth = new Map(rows.map((r) => [r.month, r]));
  const out: TrendPoint[] = [];

  for (let i = months - 1; i >= 0; i -= 1) {
    const month = shiftMonthKey(endMonth, -i);
    const found = byMonth.get(month);
    const incomeMinor = found?.incomeMinor ?? 0;
    const expenseMinor = found?.expenseMinor ?? 0;
    out.push({ month, incomeMinor, expenseMinor, netMinor: incomeMinor - expenseMinor });
  }

  return out;
}

// --- what was put away -------------------------------------------------------

/**
 * The two kinds of long-term account money can be moved *into*, and the reason
 * they are counted apart.
 *
 * ## Why "সঞ্চয়" is not on the income statement, and cannot be
 *
 * A DPS instalment is not an expense. Nothing is consumed and nobody is owed:
 * ৳2,000 leaves the current account and arrives in the savings account, one
 * asset becoming another. So it is a `TRANSFER`, it never touches a nominal
 * account, and it is therefore invisible to every income-statement figure in
 * this application — correctly. "মাসে সঞ্চয় কত হচ্ছে" is a real question the
 * books can answer and no statement asks: it is a question about *transfers*,
 * and it has to be asked of the ledger directly.
 *
 * ## Why a `SAVINGS` account is সঞ্চয় and an `ASSET` account is not
 *
 * Both are money the household set aside, and folding them into one figure
 * would still be wrong. A DPS instalment is a fixed monetary amount, repeated,
 * redeemable in money at a number the bank already named — it is the thing
 * somebody means by "কত সঞ্চয় হচ্ছে", and a savings rate built on it is
 * comparable from one month to the next. Buying a ৳9,00,000 plot of land is
 * also setting money aside, and putting it on the same line would swamp a
 * ৳2,000 instalment, take the savings rate to 700% in one month and to nothing
 * in the eleven after it, and make the series useless for the only thing a
 * series is for.
 *
 * So the judgement is: **`SAVINGS` is saving, `ASSET` is investing**, they are
 * reported side by side under their own names, and the savings rate is built on
 * the first alone. The second is disclosed rather than hidden, so nobody has to
 * wonder where the land went.
 *
 * There is a mechanical reason for the split too, and it is the stronger one. An
 * `ASSET` account's balance also moves when the gold is revalued, which is not
 * money being put anywhere — see `TRANSACTION_TYPES_NOT_MOVEMENTS`. Measuring
 * "what was put away" as a balance movement would count that; measuring it as
 * the entries on the account, with remeasurements excluded, does not.
 */
export type SavingsVehicle = 'SAVINGS' | 'INVESTMENT';

/** Which of the two, or neither. Nothing else can receive সঞ্চয়. */
export function savingsVehicleOf(type: AccountType): SavingsVehicle | null {
  switch (type) {
    case 'SAVINGS':
      return 'SAVINGS';
    case 'ASSET':
      return 'INVESTMENT';
    default:
      return null;
  }
}

/**
 * Transactions that change what a savings account holds without anybody having
 * put anything into it. Excluded from every figure below.
 *
 * `OPENING_BALANCE` is the whole reason this list exists. Somebody who starts
 * keeping books today enters a DPS that already holds ৳2,00,000; without this
 * exclusion their first month reads "আপনি এই মাসে ২ লাখ টাকা সঞ্চয় করেছেন",
 * which is the single most confidently wrong sentence this report could print.
 * An opening balance is the recognition of what was already there, not an act
 * of saving.
 *
 * `REVALUATION` is the same argument on the investing side: gold going up
 * ৳50,000 is the world moving, not the household setting anything aside, and no
 * money changed hands at all.
 *
 * `ADJUSTMENT` is deliberately **not** here. A correction changes what the books
 * say is in the account, and a সঞ্চয় figure that quietly ignored corrections
 * would stop agreeing with the balance it is supposed to explain.
 */
export const TRANSACTION_TYPES_NOT_MOVEMENTS: readonly TransactionType[] = [
  'OPENING_BALANCE',
  'REVALUATION',
];

/** One ledger entry on a savings or investment account. `amountMinor` is positive. */
export interface VehicleEntryRow {
  accountId: string;
  name: string;
  type: AccountType;
  direction: 'DEBIT' | 'CREDIT';
  amountMinor: number;
}

/**
 * What one instrument took in and gave back over a period.
 *
 * `netMinor` is `inMinor − outMinor` and is the only one of the three that can
 * be negative — a month where a DPS was broken into shows ৳0 in, ৳60,000 out
 * and −৳60,000 net, and the panel that prints it must not drop the sign.
 */
export interface VehicleFlow {
  accountId: string;
  name: string;
  type: AccountType;
  vehicle: SavingsVehicle;
  /** Money that arrived, always positive. */
  inMinor: number;
  /** Money that left, always positive. */
  outMinor: number;
  netMinor: number;
}

/**
 * A period's saving, its investing, and the instruments behind each.
 *
 * `savings` sums to `savedMinor` exactly and `investments` to `investedMinor`,
 * for the same reason the balance sheet's groups sum to their headings: both
 * sides are built here, in one pass, from one list. Nothing downstream re-adds
 * anything.
 */
export interface SavingsFlow {
  /** Net into every `SAVINGS` account. Negative when more came out than went in. */
  savedMinor: number;
  /** Net into every `ASSET` account. Never folded into `savedMinor`. */
  investedMinor: number;
  savings: VehicleFlow[];
  investments: VehicleFlow[];
}

/**
 * Fold ledger entries on the long-term accounts into what each held on to.
 *
 * ## The three things this has to get right
 *
 * **A transfer between two savings accounts is not new saving.** Moving
 * ৳50,000 from one DPS to another debits the second and credits the first, so
 * the two contribute +50,000 and −50,000 and the total is zero. That falls out
 * of summing *signed* effects rather than counting deposits, which is why the
 * arithmetic is written this way round and not as "add up everything that
 * arrived". The two instruments still show their own movement on their own row,
 * which is the truth: one of them gained and the other lost.
 *
 * **Money coming back out is dis-saving.** A withdrawal credits the account and
 * reduces the figure. A report that only counted deposits would tell somebody
 * who emptied their savings to pay for a wedding that they saved ৳2,000 that
 * month.
 *
 * **Profit the bank adds to the balance is saving.** It arrives as an `INCOME`
 * transaction debiting the savings account, so it lands in আয় and in সঞ্চয়
 * both — which is exactly right: it was earned, and it was kept.
 *
 * Rows arrive one per account and direction, the shape an aggregate produces.
 * An account that only ever took money in has no credit row and gets
 * `outMinor: 0` rather than being absent.
 */
export function buildSavingsFlow(rows: readonly VehicleEntryRow[]): SavingsFlow {
  const byAccount = new Map<string, VehicleFlow>();

  for (const row of rows) {
    const vehicle = savingsVehicleOf(row.type);
    if (!vehicle) continue;

    const found = byAccount.get(row.accountId) ?? {
      accountId: row.accountId,
      name: row.name,
      type: row.type,
      vehicle,
      inMinor: 0,
      outMinor: 0,
      netMinor: 0,
    };
    if (row.direction === 'DEBIT') found.inMinor += row.amountMinor;
    else found.outMinor += row.amountMinor;
    found.netMinor = found.inMinor - found.outMinor;
    byAccount.set(row.accountId, found);
  }

  /* Biggest net first, so the instrument that took the most money this month is
     the first line read. A withdrawal therefore sorts to the bottom, which is
     where somebody scanning for "what did I put away" expects it. */
  const all = [...byAccount.values()].sort((a, b) => b.netMinor - a.netMinor);
  const savings = all.filter((flow) => flow.vehicle === 'SAVINGS');
  const investments = all.filter((flow) => flow.vehicle === 'INVESTMENT');

  return {
    savedMinor: sumMinor(savings.map((flow) => flow.netMinor)),
    investedMinor: sumMinor(investments.map((flow) => flow.netMinor)),
    savings,
    investments,
  };
}

/**
 * How much of what came in was put away, in basis points. 25% is 2500.
 *
 * `null`, never zero, when there was no income. A month with no income and
 * ৳5,000 put away out of savings from December is not a month with a 0% savings
 * rate — it is a month the question cannot be asked of, and printing 0% would
 * be an answer to a question nobody asked. The screen prints a dash.
 *
 * Negative is a real answer and is returned as one: a month that took ৳10,000
 * out of a DPS against ৳40,000 of income is −2500, "সঞ্চয় থেকে ভাঙানো হয়েছে",
 * and rounding it to zero would hide the only month worth noticing. Over 10,000
 * is real too — savings can be fed from cash already in hand.
 *
 * `Math.trunc`, not `Math.round`, which is banned repo-wide: the same integer
 * arithmetic `IncomeStatementFigures.savingsRateBps` uses, so the two rates on
 * this product round identically.
 */
export function savingsRateBps(savedMinor: number, incomeMinor: number): number | null {
  if (incomeMinor <= 0) return null;
  return Math.trunc((savedMinor * 10_000) / incomeMinor);
}

/** One month of the four figures, before the gaps are filled in. */
export interface MonthlySavingsTotals extends MonthTotals {
  savedMinor: number;
  investedMinor: number;
}

/**
 * A month on the সঞ্চয় trend: what came in, what went out, what was put away,
 * and the two figures derived from them.
 */
export interface SavingsTrendPoint extends MonthlySavingsTotals {
  /** Income less expenses — what was *not* spent, which is not what was saved. */
  surplusMinor: number;
  /** `savedMinor ÷ incomeMinor`. Null in a month with no income. */
  savingsRateBps: number | null;
}

/**
 * A contiguous series ending at `endMonth`, zero-filled.
 *
 * The sibling of `buildTrend` and gap-filled for the same reason: a chart that
 * silently skips an empty month draws a straight line across it and invents a
 * saving habit that never happened. Kept separate rather than widening
 * `buildTrend`, because the income-and-expense chart is drawn from a query that
 * knows nothing about savings accounts and must not start carrying null
 * columns for them.
 */
export function buildSavingsTrend(
  rows: readonly MonthlySavingsTotals[],
  endMonth: string,
  months: number,
): SavingsTrendPoint[] {
  const byMonth = new Map(rows.map((r) => [r.month, r]));
  const out: SavingsTrendPoint[] = [];

  for (let i = months - 1; i >= 0; i -= 1) {
    const month = shiftMonthKey(endMonth, -i);
    const found = byMonth.get(month);
    const incomeMinor = found?.incomeMinor ?? 0;
    const expenseMinor = found?.expenseMinor ?? 0;
    const savedMinor = found?.savedMinor ?? 0;
    out.push({
      month,
      incomeMinor,
      expenseMinor,
      savedMinor,
      investedMinor: found?.investedMinor ?? 0,
      surplusMinor: incomeMinor - expenseMinor,
      savingsRateBps: savingsRateBps(savedMinor, incomeMinor),
    });
  }

  return out;
}

// --- category breakdown ------------------------------------------------------

export interface CategoryTotal {
  categoryId: string | null;
  name: string;
  totalMinor: number;
  /** Set on a sub-category so a roll-up can name a parent that has no spending. */
  parentName?: string;
}

export interface CategoryShare extends CategoryTotal {
  /** Percentage of the period's total, to one decimal, as a number. */
  sharePercent: number;
}

/**
 * Sorted largest first, with each slice's share of the whole. Shares are
 * computed from integer poisha and only become a percentage at the end, so no
 * rounding error creeps into the amounts themselves.
 */
export function withShares(rows: readonly CategoryTotal[]): CategoryShare[] {
  const total = sumMinor(rows.map((r) => r.totalMinor));
  return rows
    .slice()
    .sort((a, b) => b.totalMinor - a.totalMinor)
    .map((row) => ({
      ...row,
      sharePercent: total === 0 ? 0 : Math.floor((row.totalMinor / total) * 1000 + 0.5) / 10,
    }));
}

export interface CategoryNode extends CategoryTotal {
  /** The parent's own total plus every child's. */
  rolledUpMinor: number;
  children: CategoryTotal[];
}

/**
 * Fold sub-category totals into their parent.
 *
 * Categories are two levels deep on purpose: deeper nesting makes a report
 * unreadable and a picker unusable on a phone. A report therefore shows parents
 * by default — "যাতায়াত ৳৪,০০০" rather than four separate lines — and the
 * children are there to expand into.
 *
 * A transaction may sit on either level, so a parent's own total is kept
 * separate from the rolled-up figure; losing that distinction would make
 * "যাতায়াত" look like it had no direct spending of its own.
 */
export function rollUpToParents(
  rows: readonly CategoryTotal[],
  parentOf: ReadonlyMap<string, string | null>,
): CategoryNode[] {
  const byId = new Map<string, CategoryNode>();
  const orphans: CategoryTotal[] = [];

  const nodeFor = (row: CategoryTotal): CategoryNode => {
    const id = row.categoryId!;
    const existing = byId.get(id);
    if (existing) return existing;
    const created: CategoryNode = { ...row, rolledUpMinor: row.totalMinor, children: [] };
    byId.set(id, created);
    return created;
  };

  // Parents first, so a child never creates a stub that loses the real name.
  for (const row of rows) {
    if (row.categoryId && !parentOf.get(row.categoryId)) nodeFor(row);
  }

  for (const row of rows) {
    if (!row.categoryId) {
      orphans.push(row);
      continue;
    }
    const parentId = parentOf.get(row.categoryId);
    if (!parentId) continue; // already added above

    const parent = byId.get(parentId);
    if (!parent) {
      /* The parent had no spending of its own, so it is not in `rows`. It still
       * has to appear, or its children's money would vanish from the report. */
      const stub: CategoryNode = {
        categoryId: parentId,
        name: row.parentName ?? 'অন্যান্য',
        totalMinor: 0,
        rolledUpMinor: 0,
        children: [],
      };
      byId.set(parentId, stub);
    }
    const target = byId.get(parentId)!;
    target.children.push(row);
    target.rolledUpMinor += row.totalMinor;
  }

  const nodes = [...byId.values()].map((n) => ({
    ...n,
    children: n.children.slice().sort((a, b) => b.totalMinor - a.totalMinor),
  }));

  for (const orphan of orphans) {
    nodes.push({ ...orphan, rolledUpMinor: orphan.totalMinor, children: [] });
  }

  return nodes.sort((a, b) => b.rolledUpMinor - a.rolledUpMinor);
}

/** The n largest, with everything else folded into one "অন্যান্য" line. */
export function topWithRest(
  rows: readonly CategoryTotal[],
  n: number,
  restLabel = 'অন্যান্য',
): CategoryTotal[] {
  const sorted = rows.slice().sort((a, b) => b.totalMinor - a.totalMinor);
  if (sorted.length <= n) return sorted;

  const head = sorted.slice(0, n);
  const restTotal = sumMinor(sorted.slice(n).map((r) => r.totalMinor));
  if (restTotal === 0) return head;
  return [...head, { categoryId: null, name: restLabel, totalMinor: restTotal }];
}

// --- cash flow ---------------------------------------------------------------

export interface CashFlowInput {
  openingMinor: number;
  inflowMinor: number;
  outflowMinor: number;
}

export interface CashFlow extends CashFlowInput {
  netMinor: number;
  closingMinor: number;
}

/**
 * Opening plus what came in, minus what went out. The closing figure must equal
 * the account balance at the end of the period; a mismatch means an entry was
 * missed, so this is the report that catches a broken query.
 */
export function buildCashFlow(input: CashFlowInput): CashFlow {
  const netMinor = input.inflowMinor - input.outflowMinor;
  return { ...input, netMinor, closingMinor: input.openingMinor + netMinor };
}
