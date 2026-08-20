import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { cuid, isoDate, isSupportedCurrency, positiveMinorAmount } from '@hishab/shared';
import { z } from 'zod';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { zodPipe } from '../common/zod.pipe';
import { TransactionsService } from '../transactions/transactions.service';
import {
  INGEST_SECRET_HEADER,
  INGEST_UNAUTHORISED,
  INGEST_WORKSPACE_HEADER,
  IngestionService,
} from './ingestion.service';

/* Mirrors of the Prisma enums, kept local until ingestion earns a place in
 * @hishab/shared — the same holding pattern loans and savings use, so there is
 * one obvious file to move them out of. */
const INGESTION_CHANNELS = ['SMS', 'EMAIL', 'WEBHOOK'] as const;
const DRAFT_STATUSES = ['PENDING', 'ACCEPTED', 'REJECTED', 'DUPLICATE'] as const;
const DIRECTIONS = ['IN', 'OUT'] as const;

/**
 * 32 KB, per spec §4.2. A bank alert is a few hundred bytes; anything at this
 * size is a mistake or an attack, and either way it should be refused at the
 * edge rather than stored. Characters rather than bytes, which is close enough
 * for a sanity cap and does not need the body buffered twice to measure.
 */
const MAX_BODY_LENGTH = 32_768;

/**
 * Per minute, per **workspace** — the number is unchanged, the axis is not.
 *
 * `WorkspaceThrottlerGuard` verifies the secret in `x-hishab-ingest-secret`
 * before it will believe the workspace in `x-hishab-workspace`, and only then
 * counts the request against that workspace. So a hundred forwarders behind one
 * carrier NAT no longer share a budget, and one workspace's runaway forwarder
 * can no longer lock the others out.
 *
 * A request that fails that check — no secret, wrong secret, no root secret
 * configured — is counted against the caller's address instead, so guessing the
 * secret is still capped at this rate per IP. The e2e suite drives everything
 * from 127.0.0.1, so the ceiling is raised under test exactly as the global
 * limiter does it.
 */
const WEBHOOK_RATE_LIMIT = Number(
  process.env.INGESTION_THROTTLE_LIMIT ?? (process.env.NODE_ENV === 'test' ? 100_000 : 60),
);

/**
 * A cleared filter arrives as `?status=` — an empty string, not an absent key.
 * Treating that as "no filter" is the difference between a working "সব" chip
 * and a 400 the user cannot explain.
 */
const optionalQuery = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (value === '' || value === null ? undefined : value), schema.optional());

/**
 * What an SMS-forwarder app posts.
 *
 * Raw text only. Spec §4.2 also describes a structured body — an already-parsed
 * `{ amount, direction, … }` from a bank's own webhook — which would skip the
 * parser and arrive at full confidence. It is deliberately not accepted yet:
 * there is no bank sending us one, and an endpoint that takes a caller's word
 * for an amount needs a per-source trust decision that does not exist here.
 */
const webhookFields = z.object({
  channel: z.enum(INGESTION_CHANNELS).default('WEBHOOK'),
  /** Shortcode, sender address, or whatever the forwarder calls itself. */
  sender: z.string().max(200).optional(),
  /** When it reached the device. Defaults to now; a future stamp is pulled back. */
  receivedAt: z.string().datetime({ offset: true }).optional(),
  /* The message itself.
   *
   * The refusal is spelled out because of who reads it: not a developer with
   * the schema open, but somebody standing in Shortcuts wondering why the run
   * they just pressed came back red. Zod's own `String must contain at least 1
   * character(s)` names the constraint and not the fix — and the fix is nearly
   * always the same one, because a Message automation run by hand has no
   * incoming message and hands the variable over empty. */
  body: z
    .string()
    .min(1, 'বার্তার লেখা আসেনি — body ঘরে বার্তার ভেরিয়েবলটি বসান (আইফোনে Shortcut Input)')
    .max(MAX_BODY_LENGTH),
  /**
   * The credentials, when the caller cannot set headers.
   *
   * iOS Shortcuts can, but the field editor is two taps and the header editor
   * is a list of unlabelled `Key`/`name` rows that is very easy to fill in
   * backwards — which is exactly how the first attempt at this failed, with the
   * workspace id typed in as a header *name*. A forwarder that already builds a
   * JSON body can put two more fields in it and never open the header sheet.
   *
   * Headers win when both are present. Neither is stored: `ingest` reads four
   * fields off this object and these are not among them.
   */
  workspace: z.string().max(100).optional(),
  secret: z.string().max(200).optional(),
});

