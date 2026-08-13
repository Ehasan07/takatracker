import { DEFAULT_TIMEZONE, toLocalDateString } from '@hishab/shared';

/* One implementation, in `lib/format.ts`, which follows the workspace's
   language. There were ten near-identical copies of these across the app and
   every one of them hardcoded Bengali digits. The old names are re-exported so
   the call sites in this folder stay as they are. */
import { fmtDate, fmtNumber, fmtNumber as bnNum } from '@/lib/format';

export { bnNum };

/**
 * Every action `AUDIT_ACTIONS` can hold (apps/api/src/audit/audit.service.ts),
 * in the words the person who did it would use. Raw keys like
 * `transaction.updated` are engineering vocabulary; nobody reading their own
 * khata should have to decode one.
 */
export const ACTION_LABEL: Record<string, string> = {
  'auth.signup': 'অ্যাকাউন্ট খোলা হয়েছে',
  'auth.login': 'লগইন',
  'auth.login_failed': 'লগইন ব্যর্থ',
  'auth.logout': 'লগআউট',
  'auth.refresh_reuse_detected': 'পুরনো সেশন টোকেন আবার ব্যবহারের চেষ্টা',
  'auth.email_verified': 'ইমেইল যাচাই সম্পন্ন',
  'auth.verification_sent': 'যাচাইয়ের মেইল পাঠানো হয়েছে',
  'auth.password_reset_requested': 'পাসওয়ার্ড রিসেটের অনুরোধ',
  'auth.password_reset_completed': 'পাসওয়ার্ড রিসেট সম্পন্ন',
  'auth.password_changed': 'পাসওয়ার্ড বদলানো হয়েছে',
  'auth.session_revoked': 'সেশন বন্ধ করা হয়েছে',
  'auth.onboarding_completed': 'শুরুর ধাপ সম্পন্ন',
  'account.created': 'অ্যাকাউন্ট তৈরি',
  'account.updated': 'অ্যাকাউন্ট সম্পাদনা',
  'account.archived': 'অ্যাকাউন্ট আর্কাইভ',
  'transaction.created': 'লেনদেন যোগ',
  'transaction.updated': 'লেনদেন সম্পাদনা',
  'transaction.deleted': 'লেনদেন মুছে ফেলা',
  'transaction.restored': 'মুছে ফেলা লেনদেন ফেরানো',
  'transaction.reconciled': 'ব্যালেন্স মিলানো',
  'category.created': 'খাত তৈরি',
  'category.updated': 'খাত সম্পাদনা',
  'category.deleted': 'খাত মুছে ফেলা',
  'attachment.uploaded': 'সংযুক্তি আপলোড',
  'attachment.deleted': 'সংযুক্তি মুছে ফেলা',
  'import.uploaded': 'আমদানির ফাইল আপলোড',
  'import.applied': 'আমদানি সম্পন্ন',
  'import.reverted': 'আমদানি ফিরিয়ে নেওয়া',
  'export.downloaded': 'রপ্তানি ডাউনলোড',
  'data.exported': 'সব তথ্য রপ্তানি',
  'ingestion.message_received': 'বার্তা এসেছে',
  'ingestion.draft_accepted': 'খসড়া গ্রহণ',
  'ingestion.draft_rejected': 'খসড়া বাতিল',
  'loan.created': 'ঋণ যোগ',
  'loan.updated': 'ঋণ সম্পাদনা',
  'loan.deleted': 'ঋণ মুছে ফেলা',
  'loan.cancelled': 'ঋণ বাতিল',
  'loan.payment_added': 'ঋণের কিস্তি যোগ',
  'loan.payment_deleted': 'ঋণের কিস্তি মুছে ফেলা',
  'savings.plan_created': 'সঞ্চয় স্কিম তৈরি',
  'savings.plan_updated': 'সঞ্চয় স্কিম সম্পাদনা',
  'savings.plan_deleted': 'সঞ্চয় স্কিম মুছে ফেলা',
  'savings.installment_paid': 'সঞ্চয়ের কিস্তি জমা',
  'insurance.policy_created': 'বীমা পলিসি তৈরি',
  'insurance.policy_updated': 'বীমা পলিসি সম্পাদনা',
  'insurance.policy_deleted': 'বীমা পলিসি মুছে ফেলা',
  'insurance.premium_paid': 'বীমার প্রিমিয়াম জমা',
  'plan.changed': 'প্ল্যান বদলানো হয়েছে',
  'entitlement.override_changed': 'বিশেষ সুবিধা বদলানো হয়েছে',
  'notifications.telegram_bound': 'টেলিগ্রাম যুক্ত করা হয়েছে',
  'notifications.telegram_revoked': 'টেলিগ্রাম বিচ্ছিন্ন করা হয়েছে',
  'notifications.telegram_tested': 'টেলিগ্রাম পরীক্ষা',
  'notifications.settings_changed': 'নোটিফিকেশন সেটিংস বদলানো',
  'card.reminders_muted': 'কার্ডের তাগাদা বন্ধ',
  'workspace.deleted': 'কর্মক্ষেত্র মুছে ফেলা',
  'support.impersonation_started': 'সাপোর্টের প্রবেশ শুরু',
  'support.impersonation_ended': 'সাপোর্টের প্রবেশ শেষ',
};

