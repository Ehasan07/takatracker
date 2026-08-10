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
import { cuid, isoDate, positiveMinorAmount } from '@hishab/shared';
import { z } from 'zod';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { zodPipe } from '../common/zod.pipe';
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
const webhookSchema = z.object({
  channel: z.enum(INGESTION_CHANNELS).default('WEBHOOK'),
  /** Shortcode, sender address, or whatever the forwarder calls itself. */
  sender: z.string().max(200).optional(),
  /** When it reached the device. Defaults to now; a future stamp is pulled back. */
  receivedAt: z.string().datetime({ offset: true }).optional(),
  body: z.string().min(1).max(MAX_BODY_LENGTH),
});
export type WebhookBody = z.infer<typeof webhookSchema>;

const listDraftsQuerySchema = z.object({
  status: optionalQuery(z.enum(DRAFT_STATUSES)),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: optionalQuery(z.string().min(1)),
});
export type ListDraftsQuery = z.infer<typeof listDraftsQuerySchema>;

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
  categoryId: cuid.optional(),
  description: z.string().max(500).optional(),
  notes: z.string().max(2000).optional(),
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
@Controller('ingestion')
export class IngestionWebhookController {
  constructor(private readonly ingestion: IngestionService) {}

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
    if (!workspaceId || !this.ingestion.verifyWebhookSecret(workspaceId, secret)) {
      throw new UnauthorizedException(INGEST_UNAUTHORISED);
    }
    /* 200, not 202: the parse is a few regexes and happens inline, so the
     * forwarder gets the draft id back and can show the user that it landed.
     * Moving to 202 with a worker queue is a change to make when a parser gets
     * slow enough to be worth it, not before. */
    return this.ingestion.ingest(workspaceId, body);
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
