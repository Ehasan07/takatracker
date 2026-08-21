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
  accountKnowsNumber,
  accountTailOf,
  assertBalanced,
  bodyHashOf,
  createRegistry,
  expandSimpleTransaction,
  matchAccount,
  REVIEW_THRESHOLD,
  type AccountMatchCandidate,
  type EntryDraft,
} from '@hishab/core';
import { currencyForAmount, type CurrencyAmount } from '@hishab/parsers';
import {
  DEFAULT_CURRENCY,
  displayName,
  fromLocalDateString,
  toLocalDateString,
  type Locale,
} from '@hishab/shared';
import { Prisma } from '@prisma/client';
import type { DraftStatus, IngestionChannel, TransactionSource } from '@prisma/client';
import { AccountsService } from '../accounts/accounts.service';
import { InsuranceService } from '../insurance/insurance.service';
import { LoansService } from '../loans/loans.service';
import { AiSuggestService } from './ai-suggest.service';
import { AuditService } from '../audit/audit.service';
import {
  isUsableShape,
  looksFinancial,
  looksPromotional,
  messageShape,
  ucblParser,
} from '@hishab/core';
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
import { SavingsService } from '../savings/savings.service';
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
 * How confident a foreign-currency draft is allowed to look.
 *
 * `scoreConfidence` measures how much of the message was understood, and by
 * that measure a message that names its currency was understood *better* than
 * one that did not. But the number the review screen turns into "ভালোভাবে পড়া
 * গেছে" versus "যাচাই করে নিন" is answering a different question — may this be
 * accepted with one tap — and the answer for a dollar charge is no, whatever
 * else was read. The one field the ledger cannot do without, the amount in the
 * workspace's own money, is not in the message and cannot be derived from it.
 *
 * One below the threshold rather than some rounder number, because that is
 * precisely what is being said: everything short of the line where a one-tap
 * accept is offered.
 */
const FX_CONFIDENCE_CEILING = REVIEW_THRESHOLD - 1;

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

/**
 * What the review inbox needs on top of `TenantContext`: which currency the
 * books are kept in.
 *
 * Every real caller is an `AuthUser`, which has carried `currency` since the
 * fx field shipped, so nothing has to be threaded anywhere — this is only the
 * type saying out loud that the inbox cannot do its job without it. It cannot:
 * "was this message in another currency" has no answer that is not relative to
 * the workspace's own, and a hardcoded 'BDT' here would tell a workspace on
 * dollars that every one of its dollar alerts was foreign.
 */
export interface InboxContext extends TenantContext {
  /** ISO 4217 the ledger is kept in. */
  currency: string;
}

export interface DraftView {
  id: string;
  status: DraftStatus;
  /** `YYYY-MM-DD` in the workspace's timezone. */
  date: string | null;
  /**
   * The workspace's own currency, always — and **null when `fxCurrency` is
   * set**, because a message reading "USD 4.6" states no taka figure and this
   * refuses to invent one. That null is what makes the review screen ask.
   */
  amountMinor: number | null;
  /** ISO 4217 the message stated, when it stated one that is not the books'. */
  fxCurrency: string | null;
  /** The amount in `fxCurrency`, integer minor units of *that* currency. */
  fxAmountMinor: number | null;
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
  /**
   * The account number this accept just taught the workspace, if it taught one.
   *
   * Said out loud rather than done quietly. The app has changed a setting on
   * the owner's account off the back of one tap, and somebody who does not know
   * that happened cannot undo it — so the review screen repeats it back and the
   * accounts screen is where it can be removed.
   */
  learnedHint: string | null;
  /**
   * True when saying no to this draft taught the inbox a shape.
   *
   * Said back, because it is a thing done on somebody's behalf: from now on
   * messages of that shape are stored without raising a decision, and a person
   * who was not told would eventually wonder why a sender went quiet.
   */
  learnedRule: boolean;
  /**
   * The insurer whose premium this accept just ticked, when it ticked one.
   *
   * Said back for the same reason the learned hint is: the app did something on
   * the owner's behalf beyond writing the entry they asked for, and a schedule
   * that quietly changes state is one nobody can audit.
   */
  claimedPremium: string | null;
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
  /** True when a rule the owner taught kept this message out of the queue. */
  suppressed: boolean;
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

/**
 * How many hints one account may learn before this stops adding them.
 *
 * Past a dozen it is not learning, it is growing a column: a real account is
 * known by its number, its card, and the shortcode that texts about it, and
 * anything beyond that is a rule that fired on the wrong row.
 */
const MAX_LEARNED_HINTS = 12;

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
    /* For `claimInstalment`: a transfer into a DPS is that month's instalment,
       and the schedule has to hear about it however the money got there. */
    private readonly savings: SavingsService,
    /* For ধার: a repayment arriving by SMS has to move the outstanding balance,
       not merely the money, and `LoansService` is where that already lives. */
    private readonly loans: LoansService,
    /* For premiums: a receipt from an insurer settles an instalment, and the
       schedule has to hear about it however the money was recorded. */
    private readonly insurance: InsuranceService,
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
      direction: 'IN' | 'OUT' | 'TRANSFER';
      accountId: string;
      toAccountId?: string;
      categoryId?: string;
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
      /* A transfer is neither income nor expense — money the person still has,
         in a different pocket. Filing it as either is the mistake the tutorial
         page spends a paragraph on, and it would be a poor look for this
         endpoint to make it. */
      type:
        input.direction === 'TRANSFER'
          ? 'TRANSFER'
          : input.direction === 'IN'
            ? 'INCOME'
            : 'EXPENSE',
      amountMinor: input.amountMinor,
      accountId: input.accountId,
      counterAccountId: input.toAccountId,
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
      /* `currency` because "was this in another currency" is only ever a
         question relative to the books' own. A workspace kept in dollars must
         not have every one of its dollar alerts filed as foreign. */
      select: { id: true, timezone: true, currency: true },
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

