import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  assertBalanced,
  bodyHashOf,
  createRegistry,
  expandSimpleTransaction,
  REVIEW_THRESHOLD,
  type EntryDraft,
} from '@hishab/core';
import { fromLocalDateString, toLocalDateString } from '@hishab/shared';
import { Prisma } from '@prisma/client';
import type { DraftStatus, IngestionChannel, TransactionSource } from '@prisma/client';
import { AccountsService } from '../accounts/accounts.service';
import { AuditService } from '../audit/audit.service';
import { minorToNumber } from '../common/bigint-json';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { CardRemindersService } from '../notifications/card-reminders.service';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../transactions/transactions.service';
import type {
  AcceptDraftInput,
  ListDraftsQuery,
  RejectDraftInput,
  WebhookBody,
} from './ingestion.controller';

/*
 * Audit actions emitted below, all three already present in AUDIT_ACTIONS
 * (../audit/audit.service.ts) and so type-checked rather than cast:
 *   'ingestion.message_received', 'ingestion.draft_accepted',
 *   'ingestion.draft_rejected'
 */

/**
 * Messages in, drafts out.
 *
 * **Nothing a parser produces may reach the ledger without a human accepting
 * it.** That is not a guideline here, it is the shape of the module: the
 * webhook writes an `IngestionMessage` and a `TransactionDraft` and stops. The
 * only code path in this file that creates a `Transaction` is `accept`, which
 * is behind a JWT, takes the reviewer's own overrides, and stamps
 * `sourceDraftId` so the entry can always be traced back to the text that
 * proposed it. A parser that is wrong costs somebody a moment reading a screen;
 * a parser that is wrong *and* trusted costs them their books.
 *
 * Three more things hold this together:
 *
 *  - **The raw body is stored exactly as received.** Not trimmed, not
 *    normalised, not masked. A parser that gets something wrong can only be
 *    fixed against the text that broke it, and the evidence spans on the draft
 *    are offsets into that text.
 *  - **A retry must never double anybody's books.** `IngestionMessage` is
 *    unique on `(workspaceId, bodyHash)` and the hash normalises away the
 *    whitespace and case that redelivery churns. A duplicate is answered 200
 *    with `duplicate: true` and nothing is written.
 *  - **A draft is applied at most once.** The accept path claims the draft with
 *    a conditional update inside the same transaction that creates the entry,
 *    so two taps on a slow connection produce one transaction and one Bengali
 *    error, not two entries.
 */

// --- the parser registry -----------------------------------------------------

/**
 * The parsers this deployment knows about, most specific first.
 *
 * Empty on purpose. Bank and wallet parsers are M8 and they wait on real
 * redacted samples; until then every message goes to the generic reader, which
 * reports low confidence when it is guessing. Adding bKash is one new file in
 * `packages/core` and one entry in this array — nothing else in this service
 * changes.
 */
const REGISTRY = createRegistry([]);

// --- webhook authentication --------------------------------------------------

/** Which workspace the forwarder is posting for. */
export const INGEST_WORKSPACE_HEADER = 'x-hishab-workspace';

/** The per-workspace shared secret. */
export const INGEST_SECRET_HEADER = 'x-hishab-ingest-secret';

/**
 * Domain separator for the derived secret. Bump the version if the derivation
 * ever changes: every workspace's webhook secret changes with it, and every
 * forwarder has to be reconfigured, so it must be a deliberate act.
 */
const SECRET_PURPOSE = 'hishab.ingest.webhook.v1';

/**
 * One message for every way authentication can fail — bad secret, unknown
 * workspace, missing header, suspended workspace. Distinguishing them would let
 * anyone with the endpoint enumerate workspace ids.
 */
export const INGEST_UNAUTHORISED = 'ওয়েবহুক সিক্রেট মেলেনি';

const ALREADY_APPLIED = 'এই খসড়াটি আগেই লেনদেন হিসেবে যোগ করা হয়েছে';

const CURRENCY = 'BDT';

const APP_URL = process.env.API_PUBLIC_URL ?? `http://localhost:${process.env.API_PORT ?? 4000}`;

// --- views -------------------------------------------------------------------

