import { sumMinor } from '@hishab/shared';

/**
 * Money lent to people and money borrowed from them.
 *
 * The loan *movements* live in the ordinary double-entry ledger (schema.prisma
 * §Loan): a loan owns a RECEIVABLE or PAYABLE control account and every
 * disbursement or repayment is a plain transfer. So this module deliberately
 * holds no balances of its own — it answers the questions the ledger cannot:
 *
 *  1. **What is actually owed?** Interest is an agreement between two people,
 *     so the *terms* are the only place it can be derived from. Where a rate was
 *     agreed it is also posted, month by month, by `interestAccrualSchedule`
 *     below — the derivation stays the single source of the figure and the
 *     ledger is brought up to it, never the other way round.
 *  2. **How far along is this loan?** A progress ring and a status badge, from
 *     the payments and the calendar.
 *  3. **What does the statement read like?** Opening balance, dated rows with a
 *     running balance, closing balance — the way a bank statement reads, so the
 *     closing figure can be checked against the control account.
 *
 * Every amount is an integer number of poisha; rates are basis points
 * (825 = 8.25%) so the input stays an integer too. Floats appear only inside a
 * single interest expression and are truncated back to poisha immediately.
 *
 * Dates are read by their **local calendar day**, not by the instant: a loan
 * taken at 3pm and looked at at 9am the next morning is one day old, not
 * three-quarters of one. Callers pass dates already in the user's own frame,
 * which is what both the web app and the API do.
 */

export type LoanDirection = 'LENT' | 'BORROWED';
export type LoanInterestType = 'NONE' | 'FIXED' | 'PERCENT';
export type LoanStatus = 'ACTIVE' | 'COMPLETED' | 'OVERDUE' | 'CANCELLED';

export interface LoanTerms {
  principalMinor: number;
  interestType: LoanInterestType;
  /** Agreed lump sum of interest, poisha. Used when interestType is FIXED. */
  interestMinor: number;
  /** Annual rate in basis points (825 = 8.25%). Used when interestType is PERCENT. */
  interestRateBps: number;
  loanDate: Date;
  dueDate: Date | null;
}

/**
 * Simple interest is quoted per year, and a year here is 365 days flat.
 *
 * No 360-day banker's year and no leap-year adjustment: this is a household
 * loan between two people, and "৳১০,০০০ a year on a lakh" has to come out as
 * exactly ৳10,000 after exactly a year or the borrower will not accept the
 * number.
 */
const DAYS_PER_YEAR = 365;

const MS_PER_DAY = 86_400_000;

/** Poisha in, poisha out: never let a fractional poisha into a money value. */
function toMinor(value: number): number {
  return Math.trunc(value);
}

/** Local midnight of the calendar day `date` falls on. */
function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

/** Local midnight of the last calendar day of the month `date` falls in. */
function endOfLocalMonth(date: Date): Date {
  // Day 0 of the next month is the last day of this one, whatever its length.
  return new Date(date.getFullYear(), date.getMonth() + 1, 0, 0, 0, 0, 0);
}

/** `days` calendar days after local midnight of `date`. */
function addLocalDays(date: Date, days: number): Date {
  const moved = startOfLocalDay(date);
  moved.setDate(moved.getDate() + days);
  return moved;
}

/**
 * Whole calendar days from `from` to `to`, negative when `to` is earlier.
 *
 * Both ends are collapsed to local midnight first, so the time of day never
 * leaks into a day count. The nearest-day rounding is for timezones with
 * daylight saving, where a day can be 23 or 25 hours long and a plain division
 * would report 23 hours as zero days. (Written without `Math.round`: the lint
 * rule banning it exists to keep floats out of money, and this is days.)
 */
function wholeDaysBetween(from: Date, to: Date): number {
  const span = startOfLocalDay(to).getTime() - startOfLocalDay(from).getTime();
  return Math.floor(span / MS_PER_DAY + 0.5);
}

/**
 * Interest owed over the whole life of the loan, poisha.
 *
 * - `NONE` is zero, and it is the default: most household lending in Bangladesh
 *   carries no interest at all, and inventing some would be a lie about what
 *   two people agreed.
 * - `FIXED` is the agreed lump sum, owed in full from day one. It does not
 *   accrue, so `asOf` cannot change it — that is the whole point of agreeing a
 *   flat "৳২,০০০ extra" instead of a rate.
 * - `PERCENT` is **simple** interest over the elapsed time, never compounded.
 *   Nobody lending to a cousin compounds monthly, and compounding on a loan
 *   that is repaid late would run away from a figure either side recognises.
 *   It also **stops accruing at the due date**: past the agreed date the debt
 *   is a fixed sum being chased, not a balance that keeps growing forever.
 */