/**
 * The filter. Fifty-odd chips would not fit a 320px screen, so the same list
 * becomes one grouped picker. Order and membership follow `AUDIT_ACTIONS`; a
 * key added to the API but not here still filters, it just reads as its raw
 * name until somebody writes the Bengali for it.
 */
export const ACTION_GROUPS: readonly { label: string; actions: readonly string[] }[] = [
  {
    label: 'লেনদেন',
    actions: [
      'transaction.created',
      'transaction.updated',
      'transaction.deleted',
      'transaction.restored',
      'transaction.reconciled',
    ],
  },
  { label: 'অ্যাকাউন্ট', actions: ['account.created', 'account.updated', 'account.archived'] },
  { label: 'খাত', actions: ['category.created', 'category.updated', 'category.deleted'] },
  {
    label: 'ঋণ',
    actions: [
      'loan.created',
      'loan.updated',
      'loan.deleted',
      'loan.cancelled',
      'loan.payment_added',
      'loan.payment_deleted',
    ],
  },
  {
    label: 'সঞ্চয়',
    actions: [
      'savings.plan_created',
      'savings.plan_updated',
      'savings.plan_deleted',
      'savings.installment_paid',
    ],
  },
  {
    label: 'বীমা',
    actions: [
      'insurance.policy_created',
      'insurance.policy_updated',
      'insurance.policy_deleted',
      'insurance.premium_paid',
    ],
  },
  {
    label: 'লগইন ও নিরাপত্তা',
    actions: [
      'auth.signup',
      'auth.login',
      'auth.login_failed',
      'auth.logout',
      'auth.password_changed',
      'auth.password_reset_requested',
      'auth.password_reset_completed',
      'auth.session_revoked',
      'auth.refresh_reuse_detected',
      'auth.email_verified',
      'auth.verification_sent',
      'auth.onboarding_completed',
    ],
  },
  {
    label: 'আমদানি ও রপ্তানি',
    actions: [
      'import.uploaded',
      'import.applied',
      'import.reverted',
      'export.downloaded',
      'data.exported',
      'attachment.uploaded',
      'attachment.deleted',
    ],
  },
  {
    label: 'বার্তা থেকে লেনদেন',
    actions: ['ingestion.message_received', 'ingestion.draft_accepted', 'ingestion.draft_rejected'],
  },
  {
    label: 'নোটিফিকেশন',
    actions: [
      'notifications.telegram_bound',
      'notifications.telegram_revoked',
      'notifications.telegram_tested',
      'notifications.settings_changed',
      'card.reminders_muted',
    ],
  },
  {
    label: 'প্ল্যান ও কর্মক্ষেত্র',
    actions: [
      'plan.changed',
      'entitlement.override_changed',
      'workspace.deleted',
      'support.impersonation_started',
      'support.impersonation_ended',
    ],
  },
];

export function actionLabel(action: string): string {
  return ACTION_LABEL[action] ?? action;
}

/** The family an action belongs to, used to pick its icon and its tint. */
export function actionFamily(action: string): string {
  return action.split('.')[0] ?? '';
}

/** Actions worth marking in red: something failed or something was destroyed. */
const ALARMING = new Set([
  'auth.login_failed',
  'auth.refresh_reuse_detected',
  'transaction.deleted',
  'category.deleted',
  'account.archived',
  'attachment.deleted',
  'loan.deleted',
  'loan.cancelled',
  'loan.payment_deleted',
  'savings.plan_deleted',
  'insurance.policy_deleted',
  'import.reverted',
  'workspace.deleted',
  'support.impersonation_started',
]);