/**
 * The same message under the names other forwarders already use.
 *
 * Every SMS-forwarding app and Shortcut in the world has settled on its own
 * spelling — `message`, `text`, `body`; `source`, `channel`; `from`, `sender` —
 * and the person wiring one up should not have to rename fields to match us.
 * The aliases are read only when the canonical name is absent, so a body that
 * says both is never ambiguous.
 *
 * `source: "sms"` is upper-cased on the way in for the same reason: no
 * forwarder types an enum in capitals, and refusing it would be pedantry.
 */
const webhookSchema = z.preprocess((raw) => {
  if (typeof raw !== 'object' || raw === null) return raw;
  const it = { ...(raw as Record<string, unknown>) };

  const alias = (canonical: string, ...others: string[]): void => {
    if (it[canonical] !== undefined && it[canonical] !== '') return;
    for (const other of others) {
      if (it[other] !== undefined && it[other] !== '') {
        it[canonical] = it[other];
        return;
      }
    }
  };

  alias('body', 'message', 'text');
  alias('sender', 'from');
  alias('channel', 'source');
  alias('workspace', 'workspaceId');

  if (typeof it.channel === 'string') it.channel = it.channel.toUpperCase();
  return it;
}, webhookFields);

export type WebhookBody = z.infer<typeof webhookSchema>;

const listDraftsQuerySchema = z.object({
  status: optionalQuery(z.enum(DRAFT_STATUSES)),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: optionalQuery(z.string().min(1)),
});
export type ListDraftsQuery = z.infer<typeof listDraftsQuerySchema>;

/** Every message, not only the ones that raised a decision. */
const listMessagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: optionalQuery(z.string().min(1)),
});
export type ListMessagesQuery = z.infer<typeof listMessagesQuerySchema>;

/**
 * Everything is optional and everything overrides the parser. A field left out
 * keeps whatever the draft proposed; a field supplied wins. The service refuses
 * the accept if the *merged* result is still missing something the ledger needs,
 * so a low-confidence draft is acceptable once a person has filled the gaps and
 * a high-confidence one is refused if they cleared a field.
 */
const acceptDraftSchema = z.object({
  date: isoDate.optional(),
  amountMinor: positiveMinorAmount.optional(),
  direction: z.enum(DIRECTIONS).optional(),
  payee: z.string().max(200).nullable().optional(),
  accountId: cuid.optional(),
  /**
   * The account on the *other* side, when this was a transfer between two of
   * the reviewer's own accounts.
   *
   * Absent for the ordinary case, and there is deliberately no way for the
   * parser to fill it: a bank message sees one account and cannot know whether
   * the money it describes came from a wallet of yours or from your employer.
   * Supplying it says "this was not income or spending" and the accept books a
   * TRANSFER instead — with no খাত, because there is nothing for one to mean.
   */
  counterAccountId: cuid.optional(),
  categoryId: cuid.optional(),
  description: z.string().max(500).optional(),
  notes: z.string().max(2000).optional(),
  /* What the money actually was, when the message said it was not the
   * workspace's own — the same pair, with the same names and the same units, as
   * `transactionWriteSchema` uses for the ledger itself. `amountMinor` above
   * stays in the workspace's currency whatever these say; the reviewer converts
   * at a rate they declare and these two record the original beside it.
   *
   * `nullish`, so an accept can say "not another currency after all" as well as
   * "unchanged" — a parser that read a code out of a reference number has to be
   * correctable from the screen rather than only by rejecting the whole draft.
   *
   * Deliberately no both-or-neither rule here: the draft supplies whichever half
   * the request leaves out, so the pairing can only be judged after the merge,
   * and `IngestionService.accept` is where that happens. */
  fxCurrency: z
    .string()
    .trim()
    .toUpperCase()
    .refine(isSupportedCurrency, 'এই কারেন্সিটি সমর্থিত নয়')
    .nullish(),
  fxAmountMinor: positiveMinorAmount.nullish(),
  /**
   * A repayment on a loan that already exists.
   *
   * The case the review screen could not record at all: ৳3,000 arrives in
   * bKash and it is the money somebody borrowed coming back. Booked as income
   * it invents earnings and leaves the debt standing at its full size, so the
   * one entry that was needed — the balance coming down — never happens. With
   * this the accept posts through the loan itself: the instalment, the ledger
   * movement and the closing of the loan when it reaches zero, all in the one
   * place that already knows how.
   */
  loanId: cuid.optional(),
  /**
   * A loan being *made* from this message, rather than repaid.
   *
   * `LENT` for money going out to somebody, `BORROWED` for money arriving from
   * them. Needs a counterparty — an existing `personId`, or a `personName` to
   * create one from, exactly as `POST /loans` takes them.
   */
  loanDirection: z.enum(['LENT', 'BORROWED']).optional(),
  personId: cuid.optional(),
  personName: z.string().trim().min(1).max(120).optional(),
});
export type AcceptDraftInput = z.infer<typeof acceptDraftSchema>;

