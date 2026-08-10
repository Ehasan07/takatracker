import { Injectable, NotFoundException } from '@nestjs/common';
import { searchTokens } from '@hishab/core';
import { Prisma } from '@prisma/client';
import type { MailFolder } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../transactions/transactions.service';
import type { ListMailMessagesQuery } from './mail-accounts.controller';

/**
 * Reading stored mail.
 *
 * Every method here is a database read and nothing else — no mail server is
 * contacted from this file, ever. That is the point of the split: a mailbox is
 * slow and rate-limited, a `SELECT` is not, and the screens have to be built on
 * the one that is fast.
 *
 * **The tenant guard is the whole file.** `workspaceId` comes from the JWT on
 * every query, including the single-message read, and `accountId` from the query
 * string is only ever an extra `AND` on top of it — a foreign account id
 * therefore narrows the result to nothing rather than widening it to somebody
 * else's inbox. There is no code path here that takes a workspace from a
 * parameter, and `MailMessage.workspaceId` is written by the worker from the
 * account row, so the column being asked about cannot have been influenced by a
 * caller either.
 */

const NOT_FOUND = 'বার্তাটি পাওয়া যায়নি';

/**
 * A soft-deleted mailbox's messages are already gone (`MailAccountsService.remove`
 * deletes them), so this predicate should never exclude anything. It is here as
 * the second lock: if a future code path soft-deletes an account without
 * clearing its mail, that mail must not keep appearing in somebody's inbox.
 */
const liveAccount = { mailAccount: { deletedAt: null } } as const;

/** The list view. No `body` — see `listSelect`. */
const listSelect = {
  id: true,
  mailAccountId: true,
  folder: true,
  externalId: true,
  fromAddress: true,
  toAddress: true,
  subject: true,
  snippet: true,
  receivedAt: true,
  isRead: true,
  createdAt: true,
} satisfies Prisma.MailMessageSelect;

const detailSelect = { ...listSelect, body: true } satisfies Prisma.MailMessageSelect;

type ListRow = Prisma.MailMessageGetPayload<{ select: typeof listSelect }>;
type DetailRow = Prisma.MailMessageGetPayload<{ select: typeof detailSelect }>;

export interface MailMessageView {
  id: string;
  mailAccountId: string;
  folder: MailFolder;
  externalId: string;
  fromAddress: string | null;
  toAddress: string | null;
  subject: string | null;
  snippet: string | null;
  receivedAt: string;
  isRead: boolean;
  createdAt: string;
}

export interface MailMessageDetailView extends MailMessageView {
  /** Plain text, truncated on write. Null when the provider gave us no text part. */
  body: string | null;
}

/**
 * The same ceiling the transaction search uses, for the same reason: one query
 * must not plan several hundred predicates. Tokens are ANDed, so truncating
 * widens the result slightly rather than hiding something the user asked for.
 */
const MAX_SEARCH_TOKENS = 8;

