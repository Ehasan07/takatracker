/**
 * What a workspace is allowed to do.
 *
 * This module is the single source of truth (v3 §A2). The API enforces limits
 * by calling it and the UI renders limit states by calling it — neither one
 * reimplements a rule, because a client-side copy of a paywall is how a paywall
 * gets out of step with the server that actually charges people.
 *
 * Pure functions, zero framework imports: the same code runs in the API, the
 * browser and React Native.
 */

/** A numeric ceiling, or a plain on/off switch. */
export type FeatureKind = 'LIMIT' | 'FLAG';

export interface FeatureDefinition {
  key: FeatureKey;
  kind: FeatureKind;
  /** Bengali label for limit messages and the plan comparison table. */
  label: string;
  /** How usage is counted. Informational; the API supplies the number. */
  unit?: 'count' | 'per-month' | 'megabytes' | 'tokens';
}

export const FEATURE_KEYS = [
  'accounts.max',
  'transactions.monthly.max',
  'members.max',
  'ingest.channels',
  'ingest.messages.monthly.max',
  'ai.tokens.monthly.max',
  'attachments.storage.mb',
  'email.connections.max',
  'ai.reports.enabled',
  'export.enabled',
  'sms.channel',
  'notifications.telegram',
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

export const FEATURES: Record<FeatureKey, FeatureDefinition> = {
  'accounts.max': { key: 'accounts.max', kind: 'LIMIT', label: 'অ্যাকাউন্ট', unit: 'count' },
  'transactions.monthly.max': {
    key: 'transactions.monthly.max',
    kind: 'LIMIT',
    label: 'মাসিক লেনদেন',
    unit: 'per-month',
  },
  'members.max': { key: 'members.max', kind: 'LIMIT', label: 'সদস্য', unit: 'count' },
  'ingest.channels': {
    key: 'ingest.channels',
    kind: 'LIMIT',
    label: 'ইনজেস্ট চ্যানেল',
    unit: 'count',
  },
  'ingest.messages.monthly.max': {
    key: 'ingest.messages.monthly.max',
    kind: 'LIMIT',
    label: 'মাসিক বার্তা',
    unit: 'per-month',
  },
  'ai.tokens.monthly.max': {
    key: 'ai.tokens.monthly.max',
    kind: 'LIMIT',
    label: 'মাসিক AI টোকেন',
    unit: 'tokens',
  },
  'attachments.storage.mb': {
    key: 'attachments.storage.mb',
    kind: 'LIMIT',
    label: 'সংযুক্তি স্টোরেজ',
    unit: 'megabytes',
  },
  'email.connections.max': {
    key: 'email.connections.max',
    kind: 'LIMIT',
    label: 'মেইলবক্স সংযোগ',
    unit: 'count',
  },
  'ai.reports.enabled': { key: 'ai.reports.enabled', kind: 'FLAG', label: 'AI রিপোর্ট' },
  'export.enabled': { key: 'export.enabled', kind: 'FLAG', label: 'এক্সপোর্ট' },
  'sms.channel': { key: 'sms.channel', kind: 'FLAG', label: 'SMS চ্যানেল' },
  'notifications.telegram': {
    key: 'notifications.telegram',
    kind: 'FLAG',
    label: 'টেলিগ্রাম নোটিফিকেশন',
  },
};

export function isFeatureKey(value: string): value is FeatureKey {
  return (FEATURE_KEYS as readonly string[]).includes(value);
}

/**
 * `null` means unlimited. For a FLAG, 0 is off and anything else is on.
 * This is the shape v3 §A2 specifies for `PlanFeature.limitValue`.
 */
export type LimitValue = number | null;

export type Entitlements = ReadonlyMap<FeatureKey, LimitValue>;

export interface PlanFeatureRow {
  featureKey: string;
  limitValue: LimitValue;
}

export interface OverrideRow extends PlanFeatureRow {
  expiresAt?: Date | null;
}

// --- Plan catalogue ---------------------------------------------------------

export interface PlanDefinition {
  code: string;
  name: string;
  /** Integer poisha, like every other amount in the system. */
  priceMinor: number;
  interval: 'MONTHLY' | 'YEARLY';
  isPublic: boolean;
  sortOrder: number;
  features: Record<FeatureKey, LimitValue>;
}

/**
 * The plans, defined in code rather than in a migration, so changing what a
 * tier includes is a pull request rather than a schema change. The API upserts
 * these at boot.
 *
 * PRICES ARE PLACEHOLDERS until tiers and pricing are decided — see
 * docs/PLAN.md §6. Nothing charges money yet; M31 is where billing lands.
 */
export const DEFAULT_PLANS: readonly PlanDefinition[] = [
  {
    code: 'FREE',
    name: 'ফ্রি',
    priceMinor: 0,
    interval: 'MONTHLY',
    isPublic: true,
    sortOrder: 10,
    features: {
      'accounts.max': 5,
      'transactions.monthly.max': 300,
      'members.max': 1,
      'ingest.channels': 1,
      'ingest.messages.monthly.max': 100,
      'ai.tokens.monthly.max': 0,
      'attachments.storage.mb': 50,
      'email.connections.max': 0,
      'ai.reports.enabled': 0,
      'export.enabled': 0,
      'sms.channel': 0,
      'notifications.telegram': 1,
    },
  },
  {
    code: 'PRO',
    name: 'প্রো',
    priceMinor: 49_900,
    interval: 'MONTHLY',
    isPublic: true,
    sortOrder: 20,
    features: {
      'accounts.max': null,
      'transactions.monthly.max': null,
      'members.max': 5,
      'ingest.channels': null,
      'ingest.messages.monthly.max': 2_000,
      'ai.tokens.monthly.max': 300_000,
      'attachments.storage.mb': 2_000,
      'email.connections.max': 3,
      'ai.reports.enabled': 1,
      'export.enabled': 1,
      // Owner-only, and never on a public plan (v3 §B2). Granted per workspace
      // through an override, with a note recording why.
      'sms.channel': 0,
      'notifications.telegram': 1,
    },
  },
];

export const DEFAULT_PLAN_CODE = 'FREE';

export function findPlan(code: string): PlanDefinition | undefined {
  return DEFAULT_PLANS.find((p) => p.code === code);
}

/** What a workspace gets when it has no plan at all — the free tier, not everything. */
export function fallbackEntitlements(): Entitlements {
  const free = findPlan(DEFAULT_PLAN_CODE);
  return new Map(Object.entries(free?.features ?? {}) as [FeatureKey, LimitValue][]);
}

// --- Resolution -------------------------------------------------------------

/**
 * Plan features, then per-workspace overrides on top. An expired override is
 * ignored, so a temporary grant lapses on its own rather than needing a job to
 * clean it up.
 */
export function resolveEntitlements(
  planFeatures: readonly PlanFeatureRow[],
  overrides: readonly OverrideRow[] = [],
  now: Date = new Date(0),
): Entitlements {
  const resolved = new Map<FeatureKey, LimitValue>(fallbackEntitlements());

  for (const row of planFeatures) {
    if (isFeatureKey(row.featureKey)) resolved.set(row.featureKey, row.limitValue);
  }

  for (const row of overrides) {
    if (!isFeatureKey(row.featureKey)) continue;
    if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) continue;
    resolved.set(row.featureKey, row.limitValue);
  }

  return resolved;
}

