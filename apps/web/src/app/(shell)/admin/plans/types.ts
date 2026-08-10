/**
 * The `/v1/admin/plans` contract, mirrored on the client.
 *
 * Read defensively for the same reason `../types.ts` is, and then some: this
 * endpoint was being written while this screen was, so every field below is
 * accepted under more than one spelling and nothing throws on a shape it has
 * never seen. Where a value could not be read at all it becomes `null` rather
 * than a plausible-looking zero — a package that says "৪০টি ওয়ার্কস্পেস" when it
 * meant "I could not tell" is worse than one that admits it.
 *
 * Four values carry meaning a `?? 0` would destroy:
 *
 *   `limitValue: null`     unlimited. `0` is switched off. Two different things.
 *   *absent* from `limits` not priced on this package at all — a third thing
 *                          again, and not the same as `0`. See `PlanLimits`.
 *   `workspaceCount: null` nobody counted. It is not "nobody is on it".
 *   `overCount: null`      the dry run did not say. It is not "none affected".
 */

import { DEFAULT_PLAN_CODE } from '@hishab/core';

export type JsonObject = { [key: string]: unknown };

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const obj = (value: unknown): JsonObject => (isObject(value) ? value : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;
const strOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

/** Poisha. `formatMinor` throws on a non-integer, so this is the one truncation. */
const minor = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};

const intOr = (value: unknown, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
};

/** A count that is allowed to be unknown. `null` survives; a bad value is `null` too. */
const countOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

/** A ceiling. `null` stays `null` — unlimited — and never becomes `0`. */
const limitOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

/** The first key present, so a field that got renamed on the way here still reads. */
function pick(row: JsonObject, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (row[key] !== undefined) return row[key];
  }
  return undefined;
}

// --- one package -------------------------------------------------------------

/** What a package grants for one feature. Absent from the list means not priced. */
export interface PlanLimit {
  key: string;
  /** `null` unlimited, `0` off, n a ceiling. */
  limitValue: number | null;
}

export interface AdminPlan {
  code: string;
  name: string;
  /** Integer poisha. Nothing bills yet — see `PRICING_IS_NOT_BILLING`. */
  priceMinor: number;
  currency: string;
  /** Widened past the Prisma enum so an interval added server-side still prints. */
  interval: string;
  /** On the public pricing page and in the tenant plan picker. */
  isPublic: boolean;
  sortOrder: number;
  /**
   * Withdrawn from sale. The tenants already on it stay on it.
   *
   * The API computes this as `!isPublic` — there is no second column. Retiring
   * a package *is* hiding it, and the two words name one bit. The screens say
   * so rather than drawing two switches over one value.
   */
  retired: boolean;
  retiredAt: string | null;
  /** New signups land here, and the API refuses to retire it. */
  isDefault: boolean;
  /** `null` when the payload carried no count at all. Not zero. */
  workspaceCount: number | null;
  limits: PlanLimit[];
}

/**
 * Is this package retired?
 *
 * The shipped API sends `retired: !isPublic` and has no timestamp behind it —
 * `Plan` has no `retiredAt` column, which its own comment calls out as a
 * migration nobody has written. The other spellings are still read because a
 * later migration may add one, and because a payload this build has never seen
 * must render as best it can. Absent means live: a build that has never heard
 * of retirement must not paint the whole catalogue as withdrawn.
 */
function readRetired(row: JsonObject): { retired: boolean; retiredAt: string | null } {
  const at = strOrNull(pick(row, ['retiredAt', 'retired_at', 'archivedAt']) ?? null);
  if (at !== null) return { retired: true, retiredAt: at };

  const flag = pick(row, ['isRetired', 'retired', 'isArchived']);
  if (flag === true) return { retired: true, retiredAt: null };

  const active = pick(row, ['isActive', 'active']);
  if (active === false) return { retired: true, retiredAt: null };

  const status = str(pick(row, ['status', 'state'])).toUpperCase();
  if (status === 'RETIRED' || status === 'ARCHIVED') return { retired: true, retiredAt: null };

  /* Last, and the one that actually fires today: the API defines retirement as
   * the absence of publication. Read after the explicit spellings so that a
   * server which later separates the two is believed over this inference. */
  if (pick(row, ['isPublic', 'public']) === false) return { retired: true, retiredAt: null };

  return { retired: false, retiredAt: null };
}

