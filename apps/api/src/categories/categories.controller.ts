import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { createCategorySchema } from '@hishab/shared';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { zodPipe } from '../common/zod.pipe';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';

@Controller('categories')
@UseGuards(JwtAuthGuard)
export class CategoriesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

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
  async create(
    @CurrentUser() user: AuthUser,
    @Body(zodPipe(createCategorySchema)) body: ReturnType<typeof createCategorySchema.parse>,
  ) {
    const created = await this.prisma.category.create({
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

    this.audit.emit({
      workspaceId: user.workspaceId,
      actorUserId: user.id,
      action: 'category.created',
      entity: 'Category',
      entityId: created.id,
      after: { name: created.name, kind: created.kind },
    });
    return created;
  }
}