export function limitFor(entitlements: Entitlements, key: FeatureKey): LimitValue {
  return entitlements.has(key)
    ? (entitlements.get(key) ?? null)
    : (fallbackEntitlements().get(key) ?? null);
}

/**
 * Is this feature available at all?
 *
 * A FLAG is on unless it is explicitly 0. A LIMIT of 0 means the feature is
 * switched off — a plan with `email.connections.max: 0` cannot connect a
 * mailbox, which is a different statement from "unlimited".
 */
export function can(entitlements: Entitlements, key: FeatureKey): boolean {
  const limit = limitFor(entitlements, key);
  if (limit === null) return true;
  return limit > 0;
}

/** How much headroom is left. `Infinity` when the feature is unlimited. */
export function remaining(entitlements: Entitlements, key: FeatureKey, used: number): number {
  const limit = limitFor(entitlements, key);
  if (limit === null) return Infinity;
  return Math.max(0, limit - used);
}

/** Would one more unit of usage still be within the plan? */
export function isWithinLimit(
  entitlements: Entitlements,
  key: FeatureKey,
  used: number,
  wanted = 1,
): boolean {
  const limit = limitFor(entitlements, key);
  if (limit === null) return true;
  return used + wanted <= limit;
}

export interface LimitBreach {
  featureKey: FeatureKey;
  label: string;
  limit: number;
  used: number;
}

/**
 * The machine-readable body of a 402 (v3 §A2), so the client can say "you have
 * used all 5 of your accounts" rather than showing a generic failure.
 */
export function describeBreach(
  entitlements: Entitlements,
  key: FeatureKey,
  used: number,
): LimitBreach | null {
  const limit = limitFor(entitlements, key);
  if (limit === null) return null;
  return { featureKey: key, label: FEATURES[key].label, limit, used };
}

/** Everything the UI needs to render usage, in one serialisable object. */
export function entitlementsToJson(entitlements: Entitlements): Record<string, LimitValue> {
  const out: Record<string, LimitValue> = {};
  for (const key of FEATURE_KEYS) out[key] = limitFor(entitlements, key);
  return out;
}

export function entitlementsFromJson(json: Record<string, LimitValue>): Entitlements {
  const map = new Map<FeatureKey, LimitValue>(fallbackEntitlements());
  for (const [key, value] of Object.entries(json)) {
    if (isFeatureKey(key)) map.set(key, value);
  }
  return map;
}