/**
 * The limit map, from either of the two shapes it can arrive in.
 *
 * `POST /admin/plans` takes `features` as an object keyed by feature key, and
 * `/v1/entitlements/plans` already returns it as an array of rows — so a `GET`
 * that mirrors either one is legitimate and both are read. The distinction the
 * parse must not lose is *absent* versus `null`: a key missing from the object
 * is not priced, a key present with `null` is unlimited, and `Object.entries`
 * preserves that while a `?? null` on a fixed list of keys would not.
 */
function readLimits(raw: unknown): PlanLimit[] {
  const out: PlanLimit[] = [];

  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const row = obj(entry);
      const key = str(pick(row, ['key', 'featureKey', 'feature']));
      if (key === '') continue;
      out.push({ key, limitValue: limitOrNull(pick(row, ['limitValue', 'limit', 'value'])) });
    }
    return out;
  }

  if (isObject(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      if (key === '') continue;
      /* `{ key: { limitValue } }` as well as `{ key: 5 }`, because a server that
       * decorates each entry with a label is the likelier of the two to appear
       * later and would otherwise read as `null` — unlimited — everywhere. */
      if (isObject(value)) {
        out.push({ key, limitValue: limitOrNull(pick(value, ['limitValue', 'limit', 'value'])) });
      } else {
        out.push({ key, limitValue: limitOrNull(value) });
      }
    }
  }

  return out;
}

export function toAdminPlan(raw: unknown, index = 0): AdminPlan {
  const row = obj(raw);
  const { retired, retiredAt } = readRetired(row);
  const visibility = pick(row, ['isPublic', 'public']);

  return {
    code: str(row.code) !== '' ? str(row.code) : `plan-${index}`,
    name: str(row.name, str(row.code, 'নামহীন')),
    priceMinor: minor(pick(row, ['priceMinor', 'price'])),
    currency: str(row.currency, 'BDT'),
    interval: str(row.interval, 'MONTHLY'),
    // Absent is public: the shipped packages are, and a plan that quietly
    // vanished from the pricing page because a field was renamed is worse than
    // one that is wrongly listed on a screen only operators can see.
    isPublic: visibility === undefined ? true : visibility !== false,
    sortOrder: intOr(pick(row, ['sortOrder', 'order']), 0),
    retired,
    retiredAt,
    /* The server marks the package new signups land on. Absent, the compiled
     * default is used, which is the same string the API compares against —
     * `DEFAULT_PLAN_CODE` — so an older payload still disables the retire
     * button rather than offering an action that comes back 400. */
    isDefault:
      pick(row, ['isDefault', 'default']) === true ||
      str(row.code).toUpperCase() === DEFAULT_PLAN_CODE,
    workspaceCount: countOrNull(
      pick(row, ['workspaceCount', 'workspacesCount', 'tenantCount', 'workspaces']) ??
        obj(row._count).workspaces,
    ),
    limits: readLimits(pick(row, ['features', 'limits', 'planFeatures'])),
  };
}

export function toAdminPlans(raw: unknown): AdminPlan[] {
  const rows = Array.isArray(raw)
    ? raw
    : (() => {
        const page = obj(raw);
        for (const key of ['items', 'plans', 'data', 'results']) {
          const value = page[key];
          if (Array.isArray(value)) return value;
        }
        return [];
      })();

  const plans = rows.map((entry, index) => toAdminPlan(entry, index));
  plans.sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code));
  return plans;
}

/** `Map.has` is the only honest way to ask "is this feature priced at all?". */
export function limitMapOf(plan: AdminPlan | null): Map<string, number | null> {
  const map = new Map<string, number | null>();
  for (const row of plan?.limits ?? []) map.set(row.key, row.limitValue);
  return map;
}

// --- what would happen ---------------------------------------------------------

/**
 * One workspace that would be over a ceiling, named.
 *
 * A count tells an operator how bad it is; a name tells them who to warn. The
 * API sends the worst few.
 */
export interface OverLimitTenant {
  workspaceId: string;
  name: string;
  used: number;
}

/** One feature's blast radius, as the dry run measured it. */
export interface LimitImpact {
  featureKey: string;
  /** Bengali, from the server, so a key this build never heard of still reads. */
  labelBn: string;
  previousLimit: number | null;
  newLimit: number | null;
  /** Workspaces whose current usage is strictly above the new ceiling. */
  overCount: number | null;
  /** The worst one, so "over" has a size. */
  maxUsed: number | null;
  sample: OverLimitTenant[];
}