export interface IngestResult {
  /** The `IngestionMessage` id — the same one on a replay. */
  id: string;
  duplicate: boolean;
  /** The draft this message produced, or the existing one on a replay. */
  draftId: string | null;
}

export interface DraftMessageView {
  id: string;
  channel: IngestionChannel;
  sender: string | null;
  receivedAt: string;
  /** Exactly as it arrived. This is what the "মূল বার্তা দেখুন" expander shows. */
  body: string;
}

export interface DraftView {
  id: string;
  status: DraftStatus;
  /** `YYYY-MM-DD` in the workspace's timezone. */
  date: string | null;
  amountMinor: number | null;
  direction: 'IN' | 'OUT' | null;
  payee: string | null;
  accountId: string | null;
  categoryId: string | null;
  /** 0–100. See `scoreConfidence` in @hishab/core. */
  confidence: number;
  /** True below `REVIEW_THRESHOLD`: something was guessed, so ask before applying. */
  needsReview: boolean;
  /** Field name → the exact substring of the body it was read from. */
  evidence: Record<string, string>;
  parserName: string | null;
  transactionId: string | null;
  reviewedAt: string | null;
  createdAt: string;
  message: DraftMessageView | null;
}

export interface MessageDetailView extends DraftMessageView {
  bodyHash: string;
  parserName: string | null;
  /** Whatever the parser produced, verbatim, for debugging a bad parse. */
  parsed: Prisma.JsonValue | null;
  createdAt: string;
  draftIds: string[];
}

export interface WebhookConfigView {
  /** False until INGESTION_WEBHOOK_SECRET is set on the server. */
  configured: boolean;
  url: string;
  workspaceHeader: string;
  workspaceId: string;
  secretHeader: string;
  /** Null when the server has no root secret configured. */
  secret: string | null;
}

// --- local helpers -----------------------------------------------------------

const draftInclude = {
  message: {
    select: {
      id: true,
      channel: true,
      sender: true,
      receivedAt: true,
      body: true,
      parserName: true,
    },
  },
} satisfies Prisma.TransactionDraftInclude;

type DraftRow = Prisma.TransactionDraftGetPayload<{ include: typeof draftInclude }>;

/** `undefined` is not JSON. A round-trip drops absent fields rather than storing nulls for them. */
function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function entryData(
  entry: EntryDraft,
  workspaceId: string,
): Prisma.LedgerEntryCreateWithoutTransactionInput {
  return {
    workspace: { connect: { id: workspaceId } },
    account: { connect: { id: entry.accountId } },
    category: entry.categoryId ? { connect: { id: entry.categoryId } } : undefined,
    amountMinor: BigInt(entry.amountMinor),
    direction: entry.direction,
    currency: entry.currency,
    fxRate: entry.fxRate,
  };
}