/**
 * One tap, one reason (spec §4.6). It has no column and does not need one — it
 * goes in the audit log, which is where a fact about somebody's decision
 * belongs and where a rule-quality report will later read it from.
 */
const rejectDraftSchema = z.object({
  reason: z.enum(['DUPLICATE', 'NOT_MINE', 'BAD_PARSE', 'OTHER']).default('OTHER'),
});
export type RejectDraftInput = z.infer<typeof rejectDraftSchema>;

/**
 * The inbound door.
 *
 * **No JWT.** The caller is an SMS-forwarder app on somebody's phone, not a
 * browser with a session — it has no login, no refresh, and no user in front of
 * it at three in the morning when the alert arrives. A per-workspace shared
 * secret in a header is what stands between this endpoint and the open
 * internet, and it is compared in constant time; see
 * `IngestionService.webhookSecretFor` for exactly how it is derived.
 */
/**
 * A completed entry, from a client that has already asked a person.
 *
 * The webhook posts *messages* and gets drafts back, because nothing should
 * reach a ledger unreviewed. This posts a transaction, and the difference is
 * that the review already happened — in the owner's own SMS console, where a
 * person picked the category and the account before pressing save.
 *
 * It is the same credential and therefore the same trust boundary: whoever
 * holds a workspace's ingest secret can now write to its books rather than only
 * propose. That is a real widening and it is deliberate; the alternative was a
 * second credential to keep in step, and one secret in two places the owner
 * controls is easier to reason about than two secrets in two places.
 */
const entrySchema = z
  .object({
    workspace: z.string().max(100).optional(),
    secret: z.string().max(200).optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
    amountMinor: z.number().int().positive(),
    direction: z.enum(['IN', 'OUT', 'TRANSFER']),
    accountId: z.string().min(1),
    /** Where a transfer lands. Required for `TRANSFER`, meaningless otherwise. */
    toAccountId: z.string().min(1).optional(),
    /** Required for income and expense; a transfer has no category by design. */
    categoryId: z.string().min(1).optional(),
    description: z.string().max(500).optional(),
    notes: z.string().max(2000).optional(),
  })
  .refine((v) => v.direction === 'TRANSFER' || Boolean(v.categoryId), {
    path: ['categoryId'],
    message: 'Choose a category',
  })
  .refine((v) => v.direction !== 'TRANSFER' || Boolean(v.toAccountId), {
    path: ['toAccountId'],
    message: 'Choose where the money went',
  });

@Controller('ingestion')
export class IngestionWebhookController {
  constructor(
    private readonly ingestion: IngestionService,
    private readonly transactions: TransactionsService,
  ) {}

  /**
   * Prove the caller holds this workspace's secret, and say which workspace.
   *
   * One 401 for every failure — bad secret, missing header, unknown workspace.
   * Telling them apart would turn this into a way of discovering which
   * workspace ids exist.
   */
  private tenantFrom(
    headerWorkspace: string | undefined,
    headerSecret: string | undefined,
    body: { workspace?: string; secret?: string },
  ): string {
    const tenant = headerWorkspace || body.workspace;
    const proof = headerSecret ?? body.secret;
    if (!tenant || !this.ingestion.verifyWebhookSecret(tenant, proof)) {
      throw new UnauthorizedException(INGEST_UNAUTHORISED);
    }
    return tenant;
  }

  @Post('webhook')
  @HttpCode(200)
  @Throttle({ default: { limit: WEBHOOK_RATE_LIMIT, ttl: 60_000 } })
  webhook(
    @Headers(INGEST_WORKSPACE_HEADER) workspaceId: string | undefined,
    @Headers(INGEST_SECRET_HEADER) secret: string | undefined,
    @Body(zodPipe(webhookSchema)) body: WebhookBody,
  ) {
    /* One 401 for every failure — bad secret, missing header, unknown
     * workspace. Telling them apart would turn this into a way of discovering
     * which workspace ids exist. */
    /* Headers first, body second. A forwarder that can set headers should, and
       one that cannot is not turned away for it. */
    const tenant = workspaceId || body.workspace;
    const proof = secret ?? body.secret;
    if (!tenant || !this.ingestion.verifyWebhookSecret(tenant, proof)) {
      throw new UnauthorizedException(INGEST_UNAUTHORISED);
    }
    /* 200, not 202: the parse is a few regexes and happens inline, so the
     * forwarder gets the draft id back and can show the user that it landed.
     * Moving to 202 with a worker queue is a change to make when a parser gets
     * slow enough to be worth it, not before. */
    return this.ingestion.ingest(tenant, body);
  }

