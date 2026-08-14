import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { StatementKind } from '@prisma/client';
import { toLocalDateString } from '@hishab/shared';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../auth/current-user.decorator';

/**
 * Links to a statement that somebody outside the app can open.
 *
 * ## The link is the credential
 *
 * There is no login on the far side, and there should not be: a relative you
 * lent money to, or an insurer you pay a premium to, should not need an account
 * in a product they are not a customer of. Everything else here follows from
 * that one decision.
 *
 * - **It expires.** Not optionally. A credential with no end is a credential
 *   somebody will still be holding in two years.
 * - **It can be taken back**, in one tap, and the row stays so the owner can
 *   still see it existed.
 * - **Only the hash is stored**, exactly as with refresh and email tokens. A
 *   leaked backup must not hand anybody a working link. The plaintext exists
 *   once, in the response that creates it.
 * - **It cannot widen itself.** The date window lives in this row, not in the
 *   URL, so a link to March cannot be edited into a link to everything. That is
 *   the whole reason the window is stored rather than passed.
 */

/** Long enough that guessing is not a strategy; `base64url` so it survives a URL. */
const TOKEN_BYTES = 32;

/** The default life of a link, and the longest one that can be asked for. */
export const DEFAULT_SHARE_DAYS = 30;
export const MAX_SHARE_DAYS = 365;

export interface CreateShareInput {
  kind: StatementKind;
  subjectId: string;
  /** `YYYY-MM-DD`. Both absent means the whole life of the subject. */
  from?: string;
  to?: string;
  /** The owner's own note — "for BRAC Bank", "March quarter". */
  label?: string;
  expiresInDays?: number;
}

export interface ShareView {
  id: string;
  kind: StatementKind;
  subjectId: string;
  from: string | null;
  to: string | null;
  label: string | null;
  expiresAt: string;
  revokedAt: string | null;
  viewCount: number;
  lastViewedAt: string | null;
  createdAt: string;
}

/** What the public route needs to know before it reads anything. */
export interface ResolvedShare {
  id: string;
  workspaceId: string;
  kind: StatementKind;
  subjectId: string;
  from: string | null;
  to: string | null;
  /**
   * When the link dies, shown to the reader.
   *
   * They are holding it already, so this gives nothing away — and it is the
   * difference between somebody printing the statement now and finding a dead
   * link the week their insurer asks for it.
   */
  expiresAt: string;
}