    /* A shape the owner has already said no to.
     *
     * Looked up before anything is parsed, because the answer changes what the
     * message is for: a match means this is the twenty-fifth one-time code from
     * a shortcode that has never once been a transaction, and raising a
     * twenty-fifth decision about it is the app failing to listen. The message
     * is still stored — it always is — and the screen says why it raised
     * nothing. */
    const rule = financial ? await this.matchingRule(workspaceId, sender, body) : null;

    const parsed = REGISTRY.parse({
      channel: input.channel,
      sender: sender ?? undefined,
      body,
      // The workspace's own calendar day, so the date fallback lands in the
      // user's month rather than the server's.
      receivedOn: toLocalDateString(receivedAt, workspace.timezone),
    });

    /* Which money the figure the parser found was actually in.
     *
     * Asked of the message the parser has already read, and tied to the very
     * figure it read — see `currencyForAmount`. A message that names no code,
     * or names the workspace's own, comes back null and everything below
     * behaves exactly as it did before this existed. */
    const foreign = IngestionService.foreignAmountIn(body, parsed.evidence, workspace.currency);

    /* Which of the owner's accounts the message is about, decided before the
     * draft is written so the review screen opens with the picker already on
     * the right one. Null whenever the answer is not certain — see
     * `matchAccount`, which would rather leave the field empty than fill it in
     * wrongly. */
    const matchedAccountId = financial
      ? (matchAccount(await this.matchableAccounts(workspaceId), {
          accountHint: parsed.fields.accountHint ?? null,
          sender,
          body,
        })?.accountId ?? null)
      : null;

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
            suppressedByRuleId: rule?.id ?? null,
          },
          select: { id: true },
        });

        /* A draft is created even when nothing could be *read* — a
         * zero-confidence draft with the raw text attached is exactly the thing
         * the review screen exists for. What does not raise one is a message
         * that was never about money in the first place; that message is still
         * stored and the owner still sees it under every message this phone
         * forwarded, it simply does not join a queue of decisions. */
        const draft =
          financial && !rule
            ? await tx.transactionDraft.create({
                data: {
                  workspaceId,
                  messageId: message.id,
                  status: 'PENDING',
                  date: parsed.fields.date
                    ? fromLocalDateString(parsed.fields.date, workspace.timezone)
                    : null,
                  /* Null the moment the message turns out to be in another
                   * currency, and this is the whole fix.
                   *
                   * The parser read "4.6" out of "USD 4.6" and reported 460
                   * minor units, which is 460 poisha — ৳4.60 — for a charge of
                   * about ৳560. Storing that number in a column that means taka
                   * is how the figure reached a screen labelled ৳ and how it
                   * would have reached the ledger. There is no taka figure in
                   * that message to store, so none is stored; `fxAmountMinor`
                   * below keeps what the message did say, and a person supplies
                   * the rest. */
                  amountMinor:
                    foreign || parsed.fields.amountMinor === undefined
                      ? null
                      : BigInt(parsed.fields.amountMinor),
                  fxCurrency: foreign?.currency ?? null,
                  fxAmountMinor: foreign ? BigInt(foreign.amountMinor) : null,
                  direction: parsed.fields.direction ?? null,
                  payee: parsed.fields.payee ?? null,
                  accountId: matchedAccountId,
                  confidence: foreign
                    ? Math.min(parsed.confidence, FX_CONFIDENCE_CEILING)
                    : parsed.confidence,
                  evidence: toJson(
                    foreign
                      ? IngestionService.fxEvidence(parsed.evidence, foreign.text)
                      : parsed.evidence,
                  ),
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

  /**
   * The accounts a draft is allowed to name, with everything matching needs.
   *
   * Archived and deleted accounts are excluded because a message cannot be
   * about an account the owner has put away, and the system control accounts
   * because they are the ledger's own machinery — a person never picks one and
   * neither may a match.
   */
  private async matchableAccounts(workspaceId: string): Promise<AccountMatchCandidate[]> {
    return this.prisma.account.findMany({
      where: { workspaceId, deletedAt: null, isArchived: false, systemKey: null },
      select: {
        id: true,
        name: true,
        institution: true,
        accountNumberMasked: true,
        matchHints: true,
      },
    });
  }

  async listDrafts(
    ctx: InboxContext,
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

    /* Read once for the whole page, and only when a row on it still has no
       account — a queue of already-answered drafts costs no query at all. */
    const accounts = page.some(IngestionService.wantsAccount)
      ? await this.matchableAccounts(ctx.workspaceId)
      : [];

    return {
      items: page.map((row) => IngestionService.present(row, ctx.timezone, ctx.currency, accounts)),
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
        suppressedByRuleId: true,
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
        /* Why this one raised no decision. Without it a suppressed message is
           indistinguishable on screen from one the parser could make nothing
           of, and the owner would have no way to know the inbox is quietly
           acting on a rule they taught it. */
        suppressed: row.suppressedByRuleId !== null,
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
  async accept(ctx: InboxContext, id: string, input: AcceptDraftInput): Promise<DraftView> {
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

    /* What the message said the money was, before anything the reviewer typed.
     *
     * Read through the same helper the review screen was drawn from, so the two
     * cannot disagree about the same row — including for a draft written before
     * these columns existed, where both re-read the stored message. */
    const stored = IngestionService.foreignOf(draft, ctx.currency);

    /* Which of the two the reviewer is correcting, if either. `undefined` means
     * "leave it as the message read it"; an explicit `null` means "that was not
     * another currency after all", which somebody has to be able to say when a
     * code was read out of a reference number. */
    const fxCurrency =
      input.fxCurrency === undefined ? (stored?.currency ?? null) : input.fxCurrency;
    const fxAmountMinor =
      input.fxAmountMinor === undefined ? (stored?.amountMinor ?? null) : input.fxAmountMinor;
    if ((fxCurrency === null) !== (fxAmountMinor === null)) {
      throw new BadRequestException('মূল মুদ্রা আর মূল অঙ্ক — দুটোই দিতে হবে, অথবা কোনোটিই নয়');
    }

    /**
     * The amount, and the one place a foreign-currency draft is different.
     *
     * `draft.amountMinor` is the fallback for an ordinary draft, and it must not
     * be the fallback for this one. A draft that says USD has no taka figure of
     * its own — a new one stores null, an old one stores the dollar figure under
     * a taka name — and falling back to either would put ৳4.60 in the books for
     * a $4.60 charge, which is the entire bug. The request has to carry it,
     * because the only person who knows what the card issuer actually charged is
     * the one holding the statement: it is not the mid-market rate on the day,
     * and it is not on any screen here.
     */
    const amountMinor = fxCurrency
      ? (input.amountMinor ?? null)
      : (input.amountMinor ??
        (draft.amountMinor === null ? null : minorToNumber(draft.amountMinor)));
    if (amountMinor === null || amountMinor <= 0) {
      throw new BadRequestException(
        fxCurrency
          ? `বার্তাটি ${fxCurrency}-এ ছিল — কত টাকা কাটা হয়েছে সেটি লিখুন বা রেট দিন`
          : 'টাকার পরিমাণ দিন',
      );
    }

    const direction = input.direction ?? IngestionService.directionOf(draft.direction);
    if (!direction) {
      throw new BadRequestException('টাকা ঢুকেছে না বেরিয়েছে — সেটি বেছে নিন');
    }

    const accountId = input.accountId ?? draft.accountId;
    if (!accountId) throw new BadRequestException('অ্যাকাউন্ট নির্বাচন করুন');

    /* ধার, in either of its two shapes, goes through the loans module instead
       of the ledger write below — see `acceptAsLoan`. */
    if (input.loanId || input.loanDirection) {
      return this.acceptAsLoan(ctx, draft, {
        dateIso,
        amountMinor,
        accountId,
        loanId: input.loanId,
        loanDirection: input.loanDirection,
        personId: input.personId,
        personName: input.personName,
        counterAccountId: input.counterAccountId,
        note: input.notes ?? input.description,
      });
    }

    /**
     * The other side, when the reviewer says there is one.
     *
     * A message only ever sees its own account: "১০,০০০ জমা হয়েছে" in a DPS
     * says nothing about the wallet it left. So the parser cannot propose this
     * and never tries — it is the one field on the review screen that is pure
     * human knowledge, and supplying it is what turns an accept from income or
     * expense into a transfer.
     *
     * Getting this wrong is expensive in a way a mis-categorised expense is
     * not: a DPS instalment booked as income invents ৳10,000 of earnings every
     * month, and five years of that is a net worth nobody can explain.
     */
    const counterAccountId = input.counterAccountId ?? null;
    const isTransfer = counterAccountId !== null;
    if (isTransfer && counterAccountId === accountId) {
      throw new BadRequestException('একই অ্যাকাউন্টে সরানো যায় না — অন্য একটি বেছে নিন');
    }

    /* Required for income and expense, the way the manual path requires it: an
     * ingested expense with no category is a hole in every report the user will
     * later look at, and review is the cheapest moment to fill it. Never
     * required for a transfer, which has no খাত to belong to — one of your
     * accounts became another, and nothing was earned or spent. */
    const categoryId = isTransfer ? null : (input.categoryId ?? draft.categoryId);
    if (!isTransfer && !categoryId) throw new BadRequestException('ক্যাটাগরি নির্বাচন করুন');

    await this.assertOwnership(
      ctx.workspaceId,
      isTransfer ? [accountId, counterAccountId] : [accountId],
      categoryId,
    );

    /* Checked before the write, and by id rather than by count: a tag from
       another workspace would otherwise be attached to this one's entry, and a
       join row is not something a foreign key alone can refuse — `Tag` and
       `TransactionTag` both carry `workspaceId`, so the pair would be
       internally consistent and still wrong. */
    const tagIds = input.tagIds ?? [];
    if (tagIds.length > 0) {
      const mine = await this.prisma.tag.findMany({
        where: { id: { in: tagIds }, workspaceId: ctx.workspaceId, deletedAt: null },
        select: { id: true },
      });
      if (mine.length !== new Set(tagIds).size) {
        throw new BadRequestException('ট্যাগটি পাওয়া যায়নি');
      }
    }

    const payee = input.payee === undefined ? draft.payee : input.payee;
    const type = isTransfer ? 'TRANSFER' : direction === 'IN' ? 'INCOME' : 'EXPENSE';
    const system = await this.accounts.systemAccounts(ctx.workspaceId);
    /* `direction` keeps meaning what it always meant — which way the money went
       for the account the *message* was about — and that is what decides which
       end of the transfer this account is. A DPS SMS reading "জমা হয়েছে" is
       IN, so the DPS receives and the wallet the reviewer named pays. */
    const entries = isTransfer
      ? expandSimpleTransaction(
          {
            type: 'TRANSFER',
            amountMinor,
            accountId: direction === 'IN' ? counterAccountId : accountId,
            counterAccountId: direction === 'IN' ? accountId : counterAccountId,
            currency: CURRENCY,
          },
          system,
        )
      : expandSimpleTransaction(
          { type, amountMinor, accountId, categoryId: categoryId ?? undefined, currency: CURRENCY },
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
            /* The original, beside the taka figure above. `amountMinor` on the
             * transaction is always the workspace's own money; these two say
             * what was actually spent, and the rate is the ratio of the pair —
             * derived, never stored, because a rate is the one number here that
             * could not be an integer. The manual entry sheet writes exactly
             * these two columns from exactly this shape. */
            fxCurrency,
            fxAmountMinor: fxAmountMinor === null ? null : BigInt(fxAmountMinor),
            source,
            // The thread back to the text that proposed this entry.
            sourceDraftId: draft.id,
            entries: { create: entries.map((e) => entryData(e, ctx.workspaceId)) },
            /* Written with the entry, in the same transaction. A tag applied
               afterwards would leave a window in which the row exists untagged,
               and the report that reads it would be right about a state nobody
               intended. */
            ...(tagIds.length > 0
              ? {
                  tags: {
                    create: [...new Set(tagIds)].map((tagId) => ({
                      tagId,
                      workspaceId: ctx.workspaceId,
                    })),
                  },
                }
              : {}),
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
            /* Written here too, and this is what settles a draft parsed before
               these columns existed: after the accept its row says what was
               decided rather than what an older parser guessed, so `foreignOf`
               never has to re-read the message for it again. */
            fxCurrency,
            fxAmountMinor: fxAmountMinor === null ? null : BigInt(fxAmountMinor),
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

    /* A transfer into a DPS *is* that month's instalment, and the saver should
     * not have to say so twice. Without this the schedule keeps asking to be
     * paid after the money has already moved — and the button that answers it
     * would move the money a second time.
     *
     * Awaited, so the response the review screen refreshes from already has the
     * tick; it cannot throw, and it declines whenever the match is not exact.
     * The destination is the account that was debited: `direction` is which way
     * the money went for the account the *message* was about. */
    /* A premium receipt is an expense and books perfectly well as one. What it
     * also is, and what booking it as an expense does not say, is that one
     * instalment of a policy is settled — so the বীমা screen goes on asking for
     * a premium paid three weeks ago unless somebody says so. This is the same
     * tick `claimInstalment` does for a DPS, for policies, and it declines
     * unless exactly one policy and exactly one due premium fit. */
    const claimedPremium =
      isTransfer || direction === 'IN'
        ? null
        : await this.insurance.claimPremium(ctx.workspaceId, {
            policyHint: IngestionService.evidenceOf(draft.evidence).accountHint ?? null,
            amountMinor,
            date,
            transactionId,
          });

    if (isTransfer) {
      await this.savings.claimInstalment(ctx.workspaceId, {
        toAccountId: direction === 'IN' ? accountId : counterAccountId,
        amountMinor,
        date,
        transactionId,
      });
    }

    this.audit.emit({
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.id,
      action: 'ingestion.draft_accepted',
      entity: 'TransactionDraft',
      entityId: draft.id,
      before: {
        date: draft.date ? toLocalDateString(draft.date, ctx.timezone) : null,
        amountMinor: draft.amountMinor === null ? null : minorToNumber(draft.amountMinor),
        /* What the message itself said the money was. The rate the reviewer
           worked to is `amountMinor / fxAmountMinor` in the two records
           together — the audit log can show it without anything having stored
           a fractional number. */
        fxCurrency: stored?.currency ?? null,
        fxAmountMinor: stored?.amountMinor ?? null,
        direction: draft.direction,
        payee: draft.payee,
        confidence: draft.confidence,
      },
      after: {
        transactionId,
        date: dateIso,
        amountMinor,
        fxCurrency,
        fxAmountMinor,
        direction,
        accountId,
        categoryId,
        source,
        // Which fields the person had to correct. This is the signal a future
        // rule-quality screen (spec §4.5 stage 7) is built from.
        overrides: Object.keys(input).sort(),
      },
    });

    /* Remember the account number, so this bank is never asked about again.
       After the ledger write and outside it: a lesson is worth having and never
       worth failing a transaction for. */
    const learnedHint = isTransfer
      ? null
      : await this.learnAccountHint(ctx, draft, accountId).catch(() => null);

    return {
      ...(await this.presentOne(ctx, draft.id)),
      learnedHint,
      claimedPremium: claimedPremium?.insurer ?? null,
    };
  }

  /**
   * Teach the workspace the account number the reviewer just resolved by hand.
   *
   * The queue is fifty messages deep and a bank sends the same shape of alert
   * every day. Somebody who picks the right account once has already answered
   * the question for every message that bank will ever send, and asking again
   * tomorrow is the app failing to listen rather than the person failing to
   * configure it.
   *
   * Four things stop it, and each of them would otherwise make the books worse
   * rather than better:
   *
   *  - **A transfer.** Two accounts, and the message named one of them. Which
   *    one depends on which way the reviewer said the money went, and a lesson
   *    learned from the wrong side is a wrong answer repeated daily.
   *  - **Nothing to learn.** The account already answers to that number.
   *  - **Somebody else's number.** If another account is already known by it,
   *    teaching this one makes both ambiguous, and the matcher would then
   *    correctly refuse to answer for either. A rule that silently disables a
   *    rule that already worked is worse than no rule.
   *  - **A full list.** Twelve hints is far past a real account's worth; past
   *    that this is growing a column, not learning anything.
   *
   * Nothing here can throw into the accept path — see the call site. The
   * ledger row is already written and correct.
   */
  private async learnAccountHint(
    ctx: InboxContext,
    draft: DraftRow,
    accountId: string,
  ): Promise<string | null> {
    const quoted = IngestionService.evidenceOf(draft.evidence).accountHint;
    const tail = accountTailOf(quoted);
    if (!tail) return null;

    const accounts = await this.matchableAccounts(ctx.workspaceId);
    const chosen = accounts.find((account) => account.id === accountId);
    /* Not in the list at all — a system control account, or one archived
       between the parse and the accept. Nothing to teach it. */
    if (!chosen) return null;
    if (accountKnowsNumber(chosen, tail)) return null;
    if (accounts.some((other) => other.id !== accountId && accountKnowsNumber(other, tail))) {
      return null;
    }
    if ((chosen.matchHints ?? []).length >= MAX_LEARNED_HINTS) return null;

    await this.prisma.account.update({
      where: { id: accountId },
      data: { matchHints: { push: tail } },
    });

    this.audit.emit({
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.id,
      action: 'account.match_hint_learned',
      entity: 'Account',
      entityId: accountId,
      after: { hint: tail, quoted, fromDraftId: draft.id },
    });

    return tail;
  }

  /**
   * Accepting a message as ধার — money lent, money borrowed, or money coming
   * back on a loan that already exists.
   *
   * ## Why this could not be an ordinary accept
   *
   * ৳3,000 arrives in bKash and it is a borrower repaying. Booked as income it
   * invents ৳3,000 of earnings and leaves the debt standing at its full size —
   * so the ledger is wrong twice, and the one entry that actually mattered, the
   * outstanding balance coming down, never happens. The review screen had no
   * way to say any of this: its three tabs were খরচ, আয় and ট্রান্সফার, and a
   * repayment is none of them.
   *
   * Nothing here re-implements what a loan is. `LoansService` already knows how
   * to disburse one, how to take an instalment against it, how to freeze the
   * interest clock on the payment's own date and when to close it — so this
   * calls that, and its whole job is to attach the resulting transaction to the
   * draft so a message can never be applied twice.
   *
   * ## The order, and why the claim comes first
   *
   * The draft is marked ACCEPTED *before* the loan is written, and put back if
   * the write fails. The other way round — write, then claim — would let two
   * taps a second apart both reach the loans module and post two instalments,
   * with only the second failing to claim. A duplicate repayment quietly halves
   * somebody's outstanding balance; a draft briefly stuck in the wrong state is
   * recoverable and visible. So the cheap failure is the one that is allowed to
   * happen.
   */
  private async acceptAsLoan(
    ctx: InboxContext,
    draft: DraftRow,
    input: {
      dateIso: string;
      amountMinor: number;
      accountId: string;
      loanId?: string;
      loanDirection?: 'LENT' | 'BORROWED';
      personId?: string;
      personName?: string;
      counterAccountId?: string;
      note?: string;
    },
  ): Promise<DraftView> {
    /* A loan already has two sides — the account and the person — and naming a
       third would be a transfer and a loan at once, which is not a thing. */
    if (input.counterAccountId) {
      throw new BadRequestException('ধারের সাথে ট্রান্সফারের অ্যাকাউন্ট দেওয়া যায় না');
    }
    if (input.loanId && input.loanDirection) {
      throw new BadRequestException('ধার ফেরত না নতুন ধার — একটি বেছে নিন');
    }
    if (input.loanDirection && !input.personId && !input.personName?.trim()) {
      throw new BadRequestException('কার সাথে ধার — বেছে নিন বা নাম লিখুন');
    }

    const reviewedAt = new Date();
    /* The lock, taken before anything is written. A second accept arriving now
       no longer matches PENDING and is refused, which is what stops two
       instalments landing on one loan. */
    const claimed = await this.prisma.transactionDraft.updateMany({
      where: {
        id: draft.id,
        workspaceId: ctx.workspaceId,
        status: 'PENDING',
        transactionId: null,
      },
      data: { status: 'ACCEPTED', reviewedAt, reviewedByUserId: ctx.id },
    });
    if (claimed.count !== 1) {
      throw new BadRequestException('এই খসড়াটি ইতিমধ্যে যোগ করা হয়েছে');
    }

    let transactionId: string | null = null;
    try {
      if (input.loanId) {
        await this.loans.addPayment(ctx, input.loanId, {
          date: input.dateIso,
          amountMinor: input.amountMinor,
          method: 'CASH',
          accountId: input.accountId,
          attachmentIds: [],
          ...(input.note ? { note: input.note } : {}),
        });
        /* The instalment just written. Read back rather than returned, because
           `addPayment` answers with the whole loan — the shape the loan screen
           needs — and this needs one id out of it. */
        const payment = await this.prisma.loanPayment.findFirst({
          where: { loanId: input.loanId, workspaceId: ctx.workspaceId },
          orderBy: { createdAt: 'desc' },
          select: { transactionId: true },
        });
        transactionId = payment?.transactionId ?? null;
      } else {
        const loan = await this.loans.create(ctx, {
          direction: input.loanDirection as 'LENT' | 'BORROWED',
          principalMinor: input.amountMinor,
          loanDate: input.dateIso,
          accountId: input.accountId,
          interestType: 'NONE',
          interestMinor: 0,
          interestRateBps: 0,
          attachmentIds: [],
          ...(input.personId ? { personId: input.personId } : {}),
          ...(input.personName ? { personName: input.personName.trim() } : {}),
          ...(input.note ? { note: input.note } : {}),
        });
        transactionId = loan.loan.transactionId;
      }
    } catch (err) {
      /* Put it back. The loan was not written, so a draft left saying it was
         would hide a decision the person still has to make. */
      await this.prisma.transactionDraft.updateMany({
        where: {
          id: draft.id,
          workspaceId: ctx.workspaceId,
          status: 'ACCEPTED',
          transactionId: null,
        },
        data: { status: 'PENDING', reviewedAt: null, reviewedByUserId: null },
      });
      throw err;
    }

    /* The thread from the message to the entry it became. Null only if the loan
       module booked no cash movement, which it does not for these two paths —
       but the draft stays ACCEPTED either way, because the loan *was* written
       and offering the message again would double it. */
    if (transactionId) {
      await this.prisma.transactionDraft.updateMany({
        where: { id: draft.id, workspaceId: ctx.workspaceId, transactionId: null },
        data: { transactionId },
      });
      await this.prisma.transaction.updateMany({
        where: { id: transactionId, workspaceId: ctx.workspaceId },
        data: { sourceDraftId: draft.id },
      });
    }

    this.audit.emit({
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.id,
      action: 'ingestion.draft_accepted',
      entity: 'TransactionDraft',
      entityId: draft.id,
      after: {
        as: input.loanId ? 'loan_payment' : 'loan',
        loanId: input.loanId ?? null,
        direction: input.loanDirection ?? null,
        amountMinor: input.amountMinor,
        date: input.dateIso,
        accountId: input.accountId,
        transactionId,
      },
    });

    return this.presentOne(ctx, draft.id);
  }

  /**
   * The rule that says this message has been answered before, if there is one.
   *
   * Matched on the sender *and* the shape, never on the shape alone. "Your OTP
   * is #" is a sentence half the country's shortcodes send, and a rejection of
   * one sender's version is not a statement about another's — the owner said no
   * to a message, not to a form of words.
   *
   * The count is bumped here rather than in a job, so the screen that offers to
   * remove a rule can say what removing it would let back in.
   */
  private async matchingRule(
    workspaceId: string,
    sender: string | null,
    body: string,
  ): Promise<{ id: string } | null> {
    if (!sender) return null;
    const shape = messageShape(body);
    if (!isUsableShape(shape)) return null;

    const rule = await this.prisma.ingestionRule.findFirst({
      where: { workspaceId, sender, shape },
      select: { id: true },
    });
    if (!rule) return null;

    await this.prisma.ingestionRule.update({
      where: { id: rule.id },
      data: { matchCount: { increment: 1 }, lastMatchAt: new Date() },
    });
    return rule;
  }

  /**
   * Remember a shape the owner has just said no to.
   *
   * Only for the two reasons that are about the message rather than about this
   * copy of it. `NOT_MINE` and `BAD_PARSE` describe a kind of message that will
   * arrive again unchanged; `DUPLICATE` is a fact about one entry already in
   * the books, and `OTHER` is whatever the person did not have a word for.
   * Learning from either of those would suppress messages nobody asked to
   * suppress.
   *
   * Idempotent by (workspace, sender, shape): rejecting the same shape twice
   * teaches nothing new, and the count is the rule's own, not a tally of how
   * often it was taught.
   */
  private async learnRejection(
    ctx: InboxContext,
    draft: DraftRow,
    reason: string,
  ): Promise<{ id: string; shape: string } | null> {
    if (reason !== 'NOT_MINE' && reason !== 'BAD_PARSE') return null;
    const message = draft.message;
    if (!message?.sender || !message.body) return null;

    const shape = messageShape(message.body);
    /* A shape that folds to almost nothing is every message from that sender,
       and one rejection is not permission to silence a bank. */
    if (!isUsableShape(shape)) return null;

    const existing = await this.prisma.ingestionRule.findFirst({
      where: { workspaceId: ctx.workspaceId, sender: message.sender, shape },
      select: { id: true },
    });
    if (existing) return { id: existing.id, shape };

    const rule = await this.prisma.ingestionRule.create({
      data: {
        workspaceId: ctx.workspaceId,
        sender: message.sender,
        shape,
        reason,
        /* One line of the message it was learned from. A rule is a fold of a
           sentence and unreadable on its own; the screen offering to remove one
           has to show what it was taught by. */
        sample: message.body.replace(/\s+/g, ' ').trim().slice(0, 200),
        createdByUserId: ctx.id,
      },
      select: { id: true },
    });

    this.audit.emit({
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.id,
      action: 'ingestion.rule_learned',
      entity: 'IngestionRule',
      entityId: rule.id,
      after: { sender: message.sender, reason, shape },
    });

    return { id: rule.id, shape };
  }

  /** Every shape this workspace has taught the inbox, newest first. */
  async listRules(ctx: TenantContext): Promise<
    {
      id: string;
      sender: string;
      reason: string;
      sample: string;
      matchCount: number;
      lastMatchAt: string | null;
      createdAt: string;
    }[]
  > {
    const rows = await this.prisma.ingestionRule.findMany({
      where: { workspaceId: ctx.workspaceId },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return rows.map((row) => ({
      id: row.id,
      sender: row.sender,
      reason: row.reason,
      sample: row.sample,
      matchCount: row.matchCount,
      lastMatchAt: row.lastMatchAt ? row.lastMatchAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /**
   * Forget a shape.
   *
   * The messages it suppressed are not revisited: they are stored, they are on
   * the messages screen, and re-raising decisions about mail from last month
   * because a rule was removed today would be a surprise nobody asked for. From
   * now on, that shape asks again.
   */
  async removeRule(ctx: TenantContext, id: string): Promise<void> {
    const gone = await this.prisma.ingestionRule.deleteMany({
      where: { id, workspaceId: ctx.workspaceId },
    });
    if (gone.count !== 1) throw new NotFoundException('নিয়মটি পাওয়া যায়নি');

    this.audit.emit({
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.id,
      action: 'ingestion.rule_removed',
      entity: 'IngestionRule',
      entityId: id,
    });
  }

  /**
   * Say no. Nothing is written to the ledger and the raw message stays, so the
   * parse that produced the draft can still be looked at.
   */
  async reject(ctx: InboxContext, id: string, input: RejectDraftInput): Promise<DraftView> {
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
    /* Before the audit line, so the log says whether it taught anything. */
    const learned = await this.learnRejection(ctx, draft, input.reason).catch(() => null);

    this.audit.emit({
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.id,
      action: 'ingestion.draft_rejected',
      entity: 'TransactionDraft',
      entityId: draft.id,
      after: {
        reason: input.reason,
        learnedRuleId: learned?.id ?? null,
        confidence: draft.confidence,
        parserName: draft.message?.parserName ?? null,
        messageId: draft.messageId,
      },
    });

    return { ...(await this.presentOne(ctx, draft.id)), learnedRule: learned !== null };
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
    accountIds: readonly string[],
    categoryId: string | null,
  ): Promise<void> {
    for (const accountId of accountIds) {
      const account = await this.prisma.account.findFirst({
        where: { id: accountId, workspaceId, deletedAt: null, systemKey: null },
        select: { id: true, isArchived: true },
      });
      if (!account) throw new NotFoundException('অ্যাকাউন্ট পাওয়া যায়নি');
      if (account.isArchived) {
        throw new BadRequestException('আর্কাইভ করা অ্যাকাউন্টে লেনদেন করা যায় না');
      }
    }

    /* Null for a transfer, and not an oversight: moving money between two of
       your own accounts is not spending, so there is no খাত it could belong
       to. See the accept path, which is where that decision is made. */
    if (categoryId === null) return;
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

  private async presentOne(ctx: InboxContext, id: string): Promise<DraftView> {
    const row = await this.requireDraft(ctx.workspaceId, id);
    const accounts = IngestionService.wantsAccount(row)
      ? await this.matchableAccounts(ctx.workspaceId)
      : [];
    return IngestionService.present(row, ctx.timezone, ctx.currency, accounts);
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

  // --- money that was not the workspace's ------------------------------------

  /**
   * The currency the message wrote its amount in, when that is not the books'.
   *
   * Two things it deliberately does not do. It does not go looking for the
   * first code anywhere in the text — it asks what code stands against the very
   * figure the parser chose, so a reference number reading `Ref SAR 12345`
   * cannot rename somebody's taka. And it does not convert, because the rate
   * that applied is the card issuer's and is not in the message, on any screen
   * here, or in any feed this product pays for.
   */
  private static foreignAmountIn(
    body: string,
    evidence: Record<string, string>,
    baseCurrency: string,
  ): CurrencyAmount | null {
    const quoted = evidence.amountMinor;
    if (!quoted) return null;
    const found = currencyForAmount(body, quoted);
    /* The books' own currency, spelled out. `BDT 5,000` in a taka workspace is
       not a foreign transaction, it is a bank being explicit. */
    if (!found || found.currency === (baseCurrency || DEFAULT_CURRENCY)) return null;
    return found;
  }

  /**
   * Move the amount's quotation onto the field it actually belongs to.
   *
   * `evidence.amountMinor` means "this is the text the taka figure was read
   * from", and for a dollar charge there is no taka figure — leaving the entry
   * there would have the review screen print `4.6` beside an empty box under a
   * quotation mark, which is the parser claiming something it did not read. The
   * span moves to `fxAmountMinor` and widens to include the code, so what the
   * screen highlights is `USD 4.6`: the whole fact, not half of it.
   */
  private static fxEvidence(
    evidence: Record<string, string>,
    quoted: string,
  ): Record<string, string> {
    const { amountMinor: _read, ...rest } = evidence;
    return { ...rest, fxAmountMinor: quoted };
  }

  /**
   * What a draft says about foreign money — from its columns, or from its
   * message when the columns predate them.
   *
   * The 47 drafts sitting in the owner's queue when these columns shipped were
   * parsed by code that could not see a currency, so their `fxCurrency` is null
   * and their `amountMinor` holds a dollar figure mislabelled as taka. Their raw
   * message is still stored — it is kept for precisely this, so that a parser
   * which got something wrong can be fixed against the text that broke it — so
   * it is read again here rather than left to be accepted wrongly.
   *
   * **Pending drafts only.** A draft that has been accepted or rejected is the
   * record of a decision somebody made, and re-interpreting it after the fact
   * would change what the audit trail says they were shown. Nothing is written
   * either: this is a reading, and the accept path uses the same one, so the
   * screen and the ledger cannot end up disagreeing about the same row.
   */
  private static foreignOf(
    row: DraftRow,
    baseCurrency: string,
  ): { currency: string; amountMinor: number; quoted: string | null } | null {
    if (row.fxCurrency !== null && row.fxAmountMinor !== null) {
      return {
        currency: row.fxCurrency,
        amountMinor: minorToNumber(row.fxAmountMinor),
        quoted: null,
      };
    }
    if (row.status !== 'PENDING' || !row.message) return null;

    const found = IngestionService.foreignAmountIn(
      row.message.body,
      IngestionService.evidenceOf(row.evidence),
      baseCurrency,
    );
    if (!found) return null;
    return { currency: found.currency, amountMinor: found.amountMinor, quoted: found.text };
  }

  /**
   * Is this draft still waiting for somebody to say which account it was?
   *
   * Only a pending draft is. One that has been accepted or rejected is the
   * record of a decision a person made, and re-reading it afterwards would
   * change what the audit trail says they were shown.
   */
  private static wantsAccount(row: DraftRow): boolean {
    return row.status === 'PENDING' && row.accountId === null;
  }

  /**
   * The account this draft's message names, read at display time.
   *
   * The same reading the ingest path does, repeated here for the drafts that
   * were parsed before it existed and for the ones whose account the owner has
   * only just told the app about. A hint typed on the accounts screen today
   * should light up the queue that is already sitting there, not just the next
   * message to arrive — and nothing is written, so the screen and the accept
   * path agree because they run the same function, not because a backfill kept
   * them in step.
   */
  private static hintedAccount(
    row: DraftRow,
    accounts: readonly AccountMatchCandidate[],
  ): string | null {
    if (accounts.length === 0 || !IngestionService.wantsAccount(row)) return null;
    const evidence = IngestionService.evidenceOf(row.evidence);
    /* The quoted span, not the parsed digits: `A/C (***6948)` as the message
       wrote it. `matchAccount` reduces both sides to digits, so the quotation
       is as good a key as the parse and does not need the message re-parsed. */
    return (
      matchAccount(accounts, {
        accountHint: evidence.accountHint ?? null,
        sender: row.message?.sender ?? null,
        body: row.message?.body ?? null,
      })?.accountId ?? null
    );
  }

  private static present(
    row: DraftRow,
    timezone: string,
    baseCurrency: string,
    accounts: readonly AccountMatchCandidate[] = [],
  ): DraftView {
    const foreign = IngestionService.foreignOf(row, baseCurrency);

    /* A retro-read draft still carries `evidence.amountMinor` from the parse
       that could not see a currency. The quotation moves to the field it
       belongs to, exactly as it does for a draft parsed today, so one screen
       does not have to know which vintage of row it is looking at. */
    const evidence = IngestionService.evidenceOf(row.evidence);
    const quoted = foreign?.quoted;
    const confidence = foreign ? Math.min(row.confidence, FX_CONFIDENCE_CEILING) : row.confidence;

    return {
      id: row.id,
      status: row.status,
      date: row.date ? toLocalDateString(row.date, timezone) : null,
      /* Withheld rather than converted when the money was another currency's.
         For a draft written today the column is already null; for one written
         before these columns existed it holds a dollar figure under a taka
         name, and repeating that on a screen is the bug this closes. */
      amountMinor: foreign || row.amountMinor === null ? null : minorToNumber(row.amountMinor),
      fxCurrency: foreign?.currency ?? null,
      fxAmountMinor: foreign?.amountMinor ?? null,
      direction: IngestionService.directionOf(row.direction),
      payee: row.payee,
      accountId: row.accountId ?? IngestionService.hintedAccount(row, accounts),
      categoryId: row.categoryId,
      confidence,
      needsReview: confidence < REVIEW_THRESHOLD,
      suggestedBy: row.suggestedBy,
      /* Only an accept can teach a hint, and only a reject can teach a rule;
         each says so on its own response. */
      learnedHint: null,
      learnedRule: false,
      claimedPremium: null,
      evidence: quoted ? IngestionService.fxEvidence(evidence, quoted) : evidence,
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
