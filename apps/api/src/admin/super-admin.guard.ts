import { Injectable, Logger, NotFoundException, type ExecutionContext } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { Request } from 'express';
import type { AuthUser } from '../auth/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The gate on `/admin`.
 *
 * ## Why this is a guard and a module of its own, and never a branch
 *
 * Every other query in this codebase is scoped by `workspaceId`. The routes
 * behind this guard are not — that is the entire point of them, and it makes
 * global access a **deliberate hole in the guard that protects every tenant**.
 * A hole is survivable only while it stays in one place you can point at.
 *
 * So: its own module, its own guard, its own controller prefix. The day
 * somebody writes `if (isAdmin)` into a shared service is the day a normal user
 * finds their way through it — a mistyped condition, a truthy string, a
 * refactor that moves the check above the tenant filter, and a bug in an
 * ordinary code path becomes a cross-tenant data leak instead of a broken
 * screen. There is no such branch anywhere in `src/` outside this directory,
 * and adding one is not a shortcut, it is the failure.
 *
 * ## Why the flag is read from the database on every request
 *
 * `isSuperAdmin` is deliberately absent from the JWT. A revoked operator must
 * lose access at the next request, not up to fifteen minutes later when their
 * token happens to expire — and revocation is exactly the moment you care,
 * because you revoke when you have stopped trusting somebody. `JwtStrategy`
 * re-reads the membership on every request for the same reason; this matches
 * it. One indexed primary-key lookup is not a cost worth trading that for.
 *
 * ## Why a non-operator gets 404 and not 403
 *
 * A 403 confirms the route exists. That tells an attacker there is an admin
 * panel on this host, that it lives under `/admin`, and — by probing which
 * paths answer 403 rather than 404 — its entire route map, which is a shopping
 * list of the endpoints worth attacking. A 404 says only what a request for any
 * unrouted path says. Note that this also swallows the authentication failure:
 * an unauthenticated caller gets 404 too, because a 401 here while `/admin/xyz`
 * returned 404 would enumerate the real routes just as well as a 403 would.
 */
/**
 * One shape for every rejection, so the reason can never leak through a
 * message, a code or a body key. Not authenticated, not an operator, token
 * expired — all indistinguishable from a path that was never routed.
 */
const notHere = (): NotFoundException => new NotFoundException('পাওয়া যায়নি');

@Injectable()
export class SuperAdminGuard extends AuthGuard('jwt') {
  private readonly logger = new Logger(SuperAdminGuard.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  override async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();

    /* Authenticate first — this is the ordinary JwtStrategy, so a suspended
     * membership, a deleted workspace or a stale `tokenVersion` is already
     * rejected before `isSuperAdmin` is even consulted. Its 401 is caught and
     * turned into the same 404 as everything else below. */
    let authenticated = false;
    try {
      authenticated = await (super.canActivate(context) as Promise<boolean>);
    } catch {
      authenticated = false;
    }
    if (!authenticated || !req.user?.id) throw notHere();

    const operator = await this.prisma.user.findUnique({
      where: { id: req.user.id },
      // Nothing else. This guard has no business reading a password hash.
      select: { isSuperAdmin: true },
    });

    if (!operator?.isSuperAdmin) {
      /* Logged loudly even though the caller is told nothing: an authenticated
       * user probing `/admin` is either a bug in the web app or somebody
       * looking, and both are worth seeing in the journal. Not written to
       * AuditEvent — the row would have to be filed against this user's own
       * workspace, where it means nothing to its owner, and a cheap
       * unauthenticated-ish loop could then flood the table. */
      this.logger.warn(
        `Non-operator ${req.user.id} probed ${req.method} ${req.originalUrl ?? req.url}`,
      );
      throw notHere();
    }

    return true;
  }
}
