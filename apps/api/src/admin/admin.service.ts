import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { FeatureKind, MeterPeriod, WorkspaceStatus } from '@prisma/client';
import { resolveEntitlements } from '@hishab/core';
import { startOfMonth, startOfNextMonth, toLocalDateString } from '@hishab/shared';
import { AuditService, type AuditAction } from '../audit/audit.service';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  AUDIT_VIEWED,
  FEATURE_OVERRIDDEN,
  OVERVIEW_VIEWED,
  PLAN_ASSIGNED,
  TENANT_LIST_VIEWED,
  TENANT_REACTIVATED,
  TENANT_SUSPENDED,
  TENANT_VIEWED,
  type AdminActor,
} from './admin-audit';
import type {
  AssignPlanInput,
  ListTenantsQuery,
  PlatformAuditQuery,
  SetFeatureOverrideInput,
  SuspendInput,
} from './admin.controller';

const DEFAULT_PAGE = 25;
const MAX_PAGE = 100;

/** A tenant this close to any measured ceiling is worth a support call. */
const NEAR_LIMIT_RATIO = 0.8;

/** How many tenants the near-limit sweep will hold in memory at once. */
const OVERVIEW_SCAN_CAP = 2_000;

const SIGNUP_WINDOW_DAYS = 30;

const BYTES_PER_MB = 1024 * 1024;

/* `Math.round` is banned repo-wide (money is integer poisha). This is not
 * money, but two decimals read better than a float tail either way. */
const toMb = (bytes: number): number => Number((bytes / BYTES_PER_MB).toFixed(2));

/**
 * Resolved ceilings, keyed by feature.
 *
 * Deliberately a plain `ReadonlyMap<string, …>` rather than `@hishab/core`'s
 * `Entitlements`. The catalogue is becoming open — features created at runtime
 * cannot be in a compiled union — so this module treats a feature key as what
 * it is in the database: a string.
 */
type Limits = ReadonlyMap<string, number | null>;

/**
 * The ceiling for one key, as the enforcer sees it.
 *
 * `null` is unlimited, `0` is switched off, and a key the map has never heard
 * of is **also** off. That last case is not pedantry: the catalogue is open, so
 * a feature a super admin creates this afternoon is on nobody's plan yet, and
 * reading a missing key as "unlimited" would hand every tenant in the system an
 * uncapped feature the moment it was saved.
 */
const limitOf = (limits: Limits, key: string): number | null =>
  limits.has(key) ? (limits.get(key) ?? null) : 0;

/** What the admin screens are told about one sellable feature. */
export interface FeatureDescriptor {
  key: string;
  label: string;
  labelBn: string;
  kind: FeatureKind;
  unit: string;
  period: MeterPeriod;
  category: string;
  sortOrder: number;
}

/**
 * The four features anything actually counts today, used **only** while the
 * `Feature` table is unseeded.
 *
 * `Feature` is the catalogue — that is the whole point of moving it out of a
 * TypeScript union — and `EntitlementsModule` seeds it at boot. Until a given
 * database has been through that boot, an empty table would make the tenant
 * screen look broken and would silently report "0 tenants near a limit", which
 * is a claim rather than a measurement. These four are the ones with a real
 * usage number behind them, so they are exactly the set the near-limit sweep
 * can say anything about. Labels are duplicated here on purpose: importing them
 * would tie this module back to the compiled catalogue it is trying to stop
 * depending on.
 */
const UNSEEDED_FALLBACK: FeatureDescriptor[] = [
  {
    key: 'accounts.max',
    label: 'Accounts',
    labelBn: 'অ্যাকাউন্ট',
    kind: 'LIMIT',
    unit: 'count',
    period: 'LIFETIME',
    category: 'core',
    sortOrder: 10,
  },
  {
    key: 'transactions.monthly.max',
    label: 'Monthly transactions',
    labelBn: 'মাসিক লেনদেন',
    kind: 'LIMIT',
    unit: 'per-month',
    period: 'MONTHLY',
    category: 'core',
    sortOrder: 20,
  },
  {
    key: 'members.max',
    label: 'Members',
    labelBn: 'সদস্য',
    kind: 'LIMIT',
    unit: 'count',
    period: 'LIFETIME',
    category: 'core',
    sortOrder: 30,
  },
  {
    key: 'attachments.storage.mb',
    label: 'Attachment storage',
    labelBn: 'সংযুক্তি স্টোরেজ',
    kind: 'LIMIT',
    unit: 'megabytes',
    period: 'LIFETIME',
    category: 'core',
    sortOrder: 40,
  },
];