  /**
   * `GET /v1/ingestion/options` — what to put in a forwarder's two dropdowns.
   *
   * Names and ids only. A console filling in "which account, which category"
   * needs no balances, and an endpoint that hands over what it does not need is
   * an endpoint that leaks the moment its credential does.
   *
   * The credential is in the query string here rather than a header, because
   * the caller is a browser page fetching on load. That is a weaker place for a
   * secret — query strings reach access logs — so it is offered *as well as*
   * the headers rather than instead of them, and a client that can set headers
   * should.
   */
  @Get('options')
  @Throttle({ default: { limit: WEBHOOK_RATE_LIMIT, ttl: 60_000 } })
  async options(
    @Headers(INGEST_WORKSPACE_HEADER) headerWorkspace: string | undefined,
    @Headers(INGEST_SECRET_HEADER) headerSecret: string | undefined,
    @Query('workspace') queryWorkspace?: string,
    @Query('secret') querySecret?: string,
  ) {
    const tenant = this.tenantFrom(headerWorkspace, headerSecret, {
      workspace: queryWorkspace,
      secret: querySecret,
    });
    return this.ingestion.forwarderOptions(tenant);
  }

  /**
   * `POST /v1/ingestion/entries` — a transaction somebody already reviewed.
   *
   * Goes through `TransactionsService.create`, which is the same door the app's
   * own entry sheet uses: the same ownership checks, the same plan meter, the
   * same double-entry expansion, the same audit row. A second write path that
   * built its own entries would be a second place for the ledger to be wrong.
   */
  @Post('entries')
  @HttpCode(201)
  @Throttle({ default: { limit: WEBHOOK_RATE_LIMIT, ttl: 60_000 } })
  async entry(
    @Headers(INGEST_WORKSPACE_HEADER) headerWorkspace: string | undefined,
    @Headers(INGEST_SECRET_HEADER) headerSecret: string | undefined,
    @Body(zodPipe(entrySchema)) body: z.infer<typeof entrySchema>,
  ) {
    const tenant = this.tenantFrom(headerWorkspace, headerSecret, body);
    return this.ingestion.entryFromForwarder(tenant, body);
  }
}

/** The review inbox. Ordinary session-authenticated screens. */
@Controller('ingestion')
@UseGuards(JwtAuthGuard)
export class IngestionController {
  constructor(private readonly ingestion: IngestionService) {}

  /**
   * The URL, headers and secret to paste into a forwarder app.
   *
   * Not in the original endpoint list, but the feature is unusable without it:
   * the secret is derived server-side and there would otherwise be no way for
   * anyone to learn their own.
   */
  /**
   * `GET /v1/ingestion/messages` — everything this workspace's phone forwarded.
   *
   * Separate from `/drafts` because they answer different questions. The drafts
   * list is a queue of decisions; this is a log of arrivals, and it is the only
   * screen that can answer "is my phone actually sending anything".
   */
  @Get('messages')
  messages(
    @CurrentUser() user: AuthUser,
    @Query(zodPipe(listMessagesQuerySchema)) query: ListMessagesQuery,
  ) {
    return this.ingestion.listMessages(user, query);
  }

  @Get('webhook-config')
  webhookConfig(@CurrentUser() user: AuthUser) {
    return this.ingestion.webhookConfig(user);
  }

  @Get('drafts')
  listDrafts(
    @CurrentUser() user: AuthUser,
    @Query(zodPipe(listDraftsQuerySchema)) query: ListDraftsQuery,
  ) {
    return this.ingestion.listDrafts(user, query);
  }

  @Post('drafts/:id/accept')
  @HttpCode(200)
  accept(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(zodPipe(acceptDraftSchema)) body: AcceptDraftInput,
  ) {
    return this.ingestion.accept(user, id, body);
  }

  @Post('drafts/:id/reject')
  @HttpCode(200)
  reject(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(zodPipe(rejectDraftSchema)) body: RejectDraftInput,
  ) {
    return this.ingestion.reject(user, id, body);
  }

  /** The raw message behind a draft, for working out why a parse came out wrong. */
  @Get('messages/:id')
  findMessage(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.ingestion.findMessage(user, id);
  }
}
