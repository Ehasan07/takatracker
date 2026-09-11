/** One counterparty's standing on one side of the books. Mirrors the API. */
export interface PartyDueSide {
  totalMinor: number;
  paidMinor: number;
  outstandingMinor: number;
  overdueMinor: number;
  loanCount: number;
  lastActivity: string | null;
}

export interface PartyDueRow {
  personId: string;
  code: string;
  name: string;
  phone: string | null;
  relation: string | null;
  /** Deleted, and still carrying a balance. Shown with a mark, never dropped. */
  archived: boolean;
  customer: PartyDueSide;
  supplier: PartyDueSide;
}

export interface PartyDueReport {
  asOf: string;
  customers: PartyDueRow[];
  suppliers: PartyDueRow[];
  customerTotals: PartyDueSide;
  supplierTotals: PartyDueSide;
}

/** Which list is on screen. The two are never mixed — see the sheet comment. */
export type PartySide = 'customer' | 'supplier';