/** The three features `EntitlementsService.usage` still counts with live queries. */
const LIVE_COUNTED = new Set<string>(['accounts.max', 'transactions.monthly.max', 'members.max']);

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
  ) {}

  // --- tenants ---------------------------------------------------------------

  /**
   * Every workspace, newest first, with the four numbers support asks for
   * before picking up the phone: seats, volume, disk and plan.
   *
   * Counts come from three `groupBy` calls over the ids on this page rather
   * than a correlated count per row — a page of 100 tenants is four queries,
   * not three hundred and one.
   */
  async listTenants(actor: AdminActor, query: ListTenantsQuery) {
    const limit = Math.min(MAX_PAGE, Math.max(1, query.limit ?? DEFAULT_PAGE));
    const q = query.q?.trim();

    const rows = await this.prisma.workspace.findMany({
      where: {
        deletedAt: null,
        ...(query.status ? { status: query.status } : {}),
        ...(query.planCode ? { plan: { code: query.planCode } } : {}),
        ...(q
          ? {
              OR: [
                { name: { contains: q, mode: 'insensitive' as const } },
                { owner: { email: { contains: q, mode: 'insensitive' as const } } },
              ],
            }
          : {}),
      },
      /* Two keys, because `createdAt` is not unique. Two workspaces created in
       * the same millisecond could otherwise swap places between pages and one
       * of them would never be returned. */
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        name: true,
        status: true,
        currency: true,
        timezone: true,
        createdAt: true,
        trialEndsAt: true,
        plan: { select: { code: true, name: true, priceMinor: true } },
        // Never `passwordHash`, never `tokenVersion`. This reaches a browser.
        owner: { select: { id: true, name: true, email: true } },
      },
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const ids = page.map((w) => w.id);

    const [members, transactions, storage] = await Promise.all([
      this.prisma.membership.groupBy({
        by: ['workspaceId'],
        where: { workspaceId: { in: ids }, status: 'ACTIVE' },
        _count: { _all: true },
      }),
      this.prisma.transaction.groupBy({
        by: ['workspaceId'],
        where: { workspaceId: { in: ids }, deletedAt: null },
        _count: { _all: true },
      }),
      this.prisma.attachment.groupBy({
        by: ['workspaceId'],
        where: { workspaceId: { in: ids }, deletedAt: null },
        _sum: { sizeBytes: true },
      }),
    ]);

    const memberCount = new Map(members.map((r) => [r.workspaceId, r._count._all]));
    const txnCount = new Map(transactions.map((r) => [r.workspaceId, r._count._all]));
    const bytes = new Map(storage.map((r) => [r.workspaceId, r._sum.sizeBytes ?? 0]));

    const items = page.map((w) => ({
      id: w.id,
      name: w.name,
      status: w.status,
      currency: w.currency,
      timezone: w.timezone,
      createdAt: w.createdAt.toISOString(),
      trialEndsAt: w.trialEndsAt?.toISOString() ?? null,
      plan: w.plan
        ? { code: w.plan.code, name: w.plan.name, priceMinor: Number(w.plan.priceMinor) }
        : null,
      owner: w.owner,
      memberCount: memberCount.get(w.id) ?? 0,
      transactionCount: txnCount.get(w.id) ?? 0,
      storageBytes: bytes.get(w.id) ?? 0,
      storageMb: toMb(bytes.get(w.id) ?? 0),
    }));

    this.audit.emit({
      ...this.fileAgainst(actor),
      action: TENANT_LIST_VIEWED,
      entity: 'Workspace',
      after: {
        q: q ?? null,
        status: query.status ?? null,
        planCode: query.planCode ?? null,
        limit,
        returned: items.length,
      },
    });

    return { items, nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null };
  }

  /**
   * One tenant, in enough detail to answer a support ticket without a second
   * request: what they pay for, what they are using, what has been granted by
   * hand and by whom, who can log in, and when anybody last did anything.
   */
  async tenantDetail(actor: AdminActor, workspaceId: string) {
    const workspace = await this.prisma.workspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
      select: {
        id: true,
        name: true,
        status: true,
        currency: true,
        timezone: true,
        createdAt: true,
        updatedAt: true,
        trialEndsAt: true,
        owner: { select: { id: true, name: true, email: true } },
        plan: {
          select: {
            id: true,
            code: true,
            name: true,
            priceMinor: true,
            interval: true,
            features: { select: { featureKey: true, limitValue: true } },
          },
        },
        overrides: {
          select: {
            id: true,
            featureKey: true,
            limitValue: true,
            expiresAt: true,
            note: true,
            grantedByUserId: true,
            createdAt: true,
          },
        },
        memberships: {
          orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
          select: {
            id: true,
            role: true,
            status: true,
            joinedAt: true,
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                phone: true,
                locale: true,
                emailVerifiedAt: true,
                isSuperAdmin: true,
              },
            },
          },
        },
      },
    });

    if (!workspace) throw new NotFoundException('ওয়ার্কস্পেস পাওয়া যায়নি');

    const { features: catalogue, seeded } = await this.catalogue();
    const now = new Date();

    const [usage, storage, lastTransaction, lastAudit, granters, transactionCount, limits] =
      await Promise.all([
        this.usageFor(workspace.id, workspace.timezone, catalogue, now),
        this.prisma.attachment.aggregate({
          where: { workspaceId: workspace.id, deletedAt: null },
          _sum: { sizeBytes: true },
          _count: { _all: true },
        }),
        this.prisma.transaction.findFirst({
          where: { workspaceId: workspace.id },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
        }),
        this.prisma.auditEvent.findFirst({
          where: { workspaceId: workspace.id },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true, action: true },
        }),
        this.grantersFor(workspace.overrides.map((o) => o.grantedByUserId)),
        this.prisma.transaction.count({ where: { workspaceId: workspace.id, deletedAt: null } }),
        /* Through the enforcer, not a local re-resolution. If this screen and
         * the 402 can disagree about a tenant's ceiling then the screen is
         * worse than nothing — support would talk a customer through a limit
         * that is not the one blocking them. */
        this.entitlements.forWorkspace(workspace.id) as Promise<Limits>,
      ]);

    const planLimits = new Map<string, number | null>(
      (workspace.plan?.features ?? []).map((f) => [f.featureKey, f.limitValue]),
    );
    const liveOverrides = new Map(
      workspace.overrides
        .filter((o) => !o.expiresAt || o.expiresAt.getTime() > now.getTime())
        .map((o) => [o.featureKey, o]),
    );

    const features = catalogue.map((feature) => {
      const effective = limitOf(limits, feature.key);
      const used = usage.get(feature.key) ?? null;
      return {
        key: feature.key,
        label: feature.label,
        labelBn: feature.labelBn,
        kind: feature.kind,
        unit: feature.unit,
        period: feature.period,
        category: feature.category,
        planLimit: planLimits.get(feature.key) ?? null,
        /** `null` is unlimited, everywhere in this codebase. `0` is off. */
        effectiveLimit: effective,
        overridden: liveOverrides.has(feature.key),
        /** `null` where nothing counts this feature yet — not the same as zero. */
        used,
        ratio: ratioOf(used, effective),
      };
    });

    this.audit.emit({
      workspaceId: workspace.id,
      actorUserId: actor.id,
      actorType: 'SUPPORT',
      action: TENANT_VIEWED,
      entity: 'Workspace',
      entityId: workspace.id,
      ip: actor.ip,
      userAgent: actor.userAgent,
      after: { operator: actor.email },
    });

    return {
      id: workspace.id,
      name: workspace.name,
      status: workspace.status,
      currency: workspace.currency,
      timezone: workspace.timezone,
      createdAt: workspace.createdAt.toISOString(),
      updatedAt: workspace.updatedAt.toISOString(),
      trialEndsAt: workspace.trialEndsAt?.toISOString() ?? null,
      owner: workspace.owner,
      plan: workspace.plan
        ? {
            id: workspace.plan.id,
            code: workspace.plan.code,
            name: workspace.plan.name,
            priceMinor: Number(workspace.plan.priceMinor),
            interval: workspace.plan.interval,
          }
        : null,
      /** False means the `Feature` table is empty and `features` is a stopgap. */
      catalogueSeeded: seeded,
      features,
      overrides: workspace.overrides.map((o) => ({
        id: o.id,
        featureKey: o.featureKey,
        limitValue: o.limitValue,
        expiresAt: o.expiresAt?.toISOString() ?? null,
        expired: Boolean(o.expiresAt && o.expiresAt.getTime() <= now.getTime()),
        note: o.note,
        createdAt: o.createdAt.toISOString(),
        grantedBy: o.grantedByUserId ? (granters.get(o.grantedByUserId) ?? null) : null,
      })),
      members: workspace.memberships.map((m) => ({
        membershipId: m.id,
        role: m.role,
        status: m.status,
        joinedAt: m.joinedAt.toISOString(),
        id: m.user.id,
        name: m.user.name,
        email: m.user.email,
        phone: m.user.phone,
        locale: m.user.locale,
        emailVerifiedAt: m.user.emailVerifiedAt?.toISOString() ?? null,
        /* Shown so an operator can see they are about to act on another
         * operator's tenant. Impersonation refuses that outright — see
         * AdminImpersonationService. */
        isSuperAdmin: m.user.isSuperAdmin,
      })),
      totals: {
        memberCount: workspace.memberships.filter((m) => m.status === 'ACTIVE').length,
        transactionCount,
        attachmentCount: storage._count._all,
        storageBytes: storage._sum.sizeBytes ?? 0,
        storageMb: toMb(storage._sum.sizeBytes ?? 0),
      },
      lastActivityAt:
        latest([lastTransaction?.createdAt, lastAudit?.createdAt])?.toISOString() ?? null,
      lastActivityAction: lastAudit?.action ?? null,
    };
  }

  // --- packages --------------------------------------------------------------

  /** Move a tenant onto a package. Their entitlements change on the next request. */
  async assignPlan(actor: AdminActor, workspaceId: string, input: AssignPlanInput) {
    const workspace = await this.requireWorkspace(workspaceId);
    const plan = await this.prisma.plan.findUnique({ where: { code: input.planCode } });
    if (!plan) throw new NotFoundException('এই কোডের কোনো প্ল্যান নেই');

    const before = await this.prisma.workspace
      .findUnique({ where: { id: workspaceId }, select: { plan: { select: { code: true } } } })
      .then((w) => w?.plan?.code ?? null);

    if (before === plan.code) {
      throw new BadRequestException('এই ওয়ার্কস্পেস আগে থেকেই এই প্ল্যানে আছে');
    }

    await this.prisma.workspace.update({ where: { id: workspaceId }, data: { planId: plan.id } });

    /* Awaited, not `emit`. For a read, a dropped audit row is a gap in a
     * report; for a change to what somebody is paying for it is the only
     * evidence the change was authorised at all. */
    await this.audit.record({
      workspaceId,
      actorUserId: actor.id,
      actorType: 'SUPPORT',
      action: PLAN_ASSIGNED,
      entity: 'Workspace',
      entityId: workspaceId,
      ip: actor.ip,
      userAgent: actor.userAgent,
      before: { planCode: before },
      after: { planCode: plan.code, note: input.note ?? null, operator: actor.email },
    });

    this.logger.log(
      `Operator ${actor.email} moved workspace ${workspaceId} from ${before ?? 'none'} to ${plan.code}`,
    );

    return {
      workspaceId,
      name: workspace.name,
      previousPlanCode: before,
      plan: {
        id: plan.id,
        code: plan.code,
        name: plan.name,
        priceMinor: Number(plan.priceMinor),
        interval: plan.interval,
      },
    };
  }

  /**
   * Set or clear one per-workspace override.
   *
   * `action` is explicit rather than inferred from a null `limitValue`, because
   * `null` already means *unlimited* everywhere in the entitlement code. Left
   * to inference, "give this tenant unlimited transactions" and "take the grant
   * away" would be the same request body, and the two do opposite things.
   */
  async setFeatureOverride(
    actor: AdminActor,
    workspaceId: string,
    featureKey: string,
    input: SetFeatureOverrideInput,
  ) {
    await this.requireWorkspace(workspaceId);

    const existing = await this.prisma.workspaceFeatureOverride.findUnique({
      where: { workspaceId_featureKey: { workspaceId, featureKey } },
    });

    /* `undefined`, not `null`, when there was nothing here before: the audit
     * column is `Json?`, and a literal `null` is stored as the JSON value null
     * rather than as "no value". An absent `before` is what "this override did
     * not exist" should look like on the row. */
    const before = existing
      ? {
          limitValue: existing.limitValue,
          expiresAt: existing.expiresAt?.toISOString() ?? null,
          note: existing.note,
          grantedByUserId: existing.grantedByUserId,
        }
      : undefined;

    if (input.action === 'clear') {
      if (!existing) throw new NotFoundException('এই ফিচারে কোনো ওভাররাইড নেই');
      await this.prisma.workspaceFeatureOverride.delete({ where: { id: existing.id } });

      await this.audit.record({
        workspaceId,
        actorUserId: actor.id,
        actorType: 'SUPPORT',
        action: FEATURE_OVERRIDDEN,
        entity: 'WorkspaceFeatureOverride',
        entityId: existing.id,
        ip: actor.ip,
        userAgent: actor.userAgent,
        before,
        after: { featureKey, cleared: true, note: input.note, operator: actor.email },
      });

      return {
        workspaceId,
        featureKey,
        override: null,
        effectiveLimit: await this.effectiveLimit(workspaceId, featureKey),
      };
    }

    /* `WorkspaceFeatureOverride.featureKey` is a foreign key onto
     * `Feature.key`, so an unknown key is a Postgres constraint error — a 500
     * — if it is let through. It is also exactly what happens on a database
     * where nothing has seeded the catalogue yet. Both deserve a sentence, not
     * a constraint name. */
    const known = await this.prisma.feature.findUnique({ where: { key: featureKey } });
    if (!known) {
      const seeded = (await this.prisma.feature.count()) > 0;
      throw new BadRequestException(
        seeded
          ? 'এই ফিচারটি ক্যাটালগে নেই'
          : 'ফিচার ক্যাটালগ এখনো সিড করা হয়নি, তাই ওভাররাইড দেওয়া যাচ্ছে না',
      );
    }

    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('মেয়াদ শেষের সময় ভবিষ্যতে হতে হবে');
    }

    const saved = await this.prisma.workspaceFeatureOverride.upsert({
      where: { workspaceId_featureKey: { workspaceId, featureKey } },
      create: {
        workspaceId,
        featureKey,
        limitValue: input.limitValue,
        expiresAt,
        note: input.note,
        grantedByUserId: actor.id,
      },
      update: {
        limitValue: input.limitValue,
        expiresAt,
        note: input.note,
        // Re-attributed on every edit: whoever last widened the limit is the
        // person to ask about it, not whoever opened it a year ago.
        grantedByUserId: actor.id,
      },
    });

    await this.audit.record({
      workspaceId,
      actorUserId: actor.id,
      actorType: 'SUPPORT',
      action: FEATURE_OVERRIDDEN,
      entity: 'WorkspaceFeatureOverride',
      entityId: saved.id,
      ip: actor.ip,
      userAgent: actor.userAgent,
      before,
      after: {
        featureKey,
        limitValue: saved.limitValue,
        expiresAt: saved.expiresAt?.toISOString() ?? null,
        note: saved.note,
        operator: actor.email,
      },
    });

    const granter = await this.grantersFor([saved.grantedByUserId]);

    return {
      workspaceId,
      featureKey,
      override: {
        id: saved.id,
        featureKey: saved.featureKey,
        limitValue: saved.limitValue,
        expiresAt: saved.expiresAt?.toISOString() ?? null,
        note: saved.note,
        createdAt: saved.createdAt.toISOString(),
        grantedBy: saved.grantedByUserId ? (granter.get(saved.grantedByUserId) ?? null) : null,
      },
      effectiveLimit: await this.effectiveLimit(workspaceId, featureKey),
    };
  }

  // --- lifecycle -------------------------------------------------------------

  /**
   * Suspend a tenant.
   *
   * This bites immediately and everywhere: `JwtStrategy` refuses a token whose
   * workspace is SUSPENDED on the very next request, so nobody waits for a
   * token to expire. That is also why a reason belongs on the row — the people
   * affected are logged out mid-session and somebody will have to explain it.
   */
  async suspend(actor: AdminActor, workspaceId: string, input: SuspendInput) {
    return this.setStatus(actor, workspaceId, 'SUSPENDED', TENANT_SUSPENDED, input.reason);
  }

  /**
   * Undo it. The tenant lands on ACTIVE rather than whatever they were before:
   * the previous status is not stored anywhere, and putting TRIALING back could
   * silently restore an expired trial.
   */
  async reactivate(actor: AdminActor, workspaceId: string, input: SuspendInput) {
    return this.setStatus(actor, workspaceId, 'ACTIVE', TENANT_REACTIVATED, input.reason);
  }

  private async setStatus(
    actor: AdminActor,
    workspaceId: string,
    status: WorkspaceStatus,
    action: AuditAction,
    reason?: string,
  ) {
    const workspace = await this.requireWorkspace(workspaceId);
    if (workspace.status === status) {
      throw new BadRequestException(
        status === 'SUSPENDED'
          ? 'এই ওয়ার্কস্পেস আগে থেকেই স্থগিত'
          : 'এই ওয়ার্কস্পেস আগে থেকেই সক্রিয়',
      );
    }

    const updated = await this.prisma.workspace.update({
      where: { id: workspaceId },
      data: { status },
      select: { id: true, name: true, status: true },
    });

    await this.audit.record({
      workspaceId,
      actorUserId: actor.id,
      actorType: 'SUPPORT',
      action,
      entity: 'Workspace',
      entityId: workspaceId,
      ip: actor.ip,
      userAgent: actor.userAgent,
      before: { status: workspace.status },
      after: { status, reason: reason ?? null, operator: actor.email },
    });

    this.logger.warn(
      `Operator ${actor.email} set workspace ${workspaceId} to ${status}` +
        (reason ? `: ${reason}` : ''),
    );

    return { ...updated, previousStatus: workspace.status };
  }

  // --- platform --------------------------------------------------------------

  /**
   * The platform at a glance.
   *
   * The near-limit sweep is the expensive half: it resolves entitlements for
   * every live tenant and compares them against four aggregate queries. It is
   * bounded by `OVERVIEW_SCAN_CAP` and reports `truncated` rather than quietly
   * going quadratic — the honest failure for a screen that gets refreshed all
   * day.
   */
  async overview(actor: AdminActor) {
    const now = new Date();
    const since = new Date(now.getTime() - SIGNUP_WINDOW_DAYS * 86_400_000);

    const [byStatus, byPlan, plans, totalTransactions, totalStorage, signupRows, scanned] =
      await Promise.all([
        this.prisma.workspace.groupBy({
          by: ['status'],
          where: { deletedAt: null },
          _count: { _all: true },
        }),
        this.prisma.workspace.groupBy({
          by: ['planId'],
          where: { deletedAt: null },
          _count: { _all: true },
        }),
        this.prisma.plan.findMany({ select: { id: true, code: true, name: true } }),
        this.prisma.transaction.count({ where: { deletedAt: null } }),
        this.prisma.attachment.aggregate({ where: { deletedAt: null }, _sum: { sizeBytes: true } }),
        this.prisma.workspace.findMany({
          where: { deletedAt: null, createdAt: { gte: since } },
          select: { createdAt: true, timezone: true },
        }),
        this.prisma.workspace.findMany({
          where: { deletedAt: null },
          take: OVERVIEW_SCAN_CAP + 1,
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            name: true,
            timezone: true,
            plan: {
              select: { code: true, features: { select: { featureKey: true, limitValue: true } } },
            },
            overrides: { select: { featureKey: true, limitValue: true, expiresAt: true } },
          },
        }),
      ]);

    const truncated = scanned.length > OVERVIEW_SCAN_CAP;
    const tenants = truncated ? scanned.slice(0, OVERVIEW_SCAN_CAP) : scanned;
    if (truncated) {
      this.logger.warn(
        `Overview near-limit sweep capped at ${OVERVIEW_SCAN_CAP} tenants; the count is a floor, not a total.`,
      );
    }

    const nearLimit = await this.nearLimitSweep(tenants, now);
    const planById = new Map(plans.map((p) => [p.id, p]));

    const daily = bucketByDay(
      signupRows.map((r) => r.createdAt),
      since,
      now,
      /* Buckets are drawn in one timezone, not each tenant's: a signup chart
       * whose day boundary moves per row is not a chart. */
      signupRows[0]?.timezone ?? 'Asia/Dhaka',
    );

    this.audit.emit({
      ...this.fileAgainst(actor),
      action: OVERVIEW_VIEWED,
      entity: 'Platform',
      after: { tenantsScanned: tenants.length, truncated },
    });

    return {
      generatedAt: now.toISOString(),
      tenants: {
        total: byStatus.reduce((sum, row) => sum + row._count._all, 0),
        byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r._count._all])),
        byPlan: byPlan.map((r) => ({
          code: r.planId ? (planById.get(r.planId)?.code ?? 'UNKNOWN') : 'NONE',
          name: r.planId ? (planById.get(r.planId)?.name ?? 'UNKNOWN') : 'প্ল্যান নেই',
          count: r._count._all,
        })),
      },
      signups: { windowDays: SIGNUP_WINDOW_DAYS, total: signupRows.length, daily },
      totals: {
        transactions: totalTransactions,
        storageBytes: totalStorage._sum.sizeBytes ?? 0,
        storageMb: toMb(totalStorage._sum.sizeBytes ?? 0),
      },
      nearLimit: {
        threshold: NEAR_LIMIT_RATIO,
        tenantCount: nearLimit.tenantCount,
        /** A sample for the screen, not the whole set — `tenantCount` is that. */
        sample: nearLimit.sample,
        /** Which features the sweep could measure at all. */
        measuredFeatures: nearLimit.measured,
        tenantsScanned: tenants.length,
        truncated,
      },
    };
  }

  /**
   * The audit log across tenants — the only query here whose whole purpose is
   * to ignore the workspace boundary.
   */
  async platformAudit(actor: AdminActor, query: PlatformAuditQuery) {
    const limit = Math.min(MAX_PAGE, Math.max(1, query.limit ?? 50));

    const rows = await this.prisma.auditEvent.findMany({
      where: {
        ...(query.workspaceId ? { workspaceId: query.workspaceId } : {}),
        ...(query.actorId ? { actorUserId: query.actorId } : {}),
        ...(query.action ? { action: query.action } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      include: {
        actor: { select: { id: true, name: true, email: true } },
        workspace: { select: { id: true, name: true } },
      },
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    this.audit.emit({
      /* Filed against the tenant when the query names one — the person whose
       * timeline was read is the person entitled to see that it was. An
       * unscoped read falls back to the operator's own workspace. */
      ...this.fileAgainst(actor, query.workspaceId),
      action: AUDIT_VIEWED,
      entity: 'AuditEvent',
      after: {
        workspaceId: query.workspaceId ?? null,
        actorId: query.actorId ?? null,
        action: query.action ?? null,
        returned: page.length,
      },
    });

    return {
      items: page.map((row) => ({
        id: row.id,
        workspace: row.workspace,
        action: row.action,
        entity: row.entity,
        entityId: row.entityId,
        actor: row.actor,
        actorType: row.actorType,
        before: row.before,
        after: row.after,
        ip: row.ip,
        userAgent: row.userAgent,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
    };
  }

  // --- internals -------------------------------------------------------------

  /**
   * Where a cross-tenant action is recorded.
   *
   * `AuditEvent.workspaceId` is not nullable and is a foreign key, so there is
   * no such thing as a row belonging to no tenant. Anything about one tenant is
   * filed against that tenant. Anything about the platform — the tenant list,
   * the overview, an unfiltered audit query — is filed against the
   * **operator's own** workspace: the only workspace they have standing in, and
   * the one place a review of "what did this operator do?" reads back complete.
   */
  private fileAgainst(actor: AdminActor, workspaceId?: string) {
    return {
      workspaceId: workspaceId ?? actor.workspaceId,
      actorUserId: actor.id,
      actorType: 'SUPPORT' as const,
      ip: actor.ip,
      userAgent: actor.userAgent,
    };
  }

  private async requireWorkspace(workspaceId: string) {
    const workspace = await this.prisma.workspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
      select: { id: true, name: true, status: true, timezone: true, ownerUserId: true },
    });
    if (!workspace) throw new NotFoundException('ওয়ার্কস্পেস পাওয়া যায়নি');
    return workspace;
  }

  /**
   * The sellable catalogue, from the database.
   *
   * TODO(main): `EntitlementsModule` is growing a `FeatureCatalogueService` in
   * a parallel change that owns exactly this question and seeds `Feature` at
   * boot. Delete this method and inject that service once it lands; the
   * `UNSEEDED_FALLBACK` above goes with it.
   */
  private async catalogue(): Promise<{ features: FeatureDescriptor[]; seeded: boolean }> {
    const rows = await this.prisma.feature.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
      select: {
        key: true,
        label: true,
        labelBn: true,
        kind: true,
        unit: true,
        period: true,
        category: true,
        sortOrder: true,
      },
    });
    return rows.length > 0
      ? { features: rows, seeded: true }
      : { features: UNSEEDED_FALLBACK, seeded: false };
  }

  /** id -> {id, name, email} for whoever granted an override. Never a hash. */
  private async grantersFor(ids: Array<string | null>) {
    const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (wanted.length === 0) return new Map<string, { id: string; name: string; email: string }>();
    const users = await this.prisma.user.findMany({
      where: { id: { in: wanted } },
      select: { id: true, name: true, email: true },
    });
    return new Map(users.map((u) => [u.id, u]));
  }

  private async effectiveLimit(workspaceId: string, featureKey: string): Promise<number | null> {
    const limits = (await this.entitlements.forWorkspace(workspaceId)) as Limits;
    return limitOf(limits, featureKey);
  }

  /**
   * What one tenant has consumed, per feature key.
   *
   * Three sources, in this order. `UsageMeter` wins where a row exists: it is
   * written where the work happens and is the only thing that can count a
   * feature with no cheap query behind it. Attachment storage is summed here
   * because its meter does not exist yet and `SUM(sizeBytes)` is one query.
   * `EntitlementsService.usage` fills in accounts, monthly transactions and
   * seats, which are still counted live by the enforcer.
   *
   * A key with none of the three maps to `null`, not `0`. "Nothing counts this"
   * and "this tenant has used none of it" are the same number and completely
   * different facts to whoever is deciding about a limit.
   */
  private async usageFor(
    workspaceId: string,
    timezone: string,
    catalogue: FeatureDescriptor[],
    now: Date,
  ): Promise<Map<string, number | null>> {
    const [liveUsage, storage, meters] = await Promise.all([
      this.entitlements.usage(workspaceId, timezone) as Promise<Record<string, number>>,
      this.prisma.attachment.aggregate({
        where: { workspaceId, deletedAt: null },
        _sum: { sizeBytes: true },
      }),
      this.prisma.usageMeter.findMany({
        where: { workspaceId, periodKey: { in: periodKeysFor(catalogue, timezone, now) } },
        select: { featureKey: true, periodKey: true, value: true },
      }),
    ]);

    const metered = new Map(meters.map((m) => [`${m.featureKey}|${m.periodKey}`, Number(m.value)]));
    const out = new Map<string, number | null>();

    for (const feature of catalogue) {
      const meter = metered.get(`${feature.key}|${periodKeyFor(feature.period, timezone, now)}`);
      if (meter !== undefined) {
        out.set(feature.key, meter);
      } else if (feature.key === 'attachments.storage.mb') {
        /* Rounded UP, the same way `EntitlementsService.usage` does — not the
         * two-decimal figure `toMb` gives the list screen. They must agree: at
         * 49.01 MB against a 50 MB plan this panel said 98% while the tenant
         * was already being refused with a 402, and an operator reading that
         * would have told a paying customer nothing was wrong. */
        out.set(feature.key, Math.ceil((storage._sum.sizeBytes ?? 0) / BYTES_PER_MB));
      } else if (LIVE_COUNTED.has(feature.key)) {
        out.set(feature.key, liveUsage[feature.key] ?? 0);
      } else {
        out.set(feature.key, null);
      }
    }

    return out;
  }

  /**
   * How many tenants are within `NEAR_LIMIT_RATIO` of any measured ceiling.
   *
   * Four aggregate queries for the whole scan, then pure arithmetic per tenant
   * — no per-tenant round trip. Unlimited (`null`) and switched-off (`0`)
   * ceilings are skipped: neither has a ratio, and a flag that is off is not a
   * tenant about to run out of anything.
   */
  private async nearLimitSweep(
    tenants: Array<{
      id: string;
      name: string;
      timezone: string;
      plan: {
        code: string;
        features: Array<{ featureKey: string; limitValue: number | null }>;
      } | null;
      overrides: Array<{ featureKey: string; limitValue: number | null; expiresAt: Date | null }>;
    }>,
    now: Date,
  ) {
    const ids = tenants.map((t) => t.id);
    if (ids.length === 0) return { tenantCount: 0, sample: [], measured: [] };

    const zones = new Map<string, string[]>();
    for (const tenant of tenants) {
      const bucket = zones.get(tenant.timezone);
      if (bucket) bucket.push(tenant.id);
      else zones.set(tenant.timezone, [tenant.id]);
    }

    const monthly = new Map<string, number>();
    const [accounts, members, storage, meters] = await Promise.all([
      this.prisma.account.groupBy({
        by: ['workspaceId'],
        where: { workspaceId: { in: ids }, systemKey: null, deletedAt: null, isArchived: false },
        _count: { _all: true },
      }),
      this.prisma.membership.groupBy({
        by: ['workspaceId'],
        where: { workspaceId: { in: ids }, status: 'ACTIVE' },
        _count: { _all: true },
      }),
      this.prisma.attachment.groupBy({
        by: ['workspaceId'],
        where: { workspaceId: { in: ids }, deletedAt: null },
        _sum: { sizeBytes: true },
      }),
      this.prisma.usageMeter.findMany({
        where: { workspaceId: { in: ids } },
        select: { workspaceId: true, featureKey: true, periodKey: true, value: true },
      }),
      /* One query per distinct timezone, because "this month" is a different
       * window in each. In practice every workspace is Asia/Dhaka and this is
       * a single query; the loop exists so it stays correct the day one is not. */
      ...[...zones].map(async ([zone, zoneIds]) => {
        const rows = await this.prisma.transaction.groupBy({
          by: ['workspaceId'],
          where: {
            workspaceId: { in: zoneIds },
            deletedAt: null,
            createdAt: { gte: startOfMonth(now, zone), lt: startOfNextMonth(now, zone) },
          },
          _count: { _all: true },
        });
        for (const row of rows) monthly.set(row.workspaceId, row._count._all);
      }),
    ]);

    const accountCount = new Map(accounts.map((r) => [r.workspaceId, r._count._all]));
    const memberCount = new Map(members.map((r) => [r.workspaceId, r._count._all]));
    const storageMb = new Map(storage.map((r) => [r.workspaceId, toMb(r._sum.sizeBytes ?? 0)]));
    const metered = new Map(
      meters.map((m) => [`${m.workspaceId}|${m.featureKey}|${m.periodKey}`, Number(m.value)]),
    );

    const { features: catalogue } = await this.catalogue();
    const measured = new Set<string>();
    const breaches: Array<{
      workspaceId: string;
      name: string;
      planCode: string | null;
      featureKey: string;
      used: number;
      limit: number;
      ratio: number;
    }> = [];
    let tenantCount = 0;

    for (const tenant of tenants) {
      const limits = resolveEntitlements(
        tenant.plan?.features ?? [],
        tenant.overrides,
        now,
      ) as Limits;
      let flagged = false;

      for (const feature of catalogue) {
        const limit = limitOf(limits, feature.key);
        if (limit === null || limit <= 0) continue;

        const used =
          metered.get(
            `${tenant.id}|${feature.key}|${periodKeyFor(feature.period, tenant.timezone, now)}`,
          ) ??
          countedUsage(feature.key, {
            accounts: accountCount.get(tenant.id),
            members: memberCount.get(tenant.id),
            monthly: monthly.get(tenant.id),
            storageMb: storageMb.get(tenant.id),
          });
        if (used === null) continue;

        measured.add(feature.key);
        const ratio = used / limit;
        if (ratio < NEAR_LIMIT_RATIO) continue;

        flagged = true;
        breaches.push({
          workspaceId: tenant.id,
          name: tenant.name,
          planCode: tenant.plan?.code ?? null,
          featureKey: feature.key,
          used,
          limit,
          ratio: Number(ratio.toFixed(3)),
        });
      }

      if (flagged) tenantCount += 1;
    }

    breaches.sort((a, b) => b.ratio - a.ratio);
    return { tenantCount, sample: breaches.slice(0, 20), measured: [...measured] };
  }
}

/**
 * Usage for the features the platform still counts with live aggregates.
 *
 * `null` for anything else, on purpose. A limit nobody measures cannot be near
 * its ceiling, and reporting it as 0% would be a claim we cannot support.
 */
const countedUsage = (
  featureKey: string,
  counts: { accounts?: number; members?: number; monthly?: number; storageMb?: number },
): number | null => {
  switch (featureKey) {
    case 'accounts.max':
      return counts.accounts ?? 0;
    case 'members.max':
      return counts.members ?? 0;
    case 'transactions.monthly.max':
      return counts.monthly ?? 0;
    case 'attachments.storage.mb':
      return counts.storageMb ?? 0;
    default:
      return null;
  }
};

/** `'lifetime'`, `'2026-08'` or `'2026-08-10'` — the buckets `UsageMeter` uses. */
const periodKeyFor = (period: MeterPeriod, timezone: string, now: Date): string => {
  if (period === 'MONTHLY') return toLocalDateString(now, timezone).slice(0, 7);
  if (period === 'DAILY') return toLocalDateString(now, timezone);
  return 'lifetime';
};

const periodKeysFor = (catalogue: FeatureDescriptor[], timezone: string, now: Date): string[] => [
  ...new Set(catalogue.map((f) => periodKeyFor(f.period, timezone, now))),
];

const ratioOf = (used: number | null, limit: number | null): number | null => {
  if (used === null || limit === null || limit <= 0) return null;
  return Number((used / limit).toFixed(3));
};

const latest = (dates: Array<Date | undefined>): Date | null => {
  const known = dates.filter((d): d is Date => d instanceof Date);
  if (known.length === 0) return null;
  return known.reduce((a, b) => (a.getTime() >= b.getTime() ? a : b));
};

/**
 * A count for every day in the window, zeros included.
 *
 * Omitting empty days would let a chart draw a straight line between the 3rd
 * and the 11th and call it steady growth.
 */
const bucketByDay = (
  dates: Date[],
  since: Date,
  until: Date,
  timezone: string,
): Array<{ date: string; count: number }> => {
  const counts = new Map<string, number>();
  for (let cursor = since.getTime(); cursor <= until.getTime(); cursor += 86_400_000) {
    counts.set(toLocalDateString(new Date(cursor), timezone), 0);
  }
  for (const date of dates) {
    const key = toLocalDateString(date, timezone);
    if (counts.has(key)) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));
};
