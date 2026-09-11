/**
 * The `/v1/admin/*` contract, mirrored on the client.
 *
 * Read defensively for the same reason `audit/types.ts` is: a payload shape
 * this build has never seen must render as best it can rather than throw inside
 * a render and take away the operator's only view of the platform.
 *
 * Three values carry meaning a `?? 0` would destroy, so nothing in this file
 * ever writes one:
 *
 *   `used: null`            nothing counts this feature. It is not zero.
 *   `effectiveLimit: null`  unlimited. `0` is switched off. Three states.
 *   `ratio: null`           there is no ratio, because one side of it is absent.
 *
 * Integer-vs-float matters here too. `attachments.storage.mb` arrives as
 * `Number((bytes / 1048576).toFixed(2))` — a real decimal — and `ratio` carries
 * three decimal places, so neither may be truncated on the way in. Only
 * `priceMinor` is forced to an integer, because `formatMinor` throws on
 * anything else and money is integer poisha everywhere.
 */

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

import type { ImpersonationEnvelope } from '@/lib/support-session';

export const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const obj = (value: unknown): JsonObject => (isJsonObject(value) ? value : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;
const strOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;
const bool = (value: unknown): boolean => value === true;

/** A count or a measurement. Decimals survive — storage megabytes are one. */
const num = (value: unknown, fallback = 0): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

/** The load-bearing one: `null` stays `null` and never becomes `0`. */
const numOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** Poisha. `formatMinor` throws on a non-integer, so this is the one truncation. */
const minor = (value: unknown): number => Math.trunc(num(value));

// --- people -----------------------------------------------------------------

export interface Person {
  id: string;
  name: string;
  email: string;
}

const person = (value: unknown): Person | null => {
  const row = obj(value);
  const id = strOrNull(row.id);
  if (!id) return null;
  return { id, name: str(row.name), email: str(row.email) };
};

// --- plans ------------------------------------------------------------------

export interface TenantPlan {
  code: string;
  name: string;
  priceMinor: number;
  interval?: string;
}

const tenantPlan = (value: unknown): TenantPlan | null => {
  if (!isJsonObject(value)) return null;
  const code = strOrNull(value.code);
  if (!code) return null;
  return {
    code,
    name: str(value.name, code),
    priceMinor: minor(value.priceMinor),
    interval: strOrNull(value.interval) ?? undefined,
  };
};

// --- tenants ----------------------------------------------------------------

export interface TenantRow {
  id: string;
  name: string;
  /** Widened past the Prisma enum: a status added server-side must still print. */
  status: string;
  currency: string;
  timezone: string;
  createdAt: string;
  trialEndsAt: string | null;
  plan: TenantPlan | null;
  owner: Person | null;
  memberCount: number;
  transactionCount: number;
  storageBytes: number;
  storageMb: number;
}

export interface TenantPage {
  items: TenantRow[];
  nextCursor: string | null;
}

export function toTenantRow(raw: unknown, index: number): TenantRow {
  const row = obj(raw);
  return {
    id: strOrNull(row.id) ?? `row-${index}`,
    name: str(row.name, 'নামহীন'),
    status: str(row.status, 'UNKNOWN'),
    currency: str(row.currency, 'BDT'),
    timezone: str(row.timezone, 'Asia/Dhaka'),
    createdAt: str(row.createdAt),
    trialEndsAt: strOrNull(row.trialEndsAt),
    plan: tenantPlan(row.plan),
    owner: person(row.owner),
    memberCount: num(row.memberCount),
    transactionCount: num(row.transactionCount),
    storageBytes: num(row.storageBytes),
    storageMb: num(row.storageMb),
  };
}

export function toTenantPage(raw: unknown): TenantPage {
  const page = obj(raw);
  return {
    items: list(page.items).map(toTenantRow),
    nextCursor: strOrNull(page.nextCursor),
  };
}

// --- people ------------------------------------------------------------------

/** One workspace a person belongs to, and on what terms. */
export interface UserWorkspace {
  id: string;
  name: string;
  /** Widened past the Prisma enum, like `TenantRow.status`. */
  status: string;
  role: string;
  membershipStatus: string;
  joinedAt: string;
}

export interface UserRow {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  /* Another operator. The console greys the row rather than offering a support
   * session the API refuses — see `AdminImpersonationService`. */
  isSuperAdmin: boolean;
  emailVerified: boolean;
  /** Set while an erasure is inside its grace period. */
  deletionRequestedAt: string | null;
  createdAt: string;
  workspaces: UserWorkspace[];
}

export interface UserPage {
  items: UserRow[];
  nextCursor: string | null;
}

const userWorkspace = (value: unknown, index: number): UserWorkspace => {
  const row = obj(value);
  const workspace = {
    id: strOrNull(row.id) ?? `ws-${index}`,
    name: str(row.name, 'নামহীন'),
    status: str(row.status, 'UNKNOWN'),
    role: str(row.role, 'MEMBER'),
    membershipStatus: str(row.membershipStatus, 'UNKNOWN'),
    joinedAt: str(row.joinedAt),
  };
  return workspace;
};

export function toUserRow(raw: unknown, index: number): UserRow {
  const row = obj(raw);
  return {
    id: strOrNull(row.id) ?? `user-${index}`,
    name: str(row.name, 'নামহীন'),
    email: str(row.email),
    phone: strOrNull(row.phone),
    isSuperAdmin: bool(row.isSuperAdmin),
    emailVerified: bool(row.emailVerified),
    deletionRequestedAt: strOrNull(row.deletionRequestedAt),
    createdAt: str(row.createdAt),
    workspaces: list(row.workspaces).map(userWorkspace),
  };
}

export function toUserPage(raw: unknown): UserPage {
  const page = obj(raw);
  return {
    items: list(page.items).map(toUserRow),
    nextCursor: strOrNull(page.nextCursor),
  };
}

// --- one tenant --------------------------------------------------------------

export interface TenantFeature {
  key: string;
  /** English, from `Feature.label`. Kept for a key with no Bengali behind it. */
  label: string;
  /** Bengali, from `Feature.labelBn`. This is what the screen prints. */
  labelBn: string;
  kind: string;
  unit: string;
  period: string;
  category: string;
  /** What the package grants. `null` is unlimited. */
  planLimit: number | null;
  /** What the enforcer will actually apply. `null` unlimited, `0` off. */
  effectiveLimit: number | null;
  overridden: boolean;
  /** `null` means nothing counts this. It is not zero. */
  used: number | null;
  /** `null` wherever a ratio cannot exist. */
  ratio: number | null;
}

const toFeature = (raw: unknown, index: number): TenantFeature => {
  const row = obj(raw);
  const key = strOrNull(row.key) ?? `feature-${index}`;
  return {
    key,
    label: str(row.label, key),
    labelBn: str(row.labelBn),
    kind: str(row.kind, 'LIMIT'),
    unit: str(row.unit, 'count'),
    period: str(row.period, 'LIFETIME'),
    category: str(row.category, 'core'),
    planLimit: numOrNull(row.planLimit),
    effectiveLimit: numOrNull(row.effectiveLimit),
    overridden: bool(row.overridden),
    used: numOrNull(row.used),
    ratio: numOrNull(row.ratio),
  };
};

export interface TenantOverride {
  id: string;
  featureKey: string;
  limitValue: number | null;
  expiresAt: string | null;
  /** An expired override is still a row. It is shown as expired, not as gone. */
  expired: boolean;
  note: string | null;
  createdAt: string;
  grantedBy: Person | null;
}

const toOverride = (raw: unknown, index: number): TenantOverride => {
  const row = obj(raw);
  return {
    id: strOrNull(row.id) ?? `override-${index}`,
    featureKey: str(row.featureKey),
    limitValue: numOrNull(row.limitValue),
    expiresAt: strOrNull(row.expiresAt),
    expired: bool(row.expired),
    note: strOrNull(row.note),
    createdAt: str(row.createdAt),
    grantedBy: person(row.grantedBy),
  };
};

export interface TenantMember {
  membershipId: string;
  role: string;
  status: string;
  joinedAt: string;
  id: string;
  name: string;
  email: string;
  phone: string | null;
  locale: string | null;
  emailVerifiedAt: string | null;
  isSuperAdmin: boolean;
}

const toMember = (raw: unknown, index: number): TenantMember => {
  const row = obj(raw);
  return {
    membershipId: strOrNull(row.membershipId) ?? `member-${index}`,
    role: str(row.role, 'MEMBER'),
    status: str(row.status, 'ACTIVE'),
    joinedAt: str(row.joinedAt),
    id: strOrNull(row.id) ?? '',
    name: str(row.name),
    email: str(row.email),
    phone: strOrNull(row.phone),
    locale: strOrNull(row.locale),
    emailVerifiedAt: strOrNull(row.emailVerifiedAt),
    isSuperAdmin: bool(row.isSuperAdmin),
  };
};

export interface TenantDetail {
  id: string;
  name: string;
  status: string;
  currency: string;
  timezone: string;
  createdAt: string;
  updatedAt: string;
  trialEndsAt: string | null;
  owner: Person | null;
  plan: TenantPlan | null;
  /** False means the `Feature` table is empty and `features` below is a stopgap. */
  catalogueSeeded: boolean;
  features: TenantFeature[];
  overrides: TenantOverride[];
  members: TenantMember[];
  totals: {
    memberCount: number;
    transactionCount: number;
    attachmentCount: number;
    storageBytes: number;
    storageMb: number;
  };
  lastActivityAt: string | null;
  lastActivityAction: string | null;
}

export function toTenantDetail(raw: unknown): TenantDetail {
  const row = obj(raw);
  const totals = obj(row.totals);
  return {
    id: str(row.id),
    name: str(row.name, 'নামহীন'),
    status: str(row.status, 'UNKNOWN'),
    currency: str(row.currency, 'BDT'),
    timezone: str(row.timezone, 'Asia/Dhaka'),
    createdAt: str(row.createdAt),
    updatedAt: str(row.updatedAt),
    trialEndsAt: strOrNull(row.trialEndsAt),
    owner: person(row.owner),
    plan: tenantPlan(row.plan),
    /* Absent is treated as seeded. The warning banner is for a server that
     * said `false`, not for a field an older API never sent — crying wolf on
     * every screen would train the operator to ignore the one that matters. */
    catalogueSeeded: row.catalogueSeeded === undefined ? true : bool(row.catalogueSeeded),
    features: list(row.features).map(toFeature),
    overrides: list(row.overrides).map(toOverride),
    members: list(row.members).map(toMember),
    totals: {
      memberCount: num(totals.memberCount),
      transactionCount: num(totals.transactionCount),
      attachmentCount: num(totals.attachmentCount),
      storageBytes: num(totals.storageBytes),
      storageMb: num(totals.storageMb),
    },
    lastActivityAt: strOrNull(row.lastActivityAt),
    lastActivityAction: strOrNull(row.lastActivityAction),
  };
}

// --- the platform ------------------------------------------------------------

export interface NearLimitBreach {
  workspaceId: string;
  name: string;
  planCode: string | null;
  featureKey: string;
  used: number;
  limit: number;
  ratio: number;
}

export interface Overview {
  generatedAt: string;
  tenants: {
    total: number;
    byStatus: Record<string, number>;
    byPlan: { code: string; name: string; count: number }[];
  };
  signups: { windowDays: number; total: number; daily: { date: string; count: number }[] };
  totals: { transactions: number; storageBytes: number; storageMb: number };
  nearLimit: {
    threshold: number;
    tenantCount: number;
    /** A sample for the screen. `tenantCount` is the count. */
    sample: NearLimitBreach[];
    /** Which features the sweep could measure at all. */
    measuredFeatures: string[];
    tenantsScanned: number;
    /** The sweep stopped early. `tenantCount` is then a floor, not a total. */
    truncated: boolean;
  };
}

export function toOverview(raw: unknown): Overview {
  const row = obj(raw);
  const tenants = obj(row.tenants);
  const signups = obj(row.signups);
  const totals = obj(row.totals);
  const near = obj(row.nearLimit);

  const byStatus: Record<string, number> = {};
  for (const [key, value] of Object.entries(obj(tenants.byStatus))) {
    byStatus[key] = num(value);
  }

  return {
    generatedAt: str(row.generatedAt),
    tenants: {
      total: num(tenants.total),
      byStatus,
      byPlan: list(tenants.byPlan).map((entry) => {
        const plan = obj(entry);
        return {
          code: str(plan.code, 'UNKNOWN'),
          name: str(plan.name, str(plan.code, 'UNKNOWN')),
          count: num(plan.count),
        };
      }),
    },
    signups: {
      windowDays: num(signups.windowDays, 30),
      total: num(signups.total),
      daily: list(signups.daily).map((entry) => {
        const day = obj(entry);
        return { date: str(day.date), count: num(day.count) };
      }),
    },
    totals: {
      transactions: num(totals.transactions),
      storageBytes: num(totals.storageBytes),
      storageMb: num(totals.storageMb),
    },
    nearLimit: {
      threshold: num(near.threshold, 0.8),
      tenantCount: num(near.tenantCount),
      sample: list(near.sample).map((entry) => {
        const breach = obj(entry);
        return {
          workspaceId: str(breach.workspaceId),
          name: str(breach.name, 'নামহীন'),
          planCode: strOrNull(breach.planCode),
          featureKey: str(breach.featureKey),
          used: num(breach.used),
          limit: num(breach.limit),
          ratio: num(breach.ratio),
        };
      }),
      measuredFeatures: list(near.measuredFeatures).filter(
        (value): value is string => typeof value === 'string',
      ),
      tenantsScanned: num(near.tenantsScanned),
      truncated: bool(near.truncated),
    },
  };
}

// --- the feature catalogue -------------------------------------------------------

/**
 * One row of `GET /v1/entitlements/features`.
 *
 * Beware the flip: on this endpoint `label` is the **Bengali** string and
 * `labelEn` the English one, which is the opposite way round from the admin
 * tenant payload, where `label` is English and `labelBn` Bengali.
 * `FeatureCatalogueService` explains why — the columns are named English-first
 * and the product is Bengali-first — but it means a screen reading both has to
 * know which one it is holding.
 *
 * The panel reads this so a feature invented after the web build shipped still
 * has a name. Without it, `nearLimit.measuredFeatures` is a list of bare keys.
 */
export interface CatalogueFeature {
  key: string;
  /** Bengali. */
  label: string;
  labelEn: string;
  kind: string;
  unit: string;
  period: string;
  category: string;
  isActive: boolean;
  sortOrder: number;
}

export function toCatalogue(raw: unknown): CatalogueFeature[] {
  return list(raw).map((entry, index): CatalogueFeature => {
    const row = obj(entry);
    const key = strOrNull(row.key) ?? `feature-${index}`;
    return {
      key,
      label: str(row.label, key),
      labelEn: str(row.labelEn, key),
      kind: str(row.kind, 'LIMIT'),
      unit: str(row.unit, 'count'),
      period: str(row.period, 'LIFETIME'),
      category: str(row.category, 'core'),
      isActive: row.isActive === undefined ? true : bool(row.isActive),
      sortOrder: num(row.sortOrder),
    };
  });
}

// --- the cross-tenant log ------------------------------------------------------

export interface PlatformAuditEvent {
  id: string;
  workspace: { id: string; name: string } | null;
  action: string;
  entity: string | null;
  entityId: string | null;
  actor: Person | null;
  actorType: string;
  before: JsonObject | null;
  after: JsonObject | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
}

export interface PlatformAuditPage {
  items: PlatformAuditEvent[];
  nextCursor: string | null;
}

export function toAuditPage(raw: unknown): PlatformAuditPage {
  const page = obj(raw);
  return {
    items: list(page.items).map((entry, index): PlatformAuditEvent => {
      const row = obj(entry);
      const workspace = isJsonObject(row.workspace) ? row.workspace : null;
      return {
        id: strOrNull(row.id) ?? `event-${index}`,
        workspace: workspace
          ? { id: str(workspace.id), name: str(workspace.name, 'নামহীন') }
          : null,
        action: str(row.action, 'unknown'),
        entity: strOrNull(row.entity),
        entityId: strOrNull(row.entityId),
        actor: person(row.actor),
        actorType: str(row.actorType, 'USER'),
        before: isJsonObject(row.before) ? row.before : null,
        after: isJsonObject(row.after) ? row.after : null,
        ip: strOrNull(row.ip),
        userAgent: strOrNull(row.userAgent),
        createdAt: str(row.createdAt),
      };
    }),
    nextCursor: strOrNull(page.nextCursor),
  };
}

// --- impersonation --------------------------------------------------------------

/**
 * What `POST /admin/tenants/:id/impersonate` hands back.
 *
 * There is no marker inside the JWT yet — the API says so in
 * `AdminImpersonationService`'s TODO — so every claim the support banner makes
 * comes from this envelope and from nowhere else.
 */
/* Declared in `lib/support-session.ts`, which is where the envelope is stored
 * and where `lib/api.ts` reads it from. Re-exported here so the admin console's
 * contract file still describes the whole `/admin/*` surface in one place. */
export type { ImpersonationEnvelope } from '@/lib/support-session';

export function toEnvelope(raw: unknown): ImpersonationEnvelope {
  const row = obj(raw);
  const imp = obj(row.impersonation);
  const workspace = obj(imp.workspace);
  const actingAs = obj(imp.actingAs);
  const startedBy = obj(imp.startedBy);

  return {
    tokenType: str(row.tokenType, 'impersonation'),
    accessToken: str(row.accessToken),
    transport: str(row.transport, 'authorization-bearer'),
    refreshToken: null,
    expiresIn: num(row.expiresIn, 900),
    expiresAt: str(row.expiresAt),
    sessionId: str(row.sessionId),
    impersonation: {
      workspace: {
        id: str(workspace.id),
        name: str(workspace.name, 'নামহীন'),
        status: str(workspace.status, 'UNKNOWN'),
      },
      actingAs: {
        id: str(actingAs.id),
        name: str(actingAs.name),
        email: str(actingAs.email),
        role: str(actingAs.role, 'MEMBER'),
      },
      startedBy: { id: str(startedBy.id), email: str(startedBy.email) },
      startedAt: str(imp.startedAt),
      reason: str(imp.reason),
    },
    banner: str(row.banner),
  };
}

// --- a tenant's money, and the platform's ------------------------------------

export interface AdminAccount {
  id: string;
  name: string;
  type: string;
  /** What the user typed for their own recognition. Never a full number. */
  accountNumberMasked: string | null;
  institution: string | null;
  isArchived: boolean;
  balanceMinor: number;
}

export interface TenantFinance {
  currency: string;
  accounts: AdminAccount[];
  netWorthMinor: number;
  assetsMinor: number;
  liabilitiesMinor: number;
  savings: { count: number; paidInMinor: number };
  insurance: { count: number; premiumPaidMinor: number };
  loans: { lentOutstandingMinor: number; borrowedOutstandingMinor: number; count: number };
}

export interface CategorySlice {
  name: string;
  kind: 'INCOME' | 'EXPENSE';
  totalMinor: number;
  transactionCount: number;
  /** How many workspaces contributed — the number that says "is this typical?" */
  workspaceCount: number;
}

export interface CategoryAnalytics {
  slices: CategorySlice[];
  workspacesCounted: number;
  currencyNote: string;
  currencies: { currency: string; workspaces: number }[];
}

/**
 * What a tenant's phone forwarded, as the operator panel reads it.
 *
 * `outcome` is the whole point: a message read, a money message the parser
 * could not read, and a message that was never about money. The middle one is
 * the only number worth acting on.
 */
export interface TenantMessageRow {
  id: string;
  channel: string;
  sender: string | null;
  receivedAt: string;
  body: string;
  parserName: string | null;
  outcome: 'PARSED' | 'UNREAD' | 'IGNORED';
  confidence: number | null;
  amountMinor: number | null;
  draftStatus: string | null;
}

export interface TenantMessages {
  tenant: { id: string; name: string };
  summary: { total: number; parsed: number; unread: number; ignored: number };
  messages: TenantMessageRow[];
}
