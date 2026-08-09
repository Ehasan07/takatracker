import { createHash } from 'node:crypto';
import * as argon2 from 'argon2';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * Argon2id parameters — OWASP's second recommended option (19 MiB, t=2, p=1).
 *
 * One definition, so a password set at signup, by a reset, and by a change from
 * Settings are all hashed identically; two would drift and the weaker one would
 * win silently. It lives here rather than in auth.service.ts because
 * AuthService now imports AccountService (to send the signup verification
 * mail), and AccountService needs these — importing them back out of
 * auth.service would close that loop into a cycle, and a cycle at module load
 * hands Nest an `undefined` class in `design:paramtypes`. This file imports
 * nothing from the folder, so it cannot take part in one.
 */
export const ARGON_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

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
