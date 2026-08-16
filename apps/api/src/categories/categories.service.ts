import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { searchAliasField, searchDocs, searchField, type SearchDoc } from '@hishab/core';
import {
  displayName,
  toBengaliDigits,
  type CreateCategoryInput,
  type Locale,
} from '@hishab/shared';
import { AuditService, type AuditAction } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Annotated, never `as AuditAction` — a cast would compile whatever string sat
 * on the right of it, so a typo would ship rows under an action name no query
 * looks for. The annotation makes the union upstream the authority.
 */
const CATEGORY_MERGED: AuditAction = 'category.merged';

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
  /**
   * The extra words that also find this row. Returned on every response, not
   * only after an edit: the client cannot offer to edit a list it was never
   * shown, and a blind `PATCH` would overwrite whatever is already there.
   */
  searchAliases: string[];
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

/** What `POST /categories/:id/move` hands back. */
export interface MoveCategoryResult {
  /**
   * Ledger entries whose `categoryId` changed hands.
   *
   * Exactly the number the list endpoint calls `usageCount`, and deliberately
   * so: the sheet promises "৪১২টি লেনদেন সরানো হবে" from that field before the
   * press, and a response that reported a different number would make the
   * promise a lie. Both count every entry pointing at the খাত, including the
   * ones belonging to binned transactions — see `move`.
   */
  movedCount: number;
  /** Whether the emptied source was retired in the same transaction. */
  deleted: boolean;
  from: { id: string; name: string };
  into: { id: string; name: string };
  /** Bengali, ready to show. What the screen puts in its toast. */
  message: string;
}

/**
 * A create or update body.
 *
 * `searchAliases` is `unknown` for the same reason the query parameters below
 * are: it may arrive as a list, as one comma-separated string somebody pasted,
 * or as something that is neither. It is narrowed in `parseSearchAliases`,
 * which is also where the Bengali refusals live, so create and update refuse
 * identically.
 */
