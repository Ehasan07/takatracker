import { HttpException, HttpStatus, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  DEFAULT_PLAN_CODE,
  DEFAULT_PLANS,
  describeBreach,
  entitlementsToJson,
  isWithinLimit,
  limitFor,
  remaining,
  resolveEntitlements,
  type Entitlements,
  type FeatureKey,
} from '@hishab/core';
import { startOfMonth, startOfNextMonth } from '@hishab/shared';
import { PrismaService } from '../prisma/prisma.service';
import { FeatureCatalogueService } from './feature-catalogue.service';
import { UsageMeterService } from './usage-meter.service';

/**
 * Where a 402 sends someone. Two things were wrong with the old value
 * (`https://takatracker.com/settings/plan`): that route does not exist, so
 * every plan limit dead-ended on a 404, and hardcoding the production origin
 * meant a limit hit in development jumped the user to the live site.
 */
const UPGRADE_URL =
  process.env.UPGRADE_URL ?? `${process.env.APP_URL ?? 'http://localhost:3000'}/plans`;

const BYTES_PER_MB = 1_048_576;

/**
 * Features whose usage is a meter read rather than a recount.
 *
 * Deliberately short. See `UsageMeterService` for why: anything still countable
 * from its own rows is counted, because a `COUNT(*)` cannot drift and a stored
 * counter can. A message that has been through retention pruning leaves nothing
 * to count, so the month's intake has to have been recorded when it happened.
 */
export const METERED_FEATURE_KEYS: readonly string[] = ['ingest.messages.monthly.max'];

/**
 * 402, with enough detail for the client to say "you have used all 5 of your
 * accounts" instead of showing a generic failure (v3 §A2).
 */
