/** Enum values mirror the Prisma schema exactly. Keep both in sync. */

export const ACCOUNT_TYPES = [
  'CASH',
  'BANK',
  'MOBILE_WALLET',
  'CREDIT_CARD',
  'SAVINGS',
  'RECEIVABLE',
  'PAYABLE',
  'ASSET',
  'LIABILITY',
  'EQUITY',
] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const TRANSACTION_TYPES = [
  'INCOME',
  'EXPENSE',
  'TRANSFER',
  'LOAN_GIVEN',
  'LOAN_REPAID',
  'BORROWED',
  'BORROW_REPAID',
  'SAVINGS_DEPOSIT',
  'SAVINGS_WITHDRAWAL',
  'PREMIUM_PAID',
  'ADJUSTMENT',
  'OPENING_BALANCE',
] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export const TRANSACTION_SOURCES = [
  'MANUAL',
  'SMS',
  'EMAIL',
  'WEBHOOK',
  'OCR',
  'IMPORT',
  'RECURRING',
] as const;
export type TransactionSource = (typeof TRANSACTION_SOURCES)[number];

export const ENTRY_DIRECTIONS = ['DEBIT', 'CREDIT'] as const;
export type EntryDirection = (typeof ENTRY_DIRECTIONS)[number];

export const CATEGORY_KINDS = ['INCOME', 'EXPENSE'] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];

export const LOCALES = ['bn', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

/**
 * Accounts whose natural balance grows on the DEBIT side.
 * Used to turn signed ledger entries into a human-facing balance.
 */
export const DEBIT_NORMAL_ACCOUNT_TYPES: readonly AccountType[] = [
  'CASH',
  'BANK',
  'MOBILE_WALLET',
  'SAVINGS',
  'RECEIVABLE',
  'ASSET',
];

export function isDebitNormal(type: AccountType): boolean {
  return DEBIT_NORMAL_ACCOUNT_TYPES.includes(type);
}
