import type { MeterPeriod } from '@prisma/client';
import { startOfMonth, startOfNextMonth, toLocalDateString } from '@hishab/shared';
import { METERED_FEATURE_KEYS } from '../entitlements/entitlements.service';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * How many tenants a plan-wide sweep will measure at once.
 *
 * The over-limit warning on `PUT /admin/plans/:code/features` is a fixed number
 * of aggregate queries, but it still materialises one row per workspace on the
 * plan. On the free tier that is every tenant in the system, so it is bounded
 * and reports `truncated` rather than quietly getting slower every month. A
 * truncated warning is a floor — "at least this many" — which is still the right
 * shape for a confirmation dialog.
 */
export const USAGE_SCAN_CAP = 5_000;

export const BYTES_PER_MB = 1024 * 1024;

/* `Math.round` is banned repo-wide (money is integer poisha). This is not
 * money, but two decimals read better than a float tail either way. */
export const toMb = (bytes: number): number => Number((bytes / BYTES_PER_MB).toFixed(2));

/**
 * Storage usage the way the *enforcer* counts it — rounded up.
 *
 * `EntitlementsService.usage` uses `Math.ceil`, so a workspace holding 49.01 MB
 * against a 50 MB ceiling has used 50. Anything that decides whether a tenant is
 * over a limit has to agree with the code that will refuse their next upload, or
 * the screen and the 402 contradict each other.
 */
export const storageMbOf = (bytes: number): number => Math.ceil(bytes / BYTES_PER_MB);

/**
 * Resolved ceilings, keyed by feature.
 *
 * Deliberately a plain `ReadonlyMap<string, …>` rather than `@hishab/core`'s
 * `Entitlements`. The catalogue is open — features created at runtime cannot be
 * in a compiled union — so the admin modules treat a feature key as what it is
 * in the database: a string.
 */
export type Limits = ReadonlyMap<string, number | null>;

/**
 * The ceiling for one key, as the enforcer sees it.
 *
 * `null` is unlimited, `0` is switched off, and a key the map has never heard of
 * is **also** off. That last case is not pedantry: the catalogue is open, so a
 * feature a super admin creates this afternoon is on nobody's plan yet, and
 * reading a missing key as "unlimited" would hand every tenant in the system an
 * uncapped feature the moment it was saved.
 */
export const limitOf = (limits: Limits, key: string): number | null =>
  limits.has(key) ? (limits.get(key) ?? null) : 0;

/** `'lifetime'`, `'2026-08'` or `'2026-08-10'` — the buckets `UsageMeter` uses. */
export const periodKeyFor = (period: MeterPeriod, timezone: string, now: Date): string => {
  if (period === 'MONTHLY') return toLocalDateString(now, timezone).slice(0, 7);
  if (period === 'DAILY') return toLocalDateString(now, timezone);
  return 'lifetime';
};

/**
 * The features something actually counts with a live aggregate.
 *
 * This mirrors `EntitlementsService.usage()` and must keep mirroring it: these
 * are the keys whose number an operator is shown, and whose number decides
 * whether a tenant is reported as over a lowered limit. A key that gains a
 * counter there and not here would silently drop out of the warning — the
 * warning would say "0 workspaces affected" about a limit that is about to start
 * refusing writes, which is the one wrong answer this feature exists to prevent.
 */
const LIVE_COUNTED_KEYS = [
  'accounts.max',
  'members.max',
  'transactions.monthly.max',
  'attachments.storage.mb',
  'email.connections.max',
] as const;

/** Every key any sweep can put a number against. Everything else reports null. */
export const MEASURABLE_FEATURE_KEYS: readonly string[] = [
  ...LIVE_COUNTED_KEYS,
  ...METERED_FEATURE_KEYS,
];

export interface UsageTenant {
  id: string;
  timezone: string;
}

export interface UsageMatrix {
  /**
   * What this workspace has consumed of this feature.
   *
   * `null` means *nothing counts this* — which is not the same fact as zero, and
   * must never be rendered as "0 used". A limit nobody measures cannot be shown
   * as safe to lower.
   */
  get(workspaceId: string, featureKey: string): number | null;
  /** The subset of the requested keys that anything could measure at all. */
  measured: string[];
  /** The rest of them. Named so a caller can say so out loud. */
  unmeasured: string[];
}

/**
 * Usage for many workspaces and a handful of features, in a fixed number of
 * queries.
 *
 * At most five aggregates and one meter read for the whole set, and only the
 * ones the requested keys actually need — lowering `members.max` does not pay
 * for a storage sum over every tenant on the plan. Everything after that is
 * arithmetic in memory.
 */
