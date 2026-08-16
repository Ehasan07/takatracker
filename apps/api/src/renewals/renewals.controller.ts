import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { RENEWAL_KINDS, RENEWAL_RECURRENCES } from '@hishab/core';
import { cuid, isoDate, minorAmount, positiveMinorAmount } from '@hishab/shared';
import { z } from 'zod';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { zodPipe } from '../common/zod.pipe';
import { RenewalsService } from './renewals.service';

/** Papers that expire: fitness, khajna, holding tax, a trade licence. */

const obligationFields = z.object({
  /** The asset it belongs to. Absent for a passport, which belongs to a person. */
  accountId: cuid.nullish(),
  kind: z.enum(RENEWAL_KINDS),
  title: z.string().min(1).max(120),
  recurrence: z.enum(RENEWAL_RECURRENCES).default('YEARLY'),
  dueDate: isoDate,
  /* Up to a year of warning: a passport queue is months long, and anything
     past that is not a reminder, it is a second calendar. */
  reminderLeadDays: z.number().int().min(0).max(365).default(30),
  /** The person's own estimate. Never a figure this app invented. */
  estimatedCostMinor: minorAmount.nonnegative().default(0),
  documentRef: z.string().max(120).optional(),
  note: z.string().max(2000).optional(),
});

const createObligationSchema = obligationFields;
export type CreateObligationInput = z.infer<typeof createObligationSchema>;

const updateObligationSchema = obligationFields.partial().extend({
  /** Muted without being deleted — the paper still exists. */
  isMuted: z.boolean().optional(),
});
export type UpdateObligationInput = z.infer<typeof updateObligationSchema>;

/**
 * The fee, when somebody wants it in the books as well as off the calendar.
 *
 * Optional as a whole rather than field by field. A half-filled payment — an
 * amount with no account, an account with no category — is not a partial
 * instruction this endpoint can guess the rest of, so the three arrive together
 * or not at all, and "not at all" is the behaviour renewals shipped with.
 */
const completePaymentSchema = z.object({
  /* Integer poisha, and the person's own figure. `estimatedCostMinor` only
     prefills the box on the screen; what gets booked is what they typed, because
     an estimate is not a receipt. */
  amountMinor: positiveMinorAmount,
  /** Where the money actually came from — the wallet, the bank, the card. */
  accountId: cuid,
  /* Required, unlike on some write paths, because the ledger requires it for an
     expense and a fee filed nowhere is money that vanishes from every report
     that matters. */
  categoryId: cuid,
});

const completeSchema = z.object({
  /** Defaults to today. Backdating is how a five-year backlog gets cleared. */
  completedOn: isoDate.optional(),
  /**
   * Absent means exactly what it has always meant: roll the date, touch no
   * money. Somebody clearing five years of back khajna in one sitting does not
   * want five transactions dated today, so the fee is offered and never
   * assumed. When it is present the expense is dated `completedOn` too.
   */
  payment: completePaymentSchema.optional(),
});
export type CompleteObligationInput = z.infer<typeof completeSchema>;
export type CompletePaymentInput = z.infer<typeof completePaymentSchema>;

@Controller('renewals')
@UseGuards(JwtAuthGuard)
export class RenewalsController {
  constructor(private readonly renewals: RenewalsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.renewals.list(user.workspaceId, user.timezone);
  }

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body(zodPipe(createObligationSchema)) body: CreateObligationInput,
  ) {
    return this.renewals.create(user.workspaceId, user.id, body, user.timezone);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(zodPipe(updateObligationSchema)) body: UpdateObligationInput,
  ) {
    return this.renewals.update(user.workspaceId, user.id, id, body, user.timezone);
  }

  /**
   * The whole `user`, not four fields off it.
   *
   * Booking the fee goes through `TransactionsService.create`, which takes a
   * `TenantContext` — id, workspace, timezone and locale together. `AuthUser`
   * already is one, so handing it over whole is both shorter than the four
   * positional strings this used to take and impossible to get out of order.
   */
  @Post(':id/complete')
  @HttpCode(200)
  complete(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(zodPipe(completeSchema)) body: CompleteObligationInput,
  ) {
    return this.renewals.complete(user, id, body);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.renewals.remove(user.workspaceId, user.id, id);
  }
}
