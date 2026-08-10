/**
 * What a workspace is allowed to do.
 *
 * This module is the single source of truth for the *rules* (v3 §A2): the API
 * enforces limits by calling it and the UI renders limit states by calling it,
 * so neither one reimplements a rule — a client-side copy of a paywall is how a
 * paywall gets out of step with the server that actually charges people.
 *
 * It is no longer the source of truth for the *catalogue*. `FEATURE_KEYS` used
 * to be a `const` tuple and `FeatureKey` a union derived from it, which meant
 * every sellable feature was baked into the build: a super admin could not
 * assemble a Custom package without a deployment, which is the entire point of
 * having packages. The catalogue now lives in the `Feature` table. What stays
 * here is `DEFAULT_FEATURES` — the rows the API upserts at boot so a fresh
 * install works and every environment converges on the same starting set.
 *
 * Pure functions, zero framework imports: the same code runs in the API, the
 * browser and React Native.
 */

import { startOfMonth, toLocalDateString } from '@hishab/shared';

// --- The catalogue ----------------------------------------------------------

/**
 * A numeric ceiling, a plain on/off switch, or a ceiling that refills.
 *
 * QUOTA exists in the database enum and is accepted here so a runtime-created
 * feature can use it. None of the shipped defaults are QUOTA yet — see
 * DEFAULT_FEATURES for why.
 */
export type FeatureKind = 'LIMIT' | 'FLAG' | 'QUOTA';

/** Which bucket a usage meter writes into. Mirrors `MeterPeriod` in Prisma. */
export type MeterPeriod = 'LIFETIME' | 'MONTHLY' | 'DAILY';

/**
 * A feature key is a plain string.
 *
 * WHY it is not a union any more: the catalogue is data. A key that only exists
 * because a super admin created it five minutes ago cannot be in a type that
 * was compiled last week, and narrowing to the compiled set at runtime would
 * silently drop exactly the features packages exist to sell. Referential
 * integrity is not lost by giving this up — `PlanFeature.featureKey` and
 * `WorkspaceFeatureOverride.featureKey` are foreign keys to `Feature.key`, so
 * the database refuses a row for a feature that does not exist. That is a
 * stronger guarantee than a TypeScript filter ever was, and it is enforced for
 * rows this build has never heard of.
 */
export type FeatureKey = string;

/**
 * The handful of keys the application names in its own source.
 *
 * WHY this narrow union survives when the broad one does not: these three are
 * not catalogue entries the product happens to sell, they are hardcoded into
 * behaviour — `accounts.max` is checked in `AccountsService.create`,
 * `transactions.monthly.max` in two write paths, `members.max` when an invite
 * is accepted. Those call sites cannot be data-driven without inventing a rule
 * engine, so they should at least be typo-proof: misspelling one in a string
 * literal would silently disable the limit rather than fail. Every *other* key
 * is looked up, never named, and so does not belong in a type.
 */
export const KNOWN_FEATURE_KEYS = [
  'accounts.max',
  'transactions.monthly.max',
  'members.max',
] as const;

export type KnownFeatureKey = (typeof KNOWN_FEATURE_KEYS)[number];

export interface FeatureDefinition {
  key: string;
  kind: FeatureKind;
  /**
   * Bengali — the label a user actually reads, in a 402 body and in the plan
   * comparison table. It is called `label` rather than `labelBn` because
   * Bengali is this product's first language and English is the translation;
   * it maps to the `Feature.labelBn` column, whose sibling `Feature.label`
   * holds `labelEn` below for the super-admin catalogue screen.
   */
  label: string;
  /** English. Admin screens and logs; never shown to a user. */
  labelEn: string;
  /**
   * How the number reads. 'count' | 'per-month' | 'megabytes' | 'tokens' by
   * convention, but a plain string because the database column is one and a
   * feature invented at runtime must be able to pick a unit this build has
   * never seen.
   *
   * Optional, and the renderers already treat a missing unit as a bare count —
   * a feature created in an admin form that leaves the field blank must render
   * as "সর্বোচ্চ ৫" rather than crash the plan table.
   */
  unit?: string;
  /** Which bucket its meter refills on. Ignored for a feature nothing meters. */
  period: MeterPeriod;
  /** Grouping for the admin screen: 'core', 'ingest', 'ai', 'integrations'. */
  category: string;
  /**
   * False retires a feature: plans that already grant it keep it, nothing new
   * sells it. Deleting the row instead would silently drop a limit somebody is
   * paying for.
   */
  isActive: boolean;
  sortOrder: number;
}

