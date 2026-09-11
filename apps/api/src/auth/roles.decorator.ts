import { SetMetadata } from '@nestjs/common';
import type { MembershipRole } from '@prisma/client';

export const ROLES_KEY = 'hishab:roles';

/**
 * Which memberships may reach this route.
 *
 * Every other endpoint in this API is workspace-scoped and nothing more: any
 * member of a workspace can read anything in it, because a household ledger
 * shared between two people has no secrets from either of them. This decorator
 * exists for the handful of routes where that stops being true — a file that
 * lists every customer and supplier a shop has, with what each of them owes, is
 * the owner's to hand out, not a shop assistant's.
 *
 * Used with `RolesGuard`, which reads the role off the token rather than off
 * anything the client sends. A route with no decorator is unrestricted, so
 * adding the guard globally would change nothing until a route asks.
 */
export const Roles = (...roles: readonly MembershipRole[]) => SetMetadata(ROLES_KEY, roles);
