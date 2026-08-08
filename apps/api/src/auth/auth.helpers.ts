import { createHash } from 'node:crypto';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * The one hashing shape used for every bearer secret in this folder: refresh
 * tokens, verification links, reset links. Same digest, same encoding, so a
 * lookup is always by hash and the plaintext is never a query key.
 */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * The workspace an audit event for this person should be filed against.
 *
 * The unauthenticated flows — verify/confirm, password/forgot, password/reset —
 * still have to record what happened, and `AuditEvent.workspaceId` is required.
 * Same ordering as `AuthService.defaultWorkspace`: the one they own, else the
 * oldest they belong to.
 *
 * Returns null rather than throwing. An account with no live workspace is an
 * odd state, but losing the audit line is a better outcome than a password
 * reset that 500s.
 */
export async function primaryWorkspaceId(
  prisma: PrismaService,
  userId: string,
): Promise<string | null> {
  const membership = await prisma.membership.findFirst({
    where: { userId, status: 'ACTIVE', workspace: { deletedAt: null } },
    orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
    select: { workspaceId: true },
  });
  return membership?.workspaceId ?? null;
}