export const isAlarming = (action: string): boolean => ALARMING.has(action);

export const ENTITY_LABEL: Record<string, string> = {
  Transaction: 'লেনদেন',
  Account: 'অ্যাকাউন্ট',
  Category: 'খাত',
  Loan: 'ঋণ',
  LoanPayment: 'ঋণের কিস্তি',
  SavingsPlan: 'সঞ্চয় স্কিম',
  SavingsInstallment: 'সঞ্চয়ের কিস্তি',
  InsurancePolicy: 'বীমা পলিসি',
  PremiumPayment: 'প্রিমিয়াম',
  ImportBatch: 'আমদানির ফাইল',
  Attachment: 'সংযুক্তি',
  IngestionMessage: 'আসা বার্তা',
  TransactionDraft: 'লেনদেনের খসড়া',
  TelegramConnection: 'টেলিগ্রাম সংযোগ',
  RefreshToken: 'সেশন',
  Workspace: 'কর্মক্ষেত্র',
  User: 'ব্যবহারকারী',
};

export const entityLabel = (entity: string | null): string =>
  entity ? (ENTITY_LABEL[entity] ?? entity) : '';

export const ACTOR_TYPE_LABEL: Record<string, string> = {
  USER: '',
  SYSTEM: 'সিস্টেম',
  SUPPORT: 'সাপোর্ট',
  INTEGRATION: 'সংযুক্ত সেবা',
};

/** Who did it. A null actor on a USER row is a signed-out attempt, not a bug. */
export function actorLabel(
  actor: { name: string } | null,
  actorType: string,
  action: string,
): string {
  if (actor?.name) return actor.name;
  const byType = ACTOR_TYPE_LABEL[actorType];
  if (byType) return byType;
  if (action === 'auth.login_failed') return 'লগইনের চেষ্টা (কে জানা যায়নি)';
  return 'অজানা';
}

// --- field names inside before / after --------------------------------------

export const FIELD_LABEL: Record<string, string> = {
  name: 'নাম',
  type: 'ধরন',
  kind: 'ধরন',
  isArchived: 'আর্কাইভ করা',
  date: 'তারিখ',
  description: 'বিবরণ',
  payee: 'কার সঙ্গে',
  note: 'নোট',
  notes: 'নোট',
  entries: 'খাতার লাইন',
  amountMinor: 'টাকার অঙ্ক',
  deltaMinor: 'পার্থক্য',
  actualBalanceMinor: 'প্রকৃত ব্যালেন্স',
  principalMinor: 'মূল টাকা',
  interestMinor: 'সুদ',
  interestRateBps: 'সুদের হার',
  interestType: 'সুদের ধরন',
  expectedMinor: 'কিস্তির অঙ্ক',
  accountId: 'অ্যাকাউন্ট',
  counterAccountId: 'অপর অ্যাকাউন্ট',
  loanAccountId: 'ঋণের অ্যাকাউন্ট',
  categoryId: 'খাত',
  direction: 'দিক',
  status: 'অবস্থা',
  method: 'মাধ্যম',
  referenceNumber: 'রেফারেন্স',
  transactionId: 'লেনদেন',
  loanId: 'ঋণ',
  loanNumber: 'ঋণ নম্বর',
  loanDate: 'ঋণের তারিখ',
  dueDate: 'ফেরতের তারিখ',
  paidDate: 'পরিশোধের তারিখ',
  personId: 'ব্যক্তি',
  planId: 'স্কিম',
  planName: 'স্কিমের নাম',
  planType: 'স্কিমের ধরন',
  installments: 'কিস্তির সংখ্যা',
  policyId: 'পলিসি',
  insurer: 'বীমা প্রতিষ্ঠান',
  premiums: 'প্রিমিয়ামের সংখ্যা',
  filename: 'ফাইলের নাম',
  mimeType: 'ফাইলের ধরন',
  sizeBytes: 'ফাইলের আকার',
  sha256: 'ফাইলের হ্যাশ',
  storagePath: 'সংরক্ষণের জায়গা',
  attachmentIds: 'সংযুক্তি',
  deleted: 'মুছে ফেলা হয়েছে',
  remainingRowsOnHash: 'একই ফাইল আর যত জায়গায় আছে',
  disbursementReversed: 'ছাড়ের লেনদেন ফেরানো হয়েছে',
  loanAccountArchived: 'ঋণের অ্যাকাউন্ট আর্কাইভ হয়েছে',
  format: 'ফরম্যাট',
  rowCount: 'সারির সংখ্যা',
  parsedRows: 'পড়া গেছে',
  errorRows: 'ভুল সারি',
  importedCount: 'আমদানি হয়েছে',
  skippedCount: 'বাদ পড়েছে',
  transactionCount: 'লেনদেনের সংখ্যা',
  from: 'শুরুর তারিখ',
  to: 'শেষ তারিখ',
  channel: 'চ্যানেল',
  parserName: 'যে পার্সার পড়েছে',
  confidence: 'নিশ্চয়তা',
  needsReview: 'যাচাই দরকার',
  draftId: 'খসড়া',
  messageId: 'বার্তা',
  reason: 'কারণ',
  via: 'যেভাবে',
  emailVerifiedByReset: 'রিসেটেই ইমেইল যাচাই হয়েছে',
  families: 'সেশনের সংখ্যা',
  tokens: 'টোকেনের সংখ্যা',
  cycleMonth: 'যে মাসের চক্র',
  ok: 'সফল হয়েছে',
};

