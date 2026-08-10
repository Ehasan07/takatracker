import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { cuid } from '@hishab/shared';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { zodPipe } from '../common/zod.pipe';
import { TagsService } from './tags.service';

/**
 * The write body.
 *
 * Local rather than in @hishab/shared, following `categoryBodySchema`: the alias
 * field is deliberately loose — `unknown` entries, or one string, because
 * pasting `poribar, family, ammu` into a single box is the common case — and
 * zod's own type error would arrive in English. Everything real happens in
 * `parseSearchAliases`, so create and update refuse identically and in Bengali.
 */
const tagBodySchema = z.object({
  name: z.string().min(1).max(60),
  nameBn: z.string().max(60).nullish(),
  color: z.string().max(20).nullish(),
  icon: z.string().max(40).nullish(),
  sortOrder: z.number().int().optional(),
  searchAliases: z.union([z.string(), z.array(z.unknown())]).optional(),
});

const updateTagSchema = tagBodySchema.partial();

const mergeTagSchema = z.object({ intoTagId: cuid });

@Controller('tags')
@UseGuards(JwtAuthGuard)
export class TagsController {
  constructor(private readonly tags: TagsService) {}

  /**
   * `GET /v1/tags?q=` — the workspace's tags, each with how many transactions
   * carry it and what moved under it.
   *
   * `q` searches the Bengali name, the English name and the aliases through the
   * @hishab/core matcher, so `poribar` finds পরিবার. It arrives untyped —
   * express turns a repeated parameter into an array — and is narrowed in the
   * service, where the Bengali refusals live.
   */
  @Get()
  list(@CurrentUser() user: AuthUser, @Query('q') q?: unknown) {
    return this.tags.list(user.workspaceId, { q });
  }

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body(zodPipe(tagBodySchema)) body: ReturnType<typeof tagBodySchema.parse>,
  ) {
    return this.tags.create(user.workspaceId, user.id, body);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(zodPipe(updateTagSchema)) body: ReturnType<typeof updateTagSchema.parse>,
  ) {
    return this.tags.update(user.workspaceId, user.id, id, body);
  }

  /**
   * Soft delete. The transactions keep every one of their other tags, their
   * category and their money; only the link to this label goes. The response
   * says how many rows were detached and states, in as many words, that nothing
   * was deleted.
   */
  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.tags.remove(user.workspaceId, user.id, id);
  }

  /** Fold `:id` into `intoTagId`, then retire `:id`. */
  @Post(':id/merge')
  merge(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(zodPipe(mergeTagSchema)) body: ReturnType<typeof mergeTagSchema.parse>,
  ) {
    return this.tags.merge(user.workspaceId, user.id, id, body.intoTagId);
  }
}
