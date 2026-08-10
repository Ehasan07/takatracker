import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { IMPERSONATION_ENDED, IMPERSONATION_STARTED, type AdminActor } from './admin-audit';
import type { EndImpersonationInput, StartImpersonationInput } from './admin.controller';

/**
 * The box. Fifteen minutes is long enough to reproduce a bug on somebody's
 * screen and short enough that a forgotten tab is not a standing key to their
 * books.
 */
const MAX_SECONDS = 15 * 60;

/**
 * Support impersonation.
 *
 * ## What the token actually is
 *
 * An ordinary access token for the tenant's own user, minted by
 * `AuthService.reissueAccessToken` — injected, never reimplemented. Copying the
 * claim set here would mean two places that decide what a valid session looks
 * like, and the day `tv` (the token-version check that makes a password reset
 * kill live sessions) changes shape, the copy in the admin module keeps signing
 * the old thing and nobody notices until it is a bypass.
 *
 * It has to be the tenant's user rather than the operator: `JwtStrategy`
 * re-reads `Membership` on every request, and an operator has no membership in
 * somebody else's workspace, so a token minted for them would be rejected
 * before it reached a single route. That is the guard doing its job;
 * impersonation works *with* it instead of drilling through it.
 *
 * ## How it is bounded
 *
 *  - **Fifteen minutes.** `reissueAccessToken` signs with the platform access
 *    TTL, so the box is only real while that TTL is ≤ 15 minutes. `assertBoxed`
 *    below refuses to issue anything if a deployment has widened
 *    `JWT_ACCESS_TTL`, rather than silently handing out an eight-hour key to
 *    somebody else's ledger because of an unrelated environment change.
 *  - **No refresh token.** Nothing is written to `RefreshToken`, so the session
 *    cannot be rotated, extended, or survive its own expiry. It dies on its
 *    own with no cleanup job and nothing to revoke.
 *  - **Never a cookie.** The response is a bearer token and the caller is told
 *    so. Writing it into `hishab_at` would silently replace the operator's own
 *    session with the customer's — every subsequent admin action would be
 *    attributed to the customer, and closing the banner would not undo it.
 *
 * ## What it is not
 *
 * `POST /admin/impersonate/end` records the end of the session and clears the
 * client's state. It cannot *revoke* the token: the only server-side kill
 * switch for an unexpired access token is `User.tokenVersion`, and bumping the
 * customer's version to end a support session would sign every one of their
 * own devices out. So the hard bound is the expiry, and the end call is the
 * audit event. That is stated plainly rather than dressed up, because a "revoke"
 * button that does not revoke is worse than none.
 *
 * TODO(main): once `JwtPayload` can carry them, add `imp: true` and
 * `impBy: <operator id>` claims in `AuthService.signAccessToken` and surface
 * them on `AuthUser`. Then the banner is driven by the token itself rather than
 * by the envelope below, actions taken during the session can be audited as
 * SUPPORT rather than as the customer, and sensitive routes can refuse an
 * impersonated caller outright. All three need edits to `auth/` and `AuthUser`,
 * which this change does not own.
 */
@Injectable()
export class AdminImpersonationService {
  private readonly logger = new Logger(AdminImpersonationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
  ) {}

