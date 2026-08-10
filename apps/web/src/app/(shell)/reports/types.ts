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

/** `GET /v1/reports/balance-sheet` — takes no arguments: it is always "now". */
export interface BalanceSheetDto {
  assetsMinor: number;
  liabilitiesMinor: number;
  netWorthMinor: number;
  liquidMinor: number;
  assets: BalanceLine[];
  liabilities: BalanceLine[];
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
