import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { MembershipRole } from '@prisma/client';
import type { Request } from 'express';
import { ROLES_KEY } from './roles.decorator';
import type { AuthUser } from './current-user.decorator';

/**
 * Enforce `@Roles(...)`.
 *
 * The role comes from `AuthUser`, which `JwtStrategy.validate` fills from the
 * caller's live `Membership` row on every request — not from a claim baked into
 * the token. So an owner demoted to viewer this morning loses the route this
 * afternoon without waiting for an access token to expire.
 *
 * Placed after `JwtAuthGuard` in the `@UseGuards` list so an unauthenticated
 * request is a 401 rather than this. 403 rather than 404 for the reason
 * `NoImpersonationGuard` gives: the route exists, the member can see the screen
 * it belongs to, and a 404 would send them hunting for a bug.
 *
 * **What this does not do.** It gates the route, not the underlying figures. A
 * member who cannot download the party due report can still open one
 * counterparty's ledger and read the same balance there, because those routes
 * are workspace-scoped like everything else. The restriction is on walking out
 * with the whole list in one file, which is what was actually asked for.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const allowed = this.reflector.getAllAndOverride<readonly MembershipRole[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    // No decorator: the route never asked to be restricted.
    if (!allowed || allowed.length === 0) return true;

    const request = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const role = request.user?.role;
    if (role && allowed.includes(role)) return true;

    throw new ForbiddenException('এই কাজটি শুধু ওয়ার্কস্পেসের মালিক ও অ্যাডমিন করতে পারেন');
  }
}
