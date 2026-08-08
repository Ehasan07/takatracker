import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { EmailTokenPurpose } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * One-shot links sent by email.
 *
 * The rules, all of them load-bearing:
 *
 *  - 32 bytes of `crypto.randomBytes`, base64url. Same generator and same
 *    encoding as refresh tokens; no `Math.random`, no timestamps, no user id
 *    baked into the value.
 *  - Only the SHA-256 hash is ever written. A dumped database hands an attacker
 *    a column of hashes, not a column of working password-reset links.
 *  - Lookup is BY HASH. The plaintext is never used as a query key and is never
 *    compared against a stored secret, so there is no string-compare on a
 *    secret and nothing to time. The single index probe is on a value that is
 *    not itself a credential.
 *  - Single use. `usedAt` is stamped inside the same transaction that performs
 *    the effect, so two concurrent clicks cannot both win.
 *  - Rows survive being used. That is the only way to tell "already used" from
 *    "expired" from "never existed", and those are three different things to
 *    say to a person.
 */

export const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
export const RESET_TTL_MS = 60 * 60 * 1000;

/** One outbound mail per minute per user per purpose. */
export const RESEND_COOLDOWN_MS = 60 * 1000;

const TTL_BY_PURPOSE: Record<EmailTokenPurpose, number> = {
  VERIFY_EMAIL: VERIFY_TTL_MS,
  RESET_PASSWORD: RESET_TTL_MS,
};

export interface IssuedToken {
  /** The only time the plaintext exists. It goes into an email and is dropped. */
  token: string;
  expiresAt: Date;
}

export type TokenLookup =
  | { status: 'UNKNOWN' }
  | { status: 'USED'; id: string; userId: string }
  | { status: 'EXPIRED'; id: string; userId: string }
  | { status: 'VALID'; id: string; userId: string; expiresAt: Date };

@Injectable()
export class EmailTokenService {
  constructor(private readonly prisma: PrismaService) {}

  static hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  static ttlFor(purpose: EmailTokenPurpose): number {
    return TTL_BY_PURPOSE[purpose];
  }

  async issue(
    userId: string,
    purpose: EmailTokenPurpose,
    requestIp?: string | null,
  ): Promise<IssuedToken> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + TTL_BY_PURPOSE[purpose]);

    await this.prisma.emailToken.create({
      data: {
        userId,
        purpose,
        tokenHash: EmailTokenService.hash(token),
        expiresAt,
        requestIp: requestIp?.slice(0, 60) ?? null,
      },
    });

    return { token, expiresAt };
  }

  /**
   * Read-only classification. Deliberately separate from consumption so the
   * caller can decide what an expired or replayed link should say before
   * anything is mutated.
   */
  async inspect(token: string, purpose: EmailTokenPurpose): Promise<TokenLookup> {
    const row = await this.prisma.emailToken.findUnique({
      where: { tokenHash: EmailTokenService.hash(token) },
    });

    // A token issued for verification must not be redeemable as a reset token.
    if (!row || row.purpose !== purpose) return { status: 'UNKNOWN' };
    if (row.usedAt) return { status: 'USED', id: row.id, userId: row.userId };
    if (row.expiresAt.getTime() <= Date.now()) {
      return { status: 'EXPIRED', id: row.id, userId: row.userId };
    }
    return { status: 'VALID', id: row.id, userId: row.userId, expiresAt: row.expiresAt };
  }

  /**
   * Claim a token. Returns false if somebody (or a double-clicked button) got
   * there first: the `usedAt: null` in the where clause makes this an atomic
   * compare-and-set, so exactly one caller can act on a given link.
   */
  async claim(tokenId: string): Promise<boolean> {
    const { count } = await this.prisma.emailToken.updateMany({
      where: { id: tokenId, usedAt: null },
      data: { usedAt: new Date() },
    });
    return count === 1;
  }

  /**
   * Burn every other outstanding link of this purpose once one has done its
   * job. After a password is reset, an unused reset link mailed ten minutes
   * earlier must stop working — otherwise the reset does not actually close
   * the window it exists to close.
   */
  async invalidateOutstanding(
    userId: string,
    purpose: EmailTokenPurpose,
    exceptId?: string,
  ): Promise<void> {
    await this.prisma.emailToken.updateMany({
      where: {
        userId,
        purpose,
        usedAt: null,
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      data: { usedAt: new Date() },
    });
  }

  /**
   * True when this user asked for the same kind of link less than a minute ago.
   * Enforced against the database rather than an in-memory counter so it holds
   * across restarts and across API instances, and so it is per-account rather
   * than per-IP — a shared office NAT must not lock a colleague out.
   */
  async isCoolingDown(userId: string, purpose: EmailTokenPurpose): Promise<Date | null> {
    const last = await this.prisma.emailToken.findFirst({
      where: { userId, purpose },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (!last) return null;
    const readyAt = new Date(last.createdAt.getTime() + RESEND_COOLDOWN_MS);
    return readyAt.getTime() > Date.now() ? readyAt : null;
  }
}
