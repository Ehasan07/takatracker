import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { CreateCategoryInput } from '@hishab/shared';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';

export interface CategoryView {
  id: string;
  name: string;
  nameBn: string | null;
  kind: 'INCOME' | 'EXPENSE';
  icon: string | null;
  color: string | null;
  parentId: string | null;
  sortOrder: number;
  isSystem: boolean;
  /** How many live ledger entries point at it. Deleting is refused above zero. */
  usageCount: number;
}

@Injectable()
export class CategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(workspaceId: string, kind?: 'INCOME' | 'EXPENSE'): Promise<CategoryView[]> {
    const rows = await this.prisma.category.findMany({
      where: { workspaceId, deletedAt: null, ...(kind ? { kind } : {}) },
      orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { entries: true } } },
    });

    return rows.map((c) => ({
      id: c.id,
      name: c.name,
      nameBn: c.nameBn,
      kind: c.kind,
      icon: c.icon,
      color: c.color,
      parentId: c.parentId,
      sortOrder: c.sortOrder,
      isSystem: c.isSystem,
      usageCount: c._count.entries,
    }));
  }

  async create(
    workspaceId: string,
    actorUserId: string,
    input: CreateCategoryInput,
  ): Promise<CategoryView> {
    await this.assertNameFree(workspaceId, input.kind, input.nameBn ?? input.name);

    const created = await this.prisma.category.create({
      data: {
        workspaceId,
        name: input.name,
        nameBn: input.nameBn ?? input.name,
        kind: input.kind,
        parentId: input.parentId,
        icon: input.icon,
        color: input.color,
        sortOrder: input.sortOrder,
      },
    });

    this.audit.emit({
      workspaceId,
      actorUserId,
      action: 'category.created',
      entity: 'Category',
      entityId: created.id,
      after: { name: created.nameBn ?? created.name, kind: created.kind },
    });

    return { ...created, usageCount: 0 };
  }

  async update(
    workspaceId: string,
    actorUserId: string,
    id: string,
    input: Partial<CreateCategoryInput>,
  ): Promise<CategoryView> {
    const existing = await this.prisma.category.findFirst({
      where: { id, workspaceId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('ক্যাটাগরি পাওয়া যায়নি');

    const nextName = input.nameBn ?? input.name;
    if (nextName && nextName !== (existing.nameBn ?? existing.name)) {
      await this.assertNameFree(workspaceId, existing.kind, nextName, id);
    }

    await this.prisma.category.update({
      where: { id },
      data: {
        name: input.name ?? existing.name,
        nameBn: input.nameBn ?? existing.nameBn,
        icon: input.icon,
        color: input.color,
        sortOrder: input.sortOrder,
        // The kind is deliberately fixed: flipping a category from expense to
        // income would silently invert every transaction already filed under it.
      },
    });

    this.audit.emit({
      workspaceId,
      actorUserId,
      action: 'category.updated',
      entity: 'Category',
      entityId: id,
      before: { name: existing.nameBn ?? existing.name },
      after: { name: nextName ?? existing.nameBn ?? existing.name },
    });

    const [updated] = await this.list(workspaceId).then((all) => all.filter((c) => c.id === id));
    return updated!;
  }

  /**
   * Soft delete, and only when nothing uses it. Removing a category that has
   * history would leave transactions pointing at nothing — the ledger has to
   * stay readable years later.
   */
  async remove(workspaceId: string, actorUserId: string, id: string): Promise<{ id: string }> {
    const existing = await this.prisma.category.findFirst({
      where: { id, workspaceId, deletedAt: null },
      include: { _count: { select: { entries: true, children: true } } },
    });
    if (!existing) throw new NotFoundException('ক্যাটাগরি পাওয়া যায়নি');

    if (existing._count.entries > 0) {
      throw new BadRequestException(
        `এই ক্যাটাগরিতে ${existing._count.entries}টি লেনদেন আছে — আগে সেগুলো অন্য ক্যাটাগরিতে সরান`,
      );
    }
    if (existing._count.children > 0) {
      throw new BadRequestException('আগে এর উপ-ক্যাটাগরিগুলো সরান');
    }

    await this.prisma.category.update({ where: { id }, data: { deletedAt: new Date() } });

    this.audit.emit({
      workspaceId,
      actorUserId,
      action: 'category.deleted',
      entity: 'Category',
      entityId: id,
      before: { name: existing.nameBn ?? existing.name },
    });

    return { id };
  }

  /** Two categories with the same name in the same kind is a data-entry trap. */
  private async assertNameFree(
    workspaceId: string,
    kind: 'INCOME' | 'EXPENSE',
    name: string,
    exceptId?: string,
  ): Promise<void> {
    const clash = await this.prisma.category.findFirst({
      where: {
        workspaceId,
        kind,
        deletedAt: null,
        ...(exceptId ? { id: { not: exceptId } } : {}),
        OR: [{ name }, { nameBn: name }],
      },
    });
    if (clash) throw new BadRequestException('এই নামে একটি ক্যাটাগরি আগে থেকেই আছে');
  }
}
