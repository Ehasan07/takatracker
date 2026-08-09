import { z } from 'zod';
import {
  ACCOUNT_TYPES,
  CATEGORY_KINDS,
  ENTRY_DIRECTIONS,
  LOCALES,
  TRANSACTION_SOURCES,
  TRANSACTION_TYPES,
} from './enums.js';

/** Integer poisha. Rejects floats at the API boundary so no float ever enters the stack. */
export const minorAmount = z
  .number()
  .int('Amounts must be integer poisha — no decimals in JSON')
  .safe();

export const positiveMinorAmount = minorAmount.positive('Amount must be greater than zero');

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

export const cuid = z.string().min(1);

// --- Auth -----------------------------------------------------------------

export const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'কমপক্ষে ৮ অক্ষর').max(200),
  name: z.string().min(1).max(120),
  phone: z.string().max(30).optional(),
  locale: z.enum(LOCALES).default('bn'),
  timezone: z.string().default('Asia/Dhaka'),
});
export type SignupInput = z.infer<typeof signupSchema>;

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const refreshSchema = z.object({ refreshToken: z.string().min(1) });

// --- Accounts -------------------------------------------------------------

export const createAccountSchema = z.object({
  name: z.string().min(1).max(120),
  type: z.enum(ACCOUNT_TYPES),
  currency: z.string().length(3).default('BDT'),
  openingBalance: minorAmount.default(0),
  institution: z.string().max(120).optional(),
  accountNumberMasked: z.string().max(60).optional(),
  matchHints: z.array(z.string().max(60)).max(20).default([]),
  icon: z.string().max(40).optional(),
  color: z.string().max(20).optional(),
  sortOrder: z.number().int().default(0),
  /* Credit cards only. A due day past the end of a short month is clamped, so
   * 31 means "the 28th" in February rather than spilling into March. */
  statementDayOfMonth: z.number().int().min(1).max(31).nullish(),
  dueDayOfMonth: z.number().int().min(1).max(31).nullish(),
  reminderLeadDays: z.number().int().min(1).max(28).nullish(),
});
export type CreateAccountInput = z.infer<typeof createAccountSchema>;

export const updateAccountSchema = createAccountSchema.partial().extend({
  isArchived: z.boolean().optional(),
});
export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;

// --- Categories -----------------------------------------------------------

export const createCategorySchema = z.object({
  name: z.string().min(1).max(120),
  nameBn: z.string().min(1).max(120).optional(),
  kind: z.enum(CATEGORY_KINDS),
  parentId: cuid.optional(),
  icon: z.string().max(40).optional(),
  color: z.string().max(20).optional(),
  sortOrder: z.number().int().default(0),
});
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;

// --- Ledger ---------------------------------------------------------------

export const ledgerEntrySchema = z.object({
  accountId: cuid,
  categoryId: cuid.nullish(),
  amountMinor: positiveMinorAmount,
  direction: z.enum(ENTRY_DIRECTIONS),
  currency: z.string().length(3).default('BDT'),
  fxRate: z.number().positive().default(1),
});
export type LedgerEntryInput = z.infer<typeof ledgerEntrySchema>;

export const createTransactionSchema = z.object({
  date: isoDate,
  type: z.enum(TRANSACTION_TYPES),
  description: z.string().max(500).optional(),
  notes: z.string().max(2000).optional(),
  payee: z.string().max(200).optional(),
  personId: cuid.optional(),
  projectTag: z.string().max(60).optional(),
  externalRef: z.string().max(200).optional(),
  source: z.enum(TRANSACTION_SOURCES).default('MANUAL'),
  entries: z.array(ledgerEntrySchema).min(2, 'A transaction needs at least two entries'),
});
export type CreateTransactionInput = z.infer<typeof createTransactionSchema>;

/**
 * The simple shape the UI actually posts. The server expands it into balanced
 * double-entry lines so the user never sees debits and credits.
 */
export const simpleTransactionSchema = z
  .object({
    date: isoDate,
    type: z.enum(['INCOME', 'EXPENSE', 'TRANSFER', 'ADJUSTMENT', 'OPENING_BALANCE']),
    amountMinor: positiveMinorAmount,
    accountId: cuid,
    /** Destination account — required for TRANSFER. */
    counterAccountId: cuid.optional(),
    categoryId: cuid.optional(),
    description: z.string().max(500).optional(),
    notes: z.string().max(2000).optional(),
    payee: z.string().max(200).optional(),
    externalRef: z.string().max(200).optional(),
    source: z.enum(TRANSACTION_SOURCES).default('MANUAL'),
    /* Receipt photographs. The ids come from POST /attachments, which has
     * already checked the bytes and the workspace; this only records which ones
     * belong to this entry. Loans have carried this since M12 — transactions
     * were the outlier, so a receipt attached to one silently vanished. */
    attachmentIds: z.array(cuid).max(10).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.type === 'TRANSFER') {
      if (!val.counterAccountId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['counterAccountId'],
          message: 'A transfer needs a destination account',
        });
      } else if (val.counterAccountId === val.accountId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['counterAccountId'],
          message: 'Source and destination must differ',
        });
      }
    }
    if ((val.type === 'INCOME' || val.type === 'EXPENSE') && !val.categoryId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['categoryId'],
        message: 'Choose a category',
      });
    }
  });
export type SimpleTransactionInput = z.infer<typeof simpleTransactionSchema>;

export const transactionQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  from: isoDate.optional(),
  to: isoDate.optional(),
  accountId: cuid.optional(),
  categoryId: cuid.optional(),
  type: z.enum(TRANSACTION_TYPES).optional(),
  source: z.enum(TRANSACTION_SOURCES).optional(),
  personId: cuid.optional(),
  q: z.string().max(200).optional(),
  /* Coerced, unlike `minorAmount` in a request body. A query string only ever
   * carries text, so `?minAmount=10000` arrives as "10000" and the uncoerced
   * schema answered 400 for every value — the two filters could not be used at
   * all. The integer check still applies after coercion, so a float is still
   * refused and no fractional poisha gets in. */
  minAmount: z.coerce.number().int().safe().optional(),
  maxAmount: z.coerce.number().int().safe().optional(),
});
export type TransactionQuery = z.infer<typeof transactionQuerySchema>;

/** Reconcile: user types the real balance, server books the difference. */
export const reconcileSchema = z.object({
  date: isoDate,
  actualBalanceMinor: minorAmount,
  note: z.string().max(500).optional(),
});
export type ReconcileInput = z.infer<typeof reconcileSchema>;

// --- Ingestion (M7+, defined now so the contract is stable) ----------------

export const proposedDraftSchema = z.object({
  date: isoDate,
  amountMinor: positiveMinorAmount,
  direction: z.enum(['IN', 'OUT']),
  accountId: cuid.nullish(),
  categoryId: cuid.nullish(),
  payee: z.string().max(200).nullish(),
  description: z.string().max(500).nullish(),
  personId: cuid.nullish(),
  reference: z.string().max(200).nullish(),
  currency: z.string().length(3).default('BDT'),
});
export type ProposedDraft = z.infer<typeof proposedDraftSchema>;