export const fieldLabel = (key: string): string => FIELD_LABEL[key] ?? key;

/** Keys whose value is a foreign key, not something to print raw. */
export const ID_FIELDS = new Set([
  'accountId',
  'counterAccountId',
  'loanAccountId',
  'categoryId',
  'transactionId',
  'loanId',
  'personId',
  'planId',
  'policyId',
  'draftId',
  'messageId',
]);

export const DATE_FIELDS = new Set([
  'date',
  'loanDate',
  'dueDate',
  'paidDate',
  'from',
  'to',
  'cycleMonth',
]);

// --- enum values ------------------------------------------------------------

const TRANSACTION_TYPE_LABEL: Record<string, string> = {
  INCOME: 'আয়',
  EXPENSE: 'খরচ',
  TRANSFER: 'ট্রান্সফার',
  LOAN_GIVEN: 'ধার দেওয়া',
  LOAN_REPAID: 'ধার আদায়',
  BORROWED: 'ধার নেওয়া',
  BORROW_REPAID: 'ধার পরিশোধ',
  SAVINGS_DEPOSIT: 'সঞ্চয়ে জমা',
  SAVINGS_WITHDRAWAL: 'সঞ্চয় থেকে তোলা',
  PREMIUM_PAID: 'প্রিমিয়াম পরিশোধ',
  ADJUSTMENT: 'সমন্বয়',
  OPENING_BALANCE: 'প্রারম্ভিক জের',
};

const ACCOUNT_TYPE_LABEL: Record<string, string> = {
  CASH: 'নগদ',
  BANK: 'ব্যাংক',
  MOBILE_WALLET: 'মোবাইল ওয়ালেট',
  CREDIT_CARD: 'ক্রেডিট কার্ড',
  SAVINGS: 'সঞ্চয় / ডিপিএস',
  RECEIVABLE: 'পাওনা',
  PAYABLE: 'দেনা',
  ASSET: 'সম্পদ',
  LIABILITY: 'ঋণ / দায়',
  EQUITY: 'মূলধন',
};

const DIRECTION_LABEL: Record<string, string> = {
  DEBIT: 'ডেবিট',
  CREDIT: 'ক্রেডিট',
  LENT: 'ধার দিয়েছি',
  BORROWED: 'ধার নিয়েছি',
};

const STATUS_LABEL: Record<string, string> = {
  ACTIVE: 'চলমান',
  OVERDUE: 'মেয়াদোত্তীর্ণ',
  COMPLETED: 'সম্পন্ন',
  CANCELLED: 'বাতিল',
  PENDING: 'বাকি',
  PAID: 'পরিশোধিত',
  SKIPPED: 'বাদ দেওয়া',
  MATURED: 'মেয়াদপূর্ণ',
  LAPSED: 'বাতিল হয়ে গেছে',
  DRAFT: 'খসড়া',
  PARSED: 'পড়া হয়েছে',
  APPLIED: 'প্রয়োগ হয়েছে',
  REVERTED: 'ফিরিয়ে নেওয়া',
  FAILED: 'ব্যর্থ',
};

