import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { zodPipe } from '../common/zod.pipe';
import { MAX_SHARE_DAYS, StatementShareService } from './statement-share.service';

const KINDS = ['PERSON', 'LOAN', 'SAVINGS', 'INSURANCE'] as const;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

const createSchema = z.object({
  kind: z.enum(KINDS),
  subjectId: z.string().min(1),
  /* Both absent means the whole life of the subject — which is a real choice
     somebody makes, not an oversight, so it is not refused. */
  from: isoDate.optional(),
  to: isoDate.optional(),
  label: z.string().trim().max(120).optional(),
  expiresInDays: z.number().int().min(1).max(MAX_SHARE_DAYS).optional(),
});

const listSchema = z.object({ kind: z.enum(KINDS), subjectId: z.string().min(1) });

/**
 * Making and taking back a share link. The reading end is
 * `PublicStatementController`, and it is the only route here without a guard.
 */
@Controller('statement-shares')
@UseGuards(JwtAuthGuard)
export class StatementShareController {
  constructor(private readonly shares: StatementShareService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query(zodPipe(listSchema)) query: z.infer<typeof listSchema>,
  ) {
    return this.shares.list(user, query.kind, query.subjectId);
  }

  /**
   * The response carries the token, once.
   *
   * Only the hash is stored, so there is no way to read it back later. Losing
   * it means revoking and making another — which is the right trade for a
   * credential that opens somebody's financial record.
   */
  @Post()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  create(
    @CurrentUser() user: AuthUser,
    @Body(zodPipe(createSchema)) body: z.infer<typeof createSchema>,
  ) {
    return this.shares.create(user, body);
  }

  @Delete(':id')
  revoke(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.shares.revoke(user, id);
  }
}
