import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { MIGRATION_DECISIONS } from '@hishab/core';
import { cuid, isoDate } from '@hishab/shared';
import { z } from 'zod';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { zodPipe } from '../common/zod.pipe';
import { MigrationAccessGuard, migrationAllowed } from './migration-access.guard';
import { MigrationService } from './migration.service';

/**
 * The migration endpoints.
 *
 * Read them in the order somebody uses them: pull, decide (one row at a time or
 * a whole spreadsheet), apply, and — if it was wrong — roll back.
 */

const pullSchema = z.object({
  /* The credential to the other product. Long, because it is a JWT, and never
     stored: it lives for the two calls the pull makes. */
  token: z.string().min(20).max(4000),
});
export type PullInput = z.infer<typeof pullSchema>;

/**
 * What the other product never held, in the units a person types.
 *
 * Every field optional and every one bounded: a due day of 47 is a typo that
 * would silently never fire a reminder, and a term of 9,000 months is a
 * fat-fingered figure that would generate a schedule nobody wants.
 */
const detailSchema = z
  .object({
    statementDay: z.number().int().min(1).max(31).nullish(),
    dueDay: z.number().int().min(1).max(31).nullish(),
    reminderLeadDays: z.number().int().min(0).max(30).nullish(),
    installmentMinor: z.number().int().min(0).nullish(),
    principalMinor: z.number().int().min(0).nullish(),
    termMonths: z.number().int().min(1).max(600).nullish(),
    /** Basis points, capped at a 100% annual rate. */
    profitRateBps: z.number().int().min(0).max(10_000).nullish(),
    premiumMinor: z.number().int().min(0).nullish(),
    sumAssuredMinor: z.number().int().min(0).nullish(),
    startDate: isoDate.nullish(),
    /* The same ceilings the category screen enforces, so a migrated category
       cannot hold what a hand-made one could not. */
    aliases: z.array(z.string().trim().min(1).max(40)).max(24).nullish(),
  })
  .strict();

const decisionSchema = z.object({
  decision: z.enum(MIGRATION_DECISIONS).optional(),
  targetType: z.string().max(40).optional(),
  targetId: cuid.nullish(),
  detail: detailSchema.nullish(),
  /** Empty clears the rename, so it can be undone. */
  name: z.string().max(120).optional(),
});
export type DecisionInput = z.infer<typeof decisionSchema>;

const bulkDecisionSchema = decisionSchema.extend({
  /* 400 is past every real chart of accounts and short enough that one request
     cannot become a long-running write. */
  itemIds: z.array(cuid).min(1).max(400),
});
export type BulkDecisionInput = z.infer<typeof bulkDecisionSchema>;

const applySchema = z.object({
  /** Absent means the whole batch. */
  itemIds: z.array(cuid).min(1).max(1000).optional(),
});
export type ApplyInput = z.infer<typeof applySchema>;

/**
 * One page of history.
 *
 * `offset` is the other product's own bookmark handed straight back, never a
 * row count of ours — the client sends what the last page returned and nothing
 * else. Absent means start at the beginning.
 */
const recordsSchema = z
  .object({
    token: z.string().min(20).max(4000),
    offset: z.number().int().min(0).max(10_000_000).optional(),
    /* An optional window, both local dates, `to` exclusive. Sent together or not
     at all: half a range is not an instruction the server can guess the rest
     of, and guessing would quietly import a different set than was asked for. */
    from: isoDate.optional(),
    to: isoDate.optional(),
  })
  .refine((v) => (v.from === undefined) === (v.to === undefined), {
    message: 'শুরু ও শেষ — দুইটি তারিখই দিতে হবে, নয়তো একটিও নয়',
    path: ['to'],
  })
  .refine((v) => !v.from || !v.to || v.from < v.to, {
    message: 'শেষের তারিখ শুরুর পরে হতে হবে',
    path: ['to'],
  });
export type RecordsInput = z.infer<typeof recordsSchema>;

const csvSchema = z.object({
  /* Two hundred rows of Bengali names with a BOM. A megabyte is far more than
     that and far less than something worth streaming. */
  csv: z.string().min(1).max(1_000_000),
});
export type CsvInput = z.infer<typeof csvSchema>;

@Controller('migration')
@UseGuards(JwtAuthGuard)
export class MigrationController {
  constructor(private readonly migration: MigrationService) {}