  async start(actor: AdminActor, workspaceId: string, input: StartImpersonationInput) {
    this.assertBoxed();

    const workspace = await this.prisma.workspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
      select: { id: true, name: true, status: true, timezone: true, ownerUserId: true },
    });
    if (!workspace) throw new NotFoundException('ওয়ার্কস্পেস পাওয়া যায়নি');

    /* A token for a suspended or cancelled workspace is rejected by
     * JwtStrategy on arrival. Issuing one would look like it worked and then
     * 401 on the first screen. */
    if (workspace.status === 'SUSPENDED' || workspace.status === 'CANCELLED') {
      throw new BadRequestException(
        'স্থগিত বা বাতিল ওয়ার্কস্পেসে সাপোর্ট সেশন চালু করা যায় না, আগে পুনরায় সক্রিয় করুন',
      );
    }

    const membership = await this.prisma.membership.findFirst({
      where: {
        workspaceId,
        status: 'ACTIVE',
        ...(input.userId ? { userId: input.userId } : { userId: workspace.ownerUserId }),
      },
      select: {
        role: true,
        user: { select: { id: true, name: true, email: true, isSuperAdmin: true } },
      },
    });

    if (!membership) {
      throw new NotFoundException(
        input.userId
          ? 'এই ওয়ার্কস্পেসে ওই সদস্যের সক্রিয় অ্যাকাউন্ট নেই'
          : 'এই ওয়ার্কস্পেসের মালিকের সক্রিয় সদস্যপদ নেই',
      );
    }

    /* Refused, and not out of politeness. The `/admin` guard reads
     * `isSuperAdmin` for whoever the request authenticates as — so a token
     * minted for another operator would carry full platform access while every
     * audit row inside the session named them, not the person actually acting.
     * That destroys attribution, which is the only thing making this feature
     * defensible. */
    if (membership.user.isSuperAdmin) {
      throw new ForbiddenException('একজন অপারেটরের হয়ে সাপোর্ট সেশন চালু করা যায় না');
    }

    const issued = await this.auth.reissueAccessToken(membership.user.id, workspace.id);
    const startedAt = new Date();
    const expiresIn = Math.min(issued.expiresIn, MAX_SECONDS);
    const expiresAt = new Date(startedAt.getTime() + expiresIn * 1000);
    /* Correlates the start row with the end row on a timeline that has no
     * session table to join through. Not a secret and not a credential — it
     * proves nothing on its own and is only ever echoed back. */
    const sessionId = randomBytes(12).toString('hex');

    await this.audit.record({
      workspaceId: workspace.id,
      actorUserId: actor.id,
      actorType: 'SUPPORT',
      action: IMPERSONATION_STARTED,
      entity: 'Workspace',
      entityId: workspace.id,
      ip: actor.ip,
      userAgent: actor.userAgent,
      after: {
        sessionId,
        operator: actor.email,
        actingAsUserId: membership.user.id,
        actingAsEmail: membership.user.email,
        role: membership.role,
        reason: input.reason,
        expiresAt: expiresAt.toISOString(),
      },
    });

    this.logger.warn(
      `Impersonation ${sessionId}: ${actor.email} is acting as ${membership.user.email} ` +
        `in workspace ${workspace.id} until ${expiresAt.toISOString()} — ${input.reason}`,
    );

    return {
      /* The marker. An ordinary sign-in never returns this field, so a client
       * that stores the envelope cannot mistake a support session for its own
       * — and one that ignores it gets a token that expires in fifteen minutes
       * and cannot be refreshed. */
      tokenType: 'impersonation' as const,
      accessToken: issued.accessToken,
      /** Bearer header only. Never write this into the `hishab_at` cookie. */
      transport: 'authorization-bearer' as const,
      refreshToken: null,
      expiresIn,
      expiresAt: expiresAt.toISOString(),
      sessionId,
      impersonation: {
        workspace: { id: workspace.id, name: workspace.name, status: workspace.status },
        actingAs: {
          id: membership.user.id,
          name: membership.user.name,
          email: membership.user.email,
          role: membership.role,
        },
        startedBy: { id: actor.id, email: actor.email },
        startedAt: startedAt.toISOString(),
        reason: input.reason,
      },
      /** Ready to render, so every client shows the customer the same sentence. */
      banner: `সাপোর্ট মোড — আপনি ${workspace.name}-এর ${membership.user.name} হিসেবে দেখছেন। ${expiresAt.toISOString()} পর্যন্ত।`,
    };
  }

  /**
   * Close the session.
   *
   * Called with the **operator's own** token, not the impersonation one: the
   * `/admin` guard reads `isSuperAdmin` for whoever authenticates, and the
   * customer is not an operator. That is deliberate — it keeps the operator's
   * real session alive throughout, which is what makes the bearer-only rule
   * above workable.
   */
  async end(actor: AdminActor, input: EndImpersonationInput) {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: input.workspaceId },
      select: { id: true, name: true },
    });
    if (!workspace) throw new NotFoundException('ওয়ার্কস্পেস পাওয়া যায়নি');

    const endedAt = new Date();
    await this.audit.record({
      workspaceId: workspace.id,
      actorUserId: actor.id,
      actorType: 'SUPPORT',
      action: IMPERSONATION_ENDED,
      entity: 'Workspace',
      entityId: workspace.id,
      ip: actor.ip,
      userAgent: actor.userAgent,
      after: {
        sessionId: input.sessionId ?? null,
        operator: actor.email,
        actingAsUserId: input.actingAsUserId ?? null,
        endedAt: endedAt.toISOString(),
      },
    });

    this.logger.log(
      `Impersonation ${input.sessionId ?? '(no session id)'} ended by ${actor.email} in workspace ${workspace.id}`,
    );

    return {
      ok: true,
      workspaceId: workspace.id,
      sessionId: input.sessionId ?? null,
      endedAt: endedAt.toISOString(),
      /* Said out loud in the response so no client builds a UI that promises
       * more than the server can deliver. */
      note: 'সাপোর্ট টোকেন ক্লায়েন্ট থেকে মুছে ফেলুন; এটি নিজে থেকেই মেয়াদোত্তীর্ণ হবে।',
    };
  }

  /**
   * Refuse to issue anything if the platform access TTL is wider than the box.
   *
   * `reissueAccessToken` signs with `JWT_ACCESS_TTL` (default `15m`), so the
   * fifteen-minute bound is inherited, not enforced here. If somebody widens
   * that variable for an unrelated reason — a mobile client complaining about
   * refreshes, say — impersonation would silently start handing out tokens of
   * the same length into other people's ledgers. Refusing is the loud failure:
   * it breaks one support tool instead of quietly removing its only limit.
   */
  private assertBoxed(): void {
    const configured = parseTtlSeconds(process.env.JWT_ACCESS_TTL);

    if (configured === null) {
      this.logger.error(
        `JWT_ACCESS_TTL is set to ${JSON.stringify(process.env.JWT_ACCESS_TTL)}, which this ` +
          'service cannot parse, so the impersonation window cannot be proven to be short.',
      );
      throw new BadRequestException('সাপোর্ট সেশন এখন চালু করা যাচ্ছে না, কনফিগারেশন ঠিক করুন');
    }

    if (configured > MAX_SECONDS) {
      this.logger.error(
        `Refusing to impersonate: JWT_ACCESS_TTL is ${configured}s, and an impersonation token ` +
          `inherits it. Lower it to ${MAX_SECONDS}s or give impersonation its own signer.`,
      );
      throw new BadRequestException('সাপোর্ট সেশন এখন চালু করা যাচ্ছে না, কনফিগারেশন ঠিক করুন');
    }
  }
}

const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3_600, d: 86_400 };

/** `'15m'`, `'900s'`, `'900'` — the `expiresIn` grammar `@nestjs/jwt` accepts. */
const parseTtlSeconds = (raw: string | undefined): number | null => {
  const value = raw?.trim();
  if (!value) return MAX_SECONDS; // unset falls back to ACCESS_TTL's own '15m'
  const match = /^(\d+)\s*(s|m|h|d)?$/i.exec(value);
  if (!match) return null;
  const multiplier = UNIT_SECONDS[(match[2] ?? 's').toLowerCase()] ?? 1;
  return Number(match[1]) * multiplier;
};
