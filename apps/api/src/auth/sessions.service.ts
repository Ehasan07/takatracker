import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { RefreshToken } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { primaryWorkspaceId, sha256Hex } from './auth.helpers';

/**
 * "Where am I logged in?", and the ability to answer "not there any more".
 *
 * A session is a refresh-token *family*, not a row: rotation writes a new row
 * on every refresh, so a single phone that has been open for a month is dozens
 * of rows sharing one `familyId`. Grouping by family is what makes the list
 * mean what a user thinks it means.
 */

export interface SessionSummary {
  /** The stable handle for a session. Not a secret — it authorises nothing. */
  familyId: string;
  deviceId: string | null;
  userAgent: string | null;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  /** True for the session making this request. */
  current: boolean;
}

export interface SessionRequestContext {
  /** The caller's raw refresh token, from the cookie or the request body. */
  refreshToken?: string;
  /** Fallback identity when no refresh token rides along with the request. */
  deviceId?: string;
  ip?: string;
  userAgent?: string;
}

/** Enough history for any real account; stops a pathological row count. */
const MAX_ROWS = 500;

@Injectable()
export class SessionsService {
  private readonly logger = new Logger(SessionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(userId: string, ctx: SessionRequestContext = {}): Promise<SessionSummary[]> {
    const rows = await this.loadLiveRows(userId);
    const currentFamilyId = this.resolveCurrentFamily(rows, ctx);

    return this.groupIntoFamilies(rows)
      .map((family) => ({
        // Never the token, never `tokenHash`, never `replacedBy` — the whole
        // point of storing only hashes is undone by an endpoint that returns
        // them. A session list is metadata about credentials, not credentials.
        familyId: family.familyId,
        deviceId: family.live.deviceId,
        userAgent: family.live.userAgent,
        createdAt: family.createdAt.toISOString(),
        lastUsedAt: family.lastUsedAt.toISOString(),
        expiresAt: family.live.expiresAt.toISOString(),
        current: family.familyId === currentFamilyId,
      }))
      .sort((a, b) =>
        a.current === b.current ? b.lastUsedAt.localeCompare(a.lastUsedAt) : a.current ? -1 : 1,
      );
  }

  /** Revoke one family. Scoped to the caller, so a guessed id gets a 404. */
  async revoke(
    userId: string,
    familyId: string,
    ctx: SessionRequestContext = {},
  ): Promise<{ familyId: string; revoked: number; wasCurrent: boolean }> {
    const rows = await this.loadLiveRows(userId);
    const wasCurrent = this.resolveCurrentFamily(rows, ctx) === familyId;

    // `userId` in the where clause is the authorisation check: one user cannot
    // reach another's family even knowing its id.
    const { count } = await this.prisma.refreshToken.updateMany({
      where: { userId, familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    if (count === 0) {
      throw new NotFoundException('এই সেশনটি পাওয়া যায়নি বা আগেই বাতিল করা হয়েছে');
    }

    await this.recordRevocation(userId, count, 1, ctx);
    return { familyId, revoked: count, wasCurrent };
  }

  /**
   * Revoke everything except the caller's own session.
   *
   * When the current session cannot be identified — no refresh cookie, no
   * token in the body, no matching device id — this revokes *everything*,
   * including the caller. That is deliberate. This button is pressed by
   * someone who thinks another person is in their account; refusing to act
   * because we could not work out which session is theirs would be the worst
   * possible answer. Logging themselves out is a cost they can pay.
   */
  async revokeOthers(
    userId: string,
    ctx: SessionRequestContext = {},
  ): Promise<{
    revoked: number;
    currentSessionRevoked: boolean;
    message: string;
  }> {
    const rows = await this.loadLiveRows(userId);
    const currentFamilyId = this.resolveCurrentFamily(rows, ctx);
    const families = this.groupIntoFamilies(rows).length;

    const { count } = await this.prisma.refreshToken.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(currentFamilyId ? { familyId: { not: currentFamilyId } } : {}),
      },
      data: { revokedAt: new Date() },
    });

    const otherFamilies = currentFamilyId ? Math.max(0, families - 1) : families;
    await this.recordRevocation(userId, count, otherFamilies, ctx);

    if (!currentFamilyId) {
      this.logger.warn(`revoke-others for user ${userId} could not identify the caller's session`);
      return {
        revoked: count,
        currentSessionRevoked: true,
        message:
          'বর্তমান সেশনটি শনাক্ত করা যায়নি, তাই নিরাপত্তার জন্য সব সেশন বাতিল করা হয়েছে। আবার লগইন করুন।',
      };
    }

    return {
      revoked: count,
      currentSessionRevoked: false,
      message:
        otherFamilies > 0
          ? 'অন্য সব ডিভাইস থেকে লগআউট করা হয়েছে। এই ডিভাইসটি লগইন থাকবে।'
          : 'অন্য কোনো সক্রিয় সেশন ছিল না।',
    };
  }

  // --- internals -------------------------------------------------------------

  /** Rows that have not been revoked. Used rows stay: they carry the history. */
  private loadLiveRows(userId: string): Promise<RefreshToken[]> {
    return this.prisma.refreshToken.findMany({
      where: { userId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      take: MAX_ROWS,
    });
  }

  private groupIntoFamilies(rows: RefreshToken[]): Array<{
    familyId: string;
    live: RefreshToken;
    createdAt: Date;
    lastUsedAt: Date;
  }> {
    const now = Date.now();
    const byFamily = new Map<string, RefreshToken[]>();
    for (const row of rows) {
      const bucket = byFamily.get(row.familyId);
      if (bucket) bucket.push(row);
      else byFamily.set(row.familyId, [row]);
    }

    const families: Array<{
      familyId: string;
      live: RefreshToken;
      createdAt: Date;
      lastUsedAt: Date;
    }> = [];

    for (const [familyId, group] of byFamily) {
      // Exactly one row per family is redeemable: unused and unexpired. Without
      // it the family is dead — logged out, or simply timed out — and does not
      // belong in a list of places you are signed in.
      const live = group.find((r) => !r.usedAt && r.expiresAt.getTime() > now);
      if (!live) continue;

      let createdAt = live.createdAt;
      let lastUsedAt = live.createdAt;
      for (const row of group) {
        if (row.createdAt < createdAt) createdAt = row.createdAt;
        const touched = row.usedAt ?? row.createdAt;
        if (touched > lastUsedAt) lastUsedAt = touched;
      }

      families.push({ familyId, live, createdAt, lastUsedAt });
    }

    return families;
  }

  /**
   * Which family is making this request.
   *
   * The access token carries no family id, so the refresh token is the only
   * exact answer — and it is matched by hash, never by comparing plaintext to
   * anything stored. It may well be an already-rotated row, which is fine: the
   * family is what we want. The device-id header is a soft fallback for the
   * mobile client, which does not send the refresh token on ordinary calls.
   */
  private resolveCurrentFamily(rows: RefreshToken[], ctx: SessionRequestContext): string | null {
    if (ctx.refreshToken) {
      const hash = sha256Hex(ctx.refreshToken);
      const match = rows.find((r) => r.tokenHash === hash);
      if (match) return match.familyId;
    }

    if (ctx.deviceId) {
      // `rows` is newest-first, so this picks the most recent family on that
      // device. A guess, and only ever used to draw a "this device" label.
      const match = rows.find((r) => r.deviceId === ctx.deviceId);
      if (match) return match.familyId;
    }

    return null;
  }

  private async recordRevocation(
    userId: string,
    rowCount: number,
    familyCount: number,
    ctx: SessionRequestContext,
  ): Promise<void> {
    const workspaceId = await primaryWorkspaceId(this.prisma, userId);
    if (!workspaceId) return;
    this.audit.emit({
      workspaceId,
      actorUserId: userId,
      action: 'auth.session_revoked',
      entity: 'RefreshToken',
      after: { families: familyCount, tokens: rowCount },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  }
}
