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
  /* Signing in with a code emailed to the address, rather than with the
   * password. Its own action and not `auth.login`, because it is the one way
   * in that leaves the owner's password working and so gives them no other
   * sign it happened. */
  'auth.signin_code_requested',
  'auth.signin_code',
  'obligation.created',
  'obligation.updated',
  'obligation.completed',
  'obligation.deleted',
  'obligation.reminded',
  'migration.pulled',
  'migration.applied',
  'migration.rolledBack',
  'account.created',
  'account.updated',
  'account.archived',
  /* Marking land, gold or a vehicle to what it is worth now. Worth recording:
     it moves net worth without any income, and somebody will ask why. */
  'account.revalued',
  /* An opening balance is a real posting against equity, so setting, moving or
     clearing one moves net worth. It used to be a column change nobody could
     see afterwards; these three are its trail. */
  'account.openingBalanceSet',
  'account.openingBalanceChanged',
  'account.openingBalanceCleared',
  'transaction.created',
  'transaction.updated',
  'transaction.deleted',
  'transaction.restored',
  'transaction.reconciled',
  'category.created',
  'category.updated',
  'category.deleted',
  /* Every transaction filed under one খাত re-filed under another, in one press.
     Its own action and not `category.updated`: an update touches a name, this
     rewrites which rows every spending report attributes to which heading, and
     "why does যাতায়াত suddenly hold four hundred more transactions?" is a
     question only a row that names both খাত and the count can answer. */
  'category.merged',
  'person.created',
  'person.updated',
  'person.deleted',
  'person.merged',
  'translation.changed',
  'translation.reset',
  'tag.created',
  'tag.updated',
  'tag.deleted',
  'tag.merged',
  /* Settings that describe the books rather than a person: the quantity units
   * offered, and whatever joins them. Worth a line because "why does the
   * dropdown say গজ now" is a question a shared workspace can actually ask. */
  'workspace.settings_updated',
  'attachment.uploaded',
  'attachment.deleted',
  'import.uploaded',
  'import.applied',
  'import.reverted',
  'export.downloaded',
  /* A statement handed to somebody outside the workspace. Awaited rather than
   * emitted where it is written: this is the event a customer asks about. */
  'statement.shared',
  'statement.share_revoked',
  /* Shared spending. A bill somebody else is being asked to pay their part of
     is exactly the kind of record that gets queried later. */
  'split.group_created',
  'split.group_deleted',
  'split.expense_added',
  'split.expense_deleted',
  'split.settled',
  /* Linking two workspaces so a shared bill can reach both sets of books.
     Worth a record on both sides: it is the one place this product lets one
     person's action produce a draft in somebody else's ledger. */
  'split.invited',
  'split.mirror_accepted',
  'split.pot_opened',
  'split.contributed',
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
  /* Asked for, called off, and carried out. The third is written to a table
     that survives the erasure; the first two live in the workspace and go with
     it, which is why the request is awaited rather than emitted. */
  'account.deletion_requested',
  'account.deletion_cancelled',
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
  /* Reads, not just writes. Looking at a tenant's books is the event a customer
   * will ask about, and a support tool nobody can review is a liability. */
  'mail.account_connected',
  'mail.account_disconnected',
  'mail.sync_failed',
  'admin.tenant_list_viewed',
  'admin.tenant_viewed',
  /* Distinct from `tenant_viewed` on purpose: reading somebody's balances and
   * account list is wider than opening their plan page, and one name for both
   * would make "who looked at this customer's money?" unanswerable. */
  'admin.tenant_finance_viewed',
  /* Wider still: the customer's SMS as their phone received them, one-time
     codes and private conversation included. The strongest read this product
     allows, so it carries the plainest name. */
  'admin.tenant_messages_viewed',
  'admin.analytics_viewed',
  'admin.broadcast_sent',
  'admin.overview_viewed',
  'admin.audit_viewed',
  'admin.plan_assigned',
  'admin.plan_created',
  'admin.plan_updated',
  'admin.plan_features_updated',
  'admin.plan_retired',
  /* Its own string, not the inverse of retire. Filing "back on sale" under
   * `plan_retired` names an event as its own opposite, and folding it into
   * `plan_updated` buries it among price edits. */
  'admin.plan_unretired',
  'admin.feature_created',
  'admin.feature_updated',
  'admin.feature_overridden',
  'admin.tenant_suspended',
  'admin.tenant_reactivated',
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
