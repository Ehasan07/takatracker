/**
 * The shapes `apps/api/src/reports` actually returns. Amounts are integer
 * poisha everywhere, straight from `minorToNumber` — nothing on this screen
 * converts them to taka except `<Money>` and the chart axis.
 */

export interface CategoryRow {
  categoryId: string | null;
  name: string;
  totalMinor: number;
  sharePercent?: number;
  /** The parent this sits under, when the API knows one. Only sub-categories. */
  parentName?: string;
}

export interface CategoryNode extends CategoryRow {
  rolledUpMinor: number;
  children: CategoryRow[];
}

/** `GET /v1/reports/by-category?kind=&from=&to=` — parents, children attached. */
export interface ByCategoryDto {
  total: number;
  nodes: CategoryNode[];
}

/**
 * `GET /v1/reports/by-category?flat=1` — the same period with no rolling up:
 * every category on its own line, parents and sub-categories side by side.
 *
 * A different shape from `ByCategoryDto` because it is a different question.
 * The rolled-up view answers "what do we spend on transport"; this one answers
 * "what are the ten things we actually spend most on", and the answer is often
 * three sub-categories of one parent — which the rolled-up view cannot show
 * and, folded together, actively hides.
 */
export interface ByCategoryFlatDto {
  total: number;
  rows: CategoryRow[];
}

/** `GET /v1/reports/trend?months=` — whole calendar months, ending at this one. */
export interface TrendPoint {
  month: string;
  incomeMinor: number;
  expenseMinor: number;
  netMinor: number;
}

export interface BalanceLine {
  id: string;
  name: string;
  type: string;
  amountMinor: number;
}

/** The five kinds of thing an `ASSET` account can be. */
export type AssetKind = 'PROPERTY' | 'VEHICLE' | 'GOLD' | 'INVESTMENT' | 'OTHER';

/** `type === 'ASSET'` rows folded by what they actually are (IAS 1.54). */
export interface AssetGroupDto {
  kind: AssetKind;
  amountMinor: number;
  count: number;
}

/**
 * A group of accounts of one type, with what they come to between them.
 *
 * Used for both sides of the position panel — what is owed and what is
 * spendable — because they are the same shape, and the invariant that matters
 * is the same on both: the groups add up to the total they sit under. See
 * `buildBalanceSheet` in @hishab/core.
 */
export interface TypeGroupDto {
  type: string;
  /** On the liability side this is positive when money is owed. */
  amountMinor: number;
  count: number;
}

/** `GET /v1/reports/balance-sheet` — takes no arguments: it is always "now". */
export interface BalanceSheetDto {
  assetsMinor: number;
  liabilitiesMinor: number;
  netWorthMinor: number;
  liquidMinor: number;
  assets: BalanceLine[];
  liabilities: BalanceLine[];
  /** IAS 1.60: what turns into cash within a year, and what does not. */
  currentAssetsMinor: number;
  nonCurrentAssetsMinor: number;
  currentLiabilitiesMinor: number;
  nonCurrentLiabilitiesMinor: number;
  /** Current assets less current liabilities. */
  workingCapitalMinor: number;
  /** The three breakdowns the position panel draws, each summing to its total. */
  assetGroups: AssetGroupDto[];
  /**
   * What `assetGroups` adds up to. **Not** `nonCurrentAssetsMinor`, which also
   * takes in a DPS — see the field's comment in @hishab/core.
   */
  groupedAssetsMinor: number;
  liabilityGroups: TypeGroupDto[];
  liquidGroups: TypeGroupDto[];
  asOf?: string;
}

/**
 * One credit card's last statement — `GET /v1/reports/card-statements`.
 *
 * `statementMinor` is what the books say was owed **on the day the bill
 * closed**, and `currentMinor` is what is owed now. They are different numbers
 * for most of every month and the screen must never present one as the other.
 *
 * What the app cannot know is on the row by its absence: interest, the late
 * fee, the annual fee and the foreign-currency markup are in these figures only
 * if somebody recorded them, and no field here is the minimum payment, because
 * nothing in the schema records one.
 */
