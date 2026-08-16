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

/**
 * What kind of long-term thing an `ASSET` account holds.
 *
 * Land, a car and a BO share account are all assets and are three different
 * lines on a balance sheet — IAS 1.54 separates property, plant and equipment
 * from financial investments. Short on purpose: every extra option is one more
 * chance to file the same flat under two headings in two different years.
 */
export const ASSET_KINDS = ['PROPERTY', 'VEHICLE', 'GOLD', 'INVESTMENT', 'OTHER'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

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
  /* Marking an asset to what it is worth now. Same entries as an adjustment,
     different meaning: a correction says the ledger was wrong, a revaluation
     says the world moved. */
  'REVALUATION',
  /* Selling the asset. The opposite of a revaluation in the one way that
     matters: revaluing moves net worth with no money changing hands and posts
     to equity (IAS 16.39), while selling turns the asset into cash and the gain
     or loss goes to profit or loss (IAS 16.68). */
  'DISPOSAL',
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

/**
 * What somebody signed up on.
 *
 * Three values rather than a user-agent string, because the only thing this is
 * for is choosing which set of "add to home screen" instructions to show, and
 * those come in exactly three shapes. A parsed user-agent would be more precise
 * and less useful.
 */
export const DEVICE_KINDS = ['IOS', 'ANDROID', 'DESKTOP'] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

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
