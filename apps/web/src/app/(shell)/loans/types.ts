/**
 * The `/loans` contract, mirrored on the client.
 *
 * The shape below follows what `apps/api/src/loans` actually returns: a flat
 * `personName`/`personPhone` on the loan, and the money under `progress`. The
 * normalisers also accept the earlier draft of the contract — a nested
 * `person` object and the progress fields hoisted to the top — so the screens
 * keep working whichever one is on the wire.
 *
 * Every amount is integer poisha. Coercing at the fetch boundary is what keeps
 * a single amount arriving as a string (a BigInt serialised as text, say) from
 * making `formatMinor` throw inside render and taking the screen down.
 */

export type LoanDirection = 'LENT' | 'BORROWED';
export type LoanStatus = 'ACTIVE' | 'OVERDUE' | 'COMPLETED' | 'CANCELLED';
export type LoanInterestType = 'NONE' | 'FIXED' | 'PERCENT';
export type PaymentMethod = 'CASH' | 'BANK' | 'MOBILE_WALLET' | 'CHEQUE' | 'CARD' | 'OTHER';

export interface LoanPerson {
  id: string;
  name: string;
  phone: string | null;
}

export interface LoanProgress {
  totalPayableMinor: number;
  paidMinor: number;
  outstandingMinor: number;
  /** 0–100, one decimal place. */
  percentPaid: number;
  paymentCount: number;
  /** Negative while the due date is still ahead; 0 when there is no due date. */
  daysOverdue: number;
  isSettled: boolean;
}

export interface Loan {
  id: string;
  loanNumber: string;
  direction: LoanDirection;
  personId: string;
  personName: string;
  personPhone: string | null;
  principalMinor: number;
  interestType: LoanInterestType;
  interestMinor: number;
  interestRateBps: number;
  accruedInterestMinor: number;
  loanDate: string;
  dueDate: string | null;
  accountId: string;
  loanAccountId: string;
  note: string | null;
  status: LoanStatus;
  progress: LoanProgress;
}

export interface DirectionSummary {
  totalMinor: number;
  repaidMinor: number;
  outstandingMinor: number;
  overdueMinor: number;
  upcomingMinor: number;
  count: number;
}

export interface LoanDashboard {
  borrowed: DirectionSummary;
  lent: DirectionSummary;
}

export interface StatementRow {
  date: string;
  description: string | null;
  debitMinor: number;
  creditMinor: number;
  balanceMinor: number;
  method: string | null;
  referenceNumber: string | null;
}

export interface Statement {
  openingMinor: number;
  rows: StatementRow[];
  closingMinor: number;
}

export interface LoanStatementResponse extends Statement {
  loan?: Loan;
  person?: LoanPerson;
}

/** A loan as the party ledger summarises it, when the API sends the subtotals. */
export interface PartyLedgerLoan {
  loanId: string;
  loanNumber: string;
  direction: LoanDirection;
  status: LoanStatus;
  loanDate: string;
  dueDate: string | null;
  outstandingMinor: number;
}

export interface PartyLedgerResponse extends Statement {
  person?: LoanPerson | null;
  loans?: PartyLedgerLoan[];
  /** + the person owes the user, − the user owes the person. */
  netPositionMinor?: number;
  receivableMinor?: number;
  payableMinor?: number;
}

export interface LoanPayment {
  id: string;
  date: string;
  amountMinor: number;
  method: PaymentMethod;
  referenceNumber: string | null;
  note: string | null;
}

export interface LoanDetail {
  loan: Loan;
  person: LoanPerson;
  progress: LoanProgress;
  payments: LoanPayment[];
}

// --- what the wire may actually carry ---------------------------------------

/** The two contract shapes, overlaid. Only the normalisers ever see this. */
export interface RawLoan extends Partial<Omit<Loan, 'progress'>>, Partial<LoanProgress> {
  id: string;
  loanNumber: string;
  direction: LoanDirection;
  person?: Partial<LoanPerson> | null;
  progress?: Partial<LoanProgress> | null;
}

