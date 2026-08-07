import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import type { Request } from 'express';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from './current-user.decorator';

export interface JwtPayload {
  sub: string;
  email: string;
  /** Active workspace. Every tenant-scoped query filters on this. */
  ws: string;
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
      secretOrKey: process.env.JWT_ACCESS_SECRET ?? 'change-me-access',
    });
  }

  /**
   * A valid signature is not enough: the membership is re-checked on every
   * request, so revoking someone's access takes effect immediately rather than
   * when their 15-minute token happens to expire.
   */
  async validate(payload: JwtPayload): Promise<AuthUser> {
    if (!payload.ws) throw new UnauthorizedException();

    const membership = await this.prisma.membership.findUnique({
      where: { workspaceId_userId: { workspaceId: payload.ws, userId: payload.sub } },
      include: {
        user: { select: { id: true, email: true } },
        workspace: { select: { id: true, status: true, deletedAt: true, timezone: true } },
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

    return {
      id: membership.user.id,
      email: membership.user.email,
      workspaceId: membership.workspace.id,
      role: membership.role,
      timezone: membership.workspace.timezone,
    };
  }
}
