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
