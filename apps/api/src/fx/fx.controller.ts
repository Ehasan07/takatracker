import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { zodPipe } from '../common/zod.pipe';
import { FxService } from './fx.service';

const rateQuerySchema = z.object({
  /** Defaults to the workspace's own currency — the usual case by far. */
  from: z.string().trim().toUpperCase().length(3).optional(),
  to: z.string().trim().toUpperCase().length(3),
});

/**
 * Exchange rates, as a suggestion.
 *
 * Behind a session, not because rates are secret — they are published — but
 * because an open endpoint that makes an outbound HTTP call is somebody else's
 * free proxy, and the throttle below is only meaningful if there is an account
 * to attach it to.
 */
@Controller('fx')
@UseGuards(JwtAuthGuard)
export class FxController {
  constructor(private readonly fx: FxService) {}

  /**
   * `GET /v1/fx/rate?to=USD` — one pair, a few dozen bytes.
   *
   * Deliberately not the whole table. A rate table is 160 currencies of JSON on
   * the request path of a form somebody is typing into on a phone; the form
   * needs exactly one number.
   */
  @Get('rate')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  rate(
    @CurrentUser() user: AuthUser,
    @Query(zodPipe(rateQuerySchema)) query: z.infer<typeof rateQuerySchema>,
  ) {
    return this.fx.rate(query.from ?? user.currency, query.to);
  }
}
