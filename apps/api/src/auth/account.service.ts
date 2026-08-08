import {
  BadRequestException,
  GoneException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { AuditService } from '../audit/audit.service';
import { MailService } from '../mail/mail.service';
import { toBengaliDigits } from '../mail/mail.templates';
import { PrismaService } from '../prisma/prisma.service';
import { primaryWorkspaceId } from './auth.helpers';
import { ARGON_OPTIONS } from './auth.service';
import { EmailTokenService, RESET_TTL_MS, VERIFY_TTL_MS } from './email-token.service';

export interface RequestMeta {
  ip?: string;
  userAgent?: string;
}

/**
 * Identical body for every call to `POST /auth/password/forgot`.
 *
 * DO NOT "fix" this to 404 on an unknown address, and do not add a
 * `found: false` field. An endpoint that answers differently for a registered
 * and an unregistered email is an account-enumeration oracle: anyone can walk a
 * leaked address list through it and learn who banks with us. The user who
 * genuinely mistyped their address learns nothing here, and that is the price.
 */
const FORGOT_RESPONSE = {
  ok: true as const,
  message: 'এই ইমেইলে অ্যাকাউন্ট থাকলে পাসওয়ার্ড রিসেটের লিংক পাঠানো হয়েছে। ইনবক্স দেখুন।',
};

@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: EmailTokenService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
  ) {}

  // --- email verification ----------------------------------------------------

  /**
   * Issue and send a verification link for the signed-in user.
   *
   * Note what does NOT happen anywhere in this file: an unverified user is
   * never blocked. Verification gates nothing — no route, no guard, no feature.
   * Locking somebody out of their own books because a Bangladeshi mail provider
   * greylisted us is a far worse failure than an unverified address sitting in
   * the table. The nag in the UI is the whole enforcement mechanism.
   */
  async sendVerification(
    userId: string,
    workspaceId: string,
    meta: RequestMeta = {},
  ): Promise<{
    sent: boolean;
    alreadyVerified: boolean;
    expiresAt: string | null;
    message: string;
  }> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, email: true, name: true, emailVerifiedAt: true },
    });

    if (user.emailVerifiedAt) {
      return {
        sent: false,
        alreadyVerified: true,
        expiresAt: null,
        message: 'আপনার ইমেইল ঠিকানা আগেই যাচাই করা হয়েছে।',
      };
    }

    // One per minute per account. Told to the user in Bengali with the wait
    // left, because a button that appears to do nothing gets pressed harder.
    const readyAt = await this.tokens.isCoolingDown(user.id, 'VERIFY_EMAIL');
    if (readyAt) {
      const seconds = Math.max(1, Math.ceil((readyAt.getTime() - Date.now()) / 1000));
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          code: 'VERIFICATION_COOLDOWN',
          message: `একটি যাচাই লিংক এইমাত্র পাঠানো হয়েছে। আর ${toBengaliDigits(seconds)} সেকেন্ড পর আবার চেষ্টা করুন।`,
          retryAfterSeconds: seconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const { token, expiresAt } = await this.tokens.issue(user.id, 'VERIFY_EMAIL', meta.ip);
    const result = await this.mail.sendVerification({
      to: user.email,
      name: user.name,
      token,
      expiresInHours: VERIFY_TTL_MS / 3_600_000,
    });

    this.audit.emit({
      workspaceId,
      actorUserId: user.id,
      action: 'auth.verification_sent',
      entity: 'User',
      entityId: user.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return {
      sent: result.ok,
      alreadyVerified: false,
      expiresAt: expiresAt.toISOString(),
      message: result.ok
        ? 'যাচাই লিংক আপনার ইমেইলে পাঠানো হয়েছে।'
        : 'লিংক তৈরি হয়েছে, তবে ইমেইল পাঠাতে সমস্যা হয়েছে। কিছুক্ষণ পর আবার চেষ্টা করুন।',
    };
  }

  /**
   * Redeem a verification link. Anonymous on purpose — the link is very often
   * opened in a different browser (or on the phone) from the one that asked
   * for it, and demanding a session there would strand people.
   *
   * The three failure modes get three different answers, because "you already
   * did this, you are fine" and "this link is too old, here is a fresh one"
   * send the user to completely different places.
   */
  async confirmVerification(
    token: string,
    meta: RequestMeta = {},
  ): Promise<{ verified: true; alreadyVerified: boolean; message: string }> {
    const lookup = await this.tokens.inspect(token, 'VERIFY_EMAIL');

    if (lookup.status === 'UNKNOWN') {
      throw new BadRequestException({
        code: 'TOKEN_INVALID',
        message: 'যাচাই লিংকটি সঠিক নয়। ইমেইল থেকে পুরো লিংকটি কপি করেছেন কি না দেখুন।',
      });
    }

    if (lookup.status === 'USED') {
      const user = await this.prisma.user.findUnique({
        where: { id: lookup.userId },
        select: { emailVerifiedAt: true },
      });
      // The ordinary case: they clicked twice, or the mail client prefetched
      // the link. Nothing is wrong and there is nothing for them to do.
      if (user?.emailVerifiedAt) {
        return {
          verified: true,
          alreadyVerified: true,
          message: 'এই লিংকটি আগেই ব্যবহার করা হয়েছে — আপনার ইমেইল যাচাই করা আছে।',
        };
      }
      // Used but unverified means this link was superseded by a newer one.
      const resent = await this.resendVerification(lookup.userId, meta);
      throw new GoneException({
        code: 'TOKEN_SUPERSEDED',
        message: resent
          ? 'এই লিংকটি আর কার্যকর নয়। নতুন একটি যাচাই লিংক আপনার ইমেইলে পাঠানো হয়েছে।'
          : 'এই লিংকটি আর কার্যকর নয়। আপনার ইনবক্সে পাঠানো সর্বশেষ লিংকটি ব্যবহার করুন।',
      });
    }

    if (lookup.status === 'EXPIRED') {
      // Expiry is our deadline, not their mistake, so we hand them a new link
      // instead of a dead end. The per-account cooldown inside `issue` is what
      // stops a replayed expired token being used to mail-bomb its owner.
      const resent = await this.resendVerification(lookup.userId, meta);
      throw new GoneException({
        code: 'TOKEN_EXPIRED',
        message: resent
          ? 'এই লিংকের মেয়াদ শেষ হয়ে গেছে। নতুন একটি যাচাই লিংক আপনার ইমেইলে পাঠানো হয়েছে।'
          : 'এই লিংকের মেয়াদ শেষ হয়ে গেছে। কিছুক্ষণ আগে পাঠানো নতুন লিংকটি ইনবক্সে দেখুন।',
      });
    }

    // Atomic claim: a double-clicked button cannot verify twice.
    if (!(await this.tokens.claim(lookup.id))) {
      return {
        verified: true,
        alreadyVerified: true,
        message: 'এই লিংকটি আগেই ব্যবহার করা হয়েছে — আপনার ইমেইল যাচাই করা আছে।',
      };
    }

    const verifiedAt = new Date();
    const user = await this.prisma.user.update({
      where: { id: lookup.userId },
      data: { emailVerifiedAt: verifiedAt },
      select: { id: true, emailVerifiedAt: true },
    });

    // Older links become "already used" rather than staying live.
    await this.tokens.invalidateOutstanding(lookup.userId, 'VERIFY_EMAIL', lookup.id);

    const workspaceId = await primaryWorkspaceId(this.prisma, lookup.userId);
    if (workspaceId) {
      this.audit.emit({
        workspaceId,
        actorUserId: user.id,
        action: 'auth.email_verified',
        entity: 'User',
        entityId: user.id,
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
    }

    return {
      verified: true,
      alreadyVerified: false,
      message: 'আপনার ইমেইল ঠিকানা যাচাই সম্পন্ন হয়েছে।',
    };
  }

  /** Best-effort fresh link after a dead one. Silent when cooling down. */
  private async resendVerification(userId: string, meta: RequestMeta): Promise<boolean> {
    if (await this.tokens.isCoolingDown(userId, 'VERIFY_EMAIL')) return false;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, name: true, emailVerifiedAt: true },
    });
    if (!user || user.emailVerifiedAt) return false;

    const { token } = await this.tokens.issue(userId, 'VERIFY_EMAIL', meta.ip);
    const result = await this.mail.sendVerification({
      to: user.email,
      name: user.name,
      token,
      expiresInHours: VERIFY_TTL_MS / 3_600_000,
    });

    const workspaceId = await primaryWorkspaceId(this.prisma, userId);
    if (workspaceId) {
      this.audit.emit({
        workspaceId,
        actorUserId: userId,
        actorType: 'SYSTEM',
        action: 'auth.verification_sent',
        entity: 'User',
        entityId: userId,
        ip: meta.ip,
      });
    }
    return result.ok;
  }

  // --- password reset --------------------------------------------------------

  /**
   * Start a reset. Returns `FORGOT_RESPONSE` on every path — unknown address,
   * known address, cooling down, mail server on fire. See the constant.
   */
  async forgotPassword(rawEmail: string, meta: RequestMeta = {}): Promise<typeof FORGOT_RESPONSE> {
    const email = rawEmail.toLowerCase().trim();
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, name: true },
    });

    if (!user) {
      // Deliberately no audit line either: there is no tenant to file it
      // against, and inventing one would leak that the address is unknown.
      this.logger.debug('Password reset requested for an address with no account');
      return FORGOT_RESPONSE;
    }

    // Silent here, unlike verify/send. Telling an anonymous caller "wait 40
    // seconds" would confirm the address exists, which is the one thing this
    // endpoint must never do.
    if (await this.tokens.isCoolingDown(user.id, 'RESET_PASSWORD')) {
      return FORGOT_RESPONSE;
    }

    const { token } = await this.tokens.issue(user.id, 'RESET_PASSWORD', meta.ip);

    // Fire-and-forget, matching AuditService.emit. Waiting on an SMTP round
    // trip here would make the response measurably slower for addresses that
    // exist — a timing oracle rebuilding exactly what the identical body hides.
    void this.mail.sendPasswordReset({
      to: user.email,
      name: user.name,
      token,
      expiresInMinutes: RESET_TTL_MS / 60_000,
    });

    const workspaceId = await primaryWorkspaceId(this.prisma, user.id);
    if (workspaceId) {
      this.audit.emit({
        workspaceId,
        actorUserId: user.id,
        action: 'auth.password_reset_requested',
        entity: 'User',
        entityId: user.id,
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
    }

    return FORGOT_RESPONSE;
  }

  /**
   * Finish a reset: new hash, token burned, and every session on the account
   * destroyed.
   *
   * DO NOT keep the caller's session alive to be friendly. A password reset is
   * requested precisely when the account may already be in someone else's
   * hands; if the thief's refresh-token family survives the reset, the reset
   * accomplished nothing. Everyone logs in again — including whoever just did
   * this — and that is the point, not a rough edge.
   */
  async resetPassword(
    token: string,
    password: string,
    meta: RequestMeta = {},
  ): Promise<{ ok: true; sessionsRevoked: number; message: string }> {
    const lookup = await this.tokens.inspect(token, 'RESET_PASSWORD');

    if (lookup.status === 'UNKNOWN') {
      throw new BadRequestException({
        code: 'TOKEN_INVALID',
        message: 'রিসেট লিংকটি সঠিক নয়। ইমেইল থেকে পুরো লিংকটি কপি করেছেন কি না দেখুন।',
      });
    }

    if (lookup.status === 'USED') {
      throw new GoneException({
        code: 'TOKEN_USED',
        message:
          'এই রিসেট লিংকটি আগেই ব্যবহার করা হয়েছে। নতুন পাসওয়ার্ড দিয়ে লগইন করুন, অথবা আবার "পাসওয়ার্ড ভুলে গেছি" দিন।',
      });
    }

    if (lookup.status === 'EXPIRED') {
      // No automatic resend here, unlike verification: this endpoint is
      // anonymous, so an auto-resend would let anyone holding one stale token
      // mail its owner on demand. They ask again, from the form.
      throw new GoneException({
        code: 'TOKEN_EXPIRED',
        message:
          'এই রিসেট লিংকের মেয়াদ শেষ হয়ে গেছে। আবার "পাসওয়ার্ড ভুলে গেছি" দিয়ে নতুন লিংক নিন।',
      });
    }

    if (!(await this.tokens.claim(lookup.id))) {
      throw new GoneException({
        code: 'TOKEN_USED',
        message: 'এই রিসেট লিংকটি আগেই ব্যবহার করা হয়েছে।',
      });
    }

    const passwordHash = await argon2.hash(password, ARGON_OPTIONS);
    const now = new Date();

    const { user, sessionsRevoked, justVerified } = await this.prisma.$transaction(async (tx) => {
      const before = await tx.user.findUniqueOrThrow({
        where: { id: lookup.userId },
        select: { emailVerifiedAt: true },
      });

      /* Reaching this line means they opened a link that was delivered to that
       * mailbox and nowhere else — which is the entire question `emailVerifiedAt`
       * asks. Making them then click a separate verification mail to prove the
       * same fact again is theatre, so a reset settles it. Only when it is still
       * null: an address verified earlier keeps its original timestamp. */
      const updated = await tx.user.update({
        where: { id: lookup.userId },
        data: {
          passwordHash,
          /* Same transaction as the family revocation on purpose. A bump that
           * landed without the revocation, or the reverse, would leave the
           * account half-reset — one of the two doors still open. */
          tokenVersion: { increment: 1 },
          ...(before.emailVerifiedAt ? {} : { emailVerifiedAt: now }),
        },
        select: { id: true, email: true, name: true },
      });

      // Every family, not just other families. See the note above.
      const revoked = await tx.refreshToken.updateMany({
        where: { userId: lookup.userId, revokedAt: null },
        data: { revokedAt: now },
      });

      // Any other reset link already in flight dies with this one.
      await tx.emailToken.updateMany({
        where: { userId: lookup.userId, purpose: 'RESET_PASSWORD', usedAt: null },
        data: { usedAt: now },
      });

      // Outstanding verification links are moot now that the address is proven.
      if (!before.emailVerifiedAt) {
        await tx.emailToken.updateMany({
          where: { userId: lookup.userId, purpose: 'VERIFY_EMAIL', usedAt: null },
          data: { usedAt: now },
        });
      }

      return {
        user: updated,
        sessionsRevoked: revoked.count,
        justVerified: !before.emailVerifiedAt,
      };
    });

    void this.mail.sendPasswordChanged({ to: user.email, name: user.name });

    const workspaceId = await primaryWorkspaceId(this.prisma, user.id);
    if (workspaceId) {
      this.audit.emit({
        workspaceId,
        actorUserId: user.id,
        action: 'auth.password_reset_completed',
        entity: 'User',
        entityId: user.id,
        after: { sessionsRevoked, emailVerifiedByReset: justVerified },
        ip: meta.ip,
        userAgent: meta.userAgent,
      });

      // Its own line, so the timeline explains why the address became verified
      // without anyone having clicked a verification link.
      if (justVerified) {
        this.audit.emit({
          workspaceId,
          actorUserId: user.id,
          action: 'auth.email_verified',
          entity: 'User',
          entityId: user.id,
          after: { via: 'password_reset' },
          ip: meta.ip,
          userAgent: meta.userAgent,
        });
      }
    }

    this.logger.log(`Password reset for user ${user.id}; ${sessionsRevoked} session(s) revoked`);

    return {
      ok: true,
      sessionsRevoked,
      message:
        'পাসওয়ার্ড পরিবর্তন হয়েছে। নিরাপত্তার জন্য সব ডিভাইস থেকে লগআউট করা হয়েছে — নতুন পাসওয়ার্ড দিয়ে আবার লগইন করুন।',
    };
  }

  // --- onboarding ------------------------------------------------------------

  /**
   * Record that first-run setup is done.
   *
   * Stored as the `auth.onboarding_completed` audit event rather than a new
   * column. The audit table is already append-only, already scoped to a
   * workspace, already indexed on `[workspaceId, action]`, and the action
   * string was already declared for this milestone — so the fact is durable,
   * timestamped and attributable with no migration. If onboarding ever grows
   * per-step state ("skipped accounts, finished categories"), that is when it
   * earns a column; a single boolean does not.
   */
  async completeOnboarding(
    workspaceId: string,
    userId: string,
    meta: RequestMeta = {},
  ): Promise<{ completed: true; completedAt: string; alreadyCompleted: boolean }> {
    const existing = await this.findOnboardingEvent(workspaceId);
    if (existing) {
      return {
        completed: true,
        completedAt: existing.toISOString(),
        alreadyCompleted: true,
      };
    }

    await this.audit.record({
      workspaceId,
      actorUserId: userId,
      action: 'auth.onboarding_completed',
      entity: 'Workspace',
      entityId: workspaceId,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    // `record` swallows its own failures, so read back rather than assume.
    const completedAt = (await this.findOnboardingEvent(workspaceId)) ?? new Date();
    return { completed: true, completedAt: completedAt.toISOString(), alreadyCompleted: false };
  }

  /** null when first-run setup has not been marked done for this workspace. */
  async onboardingCompletedAt(workspaceId: string): Promise<Date | null> {
    return this.findOnboardingEvent(workspaceId);
  }

  private async findOnboardingEvent(workspaceId: string): Promise<Date | null> {
    const row = await this.prisma.auditEvent.findFirst({
      where: { workspaceId, action: 'auth.onboarding_completed' },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    });
    return row?.createdAt ?? null;
  }
}
