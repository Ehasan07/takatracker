import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { SuperAdminGuard } from '../admin/super-admin.guard';
import { zodPipe } from '../common/zod.pipe';
import { FeedbackService } from './feedback.service';

/**
 * The operator's side of the feedback table.
 *
 * ## Why a second controller, and why it is mounted under `/admin`
 *
 * This is the one query in the module that is not scoped to a workspace, so it
 * obeys the rule `super-admin.guard.ts` sets out rather than bending it: no
 * `if (isSuperAdmin)` branch inside a shared service, no third auth mechanism,
 * and no operator route that answers on a path an ordinary user's client would
 * ever call. `SuperAdminGuard` is reused verbatim — the same guard class, the
 * same database read of the flag on every request, the same 404 for everyone
 * else, so probing `/admin/feedback` tells an attacker exactly what probing
 * `/admin/anything-else` tells them, which is nothing.
 *
 * It is a separate controller from `FeedbackController` rather than a guarded
 * handler on it because the guards are class-level in this codebase and a file
 * with two different ones on two handlers is a file where somebody eventually
 * adds a third handler under whichever guard is nearest. The prefix says which
 * one applies before you read a line of it.
 *
 * It lives here and not in `admin.controller.ts` for the reason `AdminModule`
 * gives for itself: the cross-tenant query belongs beside the table it reads,
 * and `AdminService` should not grow a method for every feature that ever wants
 * an operator view.
 */

const listQuerySchema = z.object({
  kind: z.enum(['PROBLEM', 'IDEA', 'OTHER']).optional(),
  /** Everything one tenant has ever sent, for when a complaint needs context. */
  workspaceId: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

@Controller('admin/feedback')
@UseGuards(SuperAdminGuard)
export class FeedbackAdminController {
  constructor(private readonly feedback: FeedbackService) {}

  /**
   * `GET /v1/admin/feedback` — everything that has come in, newest first.
   *
   * The message is returned whole and unsummarised. An operator triaging by
   * first line is the failure this table exists to avoid: the sentence that
   * explains the bug is almost never the first one.
   */
  @Get()
  list(@Query(zodPipe(listQuerySchema)) query: ReturnType<typeof listQuerySchema.parse>) {
    return this.feedback.list(query);
  }
}
