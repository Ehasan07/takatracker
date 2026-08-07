import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { createCategorySchema } from '@hishab/shared';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { zodPipe } from '../common/zod.pipe';
import { PrismaService } from '../prisma/prisma.service';

@Controller('categories')
@UseGuards(JwtAuthGuard)
export class CategoriesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query('kind') kind?: 'INCOME' | 'EXPENSE') {
    return this.prisma.category.findMany({
      where: { workspaceId: user.workspaceId, deletedAt: null, ...(kind ? { kind } : {}) },
      orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        nameBn: true,
        kind: true,
        icon: true,
        color: true,
        parentId: true,
        sortOrder: true,
      },
    });
  }

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body(zodPipe(createCategorySchema)) body: ReturnType<typeof createCategorySchema.parse>,
  ) {
    return this.prisma.category.create({
      data: {
        workspaceId: user.workspaceId,
        name: body.name,
        nameBn: body.nameBn ?? body.name,
        kind: body.kind,
        parentId: body.parentId,
        icon: body.icon,
        color: body.color,
        sortOrder: body.sortOrder,
      },
    });
  }
}
