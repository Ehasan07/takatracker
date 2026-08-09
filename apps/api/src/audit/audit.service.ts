import { Injectable, Logger } from '@nestjs/common';
import type { AuditActorType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The actions worth recording (v3 §A3). Kept as a union rather than free text
 * so a typo cannot quietly create a category nobody ever queries.
 */
export const AUDIT_ACTIONS = [
  'auth.signup',
  'auth.login',
  'auth.login_failed',
  'auth.logout',
  'auth.refresh_reuse_detected',
  'account.created',
  'account.updated',
  'account.archived',
  'transaction.created',
  'transaction.updated',
  'transaction.deleted',
  'transaction.restored',
  'transaction.reconciled',
  'category.created',
  'category.updated',
  'category.deleted',
  'import.uploaded',
  'import.applied',
  'import.reverted',
  'export.downloaded',
  'ingestion.message_received',
  'ingestion.draft_accepted',
  'ingestion.draft_rejected',
  'auth.email_verified',
  'auth.verification_sent',
  'auth.password_reset_requested',
  'auth.password_reset_completed',
  /* Distinct from a reset on purpose. A reset is recovery from a lost or
   * compromised account and kills every session; a change is somebody in
   * settings who still has their password. Merging them would make the one
   * question this timeline exists to answer — "was I broken into?" —
   * unanswerable. */
  'auth.password_changed',
  'auth.session_revoked',
  'auth.onboarding_completed',
  'loan.created',
  'loan.updated',
  'loan.deleted',
  'loan.cancelled',
  'loan.payment_added',
  'loan.payment_deleted',
  'savings.plan_created',
  'savings.plan_updated',
  'savings.plan_deleted',
  'savings.installment_paid',
  'insurance.policy_created',
  'insurance.policy_updated',
  'insurance.policy_deleted',
  'insurance.premium_paid',
  'plan.changed',
  'entitlement.override_changed',
  'notifications.telegram_bound',
  'notifications.telegram_revoked',
  'notifications.telegram_tested',
  'notifications.settings_changed',
  'card.reminders_muted',
  'workspace.deleted',
  'data.exported',
  'support.impersonation_started',
  'support.impersonation_ended',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditContext {
  workspaceId: string;
  actorUserId?: string | null;
  actorType?: AuditActorType;
  ip?: string | null;
  userAgent?: string | null;
}

export interface AuditRecord extends AuditContext {
  action: AuditAction;
  entity?: string;
  entityId?: string;
  before?: Prisma.InputJsonValue;
  after?: Prisma.InputJsonValue;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Never throws. An audit write failing must not take a user's transaction
   * down with it — the loud failure belongs in the logs, not in their face.
   */
  async record(event: AuditRecord): Promise<void> {
    try {
      await this.prisma.auditEvent.create({
        data: {
          workspaceId: event.workspaceId,
          actorUserId: event.actorUserId ?? null,
          actorType: event.actorType ?? 'USER',
          action: event.action,
          entity: event.entity,
          entityId: event.entityId,
          before: event.before,
          after: event.after,
          ip: event.ip?.slice(0, 60),
          userAgent: event.userAgent?.slice(0, 300),
        },
      });
    } catch (err) {
      this.logger.error(`Failed to record ${event.action}: ${(err as Error).message}`);
    }
  }

  /** Fire-and-forget, for call sites on a request's critical path. */
  emit(event: AuditRecord): void {
    void this.record(event);
  }

  /** The workspace's own timeline. Cursor-paginated, newest first. */
  async list(
    workspaceId: string,
    options: { limit?: number; cursor?: string; action?: string; entityId?: string } = {},
  ) {
    const limit = Math.min(100, Math.max(1, options.limit ?? 50));
    const rows = await this.prisma.auditEvent.findMany({
      where: {
        workspaceId,
        ...(options.action ? { action: options.action } : {}),
        ...(options.entityId ? { entityId: options.entityId } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
      include: { actor: { select: { id: true, name: true, email: true } } },
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    return {
      items: page.map((row) => ({
        id: row.id,
        action: row.action,
        entity: row.entity,
        entityId: row.entityId,
        actor: row.actor ? { id: row.actor.id, name: row.actor.name } : null,
        actorType: row.actorType,
        before: row.before,
        after: row.after,
        ip: row.ip,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
    };
  }
}
