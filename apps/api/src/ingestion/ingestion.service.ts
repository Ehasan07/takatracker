import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
  forwardRef,
} from '@nestjs/common';
import {
  assertBalanced,
  bodyHashOf,
  createRegistry,
  expandSimpleTransaction,
  REVIEW_THRESHOLD,
  type EntryDraft,
} from '@hishab/core';
import { displayName, fromLocalDateString, toLocalDateString, type Locale } from '@hishab/shared';
import { Prisma } from '@prisma/client';
import type { DraftStatus, IngestionChannel, TransactionSource } from '@prisma/client';
import { AccountsService } from '../accounts/accounts.service';
import { AiSuggestService } from './ai-suggest.service';
import { AuditService } from '../audit/audit.service';
import { looksFinancial, looksPromotional, ucblParser } from '@hishab/core';
import { minorToNumber } from '../common/bigint-json';
import {
  INGEST_SECRET_HEADER,
  INGEST_WORKSPACE_HEADER,
  ingestWebhookSecretFor,
  verifyIngestWebhookSecret,
} from '../common/ingest-webhook';
import { EntitlementsService, FeatureLimitException } from '../entitlements/entitlements.service';
import { UsageMeterService } from '../entitlements/usage-meter.service';
import { TransactionsService } from '../transactions/transactions.service';
import { CardRemindersService } from '../notifications/card-reminders.service';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../transactions/transactions.service';
import type {
  AcceptDraftInput,
  ListDraftsQuery,
  ListMessagesQuery,
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
 * it.** That is not a guideline here, it is the shape of the module: an inbound
 * message writes an `IngestionMessage` and a `TransactionDraft` and stops. The
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
 *
 * There are two doors in and they share everything behind them. `ingest` is the
 * webhook's, reached by an SMS forwarder with a shared secret. `ingestFromWorker`
 * is the mailbox sweep's, reached by no request at all. They run the same
 * registry, write the same rows, charge the same meter and file the same audit
 * action; the worker's door is only stricter about what it lets through and
 * quieter about the refusals a sweep has to survive.
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
/* The bank-specific parsers, tried in order before the generic one.
 *
 * One entry so far, written from the owner's own UCB alerts. Each addition is
 * a file in `packages/core/src/parsers` and a line here; a bank nobody has
 * written one for still gets the generic reader, so the list growing is a
 * gradual improvement rather than a prerequisite. */
const REGISTRY = createRegistry([ucblParser]);

// --- webhook authentication --------------------------------------------------

/* The header names and the HMAC live in `common/ingest-webhook.ts` — the
 * rate-limit guard needs the same answer and cannot reach into this module.
 * Re-exported so the controller and every existing importer keep their import
 * site unchanged. */
export { INGEST_SECRET_HEADER, INGEST_WORKSPACE_HEADER } from '../common/ingest-webhook';

/**
 * One message for every way authentication can fail — bad secret, unknown
 * workspace, missing header, suspended workspace. Distinguishing them would let
 * anyone with the endpoint enumerate workspace ids.
 */
export const INGEST_UNAUTHORISED = 'ওয়েবহুক সিক্রেট মেলেনি';

const ALREADY_APPLIED = 'এই খসড়াটি আগেই লেনদেন হিসেবে যোগ করা হয়েছে';

const CURRENCY = 'BDT';

/**
 * Where a forwarder app should POST.
 *
 * Its own variable, not `API_PUBLIC_URL`, because the two are deliberately
 * different hosts: `sms.takatracker.com` serves this one route and answers 404
 * to everything else, so the secret a phone carries cannot reach `/auth/login`
 * or `/export/full` if that phone is lost. Falls back to the general API URL so
 * a deployment that has not split them still works.
 */
const APP_URL =
  process.env.INGEST_PUBLIC_URL ??
  process.env.API_PUBLIC_URL ??
  `http://localhost:${process.env.API_PORT ?? 4000}`;

// --- views -------------------------------------------------------------------

export interface IngestResult {
  /** The `IngestionMessage` id — the same one on a replay. */
  id: string;
  duplicate: boolean;
  /** The draft this message produced, or the existing one on a replay. */
  draftId: string | null;
}

/**
 * What a background worker hands in.
 *
 * The webhook's `WebhookBody` minus the parts that only exist because HTTP does
 * — no headers, no secret, no zod. Declared here rather than imported from the
 * controller so a worker never has to reach into the request layer to talk to
 * this service; the two shapes are deliberately identical, and `ingestFromWorker`
 * passes one straight through as the other.
 */
export interface WorkerMessage {
  channel: IngestionChannel;
  sender?: string;
  /** ISO-8601. A future stamp is pulled back to now, as on the webhook. */
  receivedAt?: string;
  body: string;
}

/**
 * Why a worker's message did or did not become a draft.
 *
 * A worker cannot be handed an exception for any of these — a sweep that threw
 * on a suspended workspace would abandon every mailbox behind it — but it must
 * still be able to tell them apart, because they mean very different things in a
 * log line and only one of them is worth warning about.
 */
export type WorkerIngestOutcome =
  | { outcome: 'drafted'; result: IngestResult }
  /** Already ingested — same content, seen before. Nothing written. */
  | { outcome: 'duplicate'; result: IngestResult }
  /** The registry could not read money out of it. Deliberately not a draft. */
  | { outcome: 'not_a_transaction' }
  /** Deleted or suspended between the row being read and this call. */
  | { outcome: 'workspace_inactive' }
  /** `ingest.messages.monthly.max` is spent. The caller should stop trying. */
  | { outcome: 'quota_reached' };

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
  /**
   * Which model proposed the category and account, when one did.
   *
   * The review screen says so out loud. Somebody deciding should be told which
   * of the values in front of them were read from their bank and which were
   * guessed by a machine that has never seen their books — a suggestion
   * presented as a reading is how people stop checking.
   */
  suggestedBy: string | null;
  transactionId: string | null;
  reviewedAt: string | null;
  createdAt: string;
  message: DraftMessageView | null;
}

