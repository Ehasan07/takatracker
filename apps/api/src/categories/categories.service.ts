import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { searchDocs, searchField, type SearchDoc } from '@hishab/core';
import { toBengaliDigits, type CreateCategoryInput } from '@hishab/shared';
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
  parentName: string | null;
  sortOrder: number;
  isSystem: boolean;
  /** How many live ledger entries point at it. Deleting is refused above zero. */
  usageCount: number;
  /**
   * Present only on a `?q=` response. `false` marks a parent that did not match
   * and is in the list purely so a matching child is not shown orphaned — the
   * client can grey it out rather than presenting it as a hit. Absent entirely
   * on an unfiltered list, so that response is byte-for-byte what it always was.
   */
  matched?: boolean;
}

/**
 * Raw query-string values, exactly as express hands them over.
 *
 * Deliberately `unknown`: a repeated parameter (`?q=a&q=b`) arrives as an array
 * and a bracketed one (`?q[x]=1`) as an object, so neither can be trusted to be
 * a string until it has been checked. Narrowing happens in `list`, which is also
 * where the Bengali refusals live, so every caller gets the same message.
 */
export interface ListCategoriesQuery {
  readonly kind?: unknown;
  readonly q?: unknown;
}

/**
 * Longer than this is a paste, not a search. Every token of the query is
 * transliterated and branched into candidate spellings before it touches a row,
 * so an unbounded `q` buys unbounded work for a result no one asked for.
 */
export const MAX_SEARCH_QUERY_LENGTH = 120;

@Injectable()
export class CategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(workspaceId: string, query: ListCategoriesQuery = {}): Promise<CategoryView[]> {
    const kind = parseKind(query.kind);
    const q = parseSearchQuery(query.q);