export interface CardStatementDto {
  id: string;
  name: string;
  accountNumberMasked: string | null;
  statementDayOfMonth: number | null;
  dueDayOfMonth: number | null;
  /** Null when the card has no statement day — then there is no statement. */
  statementDate: string | null;
  previousStatementDate: string | null;
  dueDate: string | null;
  openingMinor: number;
  purchasesMinor: number;
  paymentsMinor: number;
  statementMinor: number | null;
  currentMinor: number;
  /** Positive: used again since the bill. Negative: some of it has been paid. */
  sinceStatementMinor: number | null;
  creditLimitMinor: number;
  /** Disclosed and never added to anything. IAS 7.50(a). */
  undrawnMinor: number;
  reconciled: boolean;
}

export interface CardStatementsDto {
  asOf: string;
  cards: CardStatementDto[];
  statementTotalMinor: number;
  currentTotalMinor: number;
  withoutStatementDay: number;
}

/** `GET /v1/reports/income-statement?from=&to=&compareFrom=&compareTo=` */
export interface IncomeStatementFiguresDto {
  incomeMinor: number;
  expenseMinor: number;
  surplusMinor: number;
  /** Share of income kept, in basis points. 25% is 2500. */
  savingsRateBps: number;
  income: CategoryNode[];
  expenses: CategoryNode[];
}

export interface IncomeStatementDto extends IncomeStatementFiguresDto {
  from: string;
  to: string;
  basis: 'CASH';
  /**
   * The tag this statement was narrowed to, when it was narrowed to one.
   *
   * Printed on the page: a profit-and-loss for a shop and one for a whole
   * household look identical on paper and mean entirely different things.
   */
  segment: { tagId: string; name: string } | null;
  comparison?: IncomeStatementFiguresDto & { from: string; to: string };
}

/**
 * One savings instrument's movement over the period — a row of the সঞ্চয় panel.
 *
 * `netMinor` is `inMinor − outMinor` and is the only one of the three that can
 * go negative: a month a DPS was broken into shows ৳0 in, ৳60,000 out and
 * −৳60,000 net. The rows add up to `MonthlyFlowDto.savedMinor` exactly, which
 * is what makes it safe to print the heading over them.
 */
export interface SavingsInstrumentDto {
  accountId: string;
  /** The plan's name when one is linked, the account's own otherwise. */
  name: string;
  accountName: string;
  type: string;
  vehicle: 'SAVINGS' | 'INVESTMENT';
  planId: string | null;
  planType: string | null;
  inMinor: number;
  outMinor: number;
  netMinor: number;
}

/** One calendar month of the four figures. */
export interface MonthlyFlowPointDto {
  month: string;
  incomeMinor: number;
  expenseMinor: number;
  savedMinor: number;
  investedMinor: number;
  surplusMinor: number;
  savingsRateBps: number | null;
}

/**
 * `GET /v1/reports/monthly?from=&to=&months=` — আয়, খরচ ও সঞ্চয়.
 *
 * The third figure is on no other endpoint and can be on none of them. Putting
 * money into a DPS is one asset becoming another, so it is a transfer, it
 * touches no nominal account and it never reaches an income statement. This is
 * the transfers, netted: `savedMinor` counts money moving into `SAVINGS`
 * accounts *from outside them*, so a move between two DPS accounts adds nothing
 * and a withdrawal subtracts.
 *
 * `incomeMinor` and `expenseMinor` are the same two figures `by-category`
 * reports for the same range, off the same entries. The সারসংক্ষেপ panel and
 * this one sit on the same screen and must not disagree.
 *
 * `investedMinor` — money that went into land, gold or a car — is deliberately
 * beside সঞ্চয় and never inside it, and is not in the savings rate. See
 * `savingsVehicleOf` in @hishab/core for why.
 */