export interface RawLoanDetail {
  loan: RawLoan;
  person?: Partial<LoanPerson> | null;
  progress?: Partial<LoanProgress> | null;
  payments?: LoanPayment[];
}

export interface RawStatement<T> {
  openingMinor?: number;
  rows?: StatementRow[];
  closingMinor?: number;
  extra?: T;
}

// --- normalisers -----------------------------------------------------------

/** Coerce to a whole number. Truncation, never rounding — money is integer. */
export function int(value: number | undefined | null): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function toProgress(raw: RawLoan | RawLoanDetail['progress'], fallback?: RawLoan): LoanProgress {
  const p = (raw ?? {}) as Partial<LoanProgress>;
  const f = (fallback ?? {}) as Partial<LoanProgress>;
  const pick = (key: keyof LoanProgress): number => int((p[key] ?? f[key]) as number);
  return {
    totalPayableMinor: pick('totalPayableMinor'),
    paidMinor: pick('paidMinor'),
    outstandingMinor: pick('outstandingMinor'),
    percentPaid: pick('percentPaid'),
    paymentCount: pick('paymentCount'),
    daysOverdue: pick('daysOverdue'),
    isSettled: Boolean(p.isSettled ?? f.isSettled),
  };
}

export function toLoan(raw: RawLoan): Loan {
  return {
    id: raw.id,
    loanNumber: raw.loanNumber,
    direction: raw.direction,
    // Flat on the wire today; nested in the first draft of the contract.
    personId: raw.personId ?? raw.person?.id ?? '',
    personName: raw.personName ?? raw.person?.name ?? 'অজানা',
    personPhone: raw.personPhone ?? raw.person?.phone ?? null,
    principalMinor: int(raw.principalMinor),
    interestType: raw.interestType ?? 'NONE',
    interestMinor: int(raw.interestMinor),
    interestRateBps: int(raw.interestRateBps),
    accruedInterestMinor: int(raw.accruedInterestMinor),
    loanDate: raw.loanDate ?? '',
    dueDate: raw.dueDate ?? null,
    accountId: raw.accountId ?? '',
    loanAccountId: raw.loanAccountId ?? '',
    note: raw.note ?? null,
    status: raw.status ?? 'ACTIVE',
    progress: toProgress(raw.progress ?? null, raw),
  };
}

function toSummary(raw: Partial<DirectionSummary> | undefined): DirectionSummary {
  return {
    totalMinor: int(raw?.totalMinor),
    repaidMinor: int(raw?.repaidMinor),
    outstandingMinor: int(raw?.outstandingMinor),
    overdueMinor: int(raw?.overdueMinor),
    upcomingMinor: int(raw?.upcomingMinor),
    count: int(raw?.count),
  };
}

export function toDashboard(raw: Partial<LoanDashboard>): LoanDashboard {
  return { borrowed: toSummary(raw?.borrowed), lent: toSummary(raw?.lent) };
}

function toRow(raw: StatementRow): StatementRow {
  return {
    ...raw,
    debitMinor: int(raw.debitMinor),
    creditMinor: int(raw.creditMinor),
    balanceMinor: int(raw.balanceMinor),
  };
}

export function toStatement<T extends Statement>(raw: T): T {
  return {
    ...raw,
    openingMinor: int(raw?.openingMinor),
    closingMinor: int(raw?.closingMinor),
    rows: (raw?.rows ?? []).map(toRow),
  };
}

export function toDetail(raw: RawLoanDetail): LoanDetail {
  const loan = toLoan(raw.loan);
  const progress = raw.progress ? toProgress(raw.progress) : loan.progress;
  return {
    loan,
    person: {
      id: raw.person?.id ?? loan.personId,
      name: raw.person?.name ?? loan.personName,
      phone: raw.person?.phone ?? loan.personPhone,
    },
    progress,
    payments: (raw.payments ?? []).map((p) => ({ ...p, amountMinor: int(p.amountMinor) })),
  };
}
