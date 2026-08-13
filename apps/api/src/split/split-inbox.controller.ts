import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { zodPipe } from '../common/zod.pipe';
import { SplitService } from './split.service';

/**
 * The other side of a shared bill: drafts waiting to be let into your books.
 *
 * Not under `split/groups` because none of it is scoped to a group the caller
 * owns — these are bills somebody *else* recorded, offered to this workspace.
 * The separation is the point: accepting an invitation gives the inviter no
 * write access at all, only the ability to put a draft in front of you.
 */

const acceptSchema = z.object({ categoryId: z.string().min(1).optional() });

@Controller('split')
@UseGuards(JwtAuthGuard)
export class SplitInboxController {
  constructor(private readonly split: SplitService) {}

  /** Take up an invitation. The token is the credential; only its hash is kept. */
  @Post('join/:token')
  join(@CurrentUser() user: AuthUser, @Param('token') token: string) {
    return this.split.acceptInvite(user, token);
  }

  @Get('inbox')
  inbox(@CurrentUser() user: AuthUser) {
    return this.split.listMirrors(user);
  }

  @Post('inbox/:id/accept')
  accept(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(zodPipe(acceptSchema)) body: z.infer<typeof acceptSchema>,
  ) {
    return this.split.acceptMirror(user, id, body.categoryId);
  }

  @Post('inbox/:id/decline')
  decline(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.split.declineMirror(user, id);
  }
}