export interface MonthlyFlowDto {
  from: string;
  to: string;
  basis: 'CASH';
  incomeMinor: number;
  expenseMinor: number;
  /** What was **not spent**. Not the same number as `savedMinor`. */
  surplusMinor: number;
  savedMinor: number;
  investedMinor: number;
  /** Basis points. Null when there was no income to be a share of. */
  savingsRateBps: number | null;
  savings: SavingsInstrumentDto[];
  investments: SavingsInstrumentDto[];
  months: MonthlyFlowPointDto[];
}

/** `GET /v1/reports/net-worth-changes?from=&to=` */
export interface NetWorthChangesDto {
  from: string;
  to: string;
  basis: 'CASH';
  openingMinor: number;
  incomeMinor: number;
  expenseMinor: number;
  surplusMinor: number;
  otherMinor: number;
  /** What the "other" line is made of, so far as revaluations explain it. */
  revaluations: {
    id: string;
    date: string;
    accountName: string;
    note: string | null;
    deltaMinor: number;
  }[];
  closingMinor: number;
  movementMinor: number;
}

/**
 * One line of `GET /v1/reports/by-tag`.
 *
 * `tagId: null` is the untagged bucket. It is a real row the API emits even when
 * it is zero, and it must not be filtered out or dressed up as a tag: it is the
 * honest answer to "what is my tagging *not* covering", and hiding it lets
 * somebody believe their tags cover the whole month when they cover a third.
 */
export interface TagReportRow {
  tagId: string | null;
  name: string;
  color: string | null;
  icon: string | null;
  totalMinor: number;
  transactionCount: number;
  /** Of `TagReport.totalMinor`, not of the rows. Can add up to over 100. */
  sharePercent: number;
}

/**
 * `GET /v1/reports/by-tag?kind=&from=&to=` — the period cut by *who for* rather
 * than *what on*.
 *
 * **The rows deliberately do not add up to the total.** A transaction carrying
 * three tags appears on three rows, because ৳৫০০ of groceries tagged পারিবারিক
 * and রমজান really is ৳৫০০ of family spending *and* ৳৫০০ of Ramadan spending;
 * splitting it between them would make both answers false. So:
 *
 *   `totalMinor`       every transaction counted once — the headline, and the
 *                      figure that agrees with by-category and the dashboard
 *   `taggedMinor`      the part of it carrying at least one tag, once each
 *   `untaggedMinor`    the rest, also present as a row
 *   `attributedMinor`  what the per-tag rows add up to
 *   `overlapMinor`     `attributedMinor − taggedMinor`, the double-counted part
 *
 * The panel prints the last two whenever they are non-zero. Without that, the
 * first person to add the column up finds a number bigger than their month's
 * spending and reports it as a bug.
 */
export interface ByTagDto {
  kind: Kind;
  from: string;
  to: string;
  totalMinor: number;
  transactionCount: number;
  taggedMinor: number;
  untaggedMinor: number;
  attributedMinor: number;
  overlapMinor: number;
  rows: TagReportRow[];
}

/** `GET /v1/reports/cash-flow?from=&to=` */
export interface CashFlowDto {
  openingMinor: number;
  inflowMinor: number;
  outflowMinor: number;
  netMinor: number;
  closingMinor: number;
  accounts: string[];
  /** IAS 7's three sections. Signed: negative is money leaving. */
  operatingMinor: number;
  investingMinor: number;
  financingMinor: number;
}

/** `GET /v1/reports/category/:id?from=&to=` */
export interface DrilldownDto {
  category: { id: string; name: string; kind?: string };
  totalMinor: number;
  items: {
    transactionId: string;
    date: string;
    description: string | null;
    payee?: string | null;
    amountMinor: number;
  }[];
}

export type Kind = 'INCOME' | 'EXPENSE';