export function loanInterestMinor(terms: LoanTerms, asOf: Date): number {
  if (terms.interestType === 'NONE') return 0;
  if (terms.interestType === 'FIXED') return toMinor(terms.interestMinor);

  if (terms.principalMinor <= 0 || terms.interestRateBps <= 0) return 0;

  /* Freeze the clock at the due date when there is one. With no due date the
   * loan is open-ended and interest keeps running. */
  const until = terms.dueDate && asOf.getTime() > terms.dueDate.getTime() ? terms.dueDate : asOf;

  const days = wholeDaysBetween(terms.loanDate, until);
  if (days <= 0) return 0; // asked about a date before the money changed hands

  /* One division at the very end keeps this exact for household sums: poisha ×
   * bps × days stays far inside the safe-integer range, so ৳100,000 at 10% for
   * exactly 365 days lands on ৳10,000.00 rather than a poisha short of it. The
   * float fallback is only there so an absurd input degrades instead of
   * silently losing precision in the integer product. */
  const product = terms.principalMinor * terms.interestRateBps * days;
  const accrued = Number.isSafeInteger(product)
    ? product / (10_000 * DAYS_PER_YEAR)
    : terms.principalMinor * (terms.interestRateBps / 10_000) * (days / DAYS_PER_YEAR);

  return toMinor(accrued);
}

/** Principal + interest, poisha. */
export function totalPayableMinor(terms: LoanTerms, asOf: Date): number {
  return sumMinor([toMinor(terms.principalMinor), loanInterestMinor(terms, asOf)]);
}

// --- accrual -------------------------------------------------------------------

/** One period of interest to post: what it runs to, and what it is worth. */
export interface InterestAccrual {
  /**
   * The local calendar day this period runs to. It is also the idempotence key
   * — one accrual per loan per through-date, and never a second one for a day
   * already covered.
   */
  throughDate: Date;
  /** Poisha to post for this period. Never negative. */
  amountMinor: number;
}

export interface AccrualState {
  /** Interest for this loan already recognised in the books, poisha. */
  postedMinor: number;
  /** The latest day already accrued, or null when nothing has been. */
  accruedThrough: Date | null;
  /**
   * Do not accrue past this day. The monthly sweep passes the end of the last
   * *complete* month; a repayment passes its own date, so the interest it is
   * about to settle is in the books before the money moves.
   */
  upTo: Date;
}

/**
 * Guards against a loan dated 1926 by a slipped finger spinning out a thousand
 * periods. The last cut is always the ceiling, so hitting the cap folds the
 * remainder into one entry rather than losing any of it.
 */
const MAX_ACCRUAL_PERIODS = 600;

/**
 * The interest periods still to be posted, oldest first.
 *
 * **The arithmetic does not change here — only where the result lands.** Every
 * amount below is `loanInterestMinor` at the end of the period less what the
 * books already hold, so the ledger is pulled up to the derived figure and can
 * never disagree with the loan card printed beside it.
 *
 * Three things make it safe to run this repeatedly, which is the whole problem
 * an accrual has to solve:
 *
 *  1. **The amount is a difference, not an addition.** Post a period, feed the
 *     new total back in as `postedMinor`, and the same period computes zero.
 *     A sweep that runs twice in a month posts once because the second run has
 *     nothing left to post, before any database constraint is consulted.
 *  2. **`accruedThrough` is a watermark**, the local-date equivalent of the
 *     `YYYY-MM-DD` stamp the card and renewal reminders use. A period already
 *     covered is never offered again.
 *  3. **Each period is named by the day it runs to**, so the caller has a
 *     natural unique key to enforce (2) in the database as well.
 *
 * Month ends are the cuts, so a balance sheet dated any month end in the past
 * shows the interest that had actually been earned by then. Catching up eleven
 * months posts eleven dated entries rather than one lump dated today, because
 * one lump would make every historical balance sheet wrong in order to make
 * today's right.
 *
 * Two clocks stop it, both borrowed from `loanInterestMinor` rather than
 * reinvented: nothing is earned before the money changed hands, and nothing is
 * earned past the due date. `interestType === 'NONE'` — most household lending
 * here — produces no periods at all, and so touches the books never.
 */