@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountsService,
    private readonly entitlements: EntitlementsService,
    private readonly cardReminders: CardRemindersService,
    private readonly audit: AuditService,
  ) {}

  // --- webhook authentication ------------------------------------------------

  /**
   * The workspace's webhook secret, derived rather than stored.
   *
   *     secret = base64url( HMAC-SHA256( INGESTION_WEBHOOK_SECRET,
   *                                      "hishab.ingest.webhook.v1:<workspaceId>" ) )
   *
   * `Workspace` has no column for this and adding one was not in scope, so it
   * is derived. That is a deliberate trade with two consequences worth stating
   * plainly rather than discovering later:
   *
   *  - **Rotation is per-deployment, not per-workspace.** Changing the root env
   *    var changes every workspace's secret at once. `INGESTION_WEBHOOK_SECRET_PREVIOUS`
   *    exists so the old value keeps working while forwarders are updated; both
   *    are checked, and both comparisons always run.
   *  - **A single leaked root secret is every workspace's secret.** The proper
   *    fix is a per-workspace `webhookSecretHash` column with generate / rotate
   *    / revoke (spec §4.2), which is a migration and belongs with the settings
   *    screen that drives it.
   *
   * Returns null when the server has no root secret. Nothing is derived from a
   * default — a default would mean every deployment on earth shares one key.
   */
  webhookSecretFor(
    workspaceId: string,
    root = process.env.INGESTION_WEBHOOK_SECRET,
  ): string | null {
    if (!root) return null;
    return createHmac('sha256', root)
      .update(`${SECRET_PURPOSE}:${workspaceId}`)
      .digest('base64url');
  }

  /**
   * Constant time, always.
   *
   * `timingSafeEqual` throws on a length mismatch and returning early on length
   * would leak it, so both sides are hashed first: the digests are always 32
   * bytes and are equal exactly when the inputs are.
   */
  private static equalsInConstantTime(a: string, b: string): boolean {
    const left = createHash('sha256').update(a, 'utf8').digest();
    const right = createHash('sha256').update(b, 'utf8').digest();
    return timingSafeEqual(left, right);
  }

  /**
   * Checked before anything touches the database, so a wrong secret costs one
   * HMAC and never a query — there is no timing difference between a real
   * workspace id and an invented one.
   */
  verifyWebhookSecret(workspaceId: string | undefined, provided: string | undefined): boolean {
    if (!workspaceId || !provided) return false;

    const current = this.webhookSecretFor(workspaceId, process.env.INGESTION_WEBHOOK_SECRET);
    if (!current) {
      this.logger.warn('INGESTION_WEBHOOK_SECRET is not set — the ingestion webhook is closed');
      return false;
    }
    const previous = this.webhookSecretFor(
      workspaceId,
      process.env.INGESTION_WEBHOOK_SECRET_PREVIOUS,
    );

    /* Bitwise or, not `||`: both comparisons run whatever the first one says, so
     * the response time cannot reveal which secret matched. Whether a previous
     * secret is configured at all is a property of the server, not of the
     * attacker's guess, so branching on that is safe. */
    const matchesCurrent = Number(IngestionService.equalsInConstantTime(provided, current));
    const matchesPrevious = Number(
      previous ? IngestionService.equalsInConstantTime(provided, previous) : false,
    );
    return (matchesCurrent | matchesPrevious) === 1;
  }

  /** What the settings screen shows so a forwarder app can be pointed at us. */
  webhookConfig(ctx: TenantContext): WebhookConfigView {
    const secret = this.webhookSecretFor(ctx.workspaceId);
    return {
      configured: secret !== null,
      url: `${APP_URL}/v1/ingestion/webhook`,
      workspaceHeader: INGEST_WORKSPACE_HEADER,
      workspaceId: ctx.workspaceId,
      secretHeader: INGEST_SECRET_HEADER,
      secret,
    };
  }

  // --- intake ----------------------------------------------------------------

  /**
   * Take one message in.
   *
   * The workspace is looked up *after* the secret has already been verified by
   * the controller, so this query is only ever reached by an authenticated
   * caller. A workspace that has been deleted or suspended gets the same 401 as
   * a bad secret: whether a given id exists is not something an unauthenticated
   * probe should be able to learn.
   */
  async ingest(workspaceId: string, input: WebhookBody): Promise<IngestResult> {
    const workspace = await this.prisma.workspace.findFirst({
      where: {
        id: workspaceId,
        deletedAt: null,
        status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] },
      },
      select: { id: true, timezone: true },
    });
    if (!workspace) throw new UnauthorizedException(INGEST_UNAUTHORISED);

    const sender = input.sender?.trim() || null;
    const receivedAt = IngestionService.resolveReceivedAt(input.receivedAt);
    // Stored byte for byte. Never trimmed, never normalised — see the class doc.
    const body = input.body;
    const bodyHash = bodyHashOf(input.channel, sender, body);

    const existing = await this.findByHash(workspaceId, bodyHash);
    if (existing) return existing;

    const parsed = REGISTRY.parse({
      channel: input.channel,
      sender: sender ?? undefined,
      body,
      // The workspace's own calendar day, so the date fallback lands in the
      // user's month rather than the server's.
      receivedOn: toLocalDateString(receivedAt, workspace.timezone),
    });

    let created: { messageId: string; draftId: string };
    try {
      created = await this.prisma.$transaction(async (tx) => {
        const message = await tx.ingestionMessage.create({
          data: {
            workspaceId,
            channel: input.channel,
            sender,
            receivedAt,
            body,
            bodyHash,
            parsed: toJson(parsed),
            parserName: parsed.parserName,
          },
          select: { id: true },
        });

        /* A draft is created even when nothing could be read. A message that
         * produced no draft would vanish from the inbox and only a debug
         * endpoint would ever see it; a zero-confidence draft, with the raw
         * text attached, is exactly the thing the review screen exists for. */
        const draft = await tx.transactionDraft.create({
          data: {
            workspaceId,
            messageId: message.id,
            status: 'PENDING',
            date: parsed.fields.date
              ? fromLocalDateString(parsed.fields.date, workspace.timezone)
              : null,
            amountMinor:
              parsed.fields.amountMinor === undefined ? null : BigInt(parsed.fields.amountMinor),
            direction: parsed.fields.direction ?? null,
            payee: parsed.fields.payee ?? null,
            confidence: parsed.confidence,
            evidence: toJson(parsed.evidence),
          },
          select: { id: true },
        });

        return { messageId: message.id, draftId: draft.id };
      });
    } catch (err) {
      /* Two copies of the same alert arriving at once both miss the read above
       * and race to insert. The unique index picks a winner; the loser reports
       * the winner's ids rather than failing, because from the forwarder's
       * point of view the message did arrive. */
      if (IngestionService.isDuplicateHash(err)) {
        const winner = await this.findByHash(workspaceId, bodyHash);
        if (winner) return winner;
      }
      throw err;
    }

    /* No body in the audit log, by spec §4.7. The hash identifies the message
     * for anyone reconciling a replay without putting the text in a second
     * place it has to be purged from. */
    this.audit.emit({
      workspaceId,
      actorType: 'INTEGRATION',
      action: 'ingestion.message_received',
      entity: 'IngestionMessage',
      entityId: created.messageId,
      after: {
        channel: input.channel,
        sender,
        bodyHash,
        parserName: parsed.parserName,
        confidence: parsed.confidence,
        needsReview: parsed.confidence < REVIEW_THRESHOLD,
        draftId: created.draftId,
      },
    });

    return { id: created.messageId, duplicate: false, draftId: created.draftId };
  }

  private async findByHash(workspaceId: string, bodyHash: string): Promise<IngestResult | null> {
    const existing = await this.prisma.ingestionMessage.findUnique({
      where: { workspaceId_bodyHash: { workspaceId, bodyHash } },
      select: {
        id: true,
        drafts: { orderBy: { createdAt: 'asc' }, take: 1, select: { id: true } },
      },
    });
    if (!existing) return null;
    return { id: existing.id, duplicate: true, draftId: existing.drafts[0]?.id ?? null };
  }

  private static isDuplicateHash(err: unknown): boolean {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return false;
    if (err.code !== 'P2002') return false;
    const target = err.meta?.target;
    return Array.isArray(target) ? target.includes('bodyHash') : true;
  }

  /**
   * A forwarder reports when the SMS reached the phone. A phone with a wrong
   * clock is common, and a message stamped next week would sit at the top of
   * the inbox forever, so anything in the future is pulled back to now. The
   * past is left alone: a backfill of last month's inbox is a real use.
   */
  private static resolveReceivedAt(raw: string | undefined): Date {
    const now = new Date();
    if (!raw) return now;
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) return now;
    return parsed.getTime() > now.getTime() ? now : parsed;
  }

  // --- the review inbox ------------------------------------------------------

  async listDrafts(
    ctx: TenantContext,
    query: ListDraftsQuery,
  ): Promise<{ items: DraftView[]; nextCursor: string | null }> {
    const rows = await this.prisma.transactionDraft.findMany({
      where: {
        workspaceId: ctx.workspaceId,
        ...(query.status ? { status: query.status } : {}),
      },
      include: draftInclude,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;

    return {
      items: page.map((row) => IngestionService.present(row, ctx.timezone)),
      nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
    };
  }

  /** The raw message, for working out why a parse came out wrong. */
  async findMessage(ctx: TenantContext, id: string): Promise<MessageDetailView> {
    const row = await this.prisma.ingestionMessage.findFirst({
      where: { id, workspaceId: ctx.workspaceId },
      include: { drafts: { orderBy: { createdAt: 'asc' }, select: { id: true } } },
    });
    if (!row) throw new NotFoundException('বার্তা পাওয়া যায়নি');

    return {
      id: row.id,
      channel: row.channel,
      sender: row.sender,
      receivedAt: row.receivedAt.toISOString(),
      body: row.body,
      bodyHash: row.bodyHash,
      parserName: row.parserName,
      parsed: row.parsed,
      createdAt: row.createdAt.toISOString(),
      draftIds: row.drafts.map((draft) => draft.id),
    };
  }

  // --- the human decision ----------------------------------------------------

  /**
   * Turn a draft into a real transaction.
   *
   * The only path in this file that writes to the ledger, and it runs behind a
   * JWT with the reviewer's own corrections layered over whatever the parser
   * proposed. Every field is validated after merging, not before: a draft the
   * parser barely understood is perfectly acceptable once a person has filled
   * in the gaps, and a draft the parser was sure about is still refused if the
   * person cleared a field.
   */
  async accept(ctx: TenantContext, id: string, input: AcceptDraftInput): Promise<DraftView> {
    const draft = await this.requireDraft(ctx.workspaceId, id);
    if (draft.status === 'ACCEPTED' || draft.transactionId) {
      throw new BadRequestException(ALREADY_APPLIED);
    }
    if (draft.status !== 'PENDING') {
      throw new BadRequestException('এই খসড়াটি আর যাচাইয়ের অপেক্ষায় নেই');
    }

    /* Creating a transaction from the inbox is still creating a transaction, so
     * it is metered exactly like the manual path. Otherwise ingestion would be
     * a way round the plan limit that the person who typed their entries by
     * hand does not get. */
    await this.entitlements.assertWithinLimit(
      ctx.workspaceId,
      'transactions.monthly.max',
      ctx.timezone,
    );

    const dateIso = input.date ?? (draft.date ? toLocalDateString(draft.date, ctx.timezone) : null);
    if (!dateIso) throw new BadRequestException('তারিখ দিন');

    const amountMinor =
      input.amountMinor ?? (draft.amountMinor === null ? null : minorToNumber(draft.amountMinor));
    if (amountMinor === null || amountMinor <= 0) {
      throw new BadRequestException('টাকার পরিমাণ দিন');
    }

    const direction = input.direction ?? IngestionService.directionOf(draft.direction);
    if (!direction) {
      throw new BadRequestException('টাকা ঢুকেছে না বেরিয়েছে — সেটি বেছে নিন');
    }

    const accountId = input.accountId ?? draft.accountId;
    if (!accountId) throw new BadRequestException('অ্যাকাউন্ট নির্বাচন করুন');

    /* Required, like the manual path. An ingested expense with no category is a
     * hole in every report the user will later look at, and the moment of
     * review is the cheapest moment to fill it. */
    const categoryId = input.categoryId ?? draft.categoryId;
    if (!categoryId) throw new BadRequestException('ক্যাটাগরি নির্বাচন করুন');

    await this.assertOwnership(ctx.workspaceId, accountId, categoryId);

    const payee = input.payee === undefined ? draft.payee : input.payee;
    /* One SMS cannot tell a transfer between your own accounts from income or
     * expense — it only ever sees one side. The reviewer can retype it as a
     * transfer afterwards on the transaction itself. */
    const type = direction === 'IN' ? 'INCOME' : 'EXPENSE';
    const system = await this.accounts.systemAccounts(ctx.workspaceId);
    const entries = expandSimpleTransaction(
      { type, amountMinor, accountId, categoryId, currency: CURRENCY },
      system,
    );
    // Belt and braces: the engine says it balances, the DB trigger will too.
    assertBalanced(entries);

    const date = fromLocalDateString(dateIso, ctx.timezone);
    const source = IngestionService.sourceFor(draft.message?.channel);
    const reviewedAt = new Date();

    const transactionId = await this.runWithDoubleApplyGuard(() =>
      this.prisma.$transaction(async (tx) => {
        const created = await tx.transaction.create({
          data: {
            workspaceId: ctx.workspaceId,
            createdByUserId: ctx.id,
            date,
            type,
            description: input.description ?? payee ?? 'বার্তা থেকে যোগ করা',
            notes: input.notes,
            payee,
            source,
            // The thread back to the text that proposed this entry.
            sourceDraftId: draft.id,
            entries: { create: entries.map((e) => entryData(e, ctx.workspaceId)) },
          },
          select: { id: true },
        });

        /* Compare-and-set, and the reason a draft can never be applied twice.
         * Two accepts racing both create a transaction, then serialise here:
         * the first sets `transactionId`, the second no longer matches its own
         * WHERE, counts zero, throws, and rolls its transaction back. The
         * `@unique` on `TransactionDraft.transactionId` is the second lock on
         * the same door — it stops two drafts ever claiming one entry — and
         * `runWithDoubleApplyGuard` turns either failure into the same message. */
        const claimed = await tx.transactionDraft.updateMany({
          where: {
            id: draft.id,
            workspaceId: ctx.workspaceId,
            status: 'PENDING',
            transactionId: null,
          },
          data: {
            status: 'ACCEPTED',
            transactionId: created.id,
            reviewedAt,
            reviewedByUserId: ctx.id,
            // Persist what was actually applied, overrides included, so the
            // draft records the decision rather than the proposal.
            date,
            amountMinor: BigInt(amountMinor),
            direction,
            payee,
            accountId,
            categoryId,
          },
        });
        if (claimed.count !== 1) throw new BadRequestException(ALREADY_APPLIED);

        return created.id;
      }),
    );

    /* Money into a credit card ends that cycle's reminders, exactly as it does
     * on the manual path. Not awaited into the response: a notification concern
     * must never fail a ledger write. */
    void this.cardReminders.autoMuteOnPayment(
      ctx.workspaceId,
      entries.map((e) => e.accountId),
    );

    this.audit.emit({
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.id,
      action: 'ingestion.draft_accepted',
      entity: 'TransactionDraft',
      entityId: draft.id,
      before: {
        date: draft.date ? toLocalDateString(draft.date, ctx.timezone) : null,
        amountMinor: draft.amountMinor === null ? null : minorToNumber(draft.amountMinor),
        direction: draft.direction,
        payee: draft.payee,
        confidence: draft.confidence,
      },
      after: {
        transactionId,
        date: dateIso,
        amountMinor,
        direction,
        accountId,
        categoryId,
        source,
        // Which fields the person had to correct. This is the signal a future
        // rule-quality screen (spec §4.5 stage 7) is built from.
        overrides: Object.keys(input).sort(),
      },
    });

    return this.presentOne(ctx, draft.id);
  }

  /**
   * Say no. Nothing is written to the ledger and the raw message stays, so the
   * parse that produced the draft can still be looked at.
   */
  async reject(ctx: TenantContext, id: string, input: RejectDraftInput): Promise<DraftView> {
    const draft = await this.requireDraft(ctx.workspaceId, id);
    if (draft.status === 'ACCEPTED' || draft.transactionId) {
      throw new BadRequestException('এই খসড়াটি ইতিমধ্যে যোগ করা হয়েছে, তাই বাতিল করা যাবে না');
    }
    if (draft.status !== 'PENDING') {
      throw new BadRequestException('এই খসড়াটি আর যাচাইয়ের অপেক্ষায় নেই');
    }

    const rejected = await this.prisma.transactionDraft.updateMany({
      where: { id: draft.id, workspaceId: ctx.workspaceId, status: 'PENDING', transactionId: null },
      data: { status: 'REJECTED', reviewedAt: new Date(), reviewedByUserId: ctx.id },
    });
    if (rejected.count !== 1)
      throw new BadRequestException('এই খসড়াটি আর যাচাইয়ের অপেক্ষায় নেই');

    /* The reason has no column, and the audit log is the right home for it
     * anyway: it is a fact about a decision somebody made, and it is what a
     * rule-quality report is later built from. */
    this.audit.emit({
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.id,
      action: 'ingestion.draft_rejected',
      entity: 'TransactionDraft',
      entityId: draft.id,
      after: {
        reason: input.reason,
        confidence: draft.confidence,
        parserName: draft.message?.parserName ?? null,
        messageId: draft.messageId,
      },
    });

    return this.presentOne(ctx, draft.id);
  }

  // --- guards ----------------------------------------------------------------

  /** A draft from another workspace does not exist as far as this caller is concerned. */
  private async requireDraft(workspaceId: string, id: string): Promise<DraftRow> {
    const draft = await this.prisma.transactionDraft.findFirst({
      where: { id, workspaceId },
      include: draftInclude,
    });
    if (!draft) throw new NotFoundException('খসড়া পাওয়া যায়নি');
    return draft;
  }

  private async assertOwnership(
    workspaceId: string,
    accountId: string,
    categoryId: string,
  ): Promise<void> {
    const account = await this.prisma.account.findFirst({
      where: { id: accountId, workspaceId, deletedAt: null, systemKey: null },
      select: { id: true, isArchived: true },
    });
    if (!account) throw new NotFoundException('অ্যাকাউন্ট পাওয়া যায়নি');
    if (account.isArchived) {
      throw new BadRequestException('আর্কাইভ করা অ্যাকাউন্টে লেনদেন করা যায় না');
    }

    const category = await this.prisma.category.count({
      where: { id: categoryId, workspaceId, deletedAt: null },
    });
    if (category !== 1) throw new NotFoundException('ক্যাটাগরি পাওয়া যায়নি');
  }

  private async runWithDoubleApplyGuard<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (IngestionService.isDraftTransactionClash(err)) {
        throw new BadRequestException(ALREADY_APPLIED);
      }
      throw err;
    }
  }

  private static isDraftTransactionClash(err: unknown): boolean {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return false;
    if (err.code !== 'P2002') return false;
    const target = err.meta?.target;
    return Array.isArray(target) ? target.includes('transactionId') : false;
  }

  // --- presentation ----------------------------------------------------------

  private async presentOne(ctx: TenantContext, id: string): Promise<DraftView> {
    const row = await this.requireDraft(ctx.workspaceId, id);
    return IngestionService.present(row, ctx.timezone);
  }

  /** The column is a free-text string; only the two values the ledger understands count. */
  private static directionOf(value: string | null): 'IN' | 'OUT' | null {
    return value === 'IN' || value === 'OUT' ? value : null;
  }

  /**
   * Where the entry says it came from. The message row is only ever missing if
   * it has been purged (`onDelete: SetNull`), which retention will eventually
   * do; WEBHOOK is then the honest answer, because that is the door it came in
   * through whatever the original channel said.
   */
  private static sourceFor(channel: IngestionChannel | undefined): TransactionSource {
    switch (channel) {
      case 'SMS':
        return 'SMS';
      case 'EMAIL':
        return 'EMAIL';
      default:
        return 'WEBHOOK';
    }
  }

  /** Prisma hands back `JsonValue`; only string-to-string pairs are evidence. */
  private static evidenceOf(value: Prisma.JsonValue | null): Record<string, string> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const out: Record<string, string> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === 'string') out[key] = entry;
    }
    return out;
  }

  private static present(row: DraftRow, timezone: string): DraftView {
    return {
      id: row.id,
      status: row.status,
      date: row.date ? toLocalDateString(row.date, timezone) : null,
      amountMinor: row.amountMinor === null ? null : minorToNumber(row.amountMinor),
      direction: IngestionService.directionOf(row.direction),
      payee: row.payee,
      accountId: row.accountId,
      categoryId: row.categoryId,
      confidence: row.confidence,
      needsReview: row.confidence < REVIEW_THRESHOLD,
      evidence: IngestionService.evidenceOf(row.evidence),
      parserName: row.message?.parserName ?? null,
      transactionId: row.transactionId,
      reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      message: row.message
        ? {
            id: row.message.id,
            channel: row.message.channel,
            sender: row.message.sender,
            receivedAt: row.message.receivedAt.toISOString(),
            body: row.message.body,
          }
        : null,
    };
  }
}
