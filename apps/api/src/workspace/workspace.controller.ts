import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { LOCALES, MAX_CUSTOM_UNITS, MAX_UNIT_LENGTH } from '@hishab/shared';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { zodPipe } from '../common/zod.pipe';
import { WorkspaceService } from './workspace.service';

/**
 * `quantityUnits` is a whole-list replacement rather than add/remove routes.
 *
 * The screen holds the list in one editable control and saves it as a unit, so
 * two members editing at once is a last-write-wins over eight short strings —
 * which is what a settings form is anyway. Add and remove endpoints would buy
 * merge semantics nobody asked for and cost two more routes to guard.
 *
 * The array cap is generous here and enforced properly in `normaliseUnitList`:
 * zod's job at the edge is to refuse a payload that is obviously not a unit
 * list, not to be the second copy of the de-duplication rule.
 */
const patchSchema = z.object({
  quantityUnits: z
    .array(z.string().trim().max(MAX_UNIT_LENGTH))
    .max(MAX_CUSTOM_UNITS * 2)
    .optional(),
  /**
   * The books' language.
   *
   * Workspace-wide rather than per-member: two people sharing one set of books
   * must not see two different names for the same category, or a report one of
   * them mails the other will not agree with itself.
   */
  locale: z.enum(LOCALES).optional(),
  /**
   * Whether this workspace's messages may be shown to a language model.
   *
   * A parser can read an amount; only a model knows that "স্বপ্ন" is groceries.
   * Turning that on sends the text of somebody's bank SMS to a third party, so
   * it is off until the person whose messages they are says otherwise — a
   * default nobody discovers afterwards.
   */
  aiSuggestEnabled: z.boolean().optional(),
  businessEnabled: z.boolean().optional(),
});

@Controller('workspace')
@UseGuards(JwtAuthGuard)
export class WorkspaceController {
  constructor(private readonly workspace: WorkspaceService) {}

  /**
   * The settings `/auth/me` does not carry.
   *
   * Currency, timezone and locale ride along on `/auth/me` because every screen
   * needs them on first paint. The unit list is needed by exactly one field in
   * one sheet, so it is fetched by the screens that use it rather than added to
   * the payload every page load pays for.
   */
  @Get('settings')
  settings(@CurrentUser() user: AuthUser) {
    return this.workspace.settings(user.workspaceId);
  }

  @Patch('settings')
  update(
    @CurrentUser() user: AuthUser,
    @Body(zodPipe(patchSchema)) body: z.infer<typeof patchSchema>,
  ) {
    return this.workspace.update(user.workspaceId, user.id, body);
  }
}