export async function measureUsage(
  prisma: PrismaService,
  tenants: readonly UsageTenant[],
  featureKeys: readonly string[],
  periods: ReadonlyMap<string, MeterPeriod>,
  now: Date,
): Promise<UsageMatrix> {
  const wanted = new Set(featureKeys);
  const measured = featureKeys.filter((key) => MEASURABLE_FEATURE_KEYS.includes(key));
  const unmeasured = featureKeys.filter((key) => !MEASURABLE_FEATURE_KEYS.includes(key));

  const ids = tenants.map((t) => t.id);
  const values = new Map<string, number>();
  const at = (workspaceId: string, featureKey: string) => `${workspaceId}|${featureKey}`;

  if (ids.length === 0 || measured.length === 0) {
    return { get: () => null, measured, unmeasured };
  }

  /* One query per distinct timezone for the monthly window, because "this
   * month" is a different span in each. In practice every workspace is
   * Asia/Dhaka and this is a single query; the loop exists so it stays correct
   * the day one is not. */
  const zones = new Map<string, string[]>();
  for (const tenant of tenants) {
    const bucket = zones.get(tenant.timezone);
    if (bucket) bucket.push(tenant.id);
    else zones.set(tenant.timezone, [tenant.id]);
  }

  await Promise.all([
    wanted.has('accounts.max')
      ? prisma.account
          .groupBy({
            by: ['workspaceId'],
            // The loan control accounts carry a `systemKey` and are bookkeeping
            // machinery, not accounts the user opened. `EntitlementsService`
            // excludes them from the count, so this must too.
            where: {
              workspaceId: { in: ids },
              systemKey: null,
              deletedAt: null,
              isArchived: false,
            },
            _count: { _all: true },
          })
          .then((rows) => {
            for (const row of rows)
              values.set(at(row.workspaceId, 'accounts.max'), row._count._all);
          })
      : null,
    wanted.has('members.max')
      ? prisma.membership
          .groupBy({
            by: ['workspaceId'],
            where: { workspaceId: { in: ids }, status: 'ACTIVE' },
            _count: { _all: true },
          })
          .then((rows) => {
            for (const row of rows) values.set(at(row.workspaceId, 'members.max'), row._count._all);
          })
      : null,
    wanted.has('email.connections.max')
      ? prisma.mailAccount
          .groupBy({
            by: ['workspaceId'],
            where: { workspaceId: { in: ids }, deletedAt: null },
            _count: { _all: true },
          })
          .then((rows) => {
            for (const row of rows) {
              values.set(at(row.workspaceId, 'email.connections.max'), row._count._all);
            }
          })
      : null,
    wanted.has('attachments.storage.mb')
      ? prisma.attachment
          .groupBy({
            by: ['workspaceId'],
            where: { workspaceId: { in: ids }, deletedAt: null },
            _sum: { sizeBytes: true },
          })
          .then((rows) => {
            for (const row of rows) {
              values.set(
                at(row.workspaceId, 'attachments.storage.mb'),
                storageMbOf(row._sum.sizeBytes ?? 0),
              );
            }
          })
      : null,
    ...(wanted.has('transactions.monthly.max')
      ? [...zones].map(async ([zone, zoneIds]) => {
          const rows = await prisma.transaction.groupBy({
            by: ['workspaceId'],
            where: {
              workspaceId: { in: zoneIds },
              deletedAt: null,
              createdAt: { gte: startOfMonth(now, zone), lt: startOfNextMonth(now, zone) },
            },
            _count: { _all: true },
          });
          for (const row of rows) {
            values.set(at(row.workspaceId, 'transactions.monthly.max'), row._count._all);
          }
        })
      : []),
  ]);

  const meteredWanted = METERED_FEATURE_KEYS.filter((key) => wanted.has(key));
  if (meteredWanted.length > 0) {
    const meters = await prisma.usageMeter.findMany({
      where: { workspaceId: { in: ids }, featureKey: { in: [...meteredWanted] } },
      select: { workspaceId: true, featureKey: true, periodKey: true, value: true },
    });
    const byBucket = new Map(
      meters.map((m) => [`${m.workspaceId}|${m.featureKey}|${m.periodKey}`, Number(m.value)]),
    );
    for (const tenant of tenants) {
      for (const key of meteredWanted) {
        const period = periods.get(key) ?? 'LIFETIME';
        const bucket = `${tenant.id}|${key}|${periodKeyFor(period, tenant.timezone, now)}`;
        /* A metered feature with no row this period has consumed none of it —
         * 0, a real measurement, not the `null` that means "nobody is watching".
         * The meter is written where the work happens, so its absence is
         * evidence the work did not happen. */
        values.set(at(tenant.id, key), byBucket.get(bucket) ?? 0);
      }
    }
  }

  const measurable = new Set(measured);
  return {
    get: (workspaceId, featureKey) =>
      measurable.has(featureKey) ? (values.get(at(workspaceId, featureKey)) ?? 0) : null,
    measured,
    unmeasured,
  };
}