export class FeatureLimitException extends HttpException {
  constructor(breach: { featureKey: string; label: string; limit: number; used: number }) {
    super(
      {
        statusCode: HttpStatus.PAYMENT_REQUIRED,
        error: 'FeatureLimitReached',
        message: `${breach.label}-এর সীমা শেষ (${breach.used}/${breach.limit})। প্ল্যান আপগ্রেড করুন।`,
        featureKey: breach.featureKey,
        limit: breach.limit,
        used: breach.used,
        upgradeUrl: UPGRADE_URL,
      },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}

export class FeatureUnavailableException extends HttpException {
  constructor(featureKey: FeatureKey, label: string) {
    super(
      {
        statusCode: HttpStatus.PAYMENT_REQUIRED,
        error: 'FeatureUnavailable',
        message: `${label} আপনার প্ল্যানে নেই। প্ল্যান আপগ্রেড করুন।`,
        featureKey,
        limit: 0,
        used: 0,
        upgradeUrl: UPGRADE_URL,
      },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}

export interface UsageSnapshot {
  entitlements: Record<string, number | null>;
  usage: Record<string, number>;
  remaining: Record<string, number | null>;
  /**
   * Which keys in `usage` are a real measurement. A limit the server does not
   * count must not be drawn as a full progress bar sitting at zero — that reads
   * as "you have used none of it" when the truth is "nobody is watching".
   */
  measured: string[];
  plan: { code: string; name: string; priceMinor: number } | null;
}

export interface CataloguePlanView {
  code: string;
  name: string;
  priceMinor: number;
  /** Null when the plan is sold monthly only. */
  priceYearlyMinor: number | null;
  /** ISO 4217. The catalogue is priced in one currency, whatever a workspace keeps its books in. */
  currency: string;
  interval: string;
  features: { key: string; label: string; limitValue: number | null }[];
}

@Injectable()
export class EntitlementsService implements OnModuleInit {
  private readonly logger = new Logger(EntitlementsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly catalogue: FeatureCatalogueService,
    private readonly meters: UsageMeterService,
  ) {}

  /**
   * Seed the shipped defaults **if they are absent**, and otherwise leave them
   * alone.
   *
   * ## Why the plans are seed-if-absent and the features are not
   *
   * This used to upsert `Plan` and `PlanFeature` on every boot and delete any
   * `PlanFeature` whose key was not in `DEFAULT_PLANS`. That made the code the
   * permanent owner of FREE and PRO — so the moment the admin panel could set a
   * limit, a limit set on FREE at 09:00 was gone at the next deploy, silently,
   * with no error and nothing in a log to explain why a customer's ceiling had
   * moved back. A price list that reverts itself is worse than no editor at all.
   *
   * The rule now is: **the code says what a fresh install starts with, and the
   * database owns it from then on.** Nothing here overwrites or deletes a `Plan`
   * or a `PlanFeature` row that already exists. Changing what a shipped tier
   * includes on an install that has already booted is therefore an operator
   * action through `/admin/plans`, not a pull request — which is correct, since
   * that install's operator may have repriced it deliberately.
   *
   * `Feature` is treated differently, and the difference is not an oversight.
   * A `PlanFeature` row is a *commercial decision* — what this business charges
   * for what — and the operator is the authority on it. A `Feature` row is a
   * *description of something the code implements*: its `key` is named in
   * `AccountsService.create`, its `kind` decides how every stored number under
   * that key is read, its `period` decides which meter bucket a write lands in.
   * A build that ships a new sellable feature must be able to put it in the
   * catalogue, or it could never be sold at all. So features are still upserted
   * — see `FeatureCatalogueService.seed`, which is careful to sync only the
   * fields the code owns and never the ones the admin screen can edit.
   */
  async onModuleInit(): Promise<void> {
    // Features first, unconditionally: `PlanFeature.featureKey` is a foreign
    // key to `Feature.key`, so seeding a plan before the catalogue exists fails
    // on the very first insert.
    await this.catalogue.seed();

    for (const definition of DEFAULT_PLANS) {
      /* `upsert` with an empty `update` rather than a `findUnique` then a
       * `create`: the empty update makes "leave it exactly as it is" the
       * outcome of the same single statement that creates it, so two API
       * instances booting together cannot race into a unique-constraint crash. */
      const plan = await this.prisma.plan.upsert({
        where: { code: definition.code },
        create: {
          code: definition.code,
          name: definition.name,
          priceMinor: BigInt(definition.priceMinor),
          priceYearlyMinor:
            definition.priceYearlyMinor == null ? null : BigInt(definition.priceYearlyMinor),
          interval: definition.interval,
          isPublic: definition.isPublic,
          sortOrder: definition.sortOrder,
        },
        update: {},
      });

      for (const [featureKey, limitValue] of Object.entries(definition.features)) {
        await this.prisma.planFeature.upsert({
          where: { planId_featureKey: { planId: plan.id, featureKey } },
          create: { planId: plan.id, featureKey, limitValue },
          /* Empty for the same reason as above, and it is the whole point of
           * this change: a limit an operator has already set is a fact about
           * this deployment, not a drift from the source tree. */
          update: {},
        });
      }

      /* No prune. A key the operator removed from FREE through
       * `PUT /admin/plans/FREE/features` must stay removed, and a key they
       * added must stay added; a `deleteMany` here could only ever undo one of
       * the two. The cost is that dropping a feature from `DEFAULT_PLANS` no
       * longer withdraws it from installs that have already booted — that is
       * now `PUT /admin/plans/:code/features`, which is the same act performed
       * by whoever is entitled to perform it and leaves an audit row saying so. */
    }

    // Workspaces created before plans existed land on the free tier.
    const free = await this.prisma.plan.findUnique({ where: { code: DEFAULT_PLAN_CODE } });
    if (free) {
      const { count } = await this.prisma.workspace.updateMany({
        where: { planId: null },
        data: { planId: free.id },
      });
      if (count > 0)
        this.logger.log(`Assigned the ${DEFAULT_PLAN_CODE} plan to ${count} workspace(s)`);
    }
  }

  /** Plan features with any live per-workspace override applied on top. */
  async forWorkspace(workspaceId: string): Promise<Entitlements> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      include: { plan: { include: { features: true } }, overrides: true },
    });

    return resolveEntitlements(
      workspace?.plan?.features ?? [],
      workspace?.overrides ?? [],
      new Date(),
    );
  }

  /**
   * Current consumption, counted the same way the limits are defined.
   *
   * Two sources, and which one a feature uses is a correctness decision, not a
   * convenience one.
   *
   * DERIVED — a `COUNT(*)` or a `SUM()` over the rows the limit is about. A
   * counter drifts: miss one decrement on a delete, or let one write escape a
   * rolled-back transaction, and a workspace is locked out of something it pays
   * for with no way back short of a manual UPDATE. Anything recountable is
   * recounted, every time, including the two features this change newly
   * measured — mailbox connections are just live `MailAccount` rows, and
   * attachment storage is the sum of the bytes still on disk, which is also the
   * only version of that number that goes *down* when a user deletes a receipt.
   *
   * METERED — read from `UsageMeter`, for consumption that leaves nothing
   * behind to recount. See `METERED_FEATURE_KEYS`.
   *
   * Every other key in the catalogue reports 0, and `measured` in the snapshot
   * says which those are. An unmeasured limit must not be allowed to look
   * enforced.
   */
  async usage(workspaceId: string, timezone: string): Promise<Record<string, number>> {
    const now = new Date();
    const monthStart = startOfMonth(now, timezone);
    const monthEnd = startOfNextMonth(now, timezone);

    const [accounts, monthlyTransactions, members, storage, mailboxes, metered, catalogue] =
      await Promise.all([
        this.prisma.account.count({
          where: {
            workspaceId,
            // The loan control accounts are bookkeeping machinery, not accounts
            // the user opened, and they carry a `systemKey` for exactly that
            // reason — so this one filter also keeps them out of the count.
            // Charging a plan slot for one would mean a 402 for doing the very
            // thing the loan screen invited the user to do.
            systemKey: null,
            deletedAt: null,
            isArchived: false,
          },
        }),
        this.prisma.transaction.count({
          where: { workspaceId, deletedAt: null, createdAt: { gte: monthStart, lt: monthEnd } },
        }),
        this.prisma.membership.count({ where: { workspaceId, status: 'ACTIVE' } }),
        this.prisma.attachment.aggregate({
          where: { workspaceId, deletedAt: null },
          _sum: { sizeBytes: true },
        }),
        // A mailbox whose credentials were rejected still occupies a connection
        // slot — it is on screen, it can be repaired, and freeing the slot is
        // what the delete button is for. Only a deleted one stops counting.
        this.prisma.mailAccount.count({ where: { workspaceId, deletedAt: null } }),
        this.meters.readMany(workspaceId, METERED_FEATURE_KEYS, timezone, now),
        this.catalogue.all(),
      ]);

    // Everything the catalogue knows about starts at zero, so a feature that
    // exists but has no counter is present in the response rather than missing
    // from it — an absent key looks like a bug to a client, a zero does not.
    const usage: Record<string, number> = {};
    for (const feature of catalogue) usage[feature.key] = 0;

    return {
      ...usage,
      ...metered,
      'accounts.max': accounts,
      'transactions.monthly.max': monthlyTransactions,
      'members.max': members,
      'email.connections.max': mailboxes,
      // Rounded up. A ceiling has to round its usage the same way, or the last
      // partial megabyte would be free and a 50 MB plan would hold 50.9 MB.
      'attachments.storage.mb': Math.ceil((storage._sum.sizeBytes ?? 0) / BYTES_PER_MB),
    };
  }

  /** Which keys in `usage()` are a real measurement rather than a placeholder. */
  measuredFeatureKeys(): string[] {
    return [
      'accounts.max',
      'transactions.monthly.max',
      'members.max',
      'email.connections.max',
      'attachments.storage.mb',
      ...METERED_FEATURE_KEYS,
    ];
  }

  /**
   * Throws 402 if `wanted` more units would exceed the plan.
   *
   * The caller names a feature and, at most, how many units it is about to
   * consume. It never reasons about periods, meters or buckets: whether the
   * number behind this comes from a `COUNT(*)` over the workspace's month or
   * from a meter row keyed '2026-08' is `usage()`'s business.
   */
  async assertWithinLimit(
    workspaceId: string,
    key: FeatureKey,
    timezone: string,
    wanted = 1,
  ): Promise<void> {
    const [entitlements, usage] = await Promise.all([
      this.forWorkspace(workspaceId),
      this.usage(workspaceId, timezone),
    ]);

    const used = usage[key] ?? 0;
    if (isWithinLimit(entitlements, key, used, wanted)) return;

    const breach = describeBreach(entitlements, key, used, await this.catalogue.labelOf(key));
    if (breach) throw new FeatureLimitException(breach);
  }

  /**
   * Throws 402 if the feature is not on the plan at all.
   *
   * `label` is optional now that the catalogue carries one; passing it stays
   * supported so a caller can phrase the refusal in its own words.
   */
  async assertEnabled(workspaceId: string, key: FeatureKey, label?: string): Promise<void> {
    const entitlements = await this.forWorkspace(workspaceId);
    if (limitFor(entitlements, key) === 0) {
      throw new FeatureUnavailableException(key, label ?? (await this.catalogue.labelOf(key)));
    }
  }

  /** Everything the UI needs to render usage, in one call. */
  async snapshot(workspaceId: string, timezone: string): Promise<UsageSnapshot> {
    const [entitlements, usage, workspace] = await Promise.all([
      this.forWorkspace(workspaceId),
      this.usage(workspaceId, timezone),
      this.prisma.workspace.findUnique({ where: { id: workspaceId }, include: { plan: true } }),
    ]);
    const measured = this.measuredFeatureKeys();

    /* Every key either side knows about. The entitlement map is seeded from the
     * shipped defaults and then overwritten by the workspace's own plan rows,
     * and `usage()` starts from the catalogue — so the union is "what this
     * workspace is entitled to" plus "what could be sold to it", which is
     * exactly what a plan screen wants to draw. */
    const keys = new Set([...Object.keys(usage), ...entitlements.keys()]);

    const limits = entitlementsToJson(entitlements);
    const left: Record<string, number | null> = {};
    for (const key of keys) {
      /* A catalogue feature this workspace's plan does not grant is reported as
       * 0 — off — rather than left out. Omitting it would leave the client with
       * `remaining: 0` next to an absent limit, which reads as a bug; 0 says
       * plainly "your plan does not include this", which is the truth and is
       * what the upgrade prompt needs to know. */
      if (!(key in limits)) limits[key] = limitFor(entitlements, key);

      const value = remaining(entitlements, key, usage[key] ?? 0);
      left[key] = Number.isFinite(value) ? value : null;
    }

    return {
      entitlements: limits,
      usage,
      remaining: left,
      measured: measured.filter((key) => keys.has(key)),
      plan: workspace?.plan
        ? {
            code: workspace.plan.code,
            name: workspace.plan.name,
            priceMinor: Number(workspace.plan.priceMinor),
          }
        : null,
    };
  }

  /**
   * The public plan comparison, read from the database rather than from
   * `DEFAULT_PLANS`.
   *
   * That is the difference this whole change is about: a Custom package an
   * admin assembles this afternoon appears on the pricing page without a
   * deployment, because the page is rendering rows and not a compiled array.
   */
  async publicPlans(): Promise<CataloguePlanView[]> {
    const [plans, catalogue] = await Promise.all([
      this.prisma.plan.findMany({
        where: { isPublic: true },
        orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
        include: { features: true },
      }),
      this.catalogue.all(),
    ]);

    const order = new Map(catalogue.map((f, index) => [f.key, index]));
    const labels = new Map(catalogue.map((f) => [f.key, f.label]));

    return plans.map((plan) => ({
      code: plan.code,
      name: plan.name,
      priceMinor: Number(plan.priceMinor),
      /* Null when the plan is sold monthly only. The pricing page prints a
       * yearly column when it is a number and hides it when it is not, rather
       * than inventing twelve-times-the-monthly. */
      priceYearlyMinor: plan.priceYearlyMinor == null ? null : Number(plan.priceYearlyMinor),
      currency: plan.currency,
      interval: plan.interval,
      features: plan.features
        .slice()
        .sort(
          (a, b) =>
            (order.get(a.featureKey) ?? Number.MAX_SAFE_INTEGER) -
            (order.get(b.featureKey) ?? Number.MAX_SAFE_INTEGER),
        )
        .map((row) => ({
          key: row.featureKey,
          label: labels.get(row.featureKey) ?? row.featureKey,
          limitValue: row.limitValue,
        })),
    }));
  }
}
