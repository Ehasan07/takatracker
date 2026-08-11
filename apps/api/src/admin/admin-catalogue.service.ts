import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, type Plan, type PlanFeature } from '@prisma/client';
import { DEFAULT_PLAN_CODE, limitFor, resolveEntitlements } from '@hishab/core';
import { AuditService } from '../audit/audit.service';
import {
  FeatureCatalogueService,
  type CatalogueFeature,
} from '../entitlements/feature-catalogue.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  FEATURE_CREATED,
  FEATURE_UPDATED,
  PLAN_CREATED,
  PLAN_FEATURES_UPDATED,
  PLAN_RETIRED,
  PLAN_UNRETIRED,
  PLAN_UPDATED,
  fileAgainst,
  type AdminActor,
} from './admin-audit';
import type {
  CreateFeatureInput,
  CreatePlanInput,
  SetPlanFeaturesInput,
  UpdateFeatureInput,
  UpdatePlanInput,
} from './admin.controller';
import { USAGE_SCAN_CAP, measureUsage, type Limits } from './tenant-usage';

/** How many affected workspaces a single feature's warning names out loud. */
const WARNING_SAMPLE_SIZE = 5;

/** Where a new feature lands when the operator does not pick a position. */
const SORT_ORDER_STEP = 10;

/**
 * A limit as the API talks about it: `null` is unlimited, `0` is off, and those
 * are different facts from each other and from "not set".
 */
type LimitValue = number | null;

/**
 * Is `to` a tighter ceiling than `from`?
 *
 * `null` is unlimited, so nothing is tighter than a move *to* null and
 * everything is tighter than a move *from* it. Equal values are not tighter —
 * an operator re-saving the same map must not be warned about anything.
 */
const isTighter = (from: LimitValue, to: LimitValue): boolean => {
  if (to === null) return false;
  if (from === null) return true;
  return to < from;
};

/** One workspace that would be over a ceiling the operator is about to set. */
export interface OverLimitTenant {
  workspaceId: string;
  name: string;
  used: number;
}

/** What lowering one limit would do to the tenants already on the plan. */
export interface OverLimitFeatureWarning {
  featureKey: string;
  /** English, from `Feature.label`. */
  label: string;
  /** Bengali, from `Feature.labelBn`. This is the one to render. */
  labelBn: string;
  previousLimit: LimitValue;
  newLimit: LimitValue;
  /** Workspaces whose current usage is strictly above `newLimit`. */
  workspaceCount: number;
  /** The worst one, so the operator can see how far over "over" goes. */
  maxUsed: number;
  sample: OverLimitTenant[];
}

/**
 * The answer to "what does this change break?", computed before it is written.
 *
 * Deliberately not a blocker. An operator repricing a package on purpose is
 * doing their job; what the API owes them is the number, not a veto. Existing
 * rows are never touched either — `assertWithinLimit` compares against current
 * usage, so a workspace with 8 accounts on a plan cut to 5 keeps all 8 and is
 * simply refused a 9th. Deleting three of somebody's accounts because a price
 * list changed would be the actual disaster.
 */
export interface OverLimitWarning {
  /** Distinct workspaces over at least one of the new ceilings. */
  tenantCount: number;
  byFeature: OverLimitFeatureWarning[];
  /** Lowered keys something could put a real number against. */
  measured: string[];
  /**
   * Lowered keys nothing counts. Silence about these is not safety: the limit
   * will still be enforced the day a counter is added, and the screen must say
   * "unknown" rather than draw a reassuring zero.
   */
  unmeasured: string[];
  workspacesOnPlan: number;
  scanned: number;
  /** True when the plan has more tenants than the sweep will hold; a floor. */
  truncated: boolean;
}

/** Nothing got tighter, so nothing was measured and nobody is over. */
const noWarning = (workspacesOnPlan: number): OverLimitWarning => ({
  tenantCount: 0,
  byFeature: [],
  measured: [],
  unmeasured: [],
  workspacesOnPlan,
  scanned: 0,
  truncated: false,
});

/**
 * The package editor.
 *
 * Split from `AdminService` — which is about *tenants* — because this is about
 * the product: what may be sold, at what price, with what ceilings. The two
 * meet at exactly one point, `AdminService.assignPlan`, which puts one tenant on
 * one package. Everything here is platform-wide, and every write leaves an audit
 * row for that reason.
 *
 * There is no delete, for a plan or a feature, and that is not an omission —
 * see `retirePlan`.
 */
