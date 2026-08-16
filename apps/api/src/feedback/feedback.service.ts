import { BadRequestException, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import type { FeedbackKind, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../auth/current-user.decorator';

/**
 * What a user came to tell us, and the operator's view of it.
 *
 * The whole module is two operations. That is not an early version of something
 * larger: a feedback tool that grows statuses, assignees and threads becomes a
 * ticketing system nobody staffs, and the half-answered ticket is worse for the
 * person who wrote in than a mailbox somebody actually reads.
 */

/**
 * The longest message we will store.
 *
 * Generous on purpose — the reports that are worth having are the long ones,
 * where somebody walks through what they did and what they expected — and
 * bounded because this endpoint is authenticated but otherwise cheap, and an
 * unbounded TEXT column reachable from a form is a way to fill a disk.
 *
 * The refusal names the limit and the length, because "too long" without a
 * number means retyping and guessing.
 */
export const MAX_MESSAGE_LENGTH = 4_000;

/**
 * How many one person may send in a rolling day.
 *
 * There are two separate ceilings here and they stop different things. The
 * `@Throttle` on the controller stops a burst — a stuck retry loop, a leaning
 * finger — and it is in-memory, per process, and lifted in tests. This one is
 * the table's own ceiling: it counts rows, so it survives a restart, several
 * API processes, and a client that spaces its writes out to sit under the
 * throttler exactly. Twenty is far past anything an honest day of using the app
 * produces, which is the number to pick when the cost of being wrong is
 * somebody's genuine third bug report being refused.
 */
export const MAX_PER_DAY = 20;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SubmitFeedback {
  kind: FeedbackKind;
  message: string;
  /** The path they were on. Already reduced to a path by the controller. */
  screen: string | null;
  userAgent: string | null;
}

/** One row as an operator reads it. */
export interface FeedbackRow {
  id: string;
  kind: FeedbackKind;
  message: string;
  screen: string | null;
  userAgent: string | null;
  createdAt: Date;
  workspaceId: string;
  userId: string;
  userEmail: string;
  userName: string;
}

@Injectable()
export class FeedbackService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * File one message.
   *
   * `user.email` and the name are copied onto the row rather than joined later.
   * See the schema note: there is no foreign key, because a complaint has to
   * outlive the account of whoever sent it, and a row that cannot say who wrote
   * it cannot be answered.
   */
  async submit(user: AuthUser, input: SubmitFeedback): Promise<{ id: string }> {
    const message = input.message.trim();
    /* Belt and braces with the zod schema on the controller. This is the only
       function that writes the table, so the invariant "no empty message" is
       stated where it is true rather than only where the request arrives —
       a second caller (a support tool, a script) would otherwise be able to
       write a blank row that the list screen renders as a mystery. */
    if (message.length === 0) {
      throw new BadRequestException('কিছু একটা লিখুন — খালি পাঠানো যাবে না');
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      throw new BadRequestException(
        `লেখাটি বড় হয়ে গেছে — সর্বোচ্চ ${MAX_MESSAGE_LENGTH} অক্ষর, আপনার লেখায় ${message.length}`,
      );
    }

    const sentToday = await this.prisma.feedback.count({
      where: { userId: user.id, createdAt: { gte: new Date(Date.now() - DAY_MS) } },
    });
    if (sentToday >= MAX_PER_DAY) {
      /* 429 rather than 403: this is "not now", not "not you", and the
         difference decides whether the person tries again tomorrow or concludes
         the feature is broken. The message says so in as many words, and it
         says where else to go — a ceiling that silences somebody with a real
         problem is a worse failure than the flood it prevents. */
      throw new HttpException(
        'আজকের মতো যথেষ্ট বার্তা পাঠানো হয়েছে। জরুরি কিছু হলে ইমেইল করুন, নাহলে কাল আবার চেষ্টা করুন।',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    /* The name is not on `AuthUser` — the membership lookup that builds it has
       no use for one — so it is read here. `select` and not the whole row: this
       service has no business holding a password hash. */
    const author = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { name: true },
    });

    return this.prisma.feedback.create({
      data: {
        workspaceId: user.workspaceId,
        userId: user.id,
        userEmail: user.email,
        userName: author?.name ?? '',
        kind: input.kind,
        message,
        screen: input.screen,
        userAgent: input.userAgent,
      },
      select: { id: true },
    });
  }

  /**
   * Everything that has come in, newest first.
   *
   * Cross-tenant by construction, which is why the only route that reaches it
   * is behind `SuperAdminGuard`. Paged with a cursor rather than an offset: the
   * table only ever grows at the end being read, and `skip` on a list somebody
   * is appending to shows the same row twice or skips one.
   */
  async list(query: {
    kind?: FeedbackKind;
    workspaceId?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ items: FeedbackRow[]; nextCursor: string | null }> {
    const take = Math.min(Math.max(query.limit ?? 50, 1), 100);

    const where: Prisma.FeedbackWhereInput = {};
    if (query.kind) where.kind = query.kind;
    if (query.workspaceId) where.workspaceId = query.workspaceId;

    const rows = await this.prisma.feedback.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: take + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    /* One row over the page size was fetched purely to answer "is there more?".
       A `count` would answer it too and would cost a second scan of a table
       that only grows. */
    const hasMore = rows.length > take;
    const items = hasMore ? rows.slice(0, take) : rows;

    return {
      items: items.map((row) => ({
        id: row.id,
        kind: row.kind,
        message: row.message,
        screen: row.screen,
        userAgent: row.userAgent,
        createdAt: row.createdAt,
        workspaceId: row.workspaceId,
        userId: row.userId,
        userEmail: row.userEmail,
        userName: row.userName,
      })),
      nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null,
    };
  }
}
