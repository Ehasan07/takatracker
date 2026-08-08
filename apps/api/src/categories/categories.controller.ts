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
import { createCategorySchema } from '@hishab/shared';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { zodPipe } from '../common/zod.pipe';
import { CategoriesService } from './categories.service';

const updateCategorySchema = createCategorySchema.partial();

@Controller('categories')
@UseGuards(JwtAuthGuard)
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query('kind') kind?: 'INCOME' | 'EXPENSE') {
    return this.categories.list(user.workspaceId, kind);
  }

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body(zodPipe(createCategorySchema)) body: ReturnType<typeof createCategorySchema.parse>,
  ) {
    return this.categories.create(user.workspaceId, user.id, body);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(zodPipe(updateCategorySchema)) body: ReturnType<typeof updateCategorySchema.parse>,
  ) {
    return this.categories.update(user.workspaceId, user.id, id, body);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.categories.remove(user.workspaceId, user.id, id);
  }
}