@Injectable()
export class StatementShareService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private static hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /**
   * Create a link, and hand back the only copy of its token.
   *
   * The subject is proved to belong to the caller's workspace *before* a row is
   * written. Skipping that would let somebody mint a link to a loan they cannot
   * see — the tenancy check has to happen where the link is made, because the
   * public route has no user to check against.
   */
  async create(user: AuthUser, input: CreateShareInput): Promise<ShareView & { url: string }> {
    await this.assertSubjectIsTheirs(user.workspaceId, input.kind, input.subjectId);

    /* A calendar date, not an instant.
     *
     * `fromLocalDateString` resolves a date to the moment it begins in a given
     * zone, which is right for filtering a ledger and wrong for a `DATE`
     * column: midnight on 1 April in Dhaka is the evening of 31 March in UTC,
     * and Postgres truncates that to the 31st. A statement headed with the
     * wrong month is not a small bug.
     *
     * So the day is stored as the day, at midnight UTC, and read back in UTC.
     * The conversion to instants happens where it belongs — in the query that
     * selects the rows, against the workspace's own zone. */
    const from = calendarDate(input.from);
    const to = calendarDate(input.to);
    if (from && to && from > to) {
      throw new BadRequestException('শুরুর তারিখ শেষ তারিখের পরে হতে পারে না');
    }

    const days = Math.min(MAX_SHARE_DAYS, Math.max(1, input.expiresInDays ?? DEFAULT_SHARE_DAYS));
    const token = randomBytes(TOKEN_BYTES).toString('base64url');

    const row = await this.prisma.statementShare.create({
      data: {
        workspaceId: user.workspaceId,
        kind: input.kind,
        subjectId: input.subjectId,
        fromDate: from,
        toDate: to,
        tokenHash: StatementShareService.hash(token),
        label: input.label?.trim() || null,
        expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000),
        createdByUserId: user.id,
      },
    });

    /* Awaited, not emitted. Handing a customer's figures to somebody outside
     * the workspace is the kind of thing that has to be answerable later, and a
     * record that was dropped because the request finished first is no record.
     */
    await this.audit.record({
      workspaceId: user.workspaceId,
      actorUserId: user.id,
      action: 'statement.shared',
      entity: 'StatementShare',
      entityId: row.id,
      after: {
        kind: row.kind,
        subjectId: row.subjectId,
        from: input.from ?? null,
        to: input.to ?? null,
        expiresAt: row.expiresAt.toISOString(),
      },
    });

    return { ...this.present(row), url: `/s/${token}` };
  }

  /** Every link ever made for one subject, newest first. Never the tokens. */
  async list(user: AuthUser, kind: StatementKind, subjectId: string): Promise<ShareView[]> {
    const rows = await this.prisma.statementShare.findMany({
      where: { workspaceId: user.workspaceId, kind, subjectId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return rows.map((row) => this.present(row));
  }

  /**
   * Take a link back.
   *
   * The row stays. Deleting it would erase the fact that a statement was once
   * shared, which is exactly what the audit trail exists to keep.
   */
  async revoke(user: AuthUser, id: string): Promise<ShareView> {
    const existing = await this.prisma.statementShare.findFirst({
      where: { id, workspaceId: user.workspaceId },
    });
    if (!existing) throw new NotFoundException('লিংকটি পাওয়া যায়নি');

    const row = existing.revokedAt
      ? existing
      : await this.prisma.statementShare.update({
          where: { id },
          data: { revokedAt: new Date() },
        });

    if (!existing.revokedAt) {
      await this.audit.record({
        workspaceId: user.workspaceId,
        actorUserId: user.id,
        action: 'statement.share_revoked',
        entity: 'StatementShare',
        entityId: row.id,
        before: { revokedAt: null },
        after: { revokedAt: row.revokedAt?.toISOString() ?? null },
      });
    }

    return this.present(row);
  }

  /**
   * Turn a token into the one thing it is allowed to read.
   *
   * Returns null for every failure — unknown, expired, revoked — and says
   * nothing about which. The page shows one sentence for all three: telling a
   * stranger "this link existed but has expired" confirms that a statement was
   * shared with somebody, which is not theirs to learn.
   */
  async resolve(token: string): Promise<ResolvedShare | null> {
    const hash = StatementShareService.hash(token);
    const row = await this.prisma.statementShare.findUnique({ where: { tokenHash: hash } });
    if (!row) return null;

    /* The lookup is by a hash of the token, so this comparison is redundant
     * against the database — it is here so the *shape* of the check is the same
     * as every other token in this codebase, and stays right if the lookup ever
     * changes. */
    const given = Buffer.from(hash);
    const known = Buffer.from(row.tokenHash);
    if (given.length !== known.length || !timingSafeEqual(given, known)) return null;

    if (row.revokedAt) return null;
    if (row.expiresAt.getTime() <= Date.now()) return null;

    /* Counted on every read, and not awaited: the reader is waiting for a
     * statement, not for a counter. */
    void this.prisma.statementShare
      .update({
        where: { id: row.id },
        data: { viewCount: { increment: 1 }, lastViewedAt: new Date() },
      })
      .catch(() => undefined);

    return {
      id: row.id,
      workspaceId: row.workspaceId,
      kind: row.kind,
      subjectId: row.subjectId,
      from: row.fromDate ? toLocalDateString(row.fromDate, 'UTC') : null,
      to: row.toDate ? toLocalDateString(row.toDate, 'UTC') : null,
      expiresAt: row.expiresAt.toISOString(),
    };
  }

  /**
   * Prove the subject is this workspace's before a link to it can exist.
   *
   * The public route has no user, so this is the only place tenancy can be
   * checked. A missing subject is a 404 rather than a 403 for the usual reason:
   * "not yours" and "not there" must look the same from outside.
   */
  private async assertSubjectIsTheirs(
    workspaceId: string,
    kind: StatementKind,
    subjectId: string,
  ): Promise<void> {
    const where = { id: subjectId, workspaceId, deletedAt: null };
    const found =
      kind === 'PERSON'
        ? await this.prisma.person.count({ where })
        : kind === 'LOAN'
          ? await this.prisma.loan.count({ where })
          : kind === 'SAVINGS'
            ? await this.prisma.savingsPlan.count({ where })
            : kind === 'GROUP'
              ? await this.prisma.splitGroup.count({ where })
              : await this.prisma.insurancePolicy.count({ where });

    if (found !== 1) throw new NotFoundException('যেটির স্টেটমেন্ট চাইছেন সেটি পাওয়া যায়নি');
  }

  private present(row: {
    id: string;
    kind: StatementKind;
    subjectId: string;
    fromDate: Date | null;
    toDate: Date | null;
    label: string | null;
    expiresAt: Date;
    revokedAt: Date | null;
    viewCount: number;
    lastViewedAt: Date | null;
    createdAt: Date;
  }): ShareView {
    return {
      id: row.id,
      kind: row.kind,
      subjectId: row.subjectId,
      /* Stored as a DATE, so it is read back in UTC and not in the workspace's
         zone — a date column has no time to shift. */
      from: row.fromDate ? toLocalDateString(row.fromDate, 'UTC') : null,
      to: row.toDate ? toLocalDateString(row.toDate, 'UTC') : null,
      label: row.label,
      expiresAt: row.expiresAt.toISOString(),
      revokedAt: row.revokedAt?.toISOString() ?? null,
      viewCount: row.viewCount,
      lastViewedAt: row.lastViewedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

/**
 * `YYYY-MM-DD` as midnight UTC, so a `DATE` column stores the day that was
 * typed rather than whatever day that instant happens to be in UTC.
 */
function calendarDate(iso: string | undefined): Date | null {
  if (!iso) return null;
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}
