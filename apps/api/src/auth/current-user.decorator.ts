import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { MembershipRole } from '@prisma/client';
import type { Request } from 'express';

/**
 * The authenticated caller, injected by JwtStrategy.validate().
 *
 * `workspaceId` — not `id` — is what every tenant-scoped query filters on.
 * The workspace timezone rides along because almost every ledger query needs
 * it and it is already loaded to validate the membership.
 */
export interface AuthUser {
  id: string;
  email: string;
  workspaceId: string;
  role: MembershipRole;
  timezone: string;
  /**
   * The workspace's ISO 4217 code — what its books are kept in.
   *
   * Rides along for the same reason `timezone` does: the membership row is
   * already being read to authorise the request, so every handler that needs to
   * know what a stored integer *means* gets it without a second query.
   */
  currency: string;
  /**
   * The operator's user id when this request is a support session, otherwise
   * null.
   *
   * `id` and `email` stay the *customer's* throughout — the whole point of
   * impersonation is to see what they see — so this is the only thing on the
   * request that says the person at the keyboard is somebody else.
   */
  impersonatedBy: string | null;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const req = ctx.switchToHttp().getRequest<Request & { user: AuthUser }>();
    return req.user;
  },
);