export function interestAccrualSchedule(terms: LoanTerms, state: AccrualState): InterestAccrual[] {
  // The interest-free case is the common one, and it is exactly zero.
  if (terms.interestType === 'NONE') return [];

  const loanDay = startOfLocalDay(terms.loanDate);
  const dueDay = terms.dueDate ? startOfLocalDay(terms.dueDate) : null;
  const requested = startOfLocalDay(state.upTo);

  /* Past the due date the debt is a fixed sum being chased, not a balance that
   * keeps growing — the same freeze `loanInterestMinor` applies, applied here
   * too so the schedule simply ends instead of emitting empty months forever. */
  const ceiling = dueDay && requested.getTime() > dueDay.getTime() ? dueDay : requested;
  if (ceiling.getTime() < loanDay.getTime()) return [];

  const after = state.accruedThrough ? addLocalDays(state.accruedThrough, 1) : loanDay;
  const start = after.getTime() > loanDay.getTime() ? after : loanDay;
  if (start.getTime() > ceiling.getTime()) return [];

  /* Every month end from where we left off, then the ceiling itself. When the
   * ceiling *is* a month end the loop stops one short of it and the push below
   * supplies it, so no day is ever cut twice. */
  const cuts: Date[] = [];
  let cursor = endOfLocalMonth(start);
  while (cursor.getTime() < ceiling.getTime() && cuts.length < MAX_ACCRUAL_PERIODS) {
    cuts.push(cursor);
    cursor = endOfLocalMonth(addLocalDays(cursor, 1));
  }
  cuts.push(ceiling);

  let posted = state.postedMinor;
  const schedule: InterestAccrual[] = [];

  for (const throughDate of cuts) {
    const earned = loanInterestMinor(terms, throughDate);
    /* Clamped at zero. Editing a loan's rate downwards can leave the books
     * holding more interest than the terms now justify, and quietly reversing
     * somebody's income on a schedule is a bigger decision than a sweep should
     * make on its own. The period is still reported so the watermark advances
     * and the sweep does not reconsider it every hour. */
    const amountMinor = Math.max(0, earned - posted);
    posted += amountMinor;
    schedule.push({ throughDate, amountMinor });
  }

  return schedule;
}

export interface LoanProgress {
  totalPayableMinor: number;
  paidMinor: number;
  outstandingMinor: number;
  /** 0–100, one decimal place. */
  percentPaid: number;
  paymentCount: number;
  /** Negative when the due date is still ahead; 0 when there is no due date. */
  daysOverdue: number;
  isSettled: boolean;
}

export interface LoanPaymentInput {
  amountMinor: number;
  /**
   * When the money changed hands. Optional only so a caller that genuinely has
   * no dates still works; supply it whenever you have it, because without dates
   * a `PERCENT` loan cannot know when it was cleared.
   */
  date?: Date;
}

/**
 * The day the debt was cleared, or null if it never was.
 *
 * Walks the repayments in date order and asks, at each one, whether the money
 * paid so far covers what was owed *on that day*. The first payment that does
 * is the settlement.
 *
 * This exists because interest must stop when the debt is cleared, and a naive
 * `interest as of today` does not: a loan settled in full on Sunday would grow
 * a fresh day of interest on Monday, flip back to ACTIVE, and start demanding
 * money the borrower does not owe. Freezing at the due date is not enough —
 * most loans are repaid before it.
 *
 * Exported because the API and the web app both need the same frozen date — one
 * to stamp the interest charge row on the statement, the other to render the
 * same progress. Two copies of this rule would drift, and the first symptom
 * would be a statement disagreeing with the summary printed above it.
 */
export function settlementDate(
  terms: LoanTerms,
  payments: readonly LoanPaymentInput[],
): Date | null {
  const dated = payments.filter((p): p is Required<LoanPaymentInput> => p.date instanceof Date);
  if (dated.length !== payments.length || dated.length === 0) return null;

  const inOrder = [...dated].sort((a, b) => a.date.getTime() - b.date.getTime());
  let running = 0;
  for (const payment of inOrder) {
    running += payment.amountMinor;
    if (running >= totalPayableMinor(terms, payment.date)) return payment.date;
  }
  return null;
}

/**
 * Everything a loan card needs: what is left, how far along it is, how late.
 *
 * `payments` are the recorded repayments only. The disbursement is not one of
 * them — it is the thing being repaid.
 */
