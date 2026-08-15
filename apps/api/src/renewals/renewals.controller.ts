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
import { cuid, isoDate, minorAmount } from '@hishab/shared';
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

const completeSchema = z.object({
  /** Defaults to today. Backdating is how a five-year backlog gets cleared. */
  completedOn: isoDate.optional(),
});
export type CompleteObligationInput = z.infer<typeof completeSchema>;

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

  @Post(':id/complete')
  @HttpCode(200)
  complete(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(zodPipe(completeSchema)) body: CompleteObligationInput,
  ) {
    return this.renewals.complete(user.workspaceId, user.id, id, body.completedOn, user.timezone);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.renewals.remove(user.workspaceId, user.id, id);
  }
}
