import { HttpException, HttpStatus, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  DEFAULT_PLAN_CODE,
  DEFAULT_PLANS,
  describeBreach,
  entitlementsToJson,
  FEATURE_KEYS,
  isWithinLimit,
  limitFor,
  remaining,
  resolveEntitlements,
  type Entitlements,
  type FeatureKey,
} from '@hishab/core';
import { startOfMonth, startOfNextMonth } from '@hishab/shared';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Where a 402 sends someone. Two things were wrong with the old value
 * (`https://takatracker.com/settings/plan`): that route does not exist, so
 * every plan limit dead-ended on a 404, and hardcoding the production origin
 * meant a limit hit in development jumped the user to the live site.
 */
const UPGRADE_URL =
  process.env.UPGRADE_URL ?? `${process.env.APP_URL ?? 'http://localhost:3000'}/plans`;

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
  plan: { code: string; name: string; priceMinor: number } | null;
}

@Injectable()
export class EntitlementsService implements OnModuleInit {
  private readonly logger = new Logger(EntitlementsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * The plan catalogue lives in `packages/core`, so it is upserted at boot
   * rather than frozen into a migration. Changing what a tier includes is then
   * a pull request, and every environment converges on the same definition.
   */
  async onModuleInit(): Promise<void> {
    for (const definition of DEFAULT_PLANS) {
      const plan = await this.prisma.plan.upsert({
        where: { code: definition.code },
        create: {
          code: definition.code,
          name: definition.name,
          priceMinor: BigInt(definition.priceMinor),
          interval: definition.interval,
          isPublic: definition.isPublic,
          sortOrder: definition.sortOrder,
        },
        update: {
          name: definition.name,
          priceMinor: BigInt(definition.priceMinor),
          interval: definition.interval,
          isPublic: definition.isPublic,
          sortOrder: definition.sortOrder,
        },
      });

      for (const [featureKey, limitValue] of Object.entries(definition.features)) {
        await this.prisma.planFeature.upsert({
          where: { planId_featureKey: { planId: plan.id, featureKey } },
          create: { planId: plan.id, featureKey, limitValue },
          update: { limitValue },
        });
      }

      // A key removed from the definition must disappear from the database too,
      // or a retired limit would keep being enforced.
      await this.prisma.planFeature.deleteMany({
        where: { planId: plan.id, featureKey: { notIn: Object.keys(definition.features) } },
      });
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

  /** Current consumption, counted the same way the limits are defined. */
  async usage(workspaceId: string, timezone: string): Promise<Record<FeatureKey, number>> {
    const now = new Date();
    const monthStart = startOfMonth(now, timezone);
    const monthEnd = startOfNextMonth(now, timezone);

    const [accounts, monthlyTransactions, members] = await Promise.all([
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
    ]);

    // Features whose subsystems do not exist yet report zero rather than
    // guessing; each one starts counting when its milestone lands.
    const zeroes = Object.fromEntries(FEATURE_KEYS.map((k) => [k, 0])) as Record<
      FeatureKey,
      number
    >;

    return {
      ...zeroes,
      'accounts.max': accounts,
      'transactions.monthly.max': monthlyTransactions,
      'members.max': members,
    };
  }

  /** Throws 402 if one more unit would exceed the plan. */
  async assertWithinLimit(workspaceId: string, key: FeatureKey, timezone: string): Promise<void> {
    const [entitlements, usage] = await Promise.all([
      this.forWorkspace(workspaceId),
      this.usage(workspaceId, timezone),
    ]);

    const used = usage[key] ?? 0;
    if (isWithinLimit(entitlements, key, used)) return;

    const breach = describeBreach(entitlements, key, used);
    if (breach) throw new FeatureLimitException(breach);
  }

  /** Throws 402 if the feature is not on the plan at all. */
  async assertEnabled(workspaceId: string, key: FeatureKey, label: string): Promise<void> {
    const entitlements = await this.forWorkspace(workspaceId);
    if (limitFor(entitlements, key) === 0) throw new FeatureUnavailableException(key, label);
  }

  /** Everything the UI needs to render usage, in one call. */
  async snapshot(workspaceId: string, timezone: string): Promise<UsageSnapshot> {
    const [entitlements, usage, workspace] = await Promise.all([
      this.forWorkspace(workspaceId),
      this.usage(workspaceId, timezone),
      this.prisma.workspace.findUnique({ where: { id: workspaceId }, include: { plan: true } }),
    ]);

    const left: Record<string, number | null> = {};
    for (const key of FEATURE_KEYS) {
      const value = remaining(entitlements, key, usage[key] ?? 0);
      left[key] = Number.isFinite(value) ? value : null;
    }

    return {
      entitlements: entitlementsToJson(entitlements),
      usage,
      remaining: left,
      plan: workspace?.plan
        ? {
            code: workspace.plan.code,
            name: workspace.plan.name,
            priceMinor: Number(workspace.plan.priceMinor),
          }
        : null,
    };
  }
}
