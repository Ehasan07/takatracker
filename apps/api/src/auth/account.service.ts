import {
  BadRequestException,
  GoneException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { AuditService, type AuditAction } from '../audit/audit.service';
import { MailService } from '../mail/mail.service';
import { toBengaliDigits } from '../mail/mail.templates';
import { PrismaService } from '../prisma/prisma.service';
import { ARGON_OPTIONS, primaryWorkspaceId } from './auth.helpers';
import { BreachedPasswordService, BREACHED_PASSWORD_MESSAGE } from './breached-password.service';
import { EmailTokenService, RESET_TTL_MS, VERIFY_TTL_MS } from './email-token.service';
import { SessionsService, type SessionRequestContext } from './sessions.service';

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

/**
 * The action a deliberate, signed-in password change is filed under.
 *
 * Not `auth.password_reset_completed`. A reset is a recovery from an account
 * that may already be in someone else's hands and it destroys every session;
 * this is somebody in Settings who typed their current password correctly and
 * kept their own session. Filing both under one string makes them
 * indistinguishable on the one timeline that has to answer "was I broken
 * into?", which is the only question the timeline exists for.
 *
 * `AUDIT_ACTIONS` in audit/audit.service.ts does not carry it yet and that file
 * belongs to another change, so the string is asserted here instead of edited
 * in there. Nothing is wrong with the row that gets written — `AuditEvent.action`
 * is a plain `String` column, no enum and no migration. Delete this assertion
 * once 'auth.password_changed' is in the union.
 */
const PASSWORD_CHANGED_ACTION = 'auth.password_changed' as AuditAction;

/** One sentence for a proven address, wherever the proof came from. */
const VERIFIED_MESSAGE = 'আপনার ইমেইল ঠিকানা যাচাই সম্পন্ন হয়েছে।';

@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: EmailTokenService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
    private readonly sessions: SessionsService,
    private readonly breached: BreachedPasswordService,
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

    const { token, code, expiresAt } = await this.tokens.issue(user.id, 'VERIFY_EMAIL', meta.ip);
    const result = await this.mail.sendVerification({
      to: user.email,
      name: user.name,
      token,
      code,
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
  /**
   * Verify with the six digits from the email.
   *
   * Session-authenticated, unlike the link: a code is typed by somebody who is
   * already signed in and looking at the box, so there is no cross-device case
   * to serve and requiring the session removes a whole class of guessing —
   * an attacker needs the account *and* the code rather than the code alone.
   */
  async confirmVerificationCode(
    userId: string,
    code: string,
    meta: RequestMeta = {},
  ): Promise<{ verified: true; alreadyVerified: boolean; message: string }> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { emailVerifiedAt: true },
    });
    if (user.emailVerifiedAt) {
      return {
        verified: true,
        alreadyVerified: true,
        message: 'আপনার ইমেইল ঠিকানা আগেই যাচাই করা হয়েছে।',
      };
    }

    const digits = code.replace(/\D/g, '');
    const check = await this.tokens.checkCode(userId, 'VERIFY_EMAIL', digits);

    if (check.status === 'OK') {
      if (!(await this.markVerified(check.id, check.userId, meta))) {
        return {
          verified: true,
          alreadyVerified: true,
          message: 'আপনার ইমেইল ঠিকানা আগেই যাচাই করা হয়েছে।',
        };
      }
      return { verified: true, alreadyVerified: false, message: VERIFIED_MESSAGE };
    }

    /* Each refusal says the one thing the person can act on, and nothing that
     * would help somebody guessing: a wrong code says how many tries are left,
     * an expired one offers a fresh send, and a burnt one says so plainly
     * rather than counting down to nothing. */
    const reasons: Record<string, { code: string; message: string }> = {
      NO_CODE: {
        code: 'CODE_NOT_SENT',
        message: 'কোনো কোড পাঠানো হয়নি। আগে “কোড পাঠান” চাপুন।',
      },
      USED: { code: 'CODE_USED', message: 'এই কোডটি আগেই ব্যবহার করা হয়েছে।' },
      EXPIRED: {
        code: 'CODE_EXPIRED',
        message: 'কোডের মেয়াদ শেষ। নতুন একটি কোড চেয়ে নিন।',
      },
      LOCKED: {
        code: 'CODE_LOCKED',
        message: 'অনেকবার ভুল হয়েছে — এই কোডটি আর কাজ করবে না। নতুন একটি কোড চেয়ে নিন।',
      },
    };

    if (check.status === 'WRONG') {
      throw new BadRequestException({
        code: 'CODE_WRONG',
        message: `কোডটি মেলেনি। আর ${toBengaliDigits(check.attemptsLeft)} বার চেষ্টা করা যাবে।`,
        attemptsLeft: check.attemptsLeft,
      });
    }
    throw new BadRequestException(reasons[check.status]);
  }

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

    if (!(await this.markVerified(lookup.id, lookup.userId, meta))) {
      return {
        verified: true,
        alreadyVerified: true,
        message: 'এই লিংকটি আগেই ব্যবহার করা হয়েছে — আপনার ইমেইল যাচাই করা আছে।',
      };
    }

    return { verified: true, alreadyVerified: false, message: VERIFIED_MESSAGE };
  }

  /**
   * Claim the token and stamp the address as verified.
   *
   * Shared by the link and the code, because two implementations of "this
   * address is now proven" would eventually differ on the parts that matter —
   * the atomic claim that stops a double-clicked button verifying twice, the
   * invalidation of every older outstanding token, and the audit row. Returns
   * false when the claim was lost, which is the "already used" case.
   */
  private async markVerified(tokenId: string, userId: string, meta: RequestMeta): Promise<boolean> {
    if (!(await this.tokens.claim(tokenId))) return false;

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { emailVerifiedAt: new Date() },
      select: { id: true },
    });

    // Older links and codes become "already used" rather than staying live.
    await this.tokens.invalidateOutstanding(userId, 'VERIFY_EMAIL', tokenId);

    const workspaceId = await primaryWorkspaceId(this.prisma, userId);
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
    return true;
  }

  /** Best-effort fresh link after a dead one. Silent when cooling down. */
  private async resendVerification(userId: string, meta: RequestMeta): Promise<boolean> {
    if (await this.tokens.isCoolingDown(userId, 'VERIFY_EMAIL')) return false;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, name: true, emailVerifiedAt: true },
    });
    if (!user || user.emailVerifiedAt) return false;

    const { token, code } = await this.tokens.issue(userId, 'VERIFY_EMAIL', meta.ip);
    const result = await this.mail.sendVerification({
      to: user.email,
      name: user.name,
      token,
      code,
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

    /* Checked on every path that sets a password, not only on signup. A reset
     * is the exact moment somebody reaches for the password they use
     * everywhere else, which is the one most likely to be in a dump. */
    if (await this.breached.isBreached(password)) {
      throw new BadRequestException(BREACHED_PASSWORD_MESSAGE);
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

  // --- password change (signed in) -------------------------------------------

  /**
   * Change the password of a user who is already signed in and knows the old one.
   *
   * Deliberately not the same event as `resetPassword`, and the difference is
   * the whole design. A reset is triggered by somebody who has lost the account,
   * so it must assume the account is in someone else's hands and destroys every
   * session including the caller's. This is a person in Settings who just proved
   * they hold the current password. Logging them out of the tab they are
   * standing in teaches nothing, protects nothing, and is hostile — so their
   * session lives.
   *
   * Everything that does matter still happens: every *other* refresh-token
   * family dies, so a session a thief is holding is gone; and `tokenVersion`
   * moves, so any access token minted before this second stops validating even
   * though its signature is still perfectly good and it has minutes left to run.
   * That bump also kills the caller's own access token, which is why
   * `AuthController` mints them a replacement on the way out.
   *
   * When the caller's family cannot be identified — no refresh cookie, no device
   * id — everything is revoked, the caller included. Same call as
   * `SessionsService.revokeOthers` makes and for the same reason: not acting
   * because we could not work out which session is theirs would be the worst of
   * the available answers.
   */
  async changePassword(
    userId: string,
    workspaceId: string,
    currentPassword: string,
    newPassword: string,
    ctx: SessionRequestContext = {},
  ): Promise<{
    ok: true;
    sessionsRevoked: number;
    currentSessionRevoked: boolean;
    message: string;
  }> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, email: true, name: true, passwordHash: true },
    });

    /* No options argument, exactly as the login path does it: argon2 reads the
     * cost parameters back out of the stored digest, so a hash written under an
     * older ARGON_OPTIONS still verifies. ARGON_OPTIONS governs writing, below.
     * The `.catch` mirrors login too — a malformed digest is a failed check,
     * not a 500. */
    const ok = await argon2.verify(user.passwordHash, currentPassword).catch(() => false);

    if (!ok) {
      /* Filed under the same action as a failed login, because that is what it
       * is: a wrong credential against this account. A settings page that lets
       * somebody sitting at an unlocked laptop grind for the password has to be
       * visible on the owner's timeline. */
      this.audit.emit({
        workspaceId,
        actorUserId: userId,
        action: 'auth.login_failed',
        entity: 'User',
        entityId: userId,
        after: { via: 'password_change' },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      throw new UnauthorizedException({
        code: 'CURRENT_PASSWORD_INVALID',
        message: 'বর্তমান পাসওয়ার্ড ভুল।',
      });
    }

    // Nothing changes, so nothing should be revoked or invalidated either.
    if (currentPassword === newPassword) {
      throw new BadRequestException({
        code: 'PASSWORD_UNCHANGED',
        message: 'নতুন পাসওয়ার্ড আগের পাসওয়ার্ডের থেকে আলাদা হতে হবে।',
      });
    }

    // Resolved before the transaction: it reads the same rows the transaction
    // then updates, and it is a read-only decision, not part of the atom.
    if (await this.breached.isBreached(newPassword)) {
      throw new BadRequestException(BREACHED_PASSWORD_MESSAGE);
    }

    const currentFamilyId = await this.sessions.currentFamilyId(userId, ctx);
    const passwordHash = await argon2.hash(newPassword, ARGON_OPTIONS);
    const now = new Date();

    const sessionsRevoked = await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          passwordHash,
          /* Same transaction as the revocation, for the reason `resetPassword`
           * spells out: a bump without the revocation, or the reverse, leaves
           * the account half-changed with one of the two doors still open. */
          tokenVersion: { increment: 1 },
        },
      });

      const revoked = await tx.refreshToken.updateMany({
        where: {
          userId,
          revokedAt: null,
          ...(currentFamilyId ? { familyId: { not: currentFamilyId } } : {}),
        },
        data: { revokedAt: now },
      });

      /* Any reset link still in flight dies here. Otherwise a link mailed
       * minutes ago — possibly requested by whoever the user is changing their
       * password to lock out — could be redeemed afterwards and undo all of
       * this, which is exactly the window a password change is meant to close. */
      await tx.emailToken.updateMany({
        where: { userId, purpose: 'RESET_PASSWORD', usedAt: null },
        data: { usedAt: now },
      });

      return revoked.count;
    });

    const currentSessionRevoked = currentFamilyId === null;

    // Fire-and-forget: the notification must not be able to fail a change that
    // is already committed. Same contract as `resetPassword`.
    void this.mail.sendPasswordChanged({
      to: user.email,
      name: user.name,
      allSessionsRevoked: currentSessionRevoked,
    });

    this.audit.emit({
      workspaceId,
      actorUserId: userId,
      action: PASSWORD_CHANGED_ACTION,
      entity: 'User',
      entityId: userId,
      after: { sessionsRevoked, currentSessionRevoked },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    if (currentSessionRevoked) {
      this.logger.warn(
        `password/change for user ${userId} could not identify the caller's session`,
      );
      return {
        ok: true,
        sessionsRevoked,
        currentSessionRevoked: true,
        message:
          'পাসওয়ার্ড পরিবর্তন হয়েছে। বর্তমান সেশনটি শনাক্ত করা যায়নি, তাই নিরাপত্তার জন্য সব সেশন বাতিল করা হয়েছে — নতুন পাসওয়ার্ড দিয়ে আবার লগইন করুন।',
      };
    }

    this.logger.log(`Password changed for user ${userId}; ${sessionsRevoked} session(s) revoked`);

    return {
      ok: true,
      sessionsRevoked,
      currentSessionRevoked: false,
      message:
        sessionsRevoked > 0
          ? 'পাসওয়ার্ড পরিবর্তন হয়েছে। অন্য সব ডিভাইস থেকে লগআউট করা হয়েছে — এই ডিভাইসটি লগইন থাকবে।'
          : 'পাসওয়ার্ড পরিবর্তন হয়েছে। এই ডিভাইসটি লগইন থাকবে।',
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