export interface DryRunResult {
  /** Only the features that would actually push somebody over. */
  impacts: LimitImpact[];
  /** Distinct workspaces over at least one of the new ceilings. */
  tenantCount: number | null;
  /** How many are on the package, as the sweep saw it. */
  workspacesOnPlan: number | null;
  /** Lowered keys something could put a real number against. */
  measured: string[];
  /**
   * Lowered keys nothing counts.
   *
   * Silence about these is not safety: the ceiling is still stored and still
   * enforced the day somebody adds a counter, so the review step prints
   * "unknown" for them rather than a reassuring zero.
   */
  unmeasured: string[];
  /** The sweep hit its cap, so every count above is a floor and not a total. */
  truncated: boolean;
  /**
   * Whether this build could make sense of the answer at all.
   *
   * False does not block the save — repricing is legitimate and the operator
   * may have a deadline — but it changes what the review step is allowed to
   * claim. "০টি ওয়ার্কস্পেস বাইরে যাবে" printed from a payload nobody parsed is
   * a lie with a number on it.
   */
  understood: boolean;
}

const EMPTY_DRY_RUN: DryRunResult = {
  impacts: [],
  tenantCount: null,
  workspacesOnPlan: null,
  measured: [],
  unmeasured: [],
  truncated: false,
  understood: false,
};

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

function toImpact(raw: unknown): LimitImpact | null {
  const row = obj(raw);
  const key = str(pick(row, ['featureKey', 'key', 'feature']));
  if (key === '') return null;

  return {
    featureKey: key,
    labelBn: str(pick(row, ['labelBn', 'label']), key),
    previousLimit: limitOrNull(pick(row, ['previousLimit', 'from', 'currentLimit'])),
    newLimit: limitOrNull(pick(row, ['newLimit', 'limitValue', 'to', 'limit'])),
    overCount: countOrNull(
      pick(row, [
        'workspaceCount',
        'overCount',
        'over',
        'workspacesOverLimit',
        'affected',
        'affectedWorkspaces',
        'tenantCount',
        'count',
      ]),
    ),
    maxUsed: countOrNull(pick(row, ['maxUsed', 'worstUsed', 'used'])),
    sample: list(pick(row, ['sample', 'tenants', 'workspaces'])).map((entry) => {
      const tenant = obj(entry);
      return {
        workspaceId: str(pick(tenant, ['workspaceId', 'id'])),
        name: str(tenant.name, 'নামহীন'),
        used: countOrNull(tenant.used) ?? 0,
      };
    }),
  };
}

/**
 * What `PUT /admin/plans/:code/features` says when asked with `dryRun: true`.
 *
 * The shipped answer is `{ planCode, dryRun, applied, features, warning }`, and
 * everything this screen needs is inside `warning`. `features` beside it is the
 * *resulting* limit map, not a list of impacts — reading that one by mistake
 * would produce a row per feature with no count attached and an operator
 * confidently told nothing.
 *
 * Two older shapes are still accepted below, because this parser was written
 * against a contract rather than against a server and there is no reason to
 * make it forget: a bare `byFeature`-style array, and an envelope that puts the
 * warning fields at the top level.
 */
export function toDryRun(raw: unknown): DryRunResult {
  if (Array.isArray(raw)) {
    const impacts = raw.map(toImpact).filter((row): row is LimitImpact => row !== null);
    return { ...EMPTY_DRY_RUN, impacts, understood: impacts.length === raw.length };
  }

  if (!isObject(raw)) return EMPTY_DRY_RUN;

  /* `warning` first, then the same fields at the top level for an API that
   * flattens them. Never `raw.features`, which is the new limit map. */
  const warning = isObject(raw.warning) ? raw.warning : raw;

  const byFeature = pick(warning, ['byFeature', 'impacts', 'overLimitFeatures', 'breaches']);
  const impacts = list(byFeature)
    .map(toImpact)
    .filter((row): row is LimitImpact => row !== null);

  const tenantCount = countOrNull(
    pick(warning, ['tenantCount', 'overLimitTenants', 'workspacesOverLimit']),
  );
  const measured = stringList(warning.measured);
  const unmeasured = stringList(warning.unmeasured);

  /* Understood means the payload carried a warning, not that anybody is over.
   * An empty `byFeature` with a `tenantCount` of zero is the commonest answer
   * on this screen and is a complete one. */
  const understood =
    Array.isArray(byFeature) ||
    tenantCount !== null ||
    Array.isArray(warning.measured) ||
    Array.isArray(warning.unmeasured);

  return {
    impacts,
    tenantCount,
    workspacesOnPlan: countOrNull(
      pick(warning, ['workspacesOnPlan', 'workspaceCount', 'workspacesCount']),
    ),
    measured,
    unmeasured,
    truncated: warning.truncated === true,
    understood,
  };
}
