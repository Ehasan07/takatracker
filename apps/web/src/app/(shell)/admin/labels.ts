import {
  ACTION_GROUPS as TENANT_ACTION_GROUPS,
  actionLabel as tenantActionLabel,
  entityLabel as tenantEntityLabel,
} from '../audit/labels';
import type { TenantFeature } from './types';

/* One implementation, in `lib/format.ts`, which follows the workspace's
   language. Re-exported under the old name so the call sites stay as they are. */
import { fmtNumber as bnNum } from '@/lib/format';

export { bnNum };

/**
 * A quantity that may not be whole.
 *
 * `attachments.storage.mb` arrives as a two-decimal number, so a `bnNum` over a
 * truncated integer would print "৪৯ মেগাবাইট" for 49.97 and make a tenant look
 * further from its ceiling than it is.
 *
 * The decimals are sliced off the *string*, not computed. `(49.97 - 49) * 100`
 * is 96.99999999999999 in binary floating point, and truncating that prints
 * ৪৯.৯৬ — a wrong number, quietly, on a screen whose job is to be believed.
 * `String()` round-trips exactly what the server sent.
 */
export function bnCount(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (Number.isInteger(value)) return bnNum(value);
  const text = String(Math.abs(value));
  // Exponent form has no decimal point to slice. Nothing reports a count in
  // exponent form; if one arrives, the whole part is the honest answer.
  if (text.includes('e')) return bnNum(Math.trunc(value));
  const [whole = '0', decimals = ''] = text.split('.');
  const fraction = decimals.slice(0, 2).replace(/0+$/, '');
  const sign = value < 0 ? '-' : '';
  return `${sign}${bnNum(whole)}${fraction === '' ? '' : `.${bnNum(fraction)}`}`;
}

/**
 * A 0–1 ratio as a whole percent, truncated.
 *
 * The epsilon is not rounding: `0.29 * 100` is 28.999999999999996, and a bare
 * truncation would report ২৮% for a number the server called 0.29. It corrects
 * the representation, not the value — 1e-9 is nine orders of magnitude below
 * anything this can display.
 */
export const percentOf = (ratio: number): number => Math.floor(ratio * 100 + 1e-9);

const KIB = 1024;
const MIB = 1024 * 1024;
const GIB = 1024 * 1024 * 1024;

/** `n / unit` to one decimal place, by integer arithmetic only. */
function oneDecimal(n: number, unit: number): string {
  const whole = Math.trunc(n / unit);
  const tenths = Math.trunc(((n % unit) * 10) / unit);
  return tenths === 0 ? bnNum(whole) : `${bnNum(whole)}.${bnNum(tenths)}`;
}

/** Disk, in Bengali units. Never a raw byte count above a kilobyte. */
export function bnBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '—';
  const n = Math.trunc(Math.abs(bytes));
  if (n < KIB) return `${bnNum(n)} বাইট`;
  if (n < MIB) return `${bnNum(Math.trunc(n / KIB))} কিলোবাইট`;
  if (n < GIB) return `${oneDecimal(n, MIB)} মেগাবাইট`;
  return `${oneDecimal(n, GIB)} গিগাবাইট`;
}

export function bnPercent(ratio: number): string {
  if (!Number.isFinite(ratio)) return '—';
  return `${bnNum(percentOf(ratio))}%`;
}

/** "১০ আগস্ট ২০২৬", tolerant of a malformed row. */
/* One implementation, in `lib/format.ts`, which follows the workspace's
   language. There were ten near-identical copies of these across the app and
   every one of them hardcoded Bengali digits. The old names are re-exported so
   the call sites in this folder stay as they are.

   `bnDate` here is the *timestamp* one — an operator screen's rows are events,
   not ledger days — so it maps to `fmtStamp` rather than to `fmtDate`. */
import { fmtStamp as bnDate, fmtStampTime as bnDateTime, fmtTime as bnTime } from '@/lib/format';

export { bnDate, bnDateTime, bnTime };

/** How long until `iso`, in words. Negative reads as "expired". */
export function bnRemaining(iso: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '—';
  const seconds = Math.trunc((at - Date.now()) / 1000);
  if (seconds <= 0) return 'মেয়াদ শেষ';
  const minutes = Math.trunc(seconds / 60);
  if (minutes < 1) return `${bnNum(seconds)} সেকেন্ড বাকি`;
  const secondsLeft = seconds % 60;
  return `${bnNum(minutes)} মিনিট ${bnNum(String(secondsLeft).padStart(2, '0'))} সেকেন্ড বাকি`;
}

// --- workspaces ---------------------------------------------------------------

export const WORKSPACE_STATUS_LABEL: Record<string, string> = {
  TRIALING: 'ট্রায়ালে',
  ACTIVE: 'সক্রিয়',
  PAST_DUE: 'বকেয়া',
  SUSPENDED: 'স্থগিত',
  CANCELLED: 'বাতিল',
};

export const workspaceStatusLabel = (status: string): string =>
  WORKSPACE_STATUS_LABEL[status] ?? status;

/** '' is "everything" — the API reads an empty status as no filter. */
export const STATUS_FILTERS: readonly (readonly [string, string])[] = [
  ['', 'সব'],
  ['ACTIVE', 'সক্রিয়'],
  ['TRIALING', 'ট্রায়ালে'],
  ['PAST_DUE', 'বকেয়া'],
  ['SUSPENDED', 'স্থগিত'],
  ['CANCELLED', 'বাতিল'],
];

export const ROLE_LABEL: Record<string, string> = {
  OWNER: 'মালিক',
  ADMIN: 'অ্যাডমিন',
  MEMBER: 'সদস্য',
  VIEWER: 'দর্শক',
};

export const roleLabel = (role: string): string => ROLE_LABEL[role] ?? role;