@Injectable()
export class AdminCatalogueService {
  private readonly logger = new Logger(AdminCatalogueService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly catalogue: FeatureCatalogueService,
  ) {}

  // --- plans -----------------------------------------------------------------

  /**
   * Every package, retired and non-public ones included.
   *
   * `workspaceCount` is the reason this endpoint is not just `publicPlans()`
   * with the filter removed. An operator about to change a ceiling needs to know
   * they are holding a live package with four hundred tenants on it rather than
   * the draft they made on Tuesday, and they need to know it *before* they open
   * the editor. It is one `groupBy` for the whole list.
   *
   * Not audited. Unlike every other route in this module it reads no tenant's
   * data — a price list is the product, not a customer's books — and the only
   * tenant-derived number in it is an aggregate count already published by
   * `admin.overview_viewed`.
   */
  async listPlans() {
    const [plans, counts, catalogue] = await Promise.all([
      this.prisma.plan.findMany({
        orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
        include: { features: true },
      }),
      /* Soft-deleted workspaces are excluded: they cannot hit a limit, so
       * counting them would inflate the number an operator is using to judge
       * how dangerous an edit is. */
      this.prisma.workspace.groupBy({
        by: ['planId'],
        where: { deletedAt: null },
        _count: { _all: true },
      }),
      this.catalogue.all(),
    ]);

    const byPlanId = new Map(counts.map((row) => [row.planId, row._count._all]));

    return {
      items: plans.map((plan) =>
        this.planView(plan, plan.features, catalogue, byPlanId.get(plan.id) ?? 0),
      ),
    };
  }

  /**
   * Create a package.
   *
   * `code` is what `Workspace.planId` resolves through and what `assignPlan`
   * looks up, so it is immutable from the moment it exists — there is no PATCH
   * for it. It is also uppercased and unique: `Plan.code` is a case-sensitive
   * unique index, so without normalising, `pro` and `PRO` would be two packages
   * whose difference nobody can see in a list.
   */
  async createPlan(actor: AdminActor, input: CreatePlanInput) {
    const existing = await this.prisma.plan.findUnique({ where: { code: input.code } });
    if (existing) throw new BadRequestException('এই কোডে একটি প্ল্যান আগে থেকেই আছে');

    const catalogue = await this.catalogue.all();
    const features = this.parseLimitMap(input.features, catalogue, new Set());

    const created = await this.prisma
      .$transaction(async (tx) => {
        const plan = await tx.plan.create({
          data: {
            code: input.code,
            name: input.name,
            priceMinor: BigInt(input.priceMinor),
            priceYearlyMinor:
              input.priceYearlyMinor == null ? null : BigInt(input.priceYearlyMinor),
            interval: input.interval,
            isPublic: input.isPublic,
            sortOrder: input.sortOrder,
          },
        });
        /* One transaction with the features, so a package cannot exist in a
         * half-priced state. A plan row with no feature rows is not an empty
         * plan, it is a plan that grants the compiled fallbacks — see
         * `resolveEntitlements` — and a tenant could be assigned to it between
         * the two writes. */
        if (features.size > 0) {
          await tx.planFeature.createMany({
            data: [...features].map(([featureKey, limitValue]) => ({
              planId: plan.id,
              featureKey,
              limitValue,
            })),
          });
        }
        return tx.plan.findUniqueOrThrow({ where: { id: plan.id }, include: { features: true } });
      })
      .catch((err: unknown) => {
        /* The check above loses to a second operator submitting the same code
         * in the same second. The unique index catches it; this turns the
         * constraint name into the same sentence. */
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new BadRequestException('এই কোডে একটি প্ল্যান আগে থেকেই আছে');
        }
        throw err;
      });

    await this.audit.record({
      ...fileAgainst(actor),
      action: PLAN_CREATED,
      entity: 'Plan',
      entityId: created.id,
      after: {
        code: created.code,
        name: created.name,
        priceMinor: Number(created.priceMinor),
        priceYearlyMinor:
          created.priceYearlyMinor == null ? null : Number(created.priceYearlyMinor),
        interval: created.interval,
        isPublic: created.isPublic,
        sortOrder: created.sortOrder,
        features: Object.fromEntries(features),
        operator: actor.email,
      },
    });

    this.logger.log(`Operator ${actor.email} created plan ${created.code}`);

