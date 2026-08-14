import { createHash } from 'node:crypto';
import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Erasing an account, on the person's own say-so.
 *
 * ## Why it exists
 *
 * Because somebody who put their bank balances into a product must be able to
 * take them out again, and "email support and wait" is not a way out — it is a
 * way of hoping they give up. Google Play has required an in-app path and a
 * public web page since 2023, and the App Store the same, but the requirement
 * is the smaller reason.
 *
 * ## The grace period, and why signing in cancels it
 *
 * Deletion here is real: the cascade from `User` takes the workspace, the
 * ledger, the loans, the attachments and the audit trail with it, and there is
 * no undo afterwards. An irreversible act taken in one tap on a phone is a
 * support request nobody can answer, so the request is scheduled rather than
 * executed and `GRACE_DAYS` stand between the two.
 *
 * Signing in cancels it, without asking. Somebody who asked to be erased on
 * Monday and is reading their ledger on Wednesday has changed their mind
 * whatever the row says, and making them find a settings screen to say so is
 * how an account gets deleted out from under somebody still using it.
 *
 * ## What survives, and why anything does
 *
 * One row in `AccountDeletion`: a SHA-256 of the address and two timestamps. A
 * company that cannot say *whether* it processed a request has no answer when
 * somebody asks a second time, or when a regulator does. The hash answers that
 * question and nothing else — it can be checked against an address by somebody
 * who already knows the address, and it cannot be turned back into one.
 *
 * ## Why the owner of a shared workspace is refused
 *
 * Their books are not only theirs. Deleting the workspace would erase the other
 * members' work with no notice and no consent, so the request is refused with
 * an instruction rather than obeyed. Removing the others first is a decision
 * they can make; taking it for them is not one this service should.
 */

/** Long enough to change your mind, short enough that "deleted" means deleted. */
export const GRACE_DAYS = 7;

export interface DeletionStatus {
  requestedAt: string | null;
  scheduledFor: string | null;
}

@Injectable()
export class AccountDeletionService {
  private readonly logger = new Logger(AccountDeletionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private static hashEmail(email: string): string {
    return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
  }

  /**
   * Schedule an erasure.
   *
   * The password is required and checked here rather than trusted from the
   * session. A phone left unlocked on a table is the threat this is about, and
   * a valid session is exactly what that phone has.
   */
  async request(
    userId: string,
    workspaceId: string,
    password: string,
    reason?: string,
  ): Promise<DeletionStatus> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, passwordHash: true },
    });
    if (!user) throw new UnauthorizedException('আবার লগইন করুন');

    const ok = await argon2.verify(user.passwordHash, password).catch(() => false);
    if (!ok) throw new UnauthorizedException('পাসওয়ার্ডটি মেলেনি');

    /* Their books are not only theirs. See the note on this class. */
    const members = await this.prisma.membership.count({
      where: { workspaceId, status: 'ACTIVE' },
    });
    if (members > 1) {
      throw new BadRequestException(
        'এই খাতায় আরও সদস্য আছেন। আগে তাঁদের সরিয়ে নিন, তারপর অ্যাকাউন্ট বন্ধ করা যাবে।',
      );
    }

    const requestedAt = new Date();
    const scheduledFor = new Date(requestedAt.getTime() + GRACE_DAYS * 24 * 60 * 60 * 1000);

    await this.prisma.user.update({
      where: { id: user.id },
      data: { deletionRequestedAt: requestedAt, deletionScheduledFor: scheduledFor },
    });

    /* Awaited, not emitted. The one thing that must be answerable afterwards is
     * that this was asked for, and by the time the sweep runs the row itself is
     * gone — so if the log cannot be written, the request should not stand. */
    await this.audit.record({
      workspaceId,
      actorUserId: user.id,
      action: 'account.deletion_requested',
      entity: 'User',
      entityId: user.id,
      after: { scheduledFor: scheduledFor.toISOString(), reason: reason?.trim()?.slice(0, 500) },
    });

    return {
      requestedAt: requestedAt.toISOString(),
      scheduledFor: scheduledFor.toISOString(),
    };
  }

  /**
   * Call it off.
   *
   * Deliberately cheap — no password, no confirmation. The asymmetry is the
   * point: the destructive direction is guarded and the recovering one is not,
   * because somebody who reaches this having changed their mind should not meet
   * a second obstacle.
   */
  async cancel(userId: string, workspaceId: string): Promise<DeletionStatus> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { deletionRequestedAt: true },
    });
    if (!user?.deletionRequestedAt) return { requestedAt: null, scheduledFor: null };

    await this.prisma.user.update({
      where: { id: userId },
      data: { deletionRequestedAt: null, deletionScheduledFor: null },
    });

    this.audit.emit({
      workspaceId,
      actorUserId: userId,
      action: 'account.deletion_cancelled',
      entity: 'User',
      entityId: userId,
    });

    return { requestedAt: null, scheduledFor: null };
  }

  /** What the settings screen and the shell banner read. */
  async status(userId: string): Promise<DeletionStatus> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { deletionRequestedAt: true, deletionScheduledFor: true },
    });
    return {
      requestedAt: user?.deletionRequestedAt?.toISOString() ?? null,
      scheduledFor: user?.deletionScheduledFor?.toISOString() ?? null,
    };
  }

  /**
   * Erase everything whose grace period has run out.
   *
   * Idempotent and safe to run twice: the delete either finds a row or does
   * not. Each account is its own transaction so one failure cannot strand the
   * rest half-done.
   */
  async runDueDeletions(now = new Date()): Promise<{ deleted: number }> {
    const due = await this.prisma.user.findMany({
      where: { deletionScheduledFor: { not: null, lte: now } },
      select: { id: true, email: true, deletionRequestedAt: true },
      take: 100,
    });

    let deleted = 0;
    for (const user of due) {
      try {
        await this.prisma.$transaction(async (tx) => {
          /* The tombstone first, inside the same transaction. Written after the
           * delete it would be lost whenever the delete succeeded and the
           * insert did not, which is the one ordering that loses the record of
           * an erasure that actually happened. */
          await tx.accountDeletion.upsert({
            where: { emailHash: AccountDeletionService.hashEmail(user.email) },
            create: {
              emailHash: AccountDeletionService.hashEmail(user.email),
              requestedAt: user.deletionRequestedAt ?? now,
            },
            update: { completedAt: now },
          });

          /* Everything they own goes with this row: the membership, the
           * workspace they own, and through it the ledger, the accounts, the
           * loans, the messages and the audit trail. The cascades are declared
           * in the schema; this is the one statement that fires them. */
          await tx.user.delete({ where: { id: user.id } });
        });
        deleted += 1;
      } catch (err) {
        /* One account failing must not stop the sweep. It will be picked up on
           the next pass, and the log says which one to look at. */
        this.logger.error(`Could not erase ${user.id}: ${(err as Error).message}`);
      }
    }

    if (deleted > 0) this.logger.log(`Erased ${deleted} account(s) whose grace period ended`);
    return { deleted };
  }

  /**
   * Whether an address has already been erased.
   *
   * For the public page, so somebody who asks twice is told it was dealt with
   * rather than left wondering. Takes an address and compares hashes — this
   * never turns a stored hash back into an address.
   */
  async wasDeleted(email: string): Promise<boolean> {
    const row = await this.prisma.accountDeletion.findUnique({
      where: { emailHash: AccountDeletionService.hashEmail(email) },
      select: { id: true },
    });
    return row !== null;
  }
}
