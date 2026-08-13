import { api } from '@/lib/api';

/**
 * The shared-spending API, in one file.
 *
 * Every shape here is the one a native app will consume later — integer minor
 * units, `YYYY-MM-DD` dates, no browser types — so the screens are a client of
 * the same contract rather than the definition of it.
 */

export type SplitMethod = 'EQUAL' | 'EXACT' | 'PERCENT' | 'SHARES';
export type GroupPurpose = 'TRIP' | 'HOUSEHOLD' | 'OFFICE' | 'EVENT' | 'OTHER';

export interface GroupSummary {
  id: string;
  name: string;
  purpose: GroupPurpose;
  currency: string;
  note: string | null;
  memberCount: number;
  expenseCount: number;
  /** + the group owes you, − you owe it. */
  myNetMinor: number;
  archivedAt: string | null;
  createdAt: string;
}

export interface GroupMember {
  id: string;
  personId: string | null;
  displayName: string;
  isSelf: boolean;
  shareWeight: number;
  removedAt: string | null;
  netMinor: number;
}

export interface Suggestion {
  fromMemberId: string;
  toMemberId: string;
  amountMinor: number;
}

export interface GroupDetail {
  id: string;
  name: string;
  purpose: GroupPurpose;
  currency: string;
  note: string | null;
  archivedAt: string | null;
  createdAt: string;
  members: GroupMember[];
  positions: { memberId: string; netMinor: number }[];
  suggestions: Suggestion[];
}

export interface SharedExpenseView {
  id: string;
  description: string;
  date: string;
  totalMinor: number;
  payerMemberId: string;
  payerName: string;
  payerIsSelf: boolean;
  splitMethod: SplitMethod;
  categoryId: string | null;
  note: string | null;
  transactionId: string | null;
  myShareMinor: number;
  shares: {
    memberId: string;
    name: string;
    amountMinor: number;
    percentBps: number | null;
    shareWeight: number | null;
  }[];
}

export const splitKeys = {
  all: ['split'] as const,
  groups: () => ['split', 'groups'] as const,
  group: (id: string) => ['split', 'group', id] as const,
  expenses: (id: string) => ['split', 'group', id, 'expenses'] as const,
  settlements: (id: string) => ['split', 'group', id, 'settlements'] as const,
};

export const fetchGroups = () => api<GroupSummary[]>('/split/groups');
export const fetchGroup = (id: string) => api<GroupDetail>(`/split/groups/${id}`);
export const fetchExpenses = (id: string) =>
  api<SharedExpenseView[]>(`/split/groups/${id}/expenses`);

export interface SettlementView {
  id: string;
  fromMemberId: string;
  toMemberId: string;
  amountMinor: number;
  date: string;
  note: string | null;
}
export const fetchSettlements = (id: string) =>
  api<SettlementView[]>(`/split/groups/${id}/settlements`);
