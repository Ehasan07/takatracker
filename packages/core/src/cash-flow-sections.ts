import type { AccountType } from '@hishab/shared';

/**
 * Which section of a cash flow statement a movement belongs to.
 *
 * ## Why IAS 7 insists on three
 *
 * A single "money in, money out" figure hides the only thing anybody assessing
 * a person's finances wants to know: *where the money came from*. ৳80,000 of
 * salary and ৳80,000 borrowed from a cousin are the same number and completely
 * different facts. A lender reads the operating line to see whether somebody
 * lives within their means, the financing line to see how much of last year was
 * borrowed, and the investing line to see what was bought with the difference.
 *
 * The three, as the standard defines them and as they land for a household:
 *
 * - **Operating** — earning and living. Salary, rent, groceries, utilities,
 *   school fees, insurance premiums, interest paid or received.
 * - **Investing** — turning money into something that is still yours. Buying
 *   land or gold, paying into a DPS, and the reverse when either is sold.
 * - **Financing** — money that is somebody else's, or owed to you. Borrowing,
 *   repaying, lending, being repaid, and settling a shared bill.
 *
 * ## Why it is decided by the *other* account, not by the transaction type
 *
 * `TransactionType` looks like the obvious key and is the wrong one. A
 * `TRANSFER` between two bank accounts is not a cash flow at all; a `TRANSFER`
 * from a bank account into a land account is an investing outflow. Same type,
 * different sections, and the difference is entirely in what sat on the other
 * side of the entry.
 *
 * So: for every movement on a liquid account, look at what it moved to or from.
 * That is also what makes the classification survive features nobody has built
 * yet — a new kind of account is classified by its type, and needs no new case
 * here.
 */

export type CashFlowSection = 'OPERATING' | 'INVESTING' | 'FINANCING' | 'INTERNAL';

/** The account types that hold spendable money; see `LIQUID_TYPES` in reports. */
const LIQUID = new Set<AccountType>(['CASH', 'BANK', 'MOBILE_WALLET']);

/**
 * The section a movement belongs to, given the account on the other side.
 *
 * `systemRole` distinguishes the three nominal accounts, which all have type
 * `EQUITY` and mean entirely different things: income and expense are the
 * substance of the operating section, while the equity account carries opening
 * balances and reconciliation adjustments — which are not cash flows and must
 * not be counted as any.
 */
export function cashFlowSection(
  counterType: AccountType,
  systemRole: 'INCOME' | 'EXPENSE' | 'EQUITY' | null = null,
): CashFlowSection {
  /* Between two of your own pockets. Not a flow: the money did not arrive from
     anywhere and did not go anywhere, and counting it would inflate both sides
     of the statement by the same amount. */
  if (LIQUID.has(counterType)) return 'INTERNAL';

  if (systemRole === 'INCOME' || systemRole === 'EXPENSE') return 'OPERATING';
  /* Opening balances and reconciliation differences. The money was already
     there; saying it "flowed in" would make the first month of every workspace
     look like a windfall. */
  if (systemRole === 'EQUITY') return 'INTERNAL';

  switch (counterType) {
    /* Money owed in either direction — lending, borrowing, repaying, and
       settling a shared bill. IAS 7 puts borrowing and its repayment in
       financing; a household lending money to a relative is the same
       transaction seen from the other end. */
    case 'RECEIVABLE':
    case 'PAYABLE':
    case 'LIABILITY':
    case 'CREDIT_CARD':
      return 'FINANCING';

    /* Still yours, just no longer spendable. Land, gold, a car, and money put
       into a savings scheme. */
    case 'ASSET':
    case 'SAVINGS':
      return 'INVESTING';

    /* An equity account reached without a system role — a workspace's own
       capital line. Not a flow. */
    case 'EQUITY':
      return 'INTERNAL';

    default:
      /* Anything unclassified goes to operating rather than being dropped. A
         statement that quietly loses a movement is worse than one that files it
         under the section a household's ordinary spending lives in, and the
         totals still reconcile with the closing balance. */
      return 'OPERATING';
  }
}

export interface CashFlowSectionTotals {
  operatingMinor: number;
  investingMinor: number;
  financingMinor: number;
}

export interface SectionedCashFlow extends CashFlowSectionTotals {
  openingMinor: number;
  closingMinor: number;
  /** Operating + investing + financing. Equals closing − opening, always. */
  netMinor: number;
  inflowMinor: number;
  outflowMinor: number;
}

/**
 * Assemble the statement, and prove it against the balance it must reach.
 *
 * The check is the point of the whole thing: opening plus the three sections has
 * to equal the closing balance of every liquid account. If it does not, a
 * movement was classified into nothing or counted twice, and the statement is
 * arithmetic rather than a report. `assertReconciles` throws in that case rather
 * than shipping a plausible-looking page.
 */
export function buildSectionedCashFlow(input: {
  openingMinor: number;
  closingMinor: number;
  operatingMinor: number;
  investingMinor: number;
  financingMinor: number;
  inflowMinor: number;
  outflowMinor: number;
}): SectionedCashFlow {
  const netMinor = input.operatingMinor + input.investingMinor + input.financingMinor;
  return {
    openingMinor: input.openingMinor,
    closingMinor: input.closingMinor,
    operatingMinor: input.operatingMinor,
    investingMinor: input.investingMinor,
    financingMinor: input.financingMinor,
    netMinor,
    inflowMinor: input.inflowMinor,
    outflowMinor: input.outflowMinor,
  };
}

export class CashFlowReconciliationError extends Error {
  constructor(
    readonly expectedMinor: number,
    readonly actualMinor: number,
  ) {
    super(
      `Cash flow does not reconcile: opening + sections = ${actualMinor}, closing = ${expectedMinor}`,
    );
    this.name = 'CashFlowReconciliationError';
  }
}

export function assertReconciles(flow: SectionedCashFlow): void {
  const reached = flow.openingMinor + flow.netMinor;
  if (reached !== flow.closingMinor) {
    throw new CashFlowReconciliationError(flow.closingMinor, reached);
  }
}
