import { randomBytes, createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import type { TokenChannel } from '@prisma/client';
import { DEFAULT_CATEGORIES, DEFAULT_PLAN_CODE, SYSTEM_ACCOUNT_SEED } from '@hishab/core';
import { normaliseBdPhone, type LoginInput, type SignupInput } from '@hishab/shared';

/**
 * One sentence whichever half was wrong, and whichever identifier was used.
 *
 * "No account with that number" would turn the login form into a way of asking
 * whether somebody banks here — the same property `otp/request` protects.
 */
const LOGIN_REFUSAL = 'ইমেইল/মোবাইল বা পাসওয়ার্ড ভুল';
import { AuditService } from '../audit/audit.service';
import { jwtAccessSecret } from '../common/env';
import { PrismaService } from '../prisma/prisma.service';
import { AccountService } from './account.service';
import { ARGON_OPTIONS } from './auth.helpers';
import { BreachedPasswordService, BREACHED_PASSWORD_MESSAGE } from './breached-password.service';
import { EmailTokenService, MAX_SMS_PER_DAY, SIGN_IN_TTL_MS } from './email-token.service';
import { SmsSender } from '../notifications/sms.sender';
import { MailService } from '../mail/mail.service';

/**
 * One sentence for every way a code sign-in can fail.
 *
 * Wrong code, no such address, expired, or five wrong guesses already spent —
 * telling them apart would turn the verify route into the account-enumeration
 * oracle that the request route goes out of its way not to be. The attempt
 * counter still does its work underneath; the caller simply is not told which
 * of the four happened.
 */
const SIGN_IN_REFUSAL = 'কোডটি মেলেনি বা মেয়াদ শেষ';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface AuthMeta {
  deviceId?: string;
  userAgent?: string;
  ip?: string;
}

export interface AuthResult extends TokenPair {
  user: { id: string; email: string; name: string; locale: string };
  workspace: { id: string; name: string; currency: string; timezone: string };
}

const REFRESH_TTL_DAYS = 30;
const ACCESS_TTL = process.env.JWT_ACCESS_TTL ?? '15m';
/** The same window, in seconds, for the `expiresIn` a client schedules refreshes on. */
const ACCESS_TTL_SECONDS = 15 * 60;

/** Moved to auth.helpers.ts to keep this file out of an import cycle; re-exported so existing importers are undisturbed. */
export { ARGON_OPTIONS } from './auth.helpers';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
    private readonly account: AccountService,
    private readonly emailTokens: EmailTokenService,
    private readonly mail: MailService,
    private readonly breached: BreachedPasswordService,
    private readonly sms: SmsSender,
  ) {}

  private static hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  async signup(input: SignupInput, meta: AuthMeta = {}): Promise<AuthResult> {
    const email = input.email.toLowerCase().trim();
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) throw new ConflictException('এই ইমেইলে ইতিমধ্যে অ্যাকাউন্ট আছে');

    /* The number is a credential now, so two accounts cannot share one. The
     * unique index is the real guard — this is the readable refusal, and the
     * index is what holds when two signups race. */
    const phoneTaken = await this.prisma.user.findUnique({ where: { phone: input.phone } });
    if (phoneTaken) throw new ConflictException('এই মোবাইল নম্বরে ইতিমধ্যে অ্যাকাউন্ট আছে');

    /* Length alone was the whole rule, so `password` opened accounts. See
     * `BreachedPasswordService`: this is the other half of NIST 800-63B, and
     * the half that stops credential stuffing rather than encouraging it. */
    if (await this.breached.isBreached(input.password)) {
      throw new BadRequestException(BREACHED_PASSWORD_MESSAGE);
    }

    const passwordHash = await argon2.hash(input.password, ARGON_OPTIONS);

    const { user, workspace } = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email,
          name: input.name,
          phone: input.phone,
          passwordHash,
          locale: input.locale,
          device: input.device ?? null,
          notifyTimezone: input.timezone,
        },
      });

      // Every account gets a workspace of its own. Sharing is a later feature
      // flag, not a later migration.
      const freePlan = await tx.plan.findUnique({ where: { code: DEFAULT_PLAN_CODE } });
      const space = await tx.workspace.create({
        data: {
          name: input.name,
          ownerUserId: created.id,
          timezone: input.timezone,
          /* The workspace's own copy of both choices.
           *
           * `User.locale` is the person's preference; this is the *books'*. A
           * shared workspace has to render its categories and reports one way
           * for everybody rather than flickering between two members'
           * settings, and the currency is a property of the ledger itself —
           * changing it after entries exist would reinterpret every stored
           * integer, which is why it is asked for once, at signup. */
          locale: input.locale,
          currency: input.currency,
          planId: freePlan?.id ?? null,
          memberships: { create: { userId: created.id, role: 'OWNER' } },
        },
      });

      // Hidden nominal accounts that make the double entry balance.
      await tx.account.createMany({
        data: SYSTEM_ACCOUNT_SEED.map((a, i) => ({
          workspaceId: space.id,
          name: a.name,
          type: a.type,
          systemKey: a.systemKey,
          sortOrder: 1000 + i,
        })),
      });

      // Bangladesh-appropriate default category tree.
      await tx.category.createMany({
        data: DEFAULT_CATEGORIES.map((c) => ({
          workspaceId: space.id,
          name: c.name,
          nameBn: c.nameBn,
          kind: c.kind,
          icon: c.icon,
          sortOrder: c.sortOrder,
          isSystem: true,
          /* Seeded, not derived: `poribohon` and `restaurant` are synonyms of
           * the seeded names, and no transliteration reaches a synonym. */
          searchAliases: [...c.searchAliases],
        })),
      });

      return { user: created, workspace: space };
    });

    this.logger.log(`New user ${user.id} with workspace ${workspace.id}`);
    this.audit.emit({
      workspaceId: workspace.id,
      actorUserId: user.id,
      action: 'auth.signup',
      entity: 'User',
      entityId: user.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    /* The cold start for email verification. Without this call the loop never
     * begins: `sendVerification` was only reachable from the resend button on
     * /verify, and /verify is only reachable from the link this sends.
     *
     * Fire-and-forget with the error swallowed into the logger, exactly like
     * AuditService.emit, and for a stronger reason. An SMTP host that is down,
     * greylisting us, or simply slow must not be able to fail a signup: the
     * account, the workspace and the seed data are already committed, so a
     * throw here would return an error to somebody whose account exists, and
     * their retry would hit "এই ইমেইলে ইতিমধ্যে অ্যাকাউন্ট আছে". Nothing gates
     * on being verified either (see AccountService), so a mail that never
     * arrives costs a nag in the UI and a button press, not access. */
    void this.account
      .sendVerification(user.id, workspace.id, { ip: meta.ip, userAgent: meta.userAgent })
      .catch((err: unknown) => {
        this.logger.warn(
          `Signup verification mail for user ${user.id} was not sent: ${(err as Error).message}`,
        );
      });

    return this.issue(user, workspace);
  }

  async login(input: LoginInput, meta: AuthMeta = {}): Promise<AuthResult> {
    const { deviceId, userAgent } = meta;
    const user = await this.findByIdentifier(input.identifier);

    // Constant-ish work whether or not the user exists, so timing says nothing.
    const hash = user?.passwordHash ?? (await AuthService.dummyHash());
    const ok = await argon2.verify(hash, input.password).catch(() => false);

    if (!user || !ok) {
      /* Recorded against the workspace they would have reached, so a brute
       * force attempt is visible on the timeline the owner actually reads.
       * Nothing is recorded when the email is unknown — there is no tenant to
       * attribute it to, and inventing one would leak that the email exists. */
      if (user) {
        const workspace = await this.defaultWorkspace(user.id).catch(() => null);
        if (workspace) {
          this.audit.emit({
            workspaceId: workspace.id,
            actorUserId: user.id,
            action: 'auth.login_failed',
            entity: 'User',
            entityId: user.id,
            ip: meta.ip,
            userAgent,
          });
        }
      }
      throw new UnauthorizedException(LOGIN_REFUSAL);
    }

    const workspace = await this.defaultWorkspace(user.id);
    this.audit.emit({
      workspaceId: workspace.id,
      actorUserId: user.id,
      action: 'auth.login',
      entity: 'User',
      entityId: user.id,
      ip: meta.ip,
      userAgent,
    });
    return this.issue(user, workspace, { deviceId, userAgent });
  }

  // --- signing in with a code ------------------------------------------------

  /**
   * Ask for a sign-in code. Answers identically on every path.
   *
   * The same rule as `forgotPassword`, for the same reason: an anonymous caller
   * must not be able to learn which addresses have accounts here. Unknown
   * address, known address, cooling down, mail server down — one response, and
   * the mail is fired without being awaited so that an address that exists is
   * not measurably slower than one that does not.
   */
  /**
   * Ask for a sign-in code, by email or by text. Answers identically either way.
   *
   * The same rule as `forgotPassword`, for the same reason: an anonymous caller
   * must not learn which addresses or numbers have accounts here. Unknown,
   * known, cooling down, out of texts, gateway down — one response, and the
   * send is fired without being awaited so a registered identifier is not
   * measurably slower than one that is not.
   *
   * ## Email is the first offer and SMS the second
   *
   * Not a preference — a cost. Email is free and unmetered, a text costs money
   * per message and arrives on a lock screen. So the screen asks for the email
   * code first and only offers "send it to my phone" when that has not worked,
   * and this method defaults to `EMAIL` for a caller that says nothing.
   */
  async requestSignInCode(
    rawIdentifier: string,
    meta: AuthMeta & { channel?: TokenChannel } = {},
  ): Promise<void> {
    const channel = meta.channel ?? 'EMAIL';
    const user = await this.findByIdentifier(rawIdentifier);
    if (!user) {
      this.logger.debug('Sign-in code requested for an identifier with no account');
      return;
    }

    if (await this.emailTokens.isCoolingDown(user.id, 'SIGN_IN')) return;

    if (channel === 'SMS') {
      /* Three things have to hold, and every one of them fails silently: the
       * account has a number, the gateway exists, and the day's allowance is
       * not spent. Saying which would tell an anonymous caller something about
       * an account they have not proved they own. */
      if (!user.phone) return;
      if (!this.sms.configured) return;
      if ((await this.emailTokens.smsSentToday(user.id)) >= MAX_SMS_PER_DAY) return;

      const { code } = await this.emailTokens.issue(user.id, 'SIGN_IN', meta.ip, 'SMS');
      void this.sms.send(
        user.phone,
        `Taka Tracker: ${code} — লগইনের কোড, ${SIGN_IN_TTL_MS / 60_000} মিনিট কাজ করবে। কাউকে দেবেন না।`,
      );
    } else {
      const { code } = await this.emailTokens.issue(user.id, 'SIGN_IN', meta.ip, 'EMAIL');
      void this.mail.sendSignInCode({
        to: user.email,
        name: user.name,
        code,
        expiresInMinutes: SIGN_IN_TTL_MS / 60_000,
      });
    }

    const workspace = await this.defaultWorkspace(user.id).catch(() => null);
    if (workspace) {
      this.audit.emit({
        workspaceId: workspace.id,
        actorUserId: user.id,
        action: 'auth.signin_code_requested',
        entity: 'User',
        entityId: user.id,
        after: { channel },
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
    }
  }

  /**
   * Trade a code for a session.
   *
   * ## Why this is audited as its own action
   *
   * A code that signs somebody in is worth as much as the password, and whoever
   * can read the inbox could already have reset it. What is different is that a
   * reset stops the owner's own password working — they notice — while this
   * leaves the account looking untouched. `auth.signin_code` rather than
   * `auth.login` is what makes "somebody signed in with an emailed code" a
   * question the activity log can answer.
   *
   * ## Why it also verifies the address
   *
   * Typing back a code that was mailed to an address *is* proof of the address,
   * which is exactly what the verification flow asks for. Leaving the nag up
   * after somebody has demonstrably read their email would be asking them to
   * prove a thing they just proved.
   */
  async signInWithCode(
    rawIdentifier: string,
    code: string,
    meta: AuthMeta = {},
  ): Promise<AuthResult> {
    const user = await this.findByIdentifier(rawIdentifier);

    /* One message for every failure — wrong code, no such address, expired, or
     * five wrong guesses already spent. See `SIGN_IN_REFUSAL`. */
    /* One message for every failure, and `never` so the compiler knows the
       code below is only reached with a user in hand. */
    if (!user) throw new UnauthorizedException(SIGN_IN_REFUSAL);

    const check = await this.emailTokens.checkCode(user.id, 'SIGN_IN', code);
    if (check.status !== 'OK') {
      const failed = await this.defaultWorkspace(user.id).catch(() => null);
      if (failed) {
        this.audit.emit({
          workspaceId: failed.id,
          actorUserId: user.id,
          action: 'auth.login_failed',
          entity: 'User',
          entityId: user.id,
          ip: meta.ip,
          userAgent: meta.userAgent,
        });
      }
      throw new UnauthorizedException(SIGN_IN_REFUSAL);
    }

    /* Claim it before anything else. `checkCode` deliberately does not burn the
     * row — its contract is to *check* — so a caller that forgets this leaves a
     * code that works twice, which for a sign-in code means a session that can
     * be minted again from an email somebody already read. `claim` is an atomic
     * compare-and-set on `usedAt: null`, so a double-tapped button and a replay
     * are the same case and exactly one of them wins.
     *
     * Found by the test that asked for the same code twice, not by reading. */
    if (!(await this.emailTokens.claim(check.id))) {
      throw new UnauthorizedException(SIGN_IN_REFUSAL);
    }

    const workspace = await this.defaultWorkspace(user.id);

    /* The address is proven by the fact that they read the code. */
    if (!user.emailVerifiedAt) {
      await this.prisma.user
        .update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } })
        .catch(() => undefined);
    }

    this.audit.emit({
      workspaceId: workspace.id,
      actorUserId: user.id,
      action: 'auth.signin_code',
      entity: 'User',
      entityId: user.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return this.issue(user, workspace, { deviceId: meta.deviceId, userAgent: meta.userAgent });
  }

  /**
   * The account behind whatever they typed.
   *
   * An email or a Bangladeshi mobile, decided by looking at the value rather
   * than by asking the user to say which — the wall this removes is being told
   * "enter a valid email" after typing a real, working phone number.
   *
   * The number is normalised before the lookup, so `+8801712345678`,
   * `০১৭১২৩৪৫৬৭৮` and `01712-345678` all find the same row. The column holds
   * the canonical form because every write path runs `storablePhone` first.
   */
  private async findByIdentifier(identifier: string) {
    const trimmed = identifier.trim();
    const phone = normaliseBdPhone(trimmed);
    if (phone) return this.prisma.user.findUnique({ where: { phone } });
    return this.prisma.user.findUnique({ where: { email: trimmed.toLowerCase() } });
  }

  private static dummyHashCache: string | null = null;
  private static async dummyHash(): Promise<string> {
    AuthService.dummyHashCache ??= await argon2.hash('not-a-real-password', ARGON_OPTIONS);
    return AuthService.dummyHashCache;
  }

  /** The workspace a session lands in: the one they own, else the oldest they belong to. */
  private async defaultWorkspace(userId: string) {
    const membership = await this.prisma.membership.findFirst({
      where: { userId, status: 'ACTIVE', workspace: { deletedAt: null } },
      orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
      include: { workspace: true },
    });
    if (!membership) throw new UnauthorizedException('কোনো ওয়ার্কস্পেস পাওয়া যায়নি');
    return membership.workspace;
  }

  /** The single place an access token is minted, so the claims cannot drift. */
  private signAccessToken(
    user: { id: string; email: string; tokenVersion: number },
    workspaceId: string,
    impersonatedBy?: string,
  ): Promise<string> {
    return this.jwt.signAsync(
      /* `tv` is the user's token version at the moment of minting. JwtStrategy
       * compares it against the stored value on every request, which is how a
       * password reset kills an access token that has not expired yet — the
       * refresh families it revokes cannot reach one.
       *
       * `imp`/`impBy` mark a support session. Only ever set by
       * `AdminImpersonationService`; an ordinary sign-in omits both, so an
       * existing token and every future normal one are unchanged. The claims
       * are in the token rather than only in the response envelope because the
       * server has to be able to refuse an operator on a sensitive route, and
       * it cannot ask the client what kind of session this is. */
      {
        sub: user.id,
        email: user.email,
        ws: workspaceId,
        tv: user.tokenVersion,
        ...(impersonatedBy ? { imp: true as const, impBy: impersonatedBy } : {}),
      },
      // Read through the resolver, never `process.env`: the strategy that
      // verifies this token reads it at a different moment in the boot, and the
      // two must not be able to see different values. See common/env.ts.
      { secret: jwtAccessSecret(), expiresIn: ACCESS_TTL },
    );
  }

  /**
   * A replacement access token for a session that is deliberately surviving a
   * `tokenVersion` bump — today only `POST /auth/password/change`.
   *
   * That flow keeps the caller's refresh family alive on purpose, but the bump
   * it performs invalidates the access token that authorised the very request
   * making the change. Without this the next call is a 401. Only the
   * short-lived half is replaced: no new refresh token, no new family, so this
   * cannot be used to manufacture a session.
   */
  async reissueAccessToken(
    userId: string,
    workspaceId: string,
    impersonatedBy?: string,
  ): Promise<{ accessToken: string; expiresIn: number }> {
    // Re-read rather than trusting a caller-supplied version: the bump has just
    // been written and this token has to carry the value that is now stored.
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, email: true, tokenVersion: true },
    });
    return {
      accessToken: await this.signAccessToken(user, workspaceId, impersonatedBy),
      expiresIn: ACCESS_TTL_SECONDS,
    };
  }

  private async issue(
    user: { id: string; email: string; name: string; locale: string; tokenVersion: number },
    workspace: { id: string; name: string; currency: string; timezone: string },
    meta: { deviceId?: string; userAgent?: string; familyId?: string } = {},
  ): Promise<AuthResult> {
    const accessToken = await this.signAccessToken(user, workspace.id);

    const refreshToken = randomBytes(48).toString('base64url');
    const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 86_400_000);

    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        familyId: meta.familyId ?? randomBytes(16).toString('hex'),
        tokenHash: AuthService.hashToken(refreshToken),
        deviceId: meta.deviceId,
        userAgent: meta.userAgent?.slice(0, 300),
        expiresAt,
      },
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: ACCESS_TTL_SECONDS,
      user: { id: user.id, email: user.email, name: user.name, locale: user.locale },
      workspace: {
        id: workspace.id,
        name: workspace.name,
        currency: workspace.currency,
        timezone: workspace.timezone,
      },
    };
  }

  /**
   * Rotate a refresh token. Replaying an already-used token revokes the whole
   * family — the classic stolen-token defence (spec §9).
   */
  async refresh(token: string, deviceId?: string, userAgent?: string): Promise<AuthResult> {
    const tokenHash = AuthService.hashToken(token);
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!stored) throw new UnauthorizedException('সেশন মেয়াদোত্তীর্ণ');

    if (stored.usedAt || stored.revokedAt) {
      await this.prisma.refreshToken.updateMany({
        where: { familyId: stored.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      this.logger.warn(`Refresh token reuse detected for user ${stored.userId}; family revoked`);
      const workspace = await this.defaultWorkspace(stored.userId).catch(() => null);
      if (workspace) {
        this.audit.emit({
          workspaceId: workspace.id,
          actorUserId: stored.userId,
          actorType: 'SYSTEM',
          action: 'auth.refresh_reuse_detected',
          entity: 'RefreshToken',
          entityId: stored.id,
        });
      }
      throw new UnauthorizedException('সেশন বাতিল করা হয়েছে, আবার লগইন করুন');
    }

    if (stored.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('সেশন মেয়াদোত্তীর্ণ');
    }

    const workspace = await this.defaultWorkspace(stored.userId);
    const next = await this.issue(stored.user, workspace, {
      deviceId,
      userAgent,
      familyId: stored.familyId,
    });

    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { usedAt: new Date(), replacedBy: AuthService.hashToken(next.refreshToken) },
    });

    return next;
  }

  async logout(token: string | undefined): Promise<void> {
    if (!token) return;
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: AuthService.hashToken(token) },
    });
    if (!stored) return;
    await this.prisma.refreshToken.updateMany({
      where: { familyId: stored.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async me(userId: string, workspaceId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        phone: true,
        locale: true,
        device: true,
        notifyTimezone: true,
        // null while unproven. Nothing gates on it — see AccountService — but
        // the client needs it to show the verification nag.
        emailVerifiedAt: true,
        /* So the client can decide whether to draw the operator nav without
         * probing an admin endpoint on every page load — which would log a
         * guard warning for every ordinary user and drown the line that
         * warning exists to produce. It authorises nothing: `SuperAdminGuard`
         * re-reads this from the database on every admin request. */
        isSuperAdmin: true,
        createdAt: true,
      },
    });

    const membership = await this.prisma.membership.findUniqueOrThrow({
      where: { workspaceId_userId: { workspaceId, userId } },
      include: {
        workspace: {
          select: {
            id: true,
            name: true,
            currency: true,
            /* The books' language, not the reader's. Every screen with a
             * category name or a report heading on it renders from this. */
            locale: true,
            timezone: true,
            status: true,
          },
        },
      },
    });

    return { ...user, role: membership.role, workspace: membership.workspace };
  }
}
