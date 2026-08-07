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
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const req = ctx.switchToHttp().getRequest<Request & { user: AuthUser }>();
    return req.user;
  },
);