/**
 * The catalogue a fresh install starts with. Upserted at boot, exactly as
 * DEFAULT_PLANS already is, so `pnpm db:migrate && start` gives a working
 * system and every environment converges.
 *
 * Nothing at runtime reads this list to decide what exists — the `Feature`
 * table does. Adding an entry here changes what a *new* database is seeded
 * with and re-syncs the labels of an existing one; it is not the only way a
 * feature can come into being any more.
 *
 * All of the monthly ceilings are kind LIMIT rather than QUOTA even though
 * QUOTA ("a ceiling that is consumed and refills each period") describes them
 * better. The web plan table renders `kind === 'LIMIT'` and `kind === 'FLAG'`
 * and nothing else, so reclassifying them would make monthly transactions
 * disappear from the pricing page. QUOTA is available to features created
 * after the web side learns to render it.
 */
export const DEFAULT_FEATURES: readonly FeatureDefinition[] = [
  {
    key: 'accounts.max',
    kind: 'LIMIT',
    label: 'অ্যাকাউন্ট',
    labelEn: 'Accounts',
    unit: 'count',
    period: 'LIFETIME',
    category: 'core',
    isActive: true,
    sortOrder: 10,
  },
  {
    key: 'transactions.monthly.max',
    kind: 'LIMIT',
    label: 'মাসিক লেনদেন',
    labelEn: 'Transactions per month',
    unit: 'per-month',
    period: 'MONTHLY',
    category: 'core',
    isActive: true,
    sortOrder: 20,
  },
  {
    key: 'members.max',
    kind: 'LIMIT',
    label: 'সদস্য',
    labelEn: 'Members',
    unit: 'count',
    period: 'LIFETIME',
    category: 'core',
    isActive: true,
    sortOrder: 30,
  },
  {
    key: 'attachments.storage.mb',
    kind: 'LIMIT',
    label: 'সংযুক্তি স্টোরেজ',
    labelEn: 'Attachment storage',
    unit: 'megabytes',
    period: 'LIFETIME',
    category: 'core',
    isActive: true,
    sortOrder: 40,
  },
  {
    key: 'export.enabled',
    kind: 'FLAG',
    label: 'এক্সপোর্ট',
    labelEn: 'Export',
    unit: 'count',
    period: 'LIFETIME',
    category: 'core',
    isActive: true,
    sortOrder: 50,
  },
  {
    key: 'ingest.channels',
    kind: 'LIMIT',
    label: 'ইনজেস্ট চ্যানেল',
    labelEn: 'Ingest channels',
    unit: 'count',
    period: 'LIFETIME',
    category: 'ingest',
    isActive: true,
    sortOrder: 60,
  },
  {
    key: 'ingest.messages.monthly.max',
    kind: 'LIMIT',
    label: 'মাসিক বার্তা',
    labelEn: 'Ingested messages per month',
    unit: 'per-month',
    period: 'MONTHLY',
    category: 'ingest',
    isActive: true,
    sortOrder: 70,
  },
  {
    key: 'ai.tokens.monthly.max',
    kind: 'LIMIT',
    label: 'মাসিক AI টোকেন',
    labelEn: 'AI tokens per month',
    unit: 'tokens',
    period: 'MONTHLY',
    category: 'ai',
    isActive: true,
    sortOrder: 80,
  },
  {
    key: 'ai.reports.enabled',
    kind: 'FLAG',
    label: 'AI রিপোর্ট',
    labelEn: 'AI reports',
    unit: 'count',
    period: 'LIFETIME',
    category: 'ai',
    isActive: true,
    sortOrder: 90,
  },
  {
    key: 'email.connections.max',
    kind: 'LIMIT',
    label: 'মেইলবক্স সংযোগ',
    labelEn: 'Mailbox connections',
    unit: 'count',
    period: 'LIFETIME',
    category: 'integrations',
    isActive: true,
    sortOrder: 100,
  },
  {
    key: 'sms.channel',
    kind: 'FLAG',
    label: 'SMS চ্যানেল',
    labelEn: 'SMS channel',
    unit: 'count',
    period: 'LIFETIME',
    category: 'integrations',
    isActive: true,
    sortOrder: 110,
  },
  {
    key: 'notifications.telegram',
    kind: 'FLAG',
    label: 'টেলিগ্রাম নোটিফিকেশন',
    labelEn: 'Telegram notifications',
    unit: 'count',
    period: 'LIFETIME',
    category: 'integrations',
    isActive: true,
    sortOrder: 120,
  },
];

/**
 * The defaults keyed by key. A *fallback* lookup for labels and kinds when no
 * database row is to hand (the browser bundle has no database); the API passes
 * the real row wherever one is available.
 */
export const FEATURES: Readonly<Record<string, FeatureDefinition>> = Object.freeze(
  Object.fromEntries(DEFAULT_FEATURES.map((f) => [f.key, f])),
);

/**
 * The keys of the shipped defaults, in display order.
 *
 * NOT "every feature that exists" — that question can only be answered by
 * querying `Feature`. Kept because a client with no catalogue endpoint still
 * needs something to iterate, and because the defaults are what every install
 * has on day one.
 */