export interface CategoryWriteInput extends CreateCategoryInput {
  readonly searchAliases?: unknown;
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

/**
 * A category may carry this many aliases and each may be this long.
 *
 * Both caps are about the same thing: every alias is a key set built on every
 * request that searches, so the list is work the whole workspace pays for. The
 * seeded rows use at most seventeen, so twenty-four leaves real room to add to
 * them without leaving room to paste a paragraph. Forty characters is longer
 * than any word anybody searches by — `Grameenphone` is twelve — and a value
 * longer than that is a sentence, which the alias rungs cannot match anyway
 * because they only ever compare whole words.
 */
export const MAX_SEARCH_ALIASES = 24;
export const MAX_SEARCH_ALIAS_LENGTH = 40;

/**
 * What a pasted list is allowed to be separated by.
 *
 * Commas first, because `খাবার, বাজার, restaurant` typed into one box is the
 * common case and refusing it teaches people that the field is fussy. Newlines
 * and semicolons cost nothing to accept and are what a paste from a note or a
 * spreadsheet cell actually contains.
 */
const ALIAS_SEPARATORS = /[,;\n\r]+/;

@Injectable()
export class CategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * `locale` decides `parentName` and nothing else.
   *
   * The row's own two names are both returned — the client picks, as the
   * pickers already do. `parentName` is the one field this endpoint collapses
   * into a single string, because it is a name *about* another row rather than
   * this one's, and the search result list prints it as a prefix.
   */
  async list(
    workspaceId: string,
    query: ListCategoriesQuery = {},
    locale: Locale = 'bn',
  ): Promise<CategoryView[]> {
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

    const nameById = new Map(rows.map((c) => [c.id, displayName(c, locale)]));

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
      searchAliases: c.searchAliases,
      usageCount: c._count.entries,
    }));

    return q === undefined ? views : searchCategories(views, q);
  }

  async create(
    workspaceId: string,
    actorUserId: string,
    input: CategoryWriteInput,
    locale: Locale = 'bn',
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
        searchAliases: parseSearchAliases(input.searchAliases) ?? [],
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

    /* The parent's name, not a hardcoded null.
     *
     * This returned `parentName: null` for every row including the ones that do
     * have a parent — a `CategoryView` that contradicts its own `parentId`. It
     * went unnoticed because the categories screen refetches after a save, so
     * the lie was overwritten within a render; a caller that trusted the
     * response, as the search result list now would, gets an orphaned sub-খাত. */
    const parent = parentId
      ? await this.prisma.category.findFirst({
          where: { id: parentId, workspaceId },
          select: { name: true, nameBn: true },
        })
      : null;

    return {
      ...created,
      parentName: parent ? displayName(parent, locale) : null,
      usageCount: 0,
    };
  }

  async update(
    workspaceId: string,
    actorUserId: string,
    id: string,
    input: Partial<CategoryWriteInput>,
    locale: Locale = 'bn',
  ): Promise<CategoryView> {
    const existing = await this.prisma.category.findFirst({
      where: { id, workspaceId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('ক্যাটাগরি পাওয়া যায়নি');

    /**
     * Re-parenting: promote a sub-category to the top, or move it under a
     * different head.
     *
     * `parentId` used to be accepted by the schema and then silently dropped
     * here, so the screen could offer the move, the request could succeed, and
     * nothing changed — the worst of the three possible behaviours. It is now
     * either applied or refused out loud.
     *
     * Omitted leaves the parent alone. `null` promotes to a top-level head.
     * `resolveParent` enforces the two rules that were always true of creation:
     * the parent must be the same kind, and it must not itself be a child.
     */
    const movingParent = input.parentId !== undefined;
    const nextParentId = movingParent
      ? await this.resolveParent(workspaceId, existing.kind, input.parentId)
      : existing.parentId;

    if (movingParent && nextParentId !== existing.parentId) {
      if (nextParentId === id) {
        throw new BadRequestException('একটি খাত তার নিজের উপ-খাত হতে পারে না');
      }
      /* Two levels, and this is the half `resolveParent` cannot see: it checks
         that the *destination* is not a child, but moving a head that has
         children of its own under another head would bury them three deep. */
      const childCount = await this.prisma.category.count({
        where: { workspaceId, parentId: id, deletedAt: null },
      });
      if (nextParentId && childCount > 0) {
        throw new BadRequestException(
          'এই খাতের নিচে উপ-খাত আছে, তাই একে অন্য খাতের নিচে নেওয়া যাবে না',
        );
      }
    }

    /* Names are unique per parent, so a move has to re-check the name even when
       the name itself is untouched — `বিদ্যুৎ` may be free at the top and taken
       under `ইউটিলিটি`. */
    const nextName = input.nameBn ?? input.name;
    const renaming = Boolean(nextName) && nextName !== (existing.nameBn ?? existing.name);
    if (renaming || (movingParent && nextParentId !== existing.parentId)) {
      await this.assertNameFree(
        workspaceId,
        existing.kind,
        nextName ?? existing.nameBn ?? existing.name,
        id,
        nextParentId,
      );
    }

    /* Absent leaves the list alone; present replaces it whole, including with
     * an empty list. A `PATCH` that omitted the field and still cleared the
     * aliases would lose a row's search words to an unrelated rename. */
    const aliases = parseSearchAliases(input.searchAliases);

    await this.prisma.category.update({
      where: { id },
      data: {
        name: input.name ?? existing.name,
        nameBn: input.nameBn ?? existing.nameBn,
        icon: input.icon,
        color: input.color,
        sortOrder: input.sortOrder,
        ...(aliases === undefined ? {} : { searchAliases: aliases }),
        ...(movingParent ? { parentId: nextParentId } : {}),
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
      before: {
        name: existing.nameBn ?? existing.name,
        ...(aliases === undefined ? {} : { searchAliases: existing.searchAliases }),
        ...(movingParent ? { parentId: existing.parentId } : {}),
      },
      after: {
        name: nextName ?? existing.nameBn ?? existing.name,
        ...(aliases === undefined ? {} : { searchAliases: aliases }),
        ...(movingParent ? { parentId: nextParentId } : {}),
      },
    });

    const [updated] = await this.list(workspaceId, {}, locale).then((all) =>
      all.filter((c) => c.id === id),
    );
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
   * Re-file every transaction under one খাত beneath another, and optionally
   * retire the emptied one.
   *
   * ## Why this exists
   *
   * `remove` above tells people to "আগে সেগুলো অন্য ক্যাটাগরিতে সরান" — move the
   * transactions somewhere else first — and until now the product offered no way
   * to do it. The only route was `PATCH /transactions/:id`, one row at a time,
   * which is not a route at all for the four-hundred-row categories arriving
   * from the other product's export. Bringing years of books across means
   * merging categories that should never have been two, and that is a bulk
   * operation or it does not happen.
   *
   * ## What it changes, and what it must never change
   *
   * One foreign key. `LedgerEntry.categoryId` — and `SharedExpense.categoryId`,
   * which points at the same table and would otherwise start disagreeing with
   * the ledger row it was booked as. Nothing else: not `amountMinor`, not
   * `direction`, not `accountId`, not the transaction's date. The money does not
   * move, no balance changes, and every account's total is the same poisha after
   * this call as before it. That is stated here because the temptation to "fix"
   * a little more while holding a thousand rows open is exactly how a bulk tool
   * destroys a set of books, and because the e2e suite asserts it.
   *
   * ## Every entry, including the binned ones
   *
   * The `where` deliberately does not filter on the transaction's `deletedAt`. A
   * soft-deleted transaction keeps its ledger entries and can be restored, and
   * restoring one into a খাত that was retired underneath it would resurrect a
   * row pointing at nothing. Counting them also keeps `movedCount` equal to the
   * `usageCount` the screen showed, and to the number `remove` refuses on.
   *
   * ## One transaction
   *
   * Reads and writes both. A half-moved category — some entries here, some
   * there, the source deleted or not depending on where it stopped — is worse
   * than one that never moved, and doing the lookups outside would leave a
   * window where the target could be deleted between the check and the update.
   */
  async move(
    workspaceId: string,
    actorUserId: string,
    id: string,
    toCategoryId: string,
    deleteAfter = false,
    locale: Locale = 'bn',
  ): Promise<MoveCategoryResult> {
    if (id === toCategoryId) {
      throw new BadRequestException('একই খাতে লেনদেন সরানো যায় না — অন্য একটি খাত বেছে নিন');
    }

    const outcome = await this.prisma.$transaction(async (tx) => {
      /* Both rows read through `workspaceId`, so a target belonging to somebody
       * else is simply not found. One message for both halves and a 404 rather
       * than a 403: a workspace must not be able to learn that a category id
       * exists elsewhere from the shape of the refusal it gets back. */
      const [source, target] = await Promise.all([
        tx.category.findFirst({
          where: { id, workspaceId, deletedAt: null },
          include: { _count: { select: { children: { where: { deletedAt: null } } } } },
        }),
        tx.category.findFirst({ where: { id: toCategoryId, workspaceId, deletedAt: null } }),
      ]);
      if (!source || !target) throw new NotFoundException('ক্যাটাগরি পাওয়া যায়নি');

      /* The one refusal that is about money rather than tidiness. An INCOME
       * entry sits on the nominal income account as a CREDIT and an EXPENSE
       * entry on the nominal expense account as a DEBIT; the category is what
       * names the line, and the sign lives on the entry. Re-filing an income
       * category's entries under an expense heading would therefore leave the
       * ledger balanced and the income statement silently rewritten — earnings
       * reported as spending, the surplus wrong by twice the amount, and nothing
       * on any screen to show it happened. There is no correct bulk answer, so
       * there is no bulk answer. */
      if (source.kind !== target.kind) {
        throw new BadRequestException(
          source.kind === 'INCOME'
            ? 'আয়ের খাতের লেনদেন খরচের খাতে সরানো যায় না — দুটো খাতের ধরন এক হতে হবে'
            : 'খরচের খাতের লেনদেন আয়ের খাতে সরানো যায় না — দুটো খাতের ধরন এক হতে হবে',
        );
      }

      /* Refused rather than silently re-parented, and refused whether or not
       * `deleteAfter` was asked for, so the rule is the same either way.
       *
       * A parent's own entries can be moved while its children stay behind —
       * they are different categories and the sub-খাতগুলো keep their own
       * transactions — but then the "খাত" the person thought they were emptying
       * still holds everything filed one level down, and the delete cannot fire.
       * Re-homing the children for them would be a second decision this endpoint
       * was never told to make, and the wrong one as often as not: they may
       * belong under the target, beside it, or nowhere. `remove` says the same
       * thing in the same words, so the two refusals are learnable as one rule. */
      if (source._count.children > 0) {
        throw new BadRequestException('আগে এর উপ-খাতগুলো সরান');
      }

      /* One column, one value. Not `amountMinor`, not `direction`, not
       * `accountId`, not the transaction behind it. */
      const { count } = await tx.ledgerEntry.updateMany({
        where: { workspaceId, categoryId: id },
        data: { categoryId: toCategoryId },
      });

      /* A shared bill files the owner's own share under a household category,
       * and the ledger entry it booked carries the same id. Leaving these
       * behind would let the split screen and the spending report name two
       * different খাত for one piece of spending. */
      await tx.sharedExpense.updateMany({
        where: { workspaceId, categoryId: id },
        data: { categoryId: toCategoryId },
      });

      /* Not history — a proposal nobody has accepted yet, and the only other
       * place a category id is written down. It has no foreign key, so a
       * retired source leaves a pointer at a row `acceptDraft` will refuse to
       * resolve, and the reviewer is asked to pick a category again for no
       * reason they can see. Moved with everything else; rejected and already
       * accepted drafts are left exactly as they were, because those are a
       * record of what was decided at the time. */
      await tx.transactionDraft.updateMany({
        where: { workspaceId, categoryId: id, status: 'PENDING' },
        data: { categoryId: toCategoryId },
      });

      /* "Merge into" as one press rather than two. Inside the same transaction
       * on purpose: a source emptied and then left standing because the second
       * call failed is a খাত that reads as unused and is not. */
      if (deleteAfter) {
        await tx.category.update({ where: { id }, data: { deletedAt: new Date() } });
      }

      return { count, source, target };
    });

    const fromName = displayName(outcome.source, locale);
    const intoName = displayName(outcome.target, locale);
    const movedCount = outcome.count;

    this.audit.emit({
      workspaceId,
      actorUserId,
      action: CATEGORY_MERGED,
      entity: 'Category',
      /* Filed against the survivor. "Where did the four hundred transactions
       * under পরিবহন go?" is the question this row exists to answer, and an
       * entityId pointing at a খাত that no longer appears in any list answers
       * nothing. The source is named in `before`. */
      entityId: toCategoryId,
      before: { id, name: fromName, kind: outcome.source.kind, usageCount: movedCount },
      after: { id: toCategoryId, name: intoName, movedCount, deleted: deleteAfter },
    });

    const moved = toBengaliDigits(String(movedCount));
    return {
      movedCount,
      deleted: deleteAfter,
      from: { id, name: fromName },
      into: { id: toCategoryId, name: intoName },
      message: deleteAfter
        ? `"${fromName}"-এর ${moved}টি লেনদেন "${intoName}"-এ সরানো হয়েছে এবং খাতটি মুছে ফেলা হয়েছে।`
        : `"${fromName}"-এর ${moved}টি লেনদেন "${intoName}"-এ সরানো হয়েছে।`,
    };
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
    /* The aliases, and the one thing transliteration cannot do. `khabar` finds
     * খাবার by letter mapping; `poribohon` cannot ever find যাতায়াত that way,
     * because they are two different words that happen to mean the same thing.
     *
     * SECONDARY, not PRIMARY, and the twenty points are deliberate: an alias
     * hit scores 1220, so it beats every partial match on every row and still
     * loses to a row whose own name is exactly what was typed. See the
     * `SearchAliases.weight` note in @hishab/core. */
    aliases: searchAliasField('searchAliases', 'SECONDARY', c.searchAliases),
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

// --- aliases ------------------------------------------------------------------

/**
 * Narrow, clean and cap a submitted alias list. Returns `undefined` when the
 * field was absent, which is what leaves an existing list untouched.
 *
 * Everything a person does to this field by accident is handled rather than
 * refused, because none of it is ambiguous:
 *
 *  - **A pasted string** — `khabar, bajar, restaurant` — is split. Each element
 *    of a submitted *array* is split too, since a paste into the first box of a
 *    list widget lands there and means exactly the same thing.
 *  - **Whitespace** is trimmed, and an entry that was only whitespace is
 *    dropped rather than stored as a key that can never match.
 *  - **Duplicates** go, compared case-insensitively: `Bajar` and `bajar` are
 *    one alias, and keeping both would cost a key set per request forever.
 *    `toLowerCase`, never `toLocaleLowerCase` — under a Turkish locale the
 *    latter folds `I` to `ı` and two devices would disagree about what is a
 *    duplicate. The first spelling wins, so the user's own capitalisation is
 *    what comes back.
 *
 * What is refused is only what cannot be repaired: a non-string entry, an alias
 * past `MAX_SEARCH_ALIAS_LENGTH`, or more than `MAX_SEARCH_ALIASES` of them.
 * Silently truncating a list somebody typed would be worse than saying no.
 *
 * `ownerLabel` names the thing the aliases hang off and exists only so the count
 * refusal reads correctly for the tag list too — tags carry `searchAliases` for
 * exactly the reason categories do, and reimplementing forty lines of splitting
 * and de-duplication over there would have given the two screens two different
 * ideas of what a pasted list means. It is passed already in the locative
 * ("ক্যাটাগরিতে", "ট্যাগে") because Bengali picks that ending from the last
 * sound of the noun, so gluing one on here would be wrong half the time.
 */
export function parseSearchAliases(
  value: unknown,
  ownerLabel = 'ক্যাটাগরিতে',
): string[] | undefined {
  if (value === undefined || value === null) return undefined;

  const entries = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(entries)) {
    throw new BadRequestException('খোঁজার নাম একটি তালিকা বা কমা দিয়ে আলাদা করা লেখা হতে হবে');
  }

  const out: string[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (typeof entry !== 'string') throw new BadRequestException('খোঁজার নাম শুধু লেখা হতে পারে');
    for (const piece of entry.split(ALIAS_SEPARATORS)) {
      const alias = piece.trim();
      if (alias === '') continue;
      if (alias.length > MAX_SEARCH_ALIAS_LENGTH) {
        throw new BadRequestException(
          `প্রতিটি খোঁজার নাম ${toBengaliDigits(String(MAX_SEARCH_ALIAS_LENGTH))} অক্ষরের বেশি হতে পারবে না`,
        );
      }
      const key = alias.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(alias);
    }
  }

  if (out.length > MAX_SEARCH_ALIASES) {
    throw new BadRequestException(
      `একটি ${ownerLabel} সর্বোচ্চ ${toBengaliDigits(String(MAX_SEARCH_ALIASES))}টি খোঁজার নাম রাখা যায়`,
    );
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
