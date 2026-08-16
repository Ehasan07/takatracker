import { z } from 'zod';
import { normaliseBdPhone } from './phone.js';
import { DEFAULT_CURRENCY, isSupportedCurrency } from './currency.js';
import {
  ACCOUNT_TYPES,
  CATEGORY_KINDS,
  DEVICE_KINDS,
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
  /**
   * The mobile number, and now required.
   *
   * In Bangladesh this is the identity — it is what somebody remembers, what
   * they already sign in to bKash and Nagad with, and what they will type here
   * first. It was optional and never asked for, so all fourteen live accounts
   * have none.
   *
   * Refused rather than stored verbatim when it is not a recognisable BD
   * mobile: this one is a *credential*, not a contact note. `Person.phone`
   * keeps the opposite rule — an unparseable number there is still the best
   * record of how to reach somebody — and the two differ on purpose.
   */
  phone: z
    .string()
    .transform((value) => normaliseBdPhone(value))
    .refine((value): value is string => value !== null, {
      message: 'বাংলাদেশি মোবাইল নম্বর দিন — যেমন ০১৭১২৩৪৫৬৭৮',
    }),
  locale: z.enum(LOCALES).default('bn'),
  /**
   * ISO 4217, chosen on the signup form.
   *
   * Validated against the catalogue rather than as a bare three-letter string:
   * the code decides how many minor units are in a major one, so an unknown
   * value would be stored, silently fall back to taka's 100 at render time, and
   * make every figure in that workspace wrong by a factor nobody could see.
   */
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .refine(isSupportedCurrency, 'এই কারেন্সিটি সমর্থিত নয়')
    .default(DEFAULT_CURRENCY),
  /** Which "add to home screen" instructions this person will need. */
  device: z.enum(DEVICE_KINDS).optional(),
  timezone: z.string().default('Asia/Dhaka'),
});
export type SignupInput = z.infer<typeof signupSchema>;

/**
 * Sign in with either identifier.
 *
 * `identifier` rather than `email`, because a Bangladeshi user reaches for
 * their mobile number first and being told "enter a valid email" when they
 * typed a real, working number is the kind of wall that ends a session. The
 * server decides which one it is; see `AuthService.login`.
 *
 * `email` is still accepted as a field name so that anything already posting
 * the old shape — a saved password manager entry, an open tab — keeps working.
 */
export const loginSchema = z
  .object({
    identifier: z.string().trim().min(1).max(200).optional(),
    email: z.string().trim().min(1).max(200).optional(),
    password: z.string().min(1),
  })
  .transform((value) => ({
    identifier: value.identifier ?? value.email ?? '',
    password: value.password,
  }))
  .refine((value) => value.identifier !== '', {
    message: 'ইমেইল বা মোবাইল নম্বর দিন',
    path: ['identifier'],
  });
export type LoginInput = z.infer<typeof loginSchema>;

export const refreshSchema = z.object({ refreshToken: z.string().min(1) });

// --- Accounts -------------------------------------------------------------