/** One row of "everything this phone sent", for the customer's own screen. */
export interface MessageListView {
  id: string;
  channel: string;
  sender: string | null;
  receivedAt: string;
  body: string;
  parserName: string | null;
  /** Null when the message was never about money, so no decision was raised. */
  draftId: string | null;
  draftStatus: string | null;
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
    private readonly meters: UsageMeterService,
    private readonly cardReminders: CardRemindersService,
    private readonly audit: AuditService,
    /* Lazily: `TransactionsModule` imports this one back, because an accepted
       draft and a forwarder entry both go through the transaction writer while
       the writer's own module needs the inbox. */
    @Inject(forwardRef(() => TransactionsService))
    private readonly transactions: TransactionsService,
    private readonly ai: AiSuggestService,
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
    return ingestWebhookSecretFor(workspaceId, root);
  }

  /**
   * Checked before anything touches the database, so a wrong secret costs one
   * HMAC and never a query — there is no timing difference between a real
   * workspace id and an invented one.
   *
   * The comparison itself moved to `common/ingest-webhook.ts` because
   * `WorkspaceThrottlerGuard` needs the same answer to decide whether the
   * workspace header can be trusted as a rate-limit bucket, and a global guard
   * cannot reach into this module. What stays here is the one warning worth
   * emitting: a deployment with no root secret has the webhook closed, and
   * somebody staring at 401s deserves to be told why. The guard calls the
   * silent function so that warning happens once per refused request rather
   * than twice.
   */
  verifyWebhookSecret(workspaceId: string | undefined, provided: string | undefined): boolean {
    if (workspaceId && provided && !process.env.INGESTION_WEBHOOK_SECRET) {
      this.logger.warn('INGESTION_WEBHOOK_SECRET is not set — the ingestion webhook is closed');
      return false;
    }
    return verifyIngestWebhookSecret(workspaceId, provided);
  }

  /**
   * The accounts and categories an outside console needs for its two dropdowns.
   *
   * Names and ids, and nothing else. A console asking "which account, which
   * category" has no use for a balance, and an endpoint that returns what it
   * does not need is one that leaks the day its credential does. System
   * accounts are excluded for the reason the wallet excludes them: nobody files
   * a grocery bill against `SYSTEM_EXPENSE`.
   */
  async forwarderOptions(workspaceId: string): Promise<{
    accounts: { id: string; name: string; type: string }[];
    categories: { id: string; name: string; kind: string }[];
  }> {
    const workspace = await this.requireLiveWorkspace(workspaceId);
    const locale: Locale = workspace.locale === 'en' ? 'en' : 'bn';

    const [accounts, categories] = await Promise.all([
      this.prisma.account.findMany({
        where: { workspaceId, deletedAt: null, isArchived: false, systemKey: null },
        select: { id: true, name: true, type: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
      this.prisma.category.findMany({
        where: { workspaceId, deletedAt: null },
        select: { id: true, name: true, nameBn: true, kind: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
    ]);

    return {
      accounts,
      categories: categories.map((category) => ({
        id: category.id,
        /* The workspace's own language, so the console's dropdown reads the
           same as every picker inside the app. */
        name: displayName(category, locale),
        kind: category.kind,
      })),
    };
  }

  /**
   * A transaction an outside console has already had a person review.
   *
   * Straight through `TransactionsService.create` — the same door the app's own
   * entry sheet uses, with the same ownership checks, the same plan meter, the
   * same double-entry expansion and the same audit row. Building the entries
   * here instead would be a second way for the ledger to be wrong, and the
   * second way is always the one nobody tests.
   */
  async entryFromForwarder(
    workspaceId: string,
    input: {
      date: string;
      amountMinor: number;
      direction: 'IN' | 'OUT';
      accountId: string;
      categoryId: string;
      description?: string;
      notes?: string;
    },
  ): Promise<{ transactionId: string }> {
    const workspace = await this.requireLiveWorkspace(workspaceId);

    const ctx: TenantContext = {
      /* No user did this — a trusted client did. `id` records authorship and an
         empty string is honest rather than a borrowed identity; the audit row
         still says where it came from. */
      id: '',
      workspaceId: workspace.id,
      timezone: workspace.timezone,
      locale: workspace.locale === 'en' ? 'en' : 'bn',
    };

    const created = await this.transactions.create(ctx, {
      date: input.date,
      type: input.direction === 'IN' ? 'INCOME' : 'EXPENSE',
      amountMinor: input.amountMinor,
      accountId: input.accountId,
      categoryId: input.categoryId,
      description: input.description,
      notes: input.notes,
      source: 'WEBHOOK',
      attachmentIds: [],
    } as Parameters<TransactionsService['create']>[1]);

    return { transactionId: created.id };
  }

  /** Live, or the same 401 a bad secret gets. Never says which it was. */
  private async requireLiveWorkspace(workspaceId: string) {
    const workspace = await this.prisma.workspace.findFirst({
      where: {
        id: workspaceId,
        deletedAt: null,
        status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] },
      },
      select: { id: true, timezone: true, locale: true },
    });
    if (!workspace) throw new UnauthorizedException(INGEST_UNAUTHORISED);
    return workspace;
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

    /* Whether this message gets a decision put in front of somebody.
     *
     * A phone forwarding every SMS sends a great deal that is not a
     * transaction, and all of it is kept — the owner asked for all of it, and
     * it is what shows whether the pipe is working at all. But a draft is a
     * question, and forty questions nobody needs to answer is how a review
     * queue stops being read. So the message is always stored and only a
     * money-shaped one raises a draft — and not one that is merely selling
     * money-shaped things. A bank's advertisement carries more figures than its
     * alerts do and every one of them is wrong to file. */
    const financial = looksFinancial(body) && !looksPromotional(body);

    /* The monthly ingest ceiling, checked only once the message is known to be
     * new *and* to be worth a draft. Charging a retry against the quota would
     * let a forwarder that lost one reply burn a month's allowance on a single
     * message — and the whole point of the hash above is that a retry is free.
     * Charging a one-time code against it would be worse: the customer would
     * pay a month's allowance for messages this product never wanted and never
     * shows them a decision about. */
    if (financial) {
      await this.entitlements.assertWithinLimit(
        workspaceId,
        'ingest.messages.monthly.max',
        workspace.timezone,
      );
    }

    const parsed = REGISTRY.parse({
      channel: input.channel,
      sender: sender ?? undefined,
      body,
      // The workspace's own calendar day, so the date fallback lands in the
      // user's month rather than the server's.
      receivedOn: toLocalDateString(receivedAt, workspace.timezone),
    });

    let created: { messageId: string; draftId: string | null };
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

        /* A draft is created even when nothing could be *read* — a
         * zero-confidence draft with the raw text attached is exactly the thing
         * the review screen exists for. What does not raise one is a message
         * that was never about money in the first place; that message is still
         * stored and the owner still sees it under every message this phone
         * forwarded, it simply does not join a queue of decisions. */
        const draft = financial
          ? await tx.transactionDraft.create({
              data: {
                workspaceId,
                messageId: message.id,
                status: 'PENDING',
                date: parsed.fields.date
                  ? fromLocalDateString(parsed.fields.date, workspace.timezone)
                  : null,
                amountMinor:
                  parsed.fields.amountMinor === undefined
                    ? null
                    : BigInt(parsed.fields.amountMinor),
                direction: parsed.fields.direction ?? null,
                payee: parsed.fields.payee ?? null,
                confidence: parsed.confidence,
                evidence: toJson(parsed.evidence),
              },
              select: { id: true },
            })
          : null;

        /* Counted here, inside the same transaction as the message, and not
         * afterwards. `ingest.messages.monthly.max` is the one intake limit
         * that cannot be answered with a COUNT(*) later: retention pruning
         * removes the rows, and a month a workspace has already been charged
         * for would silently empty out. A meter that can drift is only worth
         * having if it cannot drift here, so the count and the message land
         * together or neither does.
         *
         * Nothing enforces this limit at the door yet — see the report. The
         * number is now true, which is the prerequisite. */
        if (financial) {
          await this.meters.increment(
            workspaceId,
            'ingest.messages.monthly.max',
            1,
            workspace.timezone,
            { tx },
          );
        }

        return { messageId: message.id, draftId: draft?.id ?? null };
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

    /* Ask a model which category and account this belongs to, and do not wait.
     *
     * The draft is already saved and already useful; the suggestion only fills
     * in two fields that would otherwise be blank. Awaiting it would hold a
     * webhook open on somebody else's API latency, and failing it would throw
     * away a draft that was fine. So it runs behind the response and every
     * failure inside it is silent. */
    void this.ai.suggestForDraft(workspaceId, created.draftId ?? '').catch(() => undefined);

    return { id: created.messageId, duplicate: false, draftId: created.draftId };
  }

  /**
   * The same pipeline, entered from a background worker instead of the webhook.
   *
   * One inbox, one parser registry, one dedup key, one place a human says yes.
   * A synced bank statement and a forwarded SMS produce the same
   * `IngestionMessage`, the same `TransactionDraft`, the same
   * `ingestion.message_received` audit row, and land in the same `/inbox` — and
   * **neither reaches the ledger until somebody accepts the draft.** A second
   * review queue for email would be twice the code and a worse product.
   *
   * Two things are different here, and both are about the caller being a sweep
   * rather than a request:
   *
   *  - **It refuses more than the webhook does.** A forwarded SMS was already
   *    chosen by a human's phone; a mailbox was not, and most of what is in one
   *    is not money. The rule is that the registry must have genuinely *read*
   *    both an amount and a direction out of the text — `evidence` carries only
   *    what was read, never what was inferred, which is exactly the distinction
   *    needed. Anything short of that would be a draft with nothing on it but a
   *    number somebody has to go and check, and an inbox full of those is one
   *    people stop opening. The check costs one extra parse, on a message that
   *    has already survived the caller's own filter, and it gets sharper for
   *    free the moment a real bank parser joins `REGISTRY`.
   *  - **It does not throw for the two refusals a sweep must survive.** A
   *    suspended workspace and a spent monthly quota are answers, not faults;
   *    the caller logs them and carries on with the next mailbox. Everything
   *    else — a database that is gone, a bug here — still throws, because a
   *    worker silently swallowing those is how a feature stops working for a
   *    week before anyone notices.
   *
   * `ingest.messages.monthly.max` is charged exactly as it is on the SMS path,
   * inside the same transaction as the message. Synced mail is not a way around
   * the plan limit that the person forwarding their SMS pays.
   */
  async ingestFromWorker(workspaceId: string, input: WorkerMessage): Promise<WorkerIngestOutcome> {
    /* No `receivedOn`: the fallback date needs the workspace's timezone and this
     * probe has not looked the workspace up yet. It does not matter — the two
     * fields this gate reads, `evidence.amountMinor` and `evidence.direction`,
     * are only ever populated from the message's own text. `ingest` below does
     * the real parse, with the timezone, and that is the one that is stored. */
    const probe = REGISTRY.parse({
      channel: input.channel,
      sender: input.sender,
      body: input.body,
    });
    if (probe.evidence.amountMinor === undefined || probe.evidence.direction === undefined) {
      return { outcome: 'not_a_transaction' };
    }

    try {
      const result = await this.ingest(workspaceId, input);
      return { outcome: result.duplicate ? 'duplicate' : 'drafted', result };
    } catch (err) {
      /* The workspace was deleted or suspended between the row that named it
       * being read and this call. `ingest` answers that with the webhook's
       * deliberately vague 401; from in here it simply means "not any more". */
      if (err instanceof UnauthorizedException) return { outcome: 'workspace_inactive' };
      if (err instanceof FeatureLimitException) return { outcome: 'quota_reached' };
      throw err;
    }
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

  /**
   * Every message this workspace's phone has forwarded, newest first.
   *
   * The drafts list answers "what needs deciding"; this answers "did it
   * arrive". They are different questions and the second one had no screen at
   * all: a message that raised no draft — a one-time code, a delivery
   * notification, anything not about money — was stored and then invisible to
   * the person whose phone sent it, which is the wrong way round for their own
   * data.
   *
   * `hasDraft` is what lets the screen tell the two apart without a second
   * request per row.
   */
  async listMessages(
    ctx: TenantContext,
    query: ListMessagesQuery,
  ): Promise<{ items: MessageListView[]; nextCursor: string | null }> {
    const rows = await this.prisma.ingestionMessage.findMany({
      where: { workspaceId: ctx.workspaceId },
      select: {
        id: true,
        channel: true,
        sender: true,
        receivedAt: true,
        body: true,
        parserName: true,
        createdAt: true,
        drafts: { select: { id: true, status: true }, take: 1 },
      },
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;

    return {
      items: page.map((row) => ({
        id: row.id,
        channel: row.channel,
        sender: row.sender,
        receivedAt: row.receivedAt.toISOString(),
        body: row.body,
        parserName: row.parserName,
        draftId: row.drafts[0]?.id ?? null,
        draftStatus: row.drafts[0]?.status ?? null,
      })),
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
            /* The message that proposed this entry, kept on the entry itself.
             *
             * `sourceDraftId` already threads back to it, but that is a join
             * nobody makes while looking at a ledger row six months later. The
             * question then is "what was this ৳500 for", and the bank's own
             * words answer it — the reference number, the counterparty, the
             * balance after. Only when the person wrote nothing themselves:
             * their note is about the transaction, this is only evidence. */
            notes: input.notes ?? draft.message?.body ?? undefined,
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
      suggestedBy: row.suggestedBy,
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
