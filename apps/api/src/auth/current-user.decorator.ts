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
   * The language the books are read in — `Workspace.locale`, not the person's.
   *
   * Here for the same reason `timezone` and `currency` are: the membership row
   * is already being read to authorise the request. It decides which of a
   * category's two names a response carries, and that decision cannot be left
   * to the client for the places where the server collapses the pair into one
   * string — a report row, a CSV column, a transaction's `categoryName`.
   *
   * The workspace's and not the member's, because a shared workspace must not
   * show two people two different names for the same row: a report mailed
   * between them would not agree with itself.
   */
  locale: 'bn' | 'en';
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