@Injectable()
export class MailMessagesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The tenant's mail, newest first, cursor-paginated.
   *
   * Ordered by `receivedAt desc, id desc` — the index on
   * `(workspaceId, folder, receivedAt desc)` covers the common filtered case, and
   * the `id` tiebreak is what makes the cursor stable when a sweep stores twenty
   * messages with the same second on them. `take: limit + 1` is how "is there
   * more" is answered without a second count, the same as everywhere else here.
   *
   * `body` is deliberately not selected. Fifty full email bodies is a multi-
   * megabyte response for a list where each row shows two lines; the body is
   * what `findOne` is for.
   */
  async list(
    ctx: TenantContext,
    query: ListMailMessagesQuery,
  ): Promise<{ items: MailMessageView[]; nextCursor: string | null }> {
    const where: Prisma.MailMessageWhereInput = {
      workspaceId: ctx.workspaceId,
      ...liveAccount,
      ...(query.folder ? { folder: query.folder } : {}),
      ...(query.accountId ? { mailAccountId: query.accountId } : {}),
      ...MailMessagesService.searchWhere(query.q),
    };

    const rows = await this.prisma.mailMessage.findMany({
      where,
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      select: listSelect,
    });

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;

    return {
      items: page.map(MailMessagesService.present),
      nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
    };
  }

  /** One message, with its body. Another tenant's id is a 404, not a 403. */
  async findOne(ctx: TenantContext, id: string): Promise<MailMessageDetailView> {
    const row = await this.prisma.mailMessage.findFirst({
      where: { id, workspaceId: ctx.workspaceId, ...liveAccount },
      select: detailSelect,
    });
    if (!row) throw new NotFoundException(NOT_FOUND);
    return MailMessagesService.presentDetail(row);
  }

  /**
   * Translate `q` into a `WHERE`: every token must appear somewhere on the row.
   *
   * ANDed tokens, ORed fields — `bkash statement` finds a message with `bKash` in
   * the sender and `Statement` in the subject, which a single `contains` over one
   * column could not. Tokenisation comes from `@hishab/core` so that the split
   * (NFC, case-folded, punctuation separated) matches what every other search
   * surface in this product does.
   *
   * ## What this is not
   *
   * It is a substring filter, not the Banglish matcher the loan and transaction
   * lists use. That matcher works by loading a small list — a workspace's
   * categories, its people — and folding both sides in TypeScript; a mailbox is
   * not a small list and cannot be loaded. `khabar` will not find `খাবার` in a
   * subject line, and nothing short of a denormalised fold column or Postgres
   * full-text would change that. Saying so plainly is better than a search that
   * silently fails on half the queries a Bangladeshi user types.
   *
   * The body is not searched either. It is up to 64 KB a row with no index that
   * can help, and `ILIKE '%…%'` across a tenant's whole mailbox is a sequential
   * scan over the largest column in the table.
   */
  private static searchWhere(raw: string | undefined): Prisma.MailMessageWhereInput {
    if (!raw) return {};
    const tokens = searchTokens(raw).slice(0, MAX_SEARCH_TOKENS);
    /* A query that normalises to nothing (`q=###`, `q=৳`) is *no query*, not a
     * query that matches nothing — core §4.1 treats it that way and the two must
     * not disagree. */
    if (tokens.length === 0) return {};

    return {
      AND: tokens.map((token) => {
        const contains = { contains: escapeLike(token), mode: 'insensitive' } as const;
        return {
          OR: [
            { subject: contains },
            { fromAddress: contains },
            { toAddress: contains },
            { snippet: contains },
          ],
        };
      }),
    };
  }

  private static present(row: ListRow): MailMessageView {
    return {
      id: row.id,
      mailAccountId: row.mailAccountId,
      folder: row.folder,
      externalId: row.externalId,
      fromAddress: row.fromAddress,
      toAddress: row.toAddress,
      subject: row.subject,
      snippet: row.snippet,
      receivedAt: row.receivedAt.toISOString(),
      isRead: row.isRead,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private static presentDetail(row: DetailRow): MailMessageDetailView {
    return { ...MailMessagesService.present(row), body: row.body };
  }
}

/**
 * Escape the LIKE metacharacters before a token reaches `contains`.
 *
 * Prisma interpolates `contains` straight into `ILIKE '%' || $1 || '%'`, so an
 * unescaped `%` is a wildcard: searching `50%` would return the whole mailbox
 * and `_` would match any single character. Postgres's default LIKE escape is
 * the backslash and the Prisma filter exposes no ESCAPE clause, so prefixing the
 * three metacharacters is both necessary and sufficient.
 *
 * TODO(main): identical to `escapeLike` in transactions/transactions.service.ts,
 * which does not export it. Two copies of four characters of regex is the lesser
 * evil against editing a file this change does not own; fold them into
 * `common/` when something touches both.
 */
function escapeLike(token: string): string {
  return token.replace(/[\\%_]/g, '\\$&');
}