export function summariseLoan(
  terms: LoanTerms,
  payments: readonly LoanPaymentInput[],
  asOf: Date,
): LoanProgress {
  /* Interest stops on the day the debt was cleared, not today. See
   * `settlementDate` — without this a repaid PERCENT loan quietly reopens. */
  const settled = settlementDate(terms, payments);
  const total = totalPayableMinor(terms, settled ?? asOf);
  const paidMinor = sumMinor(payments.map((p) => p.amountMinor));

  /* Outstanding never goes below zero. Someone rounding a final instalment up —
   * paying ৳5,000 to clear ৳4,970 — is normal and generous, and showing the
   * lender "-৳30 outstanding" would read as a debt owed back the other way.
   * The overpayment is simply not a receivable; if it has to be returned that
   * is a new movement, not a negative balance. */
  const outstandingMinor = Math.max(0, total - paidMinor);
  const isSettled = outstandingMinor === 0;

  /* A loan with nothing payable is complete by definition, so the ring shows
   * full rather than empty — an empty ring beside a COMPLETED badge reads as a
   * bug. Everything else is paid ÷ payable, clamped so an overpayment cannot
   * push the ring past the end. */
  const percentPaid =
    total <= 0 ? 100 : Math.min(100, Math.floor((paidMinor / total) * 1000 + 0.5) / 10);

  /* Zero once the loan is settled: a debt that has been cleared is not late,
   * however long it took, and a badge shouting "৪৫ দিন পার" at a finished loan
   * is just wrong. Zero too when no date was ever agreed — with no deadline
   * there is nothing to be late for. */
  const daysOverdue =
    terms.dueDate === null || isSettled ? 0 : wholeDaysBetween(terms.dueDate, asOf);

  return {
    totalPayableMinor: total,
    paidMinor,
    outstandingMinor,
    percentPaid,
    paymentCount: payments.length,
    daysOverdue,
    isSettled,
  };
}

/**
 * Derives the status; never returns CANCELLED (that is a user action, not
 * arithmetic — a cancelled loan is one the two people called off, which no
 * amount of counting can discover).
 *
 * Settled wins over overdue: a loan repaid three weeks late is COMPLETED, not
 * OVERDUE. The list is for chasing people, and a finished loan is nobody to chase.
 */
export function deriveLoanStatus(progress: LoanProgress): Exclude<LoanStatus, 'CANCELLED'> {
  if (progress.isSettled) return 'COMPLETED';
  if (progress.daysOverdue > 0) return 'OVERDUE';
  return 'ACTIVE';
}

// --- statement ---------------------------------------------------------------

export interface StatementRow {
  date: Date;
  description: string;
  /** Exactly one of debitMinor / creditMinor is non-zero. */
  debitMinor: number;
  creditMinor: number;
  balanceMinor: number;
}

export interface StatementInput {
  date: Date;
  description: string;
  /** Positive increases what is owed, negative reduces it. */
  deltaMinor: number;
}

/**
 * Turns dated movements into a statement with a running balance, the way an
 * account statement reads: opening balance, every row, closing balance.
 *
 * Two deliberate choices:
 *
 *  1. **Rows are sorted by date**, oldest first. A running balance down an
 *     unsorted list is meaningless. The sort is stable, so several movements on
 *     the same day keep the order they were given in — usually insertion order,
 *     which is the only tie-break the data actually carries.
 *  2. **Every addition goes through `sumMinor`**, which throws on a non-integer.
 *     A statement whose closing figure is a poisha off the control account is
 *     the bug this catches, and it is better caught loudly here than eyeballed
 *     later in a PDF.
 */
export function buildStatement(
  openingMinor: number,
  movements: readonly StatementInput[],
): { openingMinor: number; rows: StatementRow[]; closingMinor: number } {
  let balance = sumMinor([openingMinor]);
  const rows: StatementRow[] = [];

  const ordered = movements.slice().sort((a, b) => a.date.getTime() - b.date.getTime());

  for (const movement of ordered) {
    balance = sumMinor([balance, movement.deltaMinor]);
    rows.push({
      date: movement.date,
      description: movement.description,
      /* A statement has two money columns and a movement lands in exactly one of
       * them. A zero movement — rare, but it happens with a correction that
       * cancels out — sits in neither rather than printing a misleading ৳0.00
       * debit. */
      debitMinor: movement.deltaMinor > 0 ? movement.deltaMinor : 0,
      creditMinor: movement.deltaMinor < 0 ? -movement.deltaMinor : 0,
      balanceMinor: balance,
    });
  }

  return { openingMinor, rows, closingMinor: balance };
}

