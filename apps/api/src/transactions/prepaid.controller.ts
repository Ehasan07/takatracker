import { Body, Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { isoDate } from '@hishab/shared';
import { z } from 'zod';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { zodPipe } from '../common/zod.pipe';
import { PrepaidService } from './prepaid.service';

/**
 * Payments that cover a period, and the month-by-month view of them.
 *
 * Two segments on every route (`/transactions/prepaid/…`, `/transactions/:id/
 * prepaid`) so neither can be swallowed by `GET /transactions/:id`, which
 * matches a single segment.
 *
 * Nothing here posts. `PrepaidService` explains at length why a ledger that
 * declares `basis: 'CASH'` on four statement responses does not get to book an
 * accrual quietly; the short version is that the whole expense stays on the day
 * it was paid and this is a way of reading it.
 */

/** `YYYY-MM`. Months are the only unit the spread counts in. */
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'মাসটি YYYY-MM আকারে লিখুন');

/**
 * Marking a payment as covering a period — or unmarking it.
 *
 * `months: null` clears it. Both fields go together: a start with no count says
 * nothing about how long, and a count with no start says nothing about when.
 */
const setPrepaidSchema = z
  .object({
    /** The first month covered. The day is stored and never divided by. */
    startDate: isoDate.nullable(),
    /** How many months, counting the start month as the first. */
    months: z.number().int().nullable(),
  })
  .refine((val) => (val.startDate === null) === (val.months === null), {
    path: ['months'],
    message: 'শুরুর মাস আর কত মাস — দুটোই দিতে হবে, অথবা কোনোটিই নয়',
  });
export type SetPrepaidInput = z.infer<typeof setPrepaidSchema>;

const spreadQuerySchema = z.object({
  /** Defaults to the current month in the workspace's timezone. */
  from: month.optional(),
  /** How many months wide. Capped by the service at five years. */
  months: z.coerce.number().int().min(1).max(60).optional(),
});
export type PrepaidSpreadQuery = z.infer<typeof spreadQuerySchema>;

@Controller('transactions')
@UseGuards(JwtAuthGuard)
export class PrepaidController {
  constructor(private readonly prepaid: PrepaidService) {}

  @Get('prepaid/spread')
  spread(
    @CurrentUser() user: AuthUser,
    @Query(zodPipe(spreadQuerySchema)) query: PrepaidSpreadQuery,
  ) {
    return this.prepaid.spread(user, query);
  }

  @Patch(':id/prepaid')
  setPeriod(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(zodPipe(setPrepaidSchema)) body: SetPrepaidInput,
  ) {
    return this.prepaid.setPeriod(user, id, body);
  }
}