  /**
   * Whether to draw the link at all.
   *
   * The one route without the allowlist guard: the navigation has to be able to
   * ask, and an answer of `false` is not a refusal — it is the answer.
   */
  @Get('availability')
  availability(@CurrentUser() user: AuthUser) {
    return { allowed: migrationAllowed(user.email) };
  }

  @Get('batches')
  list(@CurrentUser() user: AuthUser) {
    return this.migration.list(user.workspaceId);
  }

  /**
   * Start from a spreadsheet.
   *
   * Not behind the allowlist, unlike the Wallet pull. The reason that one is
   * gated is that it asks for a live credential to another finance app; a CSV
   * of headings asks for nothing, so there is nothing to protect anybody from.
   */
  @Post('csv/start')
  @HttpCode(201)
  startFromCsv(@CurrentUser() user: AuthUser, @Body(zodPipe(csvSchema)) body: CsvInput) {
    return this.migration.startFromCsv(user.workspaceId, user.id, body.csv);
  }

  @Post('wallet/pull')
  @UseGuards(MigrationAccessGuard)
  pull(@CurrentUser() user: AuthUser, @Body(zodPipe(pullSchema)) body: PullInput) {
    return this.migration.pull(user.workspaceId, user.id, body.token);
  }

  @Get('batches/:id')
  detail(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.migration.detail(user.workspaceId, id);
  }

  @Patch('batches/:id/items/:itemId')
  decide(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body(zodPipe(decisionSchema)) body: DecisionInput,
  ) {
    return this.migration.setDecision(user.workspaceId, id, itemId, body);
  }

  @Patch('batches/:id/items')
  decideMany(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(zodPipe(bulkDecisionSchema)) body: BulkDecisionInput,
  ) {
    const { itemIds, ...patch } = body;
    return this.migration.setDecisions(user.workspaceId, id, itemIds, patch);
  }

  /**
   * The spreadsheet.
   *
   * `text/csv` with a filename, so a browser saves it rather than rendering a
   * page of commas, and `@hishab/core` has already put a BOM in front of it for
   * Excel on Windows.
   */
  @Get('batches/:id/csv')
  @Header('content-type', 'text/csv; charset=utf-8')
  @Header('content-disposition', 'attachment; filename="migration.csv"')
  csv(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.migration.toCsv(user.workspaceId, id);
  }

  @Post('batches/:id/csv')
  @HttpCode(200)
  importCsv(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(zodPipe(csvSchema)) body: CsvInput,
  ) {
    return this.migration.fromCsv(user.workspaceId, id, body.csv);
  }

  /**
   * Create what the decisions say.
   *
   * With `itemIds`, only those rows — 312 categories is not a thing anybody
   * decides in one sitting, and approving a group at a time is how the work
   * actually goes. Without it, everything.
   */
  @Post('batches/:id/apply')
  @HttpCode(200)
  apply(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(zodPipe(applySchema)) body: ApplyInput,
  ) {
    return this.migration.apply(user.workspaceId, user.id, id, user.timezone, body.itemIds);
  }

  /**
   * The records, one page per request.
   *
   * Behind the allowlist for the same reason the pull is: it takes a live
   * credential to somebody's other finance app.
   *
   * One page, never the lot. 9,625 rows in one request is a request that can
   * time out mid-write, and a half-written ledger nobody can describe is the
   * worst thing this feature could produce. The screen loops on `nextOffset`
   * and shows the count as it goes.
   */
  @Post('batches/:id/records')
  @UseGuards(MigrationAccessGuard)
  @HttpCode(200)
  records(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(zodPipe(recordsSchema)) body: RecordsInput,
  ) {
    return this.migration.importRecords(
      {
        workspaceId: user.workspaceId,
        userId: user.id,
        timezone: user.timezone,
        currency: user.currency,
      },
      id,
      body.token,
      body.offset ?? 0,
      /* Both or neither. A half-range would silently mean something other than
         what was asked for, so it is refused rather than completed. */
      body.from && body.to ? { from: body.from, to: body.to } : undefined,
    );
  }

  @Post('batches/:id/rollback')
  @HttpCode(200)
  rollback(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.migration.rollback(user.workspaceId, user.id, id);
  }

  @Delete('batches/:id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.migration.remove(user.workspaceId, id);
  }
}
