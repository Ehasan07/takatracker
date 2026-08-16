'use client';

import type { QueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { fetchPeople, peopleKeys } from '../people/queries';
import type { PersonDto } from '../people/types';
import {
  toDashboard,
  toDetail,
  toLoan,
  toStatement,
  type Loan,
  type LoanDashboard,
  type LoanDetail,
  type LoanPerson,
  type LoanStatementResponse,
  type PartyLedgerResponse,
  type RawLoan,
  type RawLoanDetail,
} from './types';

export interface LoanListFilters {
  direction?: string;
  status?: string;
  personId?: string;
  q?: string;
}

function search(params: Record<string, string | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') qs.set(key, value);
  }
  const text = qs.toString();
  return text ? `?${text}` : '';
}

/**
 * One key namespace for everything under /loans, so a single
 * `invalidateQueries({ queryKey: ['loans'] })` refreshes the hub, the loan, the
 * statement and the party ledger together after any mutation.
 */
export const loanKeys = {
  all: ['loans'] as const,
  dashboard: () => ['loans', 'dashboard'] as const,
  list: (filters: LoanListFilters) => ['loans', 'list', filters] as const,
  detail: (id: string) => ['loans', 'detail', id] as const,
  statement: (id: string, range: string) => ['loans', 'statement', id, range] as const,
  ledger: (personId: string, range: string) => ['loans', 'ledger', personId, range] as const,
};

/**
 * Everybody in the khata, not only the ones who already owe something.
 *
 * The loan sheets used to build their counterparty list by walking the loan
 * list and collecting distinct `personId`s, which quietly meant *a person you
 * have never lent to cannot be picked* — including all 28 brought over from
 * Wallet, who existed in the database and appeared nowhere on screen.
 *
 * `GET /people` had been there the whole time, and the quick-add sheet was
 * already using it through `people/queries`. The sheets reuse that function and
 * that key rather than adding a second way to ask the same question.
 *
 * Deliberately a plain mapper over an already-fetched list rather than a
 * `queryFn` of its own. Two query functions under one key is a real bug even
 * when both hit the same endpoint: whichever runs first fills the cache, the
 * other reads a shape it never produced, and the failure only shows up in the
 * order the user happens to open the screens in.
 */
export function toLoanPeople(rows: readonly PersonDto[]): LoanPerson[] {
  return rows
    .map((row) => ({ id: row.id, name: row.name, phone: row.phone ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name, 'bn'));
}

export { fetchPeople, peopleKeys };

export async function fetchLoans(filters: LoanListFilters): Promise<Loan[]> {
  const rows = await api<RawLoan[]>(`/loans${search({ ...filters })}`);
  return (rows ?? []).map(toLoan);
}

export async function fetchDashboard(): Promise<LoanDashboard> {
  return toDashboard(await api<LoanDashboard>('/loans/dashboard'));
}

export async function fetchLoanDetail(id: string): Promise<LoanDetail> {
  return toDetail(await api<RawLoanDetail>(`/loans/${id}`));
}

export async function fetchLoanStatement(
  id: string,
  range: string,
): Promise<LoanStatementResponse> {
  const raw = await api<LoanStatementResponse & { loan?: RawLoan }>(
    `/loans/${id}/statement${range}`,
  );
  return { ...toStatement(raw), loan: raw.loan ? toLoan(raw.loan) : undefined };
}

export async function fetchPartyLedger(
  personId: string,
  range: string,
): Promise<PartyLedgerResponse> {
  return toStatement(await api<PartyLedgerResponse>(`/loans/people/${personId}/ledger${range}`));
}

/**
 * A loan moves real money, so the accounts, the khata and the reports are all
 * stale the moment one changes — not just the loan screens.
 *
 * Every mutation on a loan now touches the ledger: creating one books the
 * disbursement, a payment books the repayment, and editing the principal,
 * deleting an instalment, cancelling or deleting all reverse entries and can
 * archive the control account. So the home summary (`['summary']`, the
 * income/expense card on `/`) belongs in this list too — a repayment carrying
 * interest posts to income or expense, and the card would otherwise keep
 * showing the figure from before the edit until something else refetched it.
 */
export function invalidateLoanData(queryClient: QueryClient): void {
  for (const key of [
    ['loans'],
    ['accounts'],
    ['transactions'],
    ['summary'],
    ['reports'],
    ['entitlements'],
    /* Creating a loan against a typed-in name creates the person too, so the
       next sheet must offer them without a reload. */
    ['people'],
  ]) {
    void queryClient.invalidateQueries({ queryKey: key });
  }
}
