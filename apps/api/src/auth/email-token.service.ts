import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
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

/**
 * How long the six-digit code is good for, separately from the link.
 *
 * The link keeps its 24 hours because it is opened from an email client,
 * sometimes on another device and sometimes the next morning. A code is typed
 * by somebody who is already looking at the app, so a short window costs them
 * nothing and shrinks the guessing window a great deal.
 */
export const CODE_TTL_MS = 15 * 60 * 1000;

/**
 * Wrong guesses before a code is burnt.
 *
 * Six digits is a million values — plenty against a person, not much against a
 * script. The throttle on the route bounds the rate; this bounds the total, and
 * it is the one that makes a short numeric code safe to offer at all. Five is
 * enough for a mistyped digit twice over.
 */
export const MAX_CODE_ATTEMPTS = 5;

export interface IssuedToken {
  /** The only time the plaintext exists. It goes into an email and is dropped. */
  token: string;
  /** Six digits, for somebody who would rather type than leave the app. */
  code: string;
  expiresAt: Date;
}

export type CodeCheck =
  | { status: 'OK'; id: string; userId: string }
  | { status: 'NO_CODE' }
  | { status: 'EXPIRED' }
  | { status: 'USED' }
  | { status: 'LOCKED' }
  | { status: 'WRONG'; attemptsLeft: number };

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

  /**
   * Six digits, uniformly.
   *
   * `randomInt` rather than `Math.random()`: this is the whole secret for the
   * code path, and `Math.random()` is a PRNG whose output is predictable from
   * a few samples. Leading zeros are kept — "042931" is a valid code and
   * dropping the zero would both shrink the space and confuse the typist.
   */
  static sixDigits(): string {
    return String(randomInt(0, 1_000_000)).padStart(6, '0');
  }

  /**
   * Check a typed code against the newest outstanding one for this user.
   *
   * Looked up by user and purpose rather than by hash, because six digits
   * collide across accounts and a hash lookup would occasionally hand back
   * somebody else's row. The comparison is constant-time all the same: an
   * attacker who could time it would learn the code a digit at a time.
   *
   * A wrong guess is counted. At `MAX_CODE_ATTEMPTS` the row is burnt rather
   * than merely refused — leaving it alive would let the counter be dodged by
   * asking for a new code and going back to the old one.
   */
  async checkCode(userId: string, purpose: EmailTokenPurpose, code: string): Promise<CodeCheck> {
    const row = await this.prisma.emailToken.findFirst({
      where: { userId, purpose },
      orderBy: { createdAt: 'desc' },
    });
    if (!row?.codeHash) return { status: 'NO_CODE' };
    if (row.usedAt) return { status: 'USED' };
    if (row.attempts >= MAX_CODE_ATTEMPTS) return { status: 'LOCKED' };
    /* Two clocks: the row's own expiry, and the shorter one the code lives
     * under. The link may still be good long after the digits have stopped
     * being. */
    if (row.expiresAt.getTime() <= Date.now()) return { status: 'EXPIRED' };
    if (row.createdAt.getTime() + CODE_TTL_MS <= Date.now()) return { status: 'EXPIRED' };

    const given = Buffer.from(EmailTokenService.hash(code.trim()));
    const known = Buffer.from(row.codeHash);
    const ok = given.length === known.length && timingSafeEqual(given, known);

    if (!ok) {
      const updated = await this.prisma.emailToken.update({
        where: { id: row.id },
        data: { attempts: { increment: 1 } },
        select: { attempts: true },
      });
      return { status: 'WRONG', attemptsLeft: Math.max(0, MAX_CODE_ATTEMPTS - updated.attempts) };
    }

    return { status: 'OK', id: row.id, userId: row.userId };
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
    const code = EmailTokenService.sixDigits();
    const expiresAt = new Date(Date.now() + TTL_BY_PURPOSE[purpose]);

    await this.prisma.emailToken.create({
      data: {
        userId,
        purpose,
        tokenHash: EmailTokenService.hash(token),
        codeHash: EmailTokenService.hash(code),
        expiresAt,
        requestIp: requestIp?.slice(0, 60) ?? null,
      },
    });

    return { token, code, expiresAt };
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