    return this.planView(created, created.features, catalogue, 0);
  }

  /**
   * Edit a package's commercial details. Never its `code`, never its features —
   * those are `PUT /admin/plans/:code/features`, which is one atomic map rather
   * than a field at a time.
   */
  async updatePlan(actor: AdminActor, code: string, input: UpdatePlanInput) {
    const plan = await this.requirePlan(code);

    if (input.isPublic === false) this.assertHideable(plan);

    const data = {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.priceMinor === undefined ? {} : { priceMinor: BigInt(input.priceMinor) }),
      /* Omitted leaves the yearly price alone; an explicit `null` withdraws it,
       * which is how a plan stops being sold by the year. */
      ...(input.priceYearlyMinor === undefined
        ? {}
        : {
            priceYearlyMinor:
              input.priceYearlyMinor === null ? null : BigInt(input.priceYearlyMinor),
          }),
      ...(input.interval === undefined ? {} : { interval: input.interval }),
      ...(input.isPublic === undefined ? {} : { isPublic: input.isPublic }),
      ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
    };

    const updated = await this.prisma.plan.update({
      where: { id: plan.id },
      data,
      include: { features: true },
    });

    await this.audit.record({
      ...fileAgainst(actor),
      action: PLAN_UPDATED,
      entity: 'Plan',
      entityId: plan.id,
      before: {
        code: plan.code,
        name: plan.name,
        priceMinor: Number(plan.priceMinor),
        priceYearlyMinor: plan.priceYearlyMinor == null ? null : Number(plan.priceYearlyMinor),
        interval: plan.interval,
        isPublic: plan.isPublic,
        sortOrder: plan.sortOrder,
      },
      after: {
        name: updated.name,
        priceMinor: Number(updated.priceMinor),
        priceYearlyMinor:
          updated.priceYearlyMinor == null ? null : Number(updated.priceYearlyMinor),
        interval: updated.interval,
        isPublic: updated.isPublic,
        sortOrder: updated.sortOrder,
        operator: actor.email,
      },
    });

    const catalogue = await this.catalogue.all();
    return this.planView(
      updated,
      updated.features,
      catalogue,
      await this.workspaceCount(updated.id),
    );
  }

  /**
   * Set a package's whole limit map in one request.
   *
   * The whole map, not one key at a time, because a package is a single
   * commercial statement: "five accounts, three hundred transactions, no
   * export". Applying that as five requests means five states the world can
   * stop in, one of which is a plan that grants unlimited transactions to
   * everybody on the free tier for as long as the operator's wifi is down.
   *
   * `null` is unlimited, `0` is off, and a key left out of the map is *removed*
   * from the plan — which is not the same as `0`: a removed key falls back to
   * whatever `resolveEntitlements` resolves it to, which for a shipped feature
   * is the compiled FREE default and for a runtime-created one is off. The
   * warning below computes both sides through that same resolver rather than
   * comparing the raw numbers, so what it reports is what tenants will actually
   * experience.
   */
  async setPlanFeatures(actor: AdminActor, code: string, input: SetPlanFeaturesInput) {
    const plan = await this.prisma.plan.findUnique({
      where: { code },
      include: { features: true },
    });
    if (!plan) throw new NotFoundException('এই কোডের কোনো প্ল্যান নেই');

    const catalogue = await this.catalogue.all();
    const held = new Set(plan.features.map((f) => f.featureKey));
    const next = this.parseLimitMap(input.features, catalogue, held);

    const warning = await this.overLimitWarning(plan, next, catalogue);

    /* A dry run validates exactly as hard as a real one — an operator who is
     * shown "0 affected" and then gets a 400 on save has been told nothing
     * useful. It just stops before the write. */
    if (input.dryRun) {
      return {
        planCode: plan.code,
        dryRun: true,
        applied: false,
        features: this.featureViews(
          [...next].map(([featureKey, limitValue]) => ({ featureKey, limitValue })),
          catalogue,
        ),
        warning,
      };
    }

    const before = Object.fromEntries(plan.features.map((f) => [f.featureKey, f.limitValue]));

    const saved = await this.prisma.$transaction(async (tx) => {
      await tx.planFeature.deleteMany({
        where: { planId: plan.id, featureKey: { notIn: [...next.keys()] } },
      });
      for (const [featureKey, limitValue] of next) {
        await tx.planFeature.upsert({
          where: { planId_featureKey: { planId: plan.id, featureKey } },
          create: { planId: plan.id, featureKey, limitValue },
          update: { limitValue },
        });
      }
      return tx.planFeature.findMany({ where: { planId: plan.id } });
    });

    await this.audit.record({
      ...fileAgainst(actor),
      action: PLAN_FEATURES_UPDATED,
      entity: 'Plan',
      entityId: plan.id,
      before,
      after: {
        code: plan.code,
        features: Object.fromEntries(next),
        /* The warning goes on the row, not just on the screen. Six months from
         * now the question is not "did the limit change?" but "did anyone know
         * it would push forty tenants over?", and the answer has to be in the
         * record rather than in somebody's memory of a dialog. */
        overLimitTenants: warning.tenantCount,
        overLimitFeatures: warning.byFeature.map((f) => ({
          featureKey: f.featureKey,
          previousLimit: f.previousLimit,
          newLimit: f.newLimit,
          workspaceCount: f.workspaceCount,
        })),
        operator: actor.email,
      },
    });

    if (warning.tenantCount > 0) {
      this.logger.warn(
        `Operator ${actor.email} tightened ${plan.code}; ${warning.tenantCount} workspace(s) are now over a limit. ` +
          `Existing rows are untouched; new ones will be refused with a 402.`,
      );
    }

    return {
      planCode: plan.code,
      dryRun: false,
      applied: true,
      features: this.featureViews(saved, catalogue),
      warning,
    };
  }

  /**
   * Take a package off sale.
   *
   * ## Why there is no DELETE, and why this is `isPublic: false`
   *
   * `Workspace.planId` points at the row. Deleting it would either fail on the
   * foreign key or — worse, if anyone ever adds a cascade — drop the tenants'
   * limits to the compiled fallbacks without a word to them or a row anywhere
   * saying it happened. A package somebody is on is not deletable; it is
   * withdrawable.
   *
   * `isPublic: false` is that state rather than a new column, for two reasons.
   * The behaviour is already exactly right: `EntitlementsService.publicPlans`
   * filters on `isPublic`, so a retired package vanishes from the pricing page
   * on the next request while every tenant on it keeps precisely what they had.
   * And a second boolean meaning "not offered, but for a different reason"
   * would leave four states where the code only ever branches on one, which is
   * three opportunities for the pricing page and the admin screen to disagree.
   *
   * What is genuinely lost: a package created private (an internal or bespoke
   * one, never on the pricing page) and a package retired after a year on sale
   * are the same row. The audit log distinguishes them — `admin.plan_created`
   * with `isPublic: false` versus `admin.plan_retired` — but a list cannot. If
   * that distinction ever has to be visible on screen, it wants a nullable
   * `Plan.retiredAt`, which is a migration and belongs to whoever owns the
   * schema.
   */
  async retirePlan(actor: AdminActor, code: string) {
    const plan = await this.requirePlan(code);
    this.assertHideable(plan);
    if (!plan.isPublic) throw new BadRequestException('এই প্ল্যান আগে থেকেই অবসরপ্রাপ্ত');

    return this.setVisibility(actor, plan, false, PLAN_RETIRED);
  }

  /** Put it back on sale. Tenants on it are unaffected either way. */
  async unretirePlan(actor: AdminActor, code: string) {
    const plan = await this.requirePlan(code);
    if (plan.isPublic) throw new BadRequestException('এই প্ল্যান আগে থেকেই চালু আছে');

    return this.setVisibility(actor, plan, true, PLAN_UNRETIRED);
  }

  // --- features --------------------------------------------------------------

  /**
   * The catalogue, retired entries included, with which packages grant each one.
   *
   * `grantedByPlans` is what makes retiring a feature a decision rather than a
   * guess: it is the list of packages that keep it after the catalogue stops
   * offering it. Not audited, for the same reason `listPlans` is not.
   */
  async listFeatures() {
    const [catalogue, grants] = await Promise.all([
      this.catalogue.all(),
      this.prisma.planFeature.findMany({
        select: { featureKey: true, limitValue: true, plan: { select: { code: true } } },
      }),
    ]);

    const byFeature = new Map<string, Array<{ code: string; limitValue: LimitValue }>>();
    for (const grant of grants) {
      const bucket = byFeature.get(grant.featureKey) ?? [];
      bucket.push({ code: grant.plan.code, limitValue: grant.limitValue });
      byFeature.set(grant.featureKey, bucket);
    }

    return {
      items: catalogue.map((feature) => ({
        ...this.featureDescriptor(feature),
        grantedByPlans: (byFeature.get(feature.key) ?? []).sort((a, b) =>
          a.code.localeCompare(b.code),
        ),
      })),
    };
  }

  /**
   * Add something sellable to the catalogue.
   *
   * **A new feature is off everywhere until a package prices it**, and that is
   * the single most important line in this method. Creating the row grants
   * nothing: no `PlanFeature` is written, so every workspace resolves the key
   * through `limitFor`, whose `whenUnknown` default is `0`. If this method
   * quietly wrote a row onto each plan — or if that default were `null` — saving
   * a form would hand an unpriced, uncapped feature to every tenant in the
   * system at once. The only thing created here is a description.
   *
   * `kind` is fixed at creation for the same reason it is absent from PATCH:
   * it decides how every number ever stored under this key is read.
   */
  async createFeature(actor: AdminActor, input: CreateFeatureInput) {
    const existing = await this.prisma.feature.findUnique({ where: { key: input.key } });
    if (existing) throw new BadRequestException('এই কী-তে একটি ফিচার আগে থেকেই আছে');

    const sortOrder = input.sortOrder ?? (await this.nextSortOrder());

    const created = await this.prisma.feature
      .create({
        data: {
          key: input.key,
          // English in `label`, Bengali in `labelBn` — the column names, which
          // are the opposite way round from `CatalogueFeature`. The admin API
          // speaks the column names so an operator editing a row sees the same
          // two fields the database has.
          label: input.label,
          labelBn: input.labelBn,
          kind: input.kind,
          unit: input.unit,
          period: input.period,
          category: input.category,
          isActive: input.isActive,
          sortOrder,
        },
      })
      .catch((err: unknown) => {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new BadRequestException('এই কী-তে একটি ফিচার আগে থেকেই আছে');
        }
        throw err;
      });

    /* Before the audit write, not after: the panel reads the catalogue back
     * immediately and a 30-second stale cache would make a successful save look
     * like it did nothing. */
    this.catalogue.invalidate();

    await this.audit.record({
      ...fileAgainst(actor),
      action: FEATURE_CREATED,
      entity: 'Feature',
      entityId: created.key,
      after: {
        key: created.key,
        label: created.label,
        labelBn: created.labelBn,
        kind: created.kind,
        unit: created.unit,
        period: created.period,
        category: created.category,
        isActive: created.isActive,
        sortOrder: created.sortOrder,
        operator: actor.email,
      },
    });

    this.logger.log(
      `Operator ${actor.email} added feature ${created.key} to the catalogue; it is off on every plan until one prices it`,
    );

    return {
      ...this.featureDescriptor({
        key: created.key,
        label: created.labelBn,
        labelEn: created.label,
        kind: created.kind,
        unit: created.unit,
        period: created.period,
        category: created.category,
        isActive: created.isActive,
        sortOrder: created.sortOrder,
      }),
      /** Empty, always, on the request that created it. See the doc comment. */
      grantedByPlans: [],
    };
  }

  /**
   * Edit a catalogue entry's description.
   *
   * Not `key`: it is the foreign key `PlanFeature` and `WorkspaceFeatureOverride`
   * point at, and every hardcoded call site names it as a string literal.
   *
   * Not `kind`: turning a LIMIT into a FLAG reinterprets every number already
   * stored under it. `accounts.max: 5` means "five accounts" as a LIMIT and "on"
   * as a FLAG, so one PATCH would silently convert every ceiling in the system
   * into an unbounded yes. Retire the feature and add a new one.
   *
   * Not `period` either, and for the same class of reason: it decides which
   * `UsageMeter` bucket a write lands in, so changing it strands every meter row
   * already written under the old bucket and reads this month's usage as zero.
   */
  async updateFeature(actor: AdminActor, key: string, input: UpdateFeatureInput) {
    const feature = await this.prisma.feature.findUnique({ where: { key } });
    if (!feature) throw new NotFoundException('এই কী-তে কোনো ফিচার নেই');

    const updated = await this.prisma.feature.update({
      where: { key },
      data: {
        ...(input.label === undefined ? {} : { label: input.label }),
        ...(input.labelBn === undefined ? {} : { labelBn: input.labelBn }),
        ...(input.unit === undefined ? {} : { unit: input.unit }),
        ...(input.category === undefined ? {} : { category: input.category }),
        ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
        ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
      },
    });

    this.catalogue.invalidate();

    await this.audit.record({
      ...fileAgainst(actor),
      action: FEATURE_UPDATED,
      entity: 'Feature',
      entityId: key,
      before: {
        label: feature.label,
        labelBn: feature.labelBn,
        unit: feature.unit,
        category: feature.category,
        isActive: feature.isActive,
        sortOrder: feature.sortOrder,
      },
      after: {
        label: updated.label,
        labelBn: updated.labelBn,
        unit: updated.unit,
        category: updated.category,
        isActive: updated.isActive,
        sortOrder: updated.sortOrder,
        operator: actor.email,
      },
    });

    if (feature.isActive && !updated.isActive) {
      /* Retiring a feature leaves every existing grant in place — that is what
       * `isActive` means here — so this is not a warning about tenants losing
       * anything. It is worth a line because the catalogue quietly getting
       * smaller is otherwise invisible until somebody cannot find a key. */
      this.logger.log(
        `Operator ${actor.email} retired feature ${key}; plans that already grant it keep it`,
      );
    }

    return this.featureDescriptor({
      key: updated.key,
      label: updated.labelBn,
      labelEn: updated.label,
      kind: updated.kind,
      unit: updated.unit,
      period: updated.period,
      category: updated.category,
      isActive: updated.isActive,
      sortOrder: updated.sortOrder,
    });
  }

  // --- internals -------------------------------------------------------------

  private async requirePlan(code: string): Promise<Plan> {
    const plan = await this.prisma.plan.findUnique({ where: { code } });
    if (!plan) throw new NotFoundException('এই কোডের কোনো প্ল্যান নেই');
    return plan;
  }

  /**
   * Refuse to hide the package new signups land on.
   *
   * `AuthService.signup` assigns `DEFAULT_PLAN_CODE` by code, and
   * `EntitlementsService.onModuleInit` backfills planless workspaces onto it. A
   * pricing page that does not list the plan every new user is actually put on
   * is not a withdrawn package, it is a page that lies about what the product
   * costs. Retiring it needs a code change to point the default somewhere else
   * first.
   */
  private assertHideable(plan: Plan): void {
    if (plan.code === DEFAULT_PLAN_CODE) {
      throw new BadRequestException(
        'নতুন সাইনআপ এই প্ল্যানেই যায়, তাই এটি অবসর বা লুকানো যাবে না',
      );
    }
  }

  private async setVisibility(
    actor: AdminActor,
    plan: Plan,
    isPublic: boolean,
    action: typeof PLAN_RETIRED | typeof PLAN_UNRETIRED,
  ) {
    const [updated, workspaceCount, catalogue] = await Promise.all([
      this.prisma.plan.update({
        where: { id: plan.id },
        data: { isPublic },
        include: { features: true },
      }),
      this.workspaceCount(plan.id),
      this.catalogue.all(),
    ]);

    await this.audit.record({
      ...fileAgainst(actor),
      action,
      entity: 'Plan',
      entityId: plan.id,
      before: { code: plan.code, isPublic: plan.isPublic },
      after: {
        code: plan.code,
        isPublic,
        /* On the row because it is the fact that makes retiring safe: these
         * tenants keep the package. If the count is ever seen to drop after a
         * retire, something deleted rows it had no business deleting. */
        workspacesKeepingIt: workspaceCount,
        operator: actor.email,
      },
    });

    this.logger.log(
      `Operator ${actor.email} ${isPublic ? 'un-retired' : 'retired'} plan ${plan.code}; ` +
        `${workspaceCount} workspace(s) stay on it`,
    );

    return this.planView(updated, updated.features, catalogue, workspaceCount);
  }

  private async workspaceCount(planId: string): Promise<number> {
    return this.prisma.workspace.count({ where: { planId, deletedAt: null } });
  }

  private async nextSortOrder(): Promise<number> {
    const last = await this.prisma.feature.aggregate({ _max: { sortOrder: true } });
    return (last._max.sortOrder ?? 0) + SORT_ORDER_STEP;
  }

  /**
   * Turn the request's `{ key: limit }` object into a checked map.
   *
   * Two rejections, both of which would otherwise be a 500 or a lie:
   *
   * - An unknown key. `PlanFeature.featureKey` is a foreign key onto
   *   `Feature.key`, so Postgres would refuse it with a constraint name no
   *   operator can act on.
   * - A retired key the plan does not already grant. `isActive: false` means
   *   "existing plans keep it, nothing new sells it", so adding one to a package
   *   is exactly the act that was retired. A key the plan *already* holds passes,
   *   because the screen round-trips the whole map and an unrelated retired row
   *   must not make every other edit unsavable.
   */
  private parseLimitMap(
    input: Record<string, LimitValue>,
    catalogue: readonly CatalogueFeature[],
    alreadyHeld: ReadonlySet<string>,
  ): Map<string, LimitValue> {
    const known = new Map(catalogue.map((f) => [f.key, f]));
    const out = new Map<string, LimitValue>();

    for (const [key, value] of Object.entries(input)) {
      const feature = known.get(key);
      if (!feature) {
        const seeded = catalogue.length > 0;
        throw new BadRequestException(
          seeded
            ? `ফিচার ক্যাটালগে "${key}" নেই`
            : 'ফিচার ক্যাটালগ এখনো সিড করা হয়নি, তাই প্ল্যানে ফিচার যোগ করা যাচ্ছে না',
        );
      }
      if (!feature.isActive && !alreadyHeld.has(key)) {
        throw new BadRequestException(
          `"${feature.label}" অবসরপ্রাপ্ত, নতুন প্ল্যানে যোগ করা যাবে না`,
        );
      }
      out.set(key, value);
    }

    return out;
  }

  /**
   * How many workspaces the new limits would put over their ceiling.
   *
   * Both sides go through `resolveEntitlements` — the same function the enforcer
   * uses — rather than comparing the submitted numbers to the stored ones. Two
   * things fall out of that which a naive diff gets wrong. A key *removed* from
   * a plan does not become 0; it falls back to whatever the resolver resolves,
   * which for a shipped feature is the compiled FREE default. And a tenant with
   * a live override on the key is not affected by the plan change at all, so
   * they must not be counted — their ceiling is coming from somewhere else.
   */
  private async overLimitWarning(
    plan: Plan & { features: PlanFeature[] },
    next: ReadonlyMap<string, LimitValue>,
    catalogue: readonly CatalogueFeature[],
  ): Promise<OverLimitWarning> {
    const now = new Date();
    const currentRows = plan.features.map((f) => ({
      featureKey: f.featureKey,
      limitValue: f.limitValue,
    }));
    const nextRows = [...next].map(([featureKey, limitValue]) => ({ featureKey, limitValue }));

    /* Plan-level first, with no overrides: if nothing got tighter there is
     * nothing to warn about and the sweep never runs. Raising limits is the
     * common edit and it must not cost five aggregate queries. */
    const planBefore = resolveEntitlements(currentRows, [], now) as Limits;
    const planAfter = resolveEntitlements(nextRows, [], now) as Limits;

    const tightened: Array<{ key: string; from: LimitValue; to: LimitValue }> = [];
    for (const key of new Set([...planBefore.keys(), ...planAfter.keys()])) {
      const from = limitFor(planBefore, key);
      const to = limitFor(planAfter, key);
      if (isTighter(from, to)) tightened.push({ key, from, to });
    }
    if (tightened.length === 0) return noWarning(await this.workspaceCount(plan.id));

    const keys = tightened.map((t) => t.key);
    const scanned = await this.prisma.workspace.findMany({
      where: { planId: plan.id, deletedAt: null },
      take: USAGE_SCAN_CAP + 1,
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        name: true,
        timezone: true,
        overrides: {
          where: { featureKey: { in: keys } },
          select: { featureKey: true, limitValue: true, expiresAt: true },
        },
      },
    });

    const truncated = scanned.length > USAGE_SCAN_CAP;
    const tenants = truncated ? scanned.slice(0, USAGE_SCAN_CAP) : scanned;
    if (truncated) {
      this.logger.warn(
        `Over-limit sweep for ${plan.code} capped at ${USAGE_SCAN_CAP} tenants; the count is a floor, not a total.`,
      );
    }

    const periods = new Map(catalogue.map((f) => [f.key, f.period]));
    const usage = await measureUsage(this.prisma, tenants, keys, periods, now);
    const labels = new Map(catalogue.map((f) => [f.key, f]));

    const breaches = new Map<string, OverLimitTenant[]>();
    const overTenants = new Set<string>();

    for (const tenant of tenants) {
      const after = resolveEntitlements(nextRows, tenant.overrides, now) as Limits;
      const before = resolveEntitlements(currentRows, tenant.overrides, now) as Limits;

      for (const { key } of tightened) {
        const to = limitFor(after, key);
        // An override pins this tenant's ceiling; the plan edit does not reach
        // them. Counting them would overstate the damage and send an operator
        // chasing a customer who is fine.
        if (to === null || !isTighter(limitFor(before, key), to)) continue;

        const used = usage.get(tenant.id, key);
        // `null` is "nothing counts this", which is reported as `unmeasured`
        // rather than silently treated as zero.
        if (used === null || used <= to) continue;

        overTenants.add(tenant.id);
        const bucket = breaches.get(key) ?? [];
        bucket.push({ workspaceId: tenant.id, name: tenant.name, used });
        breaches.set(key, bucket);
      }
    }

    const byFeature: OverLimitFeatureWarning[] = tightened
      .map(({ key, from, to }) => {
        const affected = (breaches.get(key) ?? []).sort((a, b) => b.used - a.used);
        const feature = labels.get(key);
        return {
          featureKey: key,
          // `CatalogueFeature.label` is the Bengali one and `labelEn` the
          // English one — the reverse of the column names. See its doc comment.
          label: feature?.labelEn ?? key,
          labelBn: feature?.label ?? key,
          previousLimit: from,
          newLimit: to,
          workspaceCount: affected.length,
          maxUsed: affected[0]?.used ?? 0,
          sample: affected.slice(0, WARNING_SAMPLE_SIZE),
        };
      })
      .filter((row) => row.workspaceCount > 0)
      .sort((a, b) => b.workspaceCount - a.workspaceCount);

    return {
      tenantCount: overTenants.size,
      byFeature,
      measured: usage.measured,
      unmeasured: usage.unmeasured,
      workspacesOnPlan: scanned.length,
      scanned: tenants.length,
      truncated,
    };
  }

  private planView(
    plan: Plan,
    features: readonly PlanFeature[],
    catalogue: readonly CatalogueFeature[],
    workspaceCount: number,
  ) {
    return {
      id: plan.id,
      code: plan.code,
      name: plan.name,
      priceMinor: Number(plan.priceMinor),
      priceYearlyMinor: plan.priceYearlyMinor == null ? null : Number(plan.priceYearlyMinor),
      currency: plan.currency,
      interval: plan.interval,
      isPublic: plan.isPublic,
      /** The same bit as `isPublic`, named for what it means here. */
      retired: !plan.isPublic,
      /** New signups land on this one; it cannot be retired. */
      isDefault: plan.code === DEFAULT_PLAN_CODE,
      sortOrder: plan.sortOrder,
      createdAt: plan.createdAt.toISOString(),
      updatedAt: plan.updatedAt.toISOString(),
      /** Live workspaces on this package. The reason to hesitate before editing. */
      workspaceCount,
      features: this.featureViews(features, catalogue),
    };
  }

  /** A plan's grants, in catalogue order, each carrying its own description. */
  private featureViews(
    features: readonly { featureKey: string; limitValue: LimitValue }[],
    catalogue: readonly CatalogueFeature[],
  ) {
    const order = new Map(catalogue.map((f, index) => [f.key, index]));
    const known = new Map(catalogue.map((f) => [f.key, f]));

    return features
      .slice()
      .sort(
        (a, b) =>
          (order.get(a.featureKey) ?? Number.MAX_SAFE_INTEGER) -
          (order.get(b.featureKey) ?? Number.MAX_SAFE_INTEGER),
      )
      .map((row) => {
        const feature = known.get(row.featureKey);
        return {
          key: row.featureKey,
          label: feature?.labelEn ?? row.featureKey,
          labelBn: feature?.label ?? row.featureKey,
          kind: feature?.kind ?? null,
          unit: feature?.unit ?? null,
          period: feature?.period ?? null,
          category: feature?.category ?? null,
          /** False means the catalogue has retired it and this plan kept it. */
          isActive: feature?.isActive ?? false,
          /** `null` is unlimited. `0` is off. They are different. */
          limitValue: row.limitValue,
        };
      });
  }

  /** One catalogue row, with the column naming the admin API speaks. */
  private featureDescriptor(feature: CatalogueFeature) {
    return {
      key: feature.key,
      /** English, from `Feature.label`. */
      label: feature.labelEn,
      /** Bengali, from `Feature.labelBn`. */
      labelBn: feature.label,
      kind: feature.kind,
      unit: feature.unit,
      period: feature.period,
      category: feature.category,
      isActive: feature.isActive,
      sortOrder: feature.sortOrder,
    };
  }
}
