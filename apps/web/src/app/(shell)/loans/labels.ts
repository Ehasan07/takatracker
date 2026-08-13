import type { LoanDirection, LoanInterestType, LoanStatus, PaymentMethod } from './types';

export const DIRECTIONS: readonly (readonly [LoanDirection, string])[] = [
  ['BORROWED', 'ধার নিয়েছি'],
  ['LENT', 'ধার দিয়েছি'],
];

/** The card headings on the hub, in the user's own voice. */
export const DIRECTION_TITLE: Record<LoanDirection, string> = {
  BORROWED: 'আমি যা ধার নিয়েছি',
  LENT: 'আমি যা ধার দিয়েছি',
};

/** "outstanding" means two different things depending on which way the money went. */
export const OUTSTANDING_LABEL: Record<LoanDirection, string> = {
  BORROWED: 'এখনও দিতে হবে',
  LENT: 'এখনও পাব',
};

export const REPAID_LABEL: Record<LoanDirection, string> = {
  BORROWED: 'পরিশোধ করেছি',
  LENT: 'আদায় হয়েছে',
};

export const STATUS_LABEL: Record<LoanStatus, string> = {
  ACTIVE: 'চলমান',
  OVERDUE: 'মেয়াদোত্তীর্ণ',
  COMPLETED: 'সম্পন্ন',
  CANCELLED: 'বাতিল',
};

/** '' is "everything" — the API treats a missing status filter as no filter. */
export const STATUS_FILTERS: readonly (readonly [string, string])[] = [
  ['', 'সব'],
  ['ACTIVE', 'চলমান'],
  ['OVERDUE', 'মেয়াদোত্তীর্ণ'],
  ['COMPLETED', 'সম্পন্ন'],
  ['CANCELLED', 'বাতিল'],
];

export const INTEREST_TYPES: readonly (readonly [LoanInterestType, string])[] = [
  ['NONE', 'সুদ নেই'],
  ['FIXED', 'নির্দিষ্ট টাকা'],
  ['PERCENT', 'শতকরা হার (বার্ষিক)'],
];

export const METHODS: readonly (readonly [PaymentMethod, string])[] = [
  ['CASH', 'নগদ'],
  ['BANK', 'ব্যাংক'],
  ['MOBILE_WALLET', 'মোবাইল ওয়ালেট'],
  ['CHEQUE', 'চেক'],
  ['CARD', 'কার্ড'],
  ['OTHER', 'অন্যান্য'],
];

export function methodLabel(method: string | null | undefined): string {
  if (!method) return '';
  return METHODS.find(([value]) => value === method)?.[1] ?? method;
}

export function statusLabel(status: string): string {
  return STATUS_LABEL[status as LoanStatus] ?? status;
}

export function directionLabel(direction: string): string {
  return DIRECTIONS.find(([value]) => value === direction)?.[1] ?? direction;
}

/* One implementation, in `lib/format.ts`, which follows the workspace's
   language. There were ten near-identical copies of these across the app and
   every one of them hardcoded Bengali digits. The old names are re-exported so
   the call sites in this folder stay as they are. */
import { fmtDate as bnDate, fmtNumber as bnNum } from '@/lib/format';

export { bnDate, bnNum };

/** Whole percent paid, clamped. Truncated — ESLint bans Math.round for a reason. */
export function paidPercent(paidMinor: number, totalMinor: number): number {
  if (totalMinor <= 0) return paidMinor > 0 ? 100 : 0;
  return Math.min(100, Math.max(0, Math.trunc((paidMinor / totalMinor) * 100)));
}