export const FEATURE_KEYS: readonly string[] = DEFAULT_FEATURES.map((f) => f.key);

/** Is this key one of the shipped defaults? Used for label fallbacks only. */
export function isFeatureKey(value: string): boolean {
  return Object.prototype.hasOwnProperty.call(FEATURES, value);
}

/** The Bengali label for a key, falling back to the key itself. */
export function featureLabel(key: FeatureKey, fallback?: string): string {
  return FEATURES[key]?.label ?? (fallback && fallback !== '' ? fallback : key);
}

// --- Meters -----------------------------------------------------------------

export const LIFETIME_PERIOD_KEY = 'lifetime';

/**
 * Which bucket a meter write lands in: 'lifetime', '2026-08' or '2026-08-10'.
 *
 * Computed in the *workspace's* timezone, never the server's. A Dhaka month
 * turns over at 18:00 UTC on the last day of the previous month, so a server
 * that used its own clock would hand six hours of one month's traffic to the
 * next — and would do it differently depending on where the container runs.
 * `startOfMonth` already resolves that boundary correctly, so this reuses it
 * rather than slicing the ISO string and hoping.
 */
export function usagePeriodKey(period: MeterPeriod, now: Date, timezone: string): string {
  switch (period) {
    case 'MONTHLY':
      return toLocalDateString(startOfMonth(now, timezone), timezone).slice(0, 7);
    case 'DAILY':
      return toLocalDateString(now, timezone);
    case 'LIFETIME':
    default:
      return LIFETIME_PERIOD_KEY;
  }
}

// --- Values -----------------------------------------------------------------

/**
 * `null` means unlimited. For a FLAG, 0 is off.
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
 * The plans a fresh install starts with, upserted at boot alongside
 * DEFAULT_FEATURES. Changing what a shipped tier includes is a pull request;
 * creating a *new* package is now a row, not a deployment.
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
  return new Map(Object.entries(free?.features ?? {}));
}

// --- Resolution -------------------------------------------------------------

/**
 * Plan features, then per-workspace overrides on top. An expired override is
 * ignored, so a temporary grant lapses on its own rather than needing a job to
 * clean it up.
 *
 * Rows are no longer filtered against a compiled key list. They come from
 * tables whose `featureKey` is a foreign key to `Feature.key`, so a row for a
 * feature that does not exist cannot be stored in the first place — and a
 * feature created after this build shipped must resolve, not be dropped.
 */
export function resolveEntitlements(
  planFeatures: readonly PlanFeatureRow[],
  overrides: readonly OverrideRow[] = [],
  now: Date = new Date(0),
): Entitlements {
  const resolved = new Map<FeatureKey, LimitValue>(fallbackEntitlements());

  for (const row of planFeatures) resolved.set(row.featureKey, row.limitValue);

  for (const row of overrides) {
    if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) continue;
    resolved.set(row.featureKey, row.limitValue);
  }

  return resolved;
}

/**
 * The ceiling for one key.
 *
 * `whenUnknown` defaults to 0 — off — and that default is load-bearing now that
 * the catalogue is open. A feature a super admin creates this afternoon is on
 * nobody's plan until they put it there; if an unknown key resolved to `null`
 * the way a missing entry used to, creating a feature would hand it to every
 * workspace in the system, unlimited, the moment it was saved. A key nobody
 * sold you is off.
 */
export function limitFor(
  entitlements: Entitlements,
  key: FeatureKey,
  whenUnknown: LimitValue = 0,
): LimitValue {
  if (entitlements.has(key)) return entitlements.get(key) ?? null;
  const defaults = fallbackEntitlements();
  if (defaults.has(key)) return defaults.get(key) ?? null;
  return whenUnknown;
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
 *
 * `label` is a parameter because the label lives in the `Feature` row now; the
 * caller that has the row passes it, and anything without one falls back to the
 * shipped defaults so a browser bundle still renders Bengali.
 */
export function describeBreach(
  entitlements: Entitlements,
  key: FeatureKey,
  used: number,
  label: string = featureLabel(key),
): LimitBreach | null {
  const limit = limitFor(entitlements, key);
  if (limit === null) return null;
  return { featureKey: key, label, limit, used };
}

/**
 * Everything the UI needs to render usage, in one serialisable object.
 *
 * Emits the resolved map itself rather than iterating a compiled key list, so a
 * feature that exists only in the database reaches the client.
 */
export function entitlementsToJson(entitlements: Entitlements): Record<string, LimitValue> {
  return Object.fromEntries(entitlements);
}

export function entitlementsFromJson(json: Record<string, LimitValue>): Entitlements {
  const map = new Map<FeatureKey, LimitValue>(fallbackEntitlements());
  for (const [key, value] of Object.entries(json)) map.set(key, value);
  return map;
}