const METHOD_LABEL: Record<string, string> = {
  CASH: 'নগদ',
  BANK: 'ব্যাংক',
  MOBILE_WALLET: 'মোবাইল ওয়ালেট',
  CHEQUE: 'চেক',
  CARD: 'কার্ড',
  OTHER: 'অন্যান্য',
};

const KIND_LABEL: Record<string, string> = { INCOME: 'আয়', EXPENSE: 'খরচ' };

/**
 * A code becomes Bengali only when we are sure what it means. `direction` says
 * DEBIT on a ledger leg and BORROWED on a loan; both are covered, and anything
 * unrecognised is returned untouched rather than guessed at.
 */
export function enumLabel(key: string, value: string): string {
  const table =
    key === 'type'
      ? { ...ACCOUNT_TYPE_LABEL, ...TRANSACTION_TYPE_LABEL }
      : key === 'kind'
        ? KIND_LABEL
        : key === 'direction'
          ? DIRECTION_LABEL
          : key === 'status'
            ? STATUS_LABEL
            : key === 'method'
              ? METHOD_LABEL
              : key === 'interestType'
                ? { NONE: 'সুদ নেই', FIXED: 'নির্দিষ্ট টাকা', PERCENT: 'শতকরা হার' }
                : null;
  return table?.[value] ?? value;
}

export const legDirectionLabel = (value: string | null): string =>
  value ? (DIRECTION_LABEL[value] ?? value) : '';

// --- numbers, dates and times ------------------------------------------------

/**
 * "১৫ জুলাই ২০২৬", tolerant of a YYYY-MM or a full timestamp.
 * `fromLocalDateString` throws on anything else, and a malformed date in one
 * old row must not blank the whole log.
 */
import { fmtDateish as bnDateish } from '@/lib/format';

export { bnDateish };

/** Basis points as a percentage: 1250 → "১২.৫%". Integer maths, no rounding. */
export function bpsToPercent(bps: number): string {
  const whole = Math.trunc(Math.abs(bps) / 100);
  const frac = Math.abs(bps) % 100;
  const sign = bps < 0 ? '-' : '';
  const tail = frac === 0 ? '' : `.${String(frac).padStart(2, '0').replace(/0$/, '')}`;
  return `${sign}${fmtNumber(`${whole}${tail}`)}%`;
}

export function bnBytes(bytes: number): string {
  const n = Math.trunc(Math.abs(bytes));
  if (n < 1024) return `${bnNum(n)} বাইট`;
  if (n < 1024 * 1024) return `${bnNum(Math.trunc(n / 1024))} কিলোবাইট`;
  return `${bnNum(Math.trunc(n / (1024 * 1024)))} মেগাবাইট`;
}

/** The workspace day an event belongs to. Grouping must follow Dhaka, not UTC. */
export function dayKey(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'অজানা';
  return toLocalDateString(at, DEFAULT_TIMEZONE);
}

export function dayHeading(key: string): string {
  if (key === 'অজানা') return 'তারিখ জানা নেই';
  const today = toLocalDateString(new Date(), DEFAULT_TIMEZONE);
  const yesterday = toLocalDateString(new Date(Date.now() - 86_400_000), DEFAULT_TIMEZONE);
  if (key === today) return 'আজ';
  if (key === yesterday) return 'গতকাল';
  try {
    return fmtDate(key);
  } catch {
    return fmtNumber(key);
  }
}

/** "১৪:০৫" in Dhaka time — the log is minute-precise and that matters here. */
export function bnTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  return fmtNumber(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: DEFAULT_TIMEZONE,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(at),
  );
}

/**
 * When `trust proxy` was fixed (commit 2d7d4c6, 2026-08-09 15:19 +06).
 *
 * Before this, Express read the socket address rather than the address nginx
 * actually saw, so every `ip` on an older row is the proxy's own — usually
 * 127.0.0.1. Those values are shown, because deleting a field from an
 * append-only log on the way to the screen is its own kind of lie, but they
 * are labelled so nobody reads one as the address a person logged in from.
 */
export const IP_TRUSTED_FROM = Date.parse('2026-08-09T09:19:01.000Z');

export function ipIsTrustworthy(createdAt: string): boolean {
  const at = Date.parse(createdAt);
  return Number.isFinite(at) && at >= IP_TRUSTED_FROM;
}

/** A record we cannot name: the tail of its id, never the whole thing. */
export const shortId = (id: string): string => `#${id.slice(-6)}`;