export const MEMBER_STATUS_LABEL: Record<string, string> = {
  ACTIVE: 'সক্রিয়',
  INVITED: 'আমন্ত্রিত',
  SUSPENDED: 'স্থগিত',
  REMOVED: 'সরানো',
};

export const memberStatusLabel = (status: string): string => MEMBER_STATUS_LABEL[status] ?? status;

// --- features ------------------------------------------------------------------

/**
 * What to print for a feature.
 *
 * `labelBn` is the Bengali column and `label` the English one — the opposite way
 * round from `/v1/entitlements/features`, whose `label` is already Bengali. This
 * screen reads the admin shape, so Bengali first, then the English label, then
 * the raw key. A key is a poor name but it is never a blank cell.
 */
export const featureName = (feature: TenantFeature): string =>
  feature.labelBn !== '' ? feature.labelBn : feature.label !== '' ? feature.label : feature.key;

export function unitSuffix(unit: string | undefined): string {
  if (unit === 'megabytes') return ' মেগাবাইট';
  if (unit === 'tokens') return ' টোকেন';
  if (unit === 'per-month') return 'টি / মাস';
  return 'টি';
}

export const CATEGORY_LABEL: Record<string, string> = {
  core: 'মূল',
  ingest: 'বার্তা ও আমদানি',
  ai: 'এআই',
  integrations: 'সংযোগ',
};

export const categoryLabel = (category: string): string => CATEGORY_LABEL[category] ?? category;

export const PERIOD_LABEL: Record<string, string> = {
  LIFETIME: 'আজীবন',
  MONTHLY: 'মাসিক',
  DAILY: 'দৈনিক',
};

export const periodLabel = (period: string): string => PERIOD_LABEL[period] ?? period;

/**
 * A ceiling, in words. Three states that must never look the same:
 *
 *   `null` unlimited
 *   `0`    switched off — and on a FLAG that is "the feature is not on"
 *   n      an actual ceiling
 */
export function limitText(limitValue: number | null, kind: string, unit: string): string {
  if (limitValue === null) return 'সীমাহীন';
  if (limitValue === 0) return kind === 'FLAG' ? 'বন্ধ' : 'বন্ধ (০)';
  if (kind === 'FLAG') return 'চালু';
  return `${bnCount(limitValue)}${unitSuffix(unit)}`;
}

/** What the operator is told when nothing counts a feature. */
export const UNMEASURED = 'গোনা হয় না';

// --- the cross-tenant log --------------------------------------------------------

/**
 * The eight strings `admin-audit.ts` writes, plus the two support ones.
 *
 * Everything else defers to `audit/labels.ts`, which already carries the whole
 * tenant-facing vocabulary. Importing it rather than copying sixty rows is the
 * one place this folder reaches into a sibling: an action renamed there would
 * otherwise read as a raw key here and nobody would notice.
 */
export const ADMIN_ACTION_LABEL: Record<string, string> = {
  'admin.overview_viewed': 'প্ল্যাটফর্মের সারসংক্ষেপ দেখা হয়েছে',
  'admin.tenant_list_viewed': 'ওয়ার্কস্পেসের তালিকা দেখা হয়েছে',
  'admin.tenant_viewed': 'একটি ওয়ার্কস্পেস দেখা হয়েছে',
  'admin.audit_viewed': 'কার্যবিবরণী দেখা হয়েছে',
  'admin.plan_assigned': 'প্ল্যান বসানো হয়েছে',
  'admin.feature_overridden': 'সীমা ওভাররাইড করা হয়েছে',
  'admin.tenant_suspended': 'ওয়ার্কস্পেস স্থগিত করা হয়েছে',
  'admin.tenant_reactivated': 'ওয়ার্কস্পেস পুনরায় সক্রিয় করা হয়েছে',
};

export const actionLabel = (action: string): string =>
  ADMIN_ACTION_LABEL[action] ?? tenantActionLabel(action);

export const ADMIN_ENTITY_LABEL: Record<string, string> = {
  Platform: 'প্ল্যাটফর্ম',
  WorkspaceFeatureOverride: 'সীমার ওভাররাইড',
  AuditEvent: 'কার্যবিবরণীর সারি',
};

export const entityLabel = (entity: string | null): string =>
  entity ? (ADMIN_ENTITY_LABEL[entity] ?? tenantEntityLabel(entity)) : '';

/** Operator actions first: they are the ones this screen exists to review. */
export const ACTION_GROUPS: readonly { label: string; actions: readonly string[] }[] = [
  {
    label: 'প্ল্যাটফর্ম অপারেশন',
    actions: [
      ...Object.keys(ADMIN_ACTION_LABEL),
      'support.impersonation_started',
      'support.impersonation_ended',
    ],
  },
  ...TENANT_ACTION_GROUPS,
];

/** Actions worth marking in red on an operator's screen. */
const ALARMING = new Set([
  'admin.tenant_suspended',
  'admin.feature_overridden',
  'admin.plan_assigned',
  'support.impersonation_started',
  'auth.login_failed',
  'auth.refresh_reuse_detected',
  'workspace.deleted',
]);

export const isAlarming = (action: string): boolean => ALARMING.has(action);

export const ACTOR_TYPE_LABEL: Record<string, string> = {
  USER: 'ব্যবহারকারী',
  SYSTEM: 'সিস্টেম',
  SUPPORT: 'অপারেটর',
  INTEGRATION: 'সংযুক্ত সেবা',
};

export const actorTypeLabel = (actorType: string): string =>
  ACTOR_TYPE_LABEL[actorType] ?? actorType;

/** A record we cannot name: the tail of its id, never the whole thing. */
export const shortId = (id: string): string => `#${id.slice(-6)}`;
