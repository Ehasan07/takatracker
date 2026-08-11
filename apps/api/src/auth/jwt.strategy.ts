import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import type { Request } from 'express';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { jwtAccessSecret } from '../common/env';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from './current-user.decorator';

export interface JwtPayload {
  sub: string;
  email: string;
  /** Active workspace. Every tenant-scoped query filters on this. */
  ws: string;
  /**
   * The user's `tokenVersion` when this token was minted.
   *
   * Optional only so tokens issued before the claim existed keep working for
   * the fifteen minutes it takes them to expire; a missing claim reads as 0,
   * which is where every account starts. Once a reset bumps the stored value
   * past 0 those old tokens stop matching too, so the rollout gap closes
   * itself rather than leaving a hole.
   */
  tv?: number;
  /**
   * True on a support token, minted by `POST /admin/impersonate/:workspaceId`.
   *
   * Absent on every ordinary sign-in, so nothing changes for a normal session.
   * Its presence is what lets a route refuse an operator outright — see
   * `NoImpersonationGuard` — rather than relying on the client to have stored
   * the envelope and behaved itself.
   */
  imp?: true;
  /** The operator's own user id. Present only alongside `imp`. */
  impBy?: string;
}

export const ACCESS_COOKIE = 'hishab_at';
export const REFRESH_COOKIE = 'hishab_rt';

/** Web sends the access token as an httpOnly cookie; mobile sends a bearer header. */
const fromCookie = (req: Request): string | null => {
  const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
  return cookies?.[ACCESS_COOKIE] ?? null;
};

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(private readonly prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        fromCookie,
      ]),
      ignoreExpiration: false,
      /* No `?? 'change-me-access'`. That default meant an EnvironmentFile that
       * failed to load left this strategy accepting tokens signed with a
       * constant published in .env.example — a silent, total auth bypass on a
       * box that looks perfectly healthy. The resolver throws in production
       * instead, and hands out one memoised value so this and the signer in
       * auth.service.ts cannot end up on different keys. */
      secretOrKey: jwtAccessSecret(),
    });
  }

  /**
   * A valid signature is not enough: the membership is re-checked on every
   * request, so revoking someone's access takes effect immediately rather than
   * when their 15-minute token happens to expire.
   *
   * `tokenVersion` rides along in that same query — the row is already being
   * read, so invalidating access tokens costs no extra round trip.
   */
  async validate(payload: JwtPayload): Promise<AuthUser> {
    if (!payload.ws) throw new UnauthorizedException();

    const membership = await this.prisma.membership.findUnique({
      where: { workspaceId_userId: { workspaceId: payload.ws, userId: payload.sub } },
      include: {
        user: { select: { id: true, email: true, tokenVersion: true } },
        workspace: {
          select: { id: true, status: true, deletedAt: true, timezone: true, currency: true },
        },
      },
    });

    if (
      !membership ||
      membership.status !== 'ACTIVE' ||
      membership.workspace.deletedAt !== null ||
      membership.workspace.status === 'SUSPENDED' ||
      membership.workspace.status === 'CANCELLED'
    ) {
      throw new UnauthorizedException();
    }

    /* The account's credentials moved after this token was minted — a password
     * reset, today. The signature is still perfectly valid, which is exactly
     * the problem: without this check a token stolen before the reset would
     * keep working until it expired on its own. */
    if ((payload.tv ?? 0) !== membership.user.tokenVersion) {
      throw new UnauthorizedException();
    }

    return {
      id: membership.user.id,
      email: membership.user.email,
      workspaceId: membership.workspace.id,
      role: membership.role,
      timezone: membership.workspace.timezone,
      currency: membership.workspace.currency,
      /* Read from the token, so it cannot be lost by a client that drops the
       * envelope. `impBy` without `imp` is treated as no session at all: the
       * pair is minted together and one without the other is not a shape this
       * server produces. */
      impersonatedBy: payload.imp === true ? (payload.impBy ?? null) : null,
    };
  }
}
