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
import { cuid } from '@hishab/shared';
import { z } from 'zod';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { zodPipe } from '../common/zod.pipe';
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

const decisionSchema = z.object({
  decision: z.enum(MIGRATION_DECISIONS).optional(),
  targetType: z.string().max(40).optional(),
  targetId: cuid.nullish(),
});
export type DecisionInput = z.infer<typeof decisionSchema>;

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

  @Get('batches')
  list(@CurrentUser() user: AuthUser) {
    return this.migration.list(user.workspaceId);
  }

  @Post('wallet/pull')
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

  @Post('batches/:id/apply')
  @HttpCode(200)
  apply(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.migration.apply(user.workspaceId, user.id, id, user.timezone);
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