// --- date presets -------------------------------------------------------------

export type DatePreset = 'today' | 'yesterday' | 'last7' | 'thisMonth' | 'lastMonth' | 'thisYear';

function dayStart(year: number, monthIndex: number, day: number): Date {
  return new Date(year, monthIndex, day, 0, 0, 0, 0);
}

function dayEnd(year: number, monthIndex: number, day: number): Date {
  return new Date(year, monthIndex, day, 23, 59, 59, 999);
}

/**
 * Inclusive local-date bounds for a preset, for the statement filter chips.
 *
 * Whole days, always: `from` at 00:00:00.000 and `to` at 23:59:59.999, so a
 * transaction recorded at 11pm is inside "আজ" instead of falling through the
 * gap that a midnight-to-midnight range leaves.
 *
 * The arithmetic is done on local calendar components rather than by adding
 * milliseconds, because "one month back" is not a fixed number of hours and
 * "yesterday" across a daylight-saving change is not 24 hours earlier.
 *
 * Two readings the names settle:
 *
 *  - `last7` is the last seven days **including today** — six days back plus
 *    today — which is what a chip labelled "গত ৭ দিন" means to the person
 *    tapping it.
 *  - `thisMonth` and `thisYear` are the **whole** calendar period, not
 *    month-to-date. Every named period is its full self; the days still to come
 *    simply have nothing in them yet, which is the honest answer.
 */
export function presetRange(preset: DatePreset, today: Date): { from: Date; to: Date } {
  const y = today.getFullYear();
  const m = today.getMonth();
  const d = today.getDate();

  switch (preset) {
    case 'today':
      return { from: dayStart(y, m, d), to: dayEnd(y, m, d) };
    case 'yesterday':
      // Day 0 of a month rolls back into the previous one, so this is safe on the 1st.
      return { from: dayStart(y, m, d - 1), to: dayEnd(y, m, d - 1) };
    case 'last7':
      return { from: dayStart(y, m, d - 6), to: dayEnd(y, m, d) };
    case 'thisMonth':
      // Day 0 of the next month is the last day of this one, whatever its length.
      return { from: dayStart(y, m, 1), to: dayEnd(y, m + 1, 0) };
    case 'lastMonth':
      // Month -1 in January is December of the year before; the constructor rolls it.
      return { from: dayStart(y, m - 1, 1), to: dayEnd(y, m, 0) };
    case 'thisYear':
      return { from: dayStart(y, 0, 1), to: dayEnd(y, 11, 31) };
    default:
      /* Presets arrive from a URL query string, so an unknown one is a real
       * possibility and a silent fallback to "today" would quietly show the
       * wrong statement. */
      throw new TypeError(`Unknown date preset: ${JSON.stringify(preset)}`);
  }
}

// --- loan numbers --------------------------------------------------------------

const LOAN_NUMBER_PATTERN = /^L-(\d+)$/i;

/**
 * Formats the next loan number from the highest existing one: 'L-0007'.
 *
 * The highest, not the count: loans get deleted, and numbering from the count
 * would hand out L-0007 twice and collide with the `(workspaceId, loanNumber)`
 * unique index. Gaps are fine — a numbered document that has been voided leaves
 * a gap in every paper ledger too.
 *
 * Anything that does not look like a loan number is ignored rather than thrown
 * on. This list comes from the database and from imported data, and refusing to
 * issue a number because one old row is malformed would block the user from
 * recording a loan at all. Whitespace and lower case are tolerated for the same
 * reason: reading 'l-0004 ' as garbage would restart the sequence at L-0001 and
 * collide on the very next insert.
 */
export function nextLoanNumber(existing: readonly string[]): string {
  let highest = 0;

  for (const raw of existing) {
    if (typeof raw !== 'string') continue;
    const match = LOAN_NUMBER_PATTERN.exec(raw.trim());
    if (!match) continue;

    const value = Number.parseInt(match[1] as string, 10);
    if (!Number.isSafeInteger(value)) continue;
    if (value > highest) highest = value;
  }

  /* Padded to four digits because that is what every existing number looks like
   * and a list sorts readably that way. Past 9999 the padding simply stops
   * mattering — 'L-10000' is preferred over truncating to a number that already
   * exists. */
  return `L-${String(highest + 1).padStart(4, '0')}`;
}