export const createAccountSchema = z.object({
  name: z.string().min(1).max(120),
  type: z.enum(ACCOUNT_TYPES),
  currency: z.string().length(3).default('BDT'),
  /**
   * What was already in the account before this ledger starts.
   *
   * Still `openingBalance`, still poisha, still signed the way every balance in
   * this system is signed — a ৳15,000 debt is −1,500,000. What changed is what
   * happens to it: the server books a dated `OPENING_BALANCE` transaction
   * against the workspace's equity account instead of writing a column nothing
   * else can see. The field is kept so the web app, the onboarding wizard and
   * the CSV importer did not all have to change on the same day.
   */
  openingBalance: minorAmount.default(0),
  /**
   * The day the opening balance was true. Defaults to today.
   *
   * The whole reason this field exists: the old column carried no date, so a
   * balance sheet dated last January showed an opening balance for an account
   * opened in June, and two periods were not comparable (IAS 1.38). A balance
   * has to belong to a day before a dated report can decide whether to count
   * it. Ignored when `openingBalance` is zero — there is nothing to date.
   */
  openingBalanceDate: isoDate.optional(),
  institution: z.string().max(120).optional(),
  accountNumberMasked: z.string().max(60).optional(),
  matchHints: z.array(z.string().max(60)).max(20).default([]),
  icon: z.string().max(40).optional(),
  color: z.string().max(20).optional(),
  sortOrder: z.number().int().default(0),
  /* Credit cards only. What the bank allows the card to carry.
   *
   * Recorded so the app can say what could be spent today, and never added to
   * anything: an undrawn limit is money the bank still holds and may withdraw,
   * so it is not cash under IAS 7.6 and not a resource the Conceptual Framework
   * would call controlled. IAS 7.50(a) — disclosed, not recognised. */
  creditLimitMinor: minorAmount.nonnegative().default(0),
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
  /**
   * The head this sits under, or `null` for a top-level one.
   *
   * Nullish rather than merely optional because on `PATCH` the three cases are
   * genuinely different: absent means *leave the parent as it is*, `null` means
   * *promote this to the top*, and an id means *move it under that one*. With
   * `.optional()` there was no way to say the second, so a sub-khat could be
   * moved sideways and never back out.
   */
  parentId: cuid.nullish(),
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
    /* Tags, not a category. The category says *what* the money went on; a tag
     * says who for or what project, and a transaction can carry several. */
    tagIds: z.array(cuid).max(20).optional(),
    /* Who the money was with — the shopkeeper, the tenant, the friend.
     *
     * The column and the `?personId=` filter have both existed since loans
     * shipped, but only the loan module ever wrote it, so `/people` counted
     * zero transactions against everyone who had no loan and the khata's person
     * filter could not find a single manual entry. Distinct from `payee`, which
     * is free text nothing can group by, and from a tag, which labels the
     * purpose rather than the counterparty.
     *
     * `nullish` rather than `optional`, because an edit has to be able to say
     * "nobody" as well as "unchanged": omitted leaves the row's person alone,
     * `null` detaches it. Same rule as `tagIds` and `attachmentIds`. */
    personId: cuid.nullish(),
    /* What the money actually was, when it was not the workspace's own.
     *
     * `amountMinor` above stays in the workspace's currency — the ledger, the
     * balances and the reports are all single-currency and stay that way. These
     * two record the original beside it, so a ৳11,000 line can still say it was
     * $100. The rate is the ratio of the two and is never stored: a rate is the
     * one number here that cannot be an integer. */
    fxCurrency: z
      .string()
      .trim()
      .toUpperCase()
      .refine(isSupportedCurrency, 'এই কারেন্সিটি সমর্থিত নয়')
      .nullish(),
    fxAmountMinor: positiveMinorAmount.nullish(),
    /* How much of a thing, beside how much it cost.
     *
     * Thousandths, integer: half a kilo is 500. "৳12,000 on fuel this year" is
     * a number the ledger already gives; "340 litres" is the one a household
     * acts on, because a price rise and a habit change look identical in taka
     * and completely different in litres.
     *
     * The unit is free text on purpose — কেজি, লিটার, পিস, ডজন, হালি, বস্তা are
     * all real and no fixed list survives contact with a Bangladeshi kitchen. */
    quantityMilli: z.number().int().positive().max(1_000_000_000).nullish(),
    quantityUnit: z.string().trim().max(20).nullish(),
  })
  .superRefine((val, ctx) => {
    /* Both or neither. One without the other is a half-recorded fact: a
     * currency with no amount says nothing, and an amount with no currency is a
     * number whose units are unknown — which is worse than not recording it. */
    /* A quantity with no unit is a bare number nobody can read back, and a
     * unit with no quantity says nothing at all. Both or neither, the same rule
     * the currency pair follows. */
    if ((val.quantityMilli == null) !== (val.quantityUnit == null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['quantityUnit'],
        message: 'পরিমাণ আর একক — দুটোই দিতে হবে, অথবা কোনোটিই নয়',
      });
    }
    if ((val.fxCurrency == null) !== (val.fxAmountMinor == null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fxAmountMinor'],
        message: 'মূল মুদ্রা আর মূল অঙ্ক — দুটোই দিতে হবে, অথবা কোনোটিই নয়',
      });
    }
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
  tagId: cuid.optional(),
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

/**
 * What an asset is worth now.
 *
 * `valueMinor` is the new value, not the change: somebody looking at a plot of
 * land knows what it is worth today and does not know what it was carried at.
 * Asking for the difference would make them do arithmetic to avoid doing
 * arithmetic. Negative is allowed for a liability, whose value is negative.
 */
export const revalueSchema = z.object({
  valueMinor: z.number().int(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'তারিখ YYYY-MM-DD আকারে দিন'),
  note: z.string().trim().max(500).optional(),
});
export type RevalueInput = z.infer<typeof revalueSchema>;

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