    /* The only database query this endpoint makes, and so the only place its
     * tenancy can be got wrong. Everything below — matching, ranking, pulling a
     * matched child's parent back in — runs in memory over exactly these rows,
     * so no later step can widen the set past this `workspaceId`. Search is
     * precisely the endpoint where that matters: a leak here would hand one
     * household's category names to another. */
    const rows = await this.prisma.category.findMany({
      where: { workspaceId, deletedAt: null, ...(kind ? { kind } : {}) },
      orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { entries: true } } },
    });

    const nameById = new Map(rows.map((c) => [c.id, c.nameBn ?? c.name]));

    const views: CategoryView[] = rows.map((c) => ({
      id: c.id,
      name: c.name,
      nameBn: c.nameBn,
      kind: c.kind,
      icon: c.icon,
      color: c.color,
      parentId: c.parentId,
      parentName: c.parentId ? (nameById.get(c.parentId) ?? null) : null,
      sortOrder: c.sortOrder,
      isSystem: c.isSystem,
      usageCount: c._count.entries,
    }));

    return q === undefined ? views : searchCategories(views, q);
  }

  async create(
    workspaceId: string,
    actorUserId: string,
    input: CreateCategoryInput,
  ): Promise<CategoryView> {
    const parentId = await this.resolveParent(workspaceId, input.kind, input.parentId);
    await this.assertNameFree(
      workspaceId,
      input.kind,
      input.nameBn ?? input.name,
      undefined,
      parentId,
    );

    const created = await this.prisma.category.create({
      data: {
        workspaceId,
        name: input.name,
        nameBn: input.nameBn ?? input.name,
        kind: input.kind,
        parentId,
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

    return { ...created, parentName: null, usageCount: 0 };
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

  /**
   * Two names may repeat across different parents — "রিকশা" under যাতায়াত and
   * under ব্যবসা are different things — but not as siblings, which is the case
   * that makes a picker ambiguous.
   */
  private async assertNameFree(
    workspaceId: string,
    kind: 'INCOME' | 'EXPENSE',
    name: string,
    exceptId?: string,
    parentId?: string | null,
  ): Promise<void> {
    const clash = await this.prisma.category.findFirst({
      where: {
        workspaceId,
        kind,
        deletedAt: null,
        parentId: parentId ?? null,
        ...(exceptId ? { id: { not: exceptId } } : {}),
        OR: [{ name }, { nameBn: name }],
      },
    });
    if (clash) throw new BadRequestException('এই নামে একটি ক্যাটাগরি আগে থেকেই আছে');
  }

  /**
   * Categories are two levels deep, deliberately. Deeper nesting makes a report
   * unreadable and a picker unusable on a phone, so a sub-category cannot have
   * sub-categories of its own.
   */
  private async resolveParent(
    workspaceId: string,
    kind: 'INCOME' | 'EXPENSE',
    parentId?: string | null,
  ): Promise<string | null> {
    if (!parentId) return null;

    const parent = await this.prisma.category.findFirst({
      where: { id: parentId, workspaceId, deletedAt: null },
    });
    if (!parent) throw new NotFoundException('মূল খাত পাওয়া যায়নি');
    if (parent.kind !== kind) {
      throw new BadRequestException('উপ-খাত ও মূল খাতের ধরন এক হতে হবে');
    }
    if (parent.parentId) {
      throw new BadRequestException('উপ-খাতের নিচে আরেকটি উপ-খাত রাখা যায় না');
    }
    return parent.id;
  }
}

// --- search -------------------------------------------------------------------

/**
 * Match and rank the workspace's categories against `q`, in memory.
 *
 * In memory on purpose. A workspace holds a few dozen categories, the whole tree
 * is already loaded to resolve `parentName` and `usageCount`, and ranking it is
 * not measurable next to the round trip that fetched it.
 *
 * The obvious future change is to push `q` down into SQL as a `WHERE name ILIKE
 * '%…%' OR nameBn ILIKE '%…%'`, and that would quietly destroy the feature.
 * Postgres cannot transliterate and no configuration makes it able to: `lower()`
 * is a no-op on a script with no case, `unaccent` has no Bengali rules, and the
 * trigram similarity between `খাবার` and `khabar` is exactly zero because they
 * share no trigrams. `?q=khabar` finds `খাবার ও বাজার` only because the fold
 * runs here, in TypeScript, over the rows already in hand.
 *
 * This list is also what makes the *transaction* filter understand Banglish:
 * `TransactionsService.buildSearchWhere` matches `?q=` against exactly these
 * rows and then filters the ledger on the ids it gets back, because the ledger
 * itself is far too large to fold in memory. So if this list ever grows past a
 * few hundred rows per workspace, two endpoints slow down, not one — and the
 * answer is still not `contains`, which cannot cross scripts at all.
 */
function searchCategories(views: readonly CategoryView[], rawQuery: string): CategoryView[] {
  const docs: SearchDoc<CategoryView>[] = views.map((c) => ({
    id: c.id,
    row: c,
    /* The picker's own order, the last tie-break before `id`, so two rows that
     * match equally well still come back in the order the user arranged them. */
    order: c.sortOrder,
    /* Both names are PRIMARY, matching the matcher's own category fixture.
     * Demoting the English one would let a Bengali hit on an unrelated row
     * outrank the row the user actually named when they typed `utility`. */
    fields: [searchField('nameBn', 'PRIMARY', c.nameBn), searchField('name', 'PRIMARY', c.name)],
  }));

  const result = searchDocs(docs, rawQuery);

  /* A one-character query is not a filter (§4.3): it would match nearly every
   * row at the weakest tier, which is indistinguishable from no filter but far
   * more surprising. Hand back the natural list rather than a ranked pretence. */
  if (!result.filtered) return [...views];

  /* Suggestions are appended rather than interleaved, which is also exactly
   * descending score order — the matcher keeps the two bands apart, the worst
   * real match scoring above the best suggestion — and the matcher only fills
   * the bucket at all when the real matches nearly ran out. So a good query
   * never shows fuzz, and a typo gets an answer instead of an empty picker. */
  const ranked = [...result.hits, ...result.suggestions].map((hit) => hit.row);
  return keepHierarchy(ranked, views);
}

/**
 * Re-attach every matched child to its parent.
 *
 * The list is two levels and the client renders it as a tree, so a child on its
 * own is an orphan: `রিকশা` with no `যাতায়াত` above it reads as a top-level
 * category that does not exist. Any parent a match needs is pulled back in and
 * flagged `matched: false`.
 *
 * Rows are grouped into families and the families ordered by their best-ranked
 * member, so a child that scored first still puts its family first — with the
 * parent printed above it. The reverse does not hold: a matching parent does not
 * drag in its children, because searching for `যাতায়াত` asks for that row, not
 * for everything filed beneath it.
 */
function keepHierarchy(
  ranked: readonly CategoryView[],
  all: readonly CategoryView[],
): CategoryView[] {
  const byId = new Map(all.map((c) => [c.id, c]));
  const order: string[] = [];
  const families = new Map<string, CategoryView[]>();

  for (const row of ranked) {
    const familyId = row.parentId ?? row.id;
    const family = families.get(familyId);
    if (family) {
      family.push(row);
    } else {
      families.set(familyId, [row]);
      order.push(familyId);
    }
  }

  const out: CategoryView[] = [];
  for (const familyId of order) {
    const family = families.get(familyId) ?? [];
    const parent = byId.get(familyId);
    /* Absent only if a child outlived its parent, which `remove` refuses to
     * allow. Emit the children anyway rather than dropping real matches. */
    if (parent) out.push({ ...parent, matched: family.some((c) => c.id === familyId) });
    for (const child of family) if (child.id !== familyId) out.push({ ...child, matched: true });
  }
  return out;
}

// --- query parameters ---------------------------------------------------------

function parseKind(value: unknown): 'INCOME' | 'EXPENSE' | undefined {
  if (value === undefined || value === '') return undefined;
  if (value === 'INCOME' || value === 'EXPENSE') return value;
  throw new BadRequestException('ধরন শুধু INCOME অথবা EXPENSE হতে পারে');
}

function parseSearchQuery(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  /* A repeated `?q=` arrives as an array. Silently taking the first would search
   * for something the user did not ask for, which is worse than refusing. */
  if (typeof value !== 'string') throw new BadRequestException('খোঁজার শব্দ একবারই দিন');
  if (value.length > MAX_SEARCH_QUERY_LENGTH) {
    throw new BadRequestException(
      `খোঁজার শব্দ ${toBengaliDigits(String(MAX_SEARCH_QUERY_LENGTH))} অক্ষরের বেশি হতে পারবে না`,
    );
  }
  return value;
}
