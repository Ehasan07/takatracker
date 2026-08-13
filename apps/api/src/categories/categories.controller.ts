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
import { createCategorySchema } from '@hishab/shared';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { zodPipe } from '../common/zod.pipe';
import { CategoriesService } from './categories.service';

/**
 * The shared create schema plus the alias list, which lives here rather than in
 * @hishab/shared because it is deliberately loose: `unknown` entries, or one
 * string, because pasting `khabar, bajar, restaurant` into a single box is the
 * common case and zod's own type error would arrive in English.
 *
 * Everything real — splitting, trimming, de-duplication, the caps — happens in
 * `parseSearchAliases`, so create and update refuse identically and in Bengali.
 */
const categoryBodySchema = createCategorySchema.extend({
  searchAliases: z.union([z.string(), z.array(z.unknown())]).optional(),
});

const updateCategorySchema = categoryBodySchema.partial();

@Controller('categories')
@UseGuards(JwtAuthGuard)
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  /**
   * `?kind=` narrows to one side of the ledger, `?q=` searches both the Bengali
   * and the English name through the @hishab/core matcher and returns the tree
   * ranked. The two compose: `kind` scopes the rows before anything is matched.
   *
   * Both values arrive untyped — express turns a repeated parameter into an
   * array — so they are handed over as-is and narrowed in the service, which is
   * where the Bengali refusals live.
   */
  @Get()
  list(@CurrentUser() user: AuthUser, @Query('kind') kind?: unknown, @Query('q') q?: unknown) {
    return this.categories.list(user.workspaceId, { kind, q }, user.locale);
  }

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body(zodPipe(categoryBodySchema)) body: ReturnType<typeof categoryBodySchema.parse>,
  ) {
    return this.categories.create(user.workspaceId, user.id, body, user.locale);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(zodPipe(updateCategorySchema)) body: ReturnType<typeof updateCategorySchema.parse>,
  ) {
    return this.categories.update(user.workspaceId, user.id, id, body, user.locale);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.categories.remove(user.workspaceId, user.id, id);
  }
}
