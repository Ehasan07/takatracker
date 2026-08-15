import type { DetailKind, MigrationDecision, MigrationDetail } from '@hishab/core';

/** One staged row, as the API presents it. */
export interface MigrationItem {
  id: string;
  kind: 'ACCOUNT' | 'CATEGORY';
  sourceId: string;
  sourceName: string;
  usageCount: number;
  decision: MigrationDecision;
  targetType: string | null;
  targetId: string | null;
  createdEntityId: string | null;
  createdEntityKind: string | null;
  skippedReason: string | null;
  /** Currency, group, archived — whatever the other product said. */
  detail: string;
  /** Which questions this row raises, if any, and whether they are answered. */
  needs: DetailKind | null;
  needsComplete: boolean;
  targetDetail: MigrationDetail | null;
}

export interface MigrationBatch {
  id: string;
  source: string;
  status: 'DRAFT' | 'APPLIED' | 'ROLLED_BACK';
  createdAt: string;
  appliedAt: string | null;
  rolledBackAt: string | null;
  note: string | null;
  counts: {
    accounts: number;
    categories: number;
    created: number;
    skipped: number;
    needsDetail: number;
  };
}

export interface MigrationBatchDetail extends MigrationBatch {
  items: MigrationItem[];
}

export interface RollbackResult {
  removed: number;
  kept: { name: string; reason: string }[];
}

export interface CsvResult {
  updated: number;
  errors: string[];
}

/** The five choices, in the order they appear in the row's menu. */
export const DECISION_LABELS: Record<MigrationDecision, string> = {
  CREATE: 'নতুন করে বানাও',
  MERGE: 'আগেরটার সাথে মেলাও',
  SAVINGS: 'সঞ্চয়/ডিপিএস হিসেবে',
  INSURANCE: 'বীমা হিসেবে',
  LIABILITY: 'দেনা হিসেবে (যে টাকা আমি দেব)',
  RECEIVABLE: 'পাওনা হিসেবে (যে টাকা আমি পাব)',
  SKIP: 'বাদ দাও',
};

/** Account types offered for an imported account, in the order they matter. */
export const ACCOUNT_TYPES: { value: string; label: string }[] = [
  { value: 'BANK', label: 'ব্যাংক' },
  { value: 'CASH', label: 'নগদ' },
  { value: 'MOBILE_WALLET', label: 'মোবাইল ব্যাংকিং' },
  { value: 'CREDIT_CARD', label: 'ক্রেডিট কার্ড' },
  { value: 'SAVINGS', label: 'সঞ্চয়' },
  { value: 'ASSET', label: 'সম্পদ' },
  { value: 'LIABILITY', label: 'দায়' },
];
