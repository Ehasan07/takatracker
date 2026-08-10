import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { searchAliasField, searchDocs, searchField, type SearchDoc } from '@hishab/core';
import { toBengaliDigits } from '@hishab/shared';
import { Prisma } from '@prisma/client';
import { AccountsService } from '../accounts/accounts.service';
import { AuditService } from '../audit/audit.service';
import {
  MAX_SEARCH_ALIASES,
  MAX_SEARCH_QUERY_LENGTH,
  parseSearchAliases,
} from '../categories/categories.service';
import { minorToNumber } from '../common/bigint-json';
import { PrismaService } from '../prisma/prisma.service';
import { TAG_CREATED, TAG_DELETED, TAG_MERGED, TAG_UPDATED } from './tag-audit';

/**
 * Tags, and why they are not categories.
 *
 * The **category** answers *what the money went on* — খাবার ও বাজার, যাতায়াত.
 * Exactly one per transaction, because a taka spent on groceries was not also
 * spent on transport, and every spending report in this application depends on
 * that being true.
 *
 * A **tag** answers *who it was for* or *what project it belonged to* —
 * পারিবারিক, শ্বশুরবাড়ি, রমজান, গাড়ি. As many per transaction as the truth
 * needs, because the same grocery bill really is a family expense one week and a
 * business one the next. Folding that into the category is the tempting mistake:
 * it would make খাবার-পারিবারিক and খাবার-ব্যবসা two different categories, and
 * every "what do we spend on food?" report would then answer a question nobody
 * asked.
 *
 * So the two coexist on purpose. One category, many tags, and the reason both
 * exist is written down here rather than left for the next reader to guess.
 */

/**
 * A tag as the API returns it.
 *
 * The counts are not optional decoration. A tag list without them is a list of
 * words: the user cannot tell পারিবারিক (three hundred transactions) from a
 * typo they made once, and cannot decide what is safe to delete or worth
 * merging. They are the reason `GET /tags` costs a second query.
 */
export interface TagView {
  id: string;
  name: string;
  nameBn: string | null;
  color: string | null;
  icon: string | null;
  sortOrder: number;
  /**
   * The extra words that also find this row, returned on every response for the
   * same reason categories return theirs: a client cannot offer to edit a list
   * it was never shown, and a blind `PATCH` would overwrite what is there.
   */
  searchAliases: string[];
  /** Live transactions carrying this tag, of every type — transfers included. */
  transactionCount: number;
  /**
   * Money that moved under this tag, all time, split by direction.
   *
   * Two figures rather than one "total", because a tag like গাড়ি genuinely has
   * both sides — the fuel every month and the day it was sold — and adding them
   * together would produce a number that means nothing. `netMinor` is the one to
   * print when there is only room for one.
   */
  incomeMinor: number;
  expenseMinor: number;
  netMinor: number;
}

/** A create or update body. `searchAliases` is `unknown` — see `CategoryWriteInput`. */
export interface TagWriteInput {
  readonly name?: string;
  readonly nameBn?: string | null;
  readonly color?: string | null;
  readonly icon?: string | null;
  readonly sortOrder?: number;
  readonly searchAliases?: unknown;
}

/** Raw query-string values, untyped for the reason `ListCategoriesQuery` is. */
export interface ListTagsQuery {
  readonly q?: unknown;
}

/** What one tag accumulated over a period, or over all time when none is given. */
export interface TagTotals {
  incomeMinor: number;
  expenseMinor: number;
  /** Transactions with an income leg. Distinct — a split still counts once. */
  incomeCount: number;
  expenseCount: number;
  /** Every live transaction carrying the tag, including transfers, which have no nominal leg. */
  transactionCount: number;
}

/**
 * How many tags one workspace may hold.
 *
 * Deliberately **not** an entitlement. See the note on `assertRoomForOneMore`
 * for why `tags.max` was not invented; this is an abuse ceiling, not a price.
 * Nobody organises a household ledger with two hundred labels — past that point
 * the picker is unusable anyway — and every one of them is a key set built on
 * every search request, so an unbounded list is work the whole workspace pays.
 */
export const MAX_TAGS_PER_WORKSPACE = 200;

@Injectable()
export class TagsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountsService,
    private readonly audit: AuditService,
  ) {}

  async list(workspaceId: string, query: ListTagsQuery = {}): Promise<TagView[]> {
    const q = parseSearchQuery(query.q);

    /* Both reads are workspace-scoped, and they are the only two this endpoint
     * makes. Everything below — matching, ranking — runs in memory over exactly
     * these rows, so no later step can widen the set past this `workspaceId`. */
    const [rows, totals] = await Promise.all([
      this.prisma.tag.findMany({
        where: { workspaceId, deletedAt: null },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
      this.tagTotals(workspaceId),
    ]);

    const views = rows.map((row) => toView(row, totals.get(row.id)));
    return q === undefined ? views : searchTags(views, q);
  }

  async create(workspaceId: string, actorUserId: string, input: TagWriteInput): Promise<TagView> {
    const name = requireName(input.name);
    const nameBn = trimOrNull(input.nameBn);
    await this.assertNameFree(workspaceId, name, nameBn);
    await this.assertRoomForOneMore(workspaceId);

    const created = await this.prisma.$transaction(async (tx) => {
      await releaseName(tx, workspaceId, [name]);
      return tx.tag.create({
        data: {
          workspaceId,
          name,
          nameBn,
          color: trimOrNull(input.color),
          icon: trimOrNull(input.icon),
          sortOrder: input.sortOrder ?? 0,
          searchAliases: parseSearchAliases(input.searchAliases, 'ট্যাগে') ?? [],
        },
      });
    });

    this.audit.emit({
      workspaceId,
      actorUserId,
      action: TAG_CREATED,
      entity: 'Tag',
      entityId: created.id,
      after: { name: created.nameBn ?? created.name },
    });

    return toView(created, undefined);
  }

  async update(
    workspaceId: string,
    actorUserId: string,
    id: string,
    input: TagWriteInput,
  ): Promise<TagView> {
    const existing = await this.prisma.tag.findFirst({
      where: { id, workspaceId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('ট্যাগ পাওয়া যায়নি');

    const name = input.name === undefined ? existing.name : requireName(input.name);
    const nameBn = input.nameBn === undefined ? existing.nameBn : trimOrNull(input.nameBn);
    if (name !== existing.name || nameBn !== existing.nameBn) {
      await this.assertNameFree(workspaceId, name, nameBn, id);
    }

    /* Absent leaves the list alone; present replaces it whole, including with an
     * empty list. A `PATCH` that omitted the field and still cleared the aliases
     * would lose a tag's search words to an unrelated recolouring. */
    const aliases = parseSearchAliases(input.searchAliases, 'ট্যাগে');

    const updated = await this.prisma.$transaction(async (tx) => {
      await releaseName(tx, workspaceId, [name]);
      return tx.tag.update({
        where: { id },
        data: {
          name,
          nameBn,
          ...(input.color === undefined ? {} : { color: trimOrNull(input.color) }),
          ...(input.icon === undefined ? {} : { icon: trimOrNull(input.icon) }),
          ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
          ...(aliases === undefined ? {} : { searchAliases: aliases }),
        },
      });
    });

    this.audit.emit({
      workspaceId,
      actorUserId,
      action: TAG_UPDATED,
      entity: 'Tag',
      entityId: id,
      before: {
        name: existing.nameBn ?? existing.name,
        ...(aliases === undefined ? {} : { searchAliases: existing.searchAliases }),
      },
      after: {
        name: updated.nameBn ?? updated.name,
        ...(aliases === undefined ? {} : { searchAliases: aliases }),
      },
    });

    const totals = await this.tagTotals(workspaceId);
    return toView(updated, totals.get(id));
  }

  /**
   * Soft delete the tag, detach it from every transaction, destroy nothing else.
   *
   * A category refuses to be deleted while transactions point at it, because a
   * transaction *must* have somewhere to be filed and the ledger has to stay
   * readable years later. A tag is the opposite: it is an annotation, the row
   * survives without it, and refusing the delete would leave a user stuck with a
   * label they created by mistake and cannot get rid of. So the join rows go and
   * the transactions do not — and the response says how many, out loud, because
   * "delete" next to a word that appears on three hundred transactions is
   * exactly the button somebody presses expecting something smaller.
   */
  async remove(
    workspaceId: string,
    actorUserId: string,
    id: string,
  ): Promise<{
    id: string;
    name: string;
    detachedTransactionCount: number;
    deletedTransactionCount: 0;
    message: string;
  }> {
    const existing = await this.prisma.tag.findFirst({
      where: { id, workspaceId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('ট্যাগ পাওয়া যায়নি');

    const detached = await this.prisma.$transaction(async (tx) => {
      /* `workspaceId` on the join as well as the tag id. The pair is redundant —
       * the tag was already proven to be this workspace's — and it stays because
       * this is the one delete in the module that could reach another tenant's
       * rows if the id above were ever trusted from somewhere else. */
      const { count } = await tx.transactionTag.deleteMany({ where: { tagId: id, workspaceId } });
      await tx.tag.update({ where: { id }, data: { deletedAt: new Date() } });
      return count;
    });

    const display = existing.nameBn ?? existing.name;

    this.audit.emit({
      workspaceId,
      actorUserId,
      action: TAG_DELETED,
      entity: 'Tag',
      entityId: id,
      before: { name: display, detachedTransactionCount: detached },
    });

    return {
      id,
      name: display,
      detachedTransactionCount: detached,
      /* Stated rather than implied. The client shows this message next to a
       * count of transactions, and "০টি লেনদেন মুছে ফেলা হয়েছে" is the
       * reassurance the user actually wants at that moment. */
      deletedTransactionCount: 0,
      message: `"${display}" ট্যাগটি ${toBengaliDigits(String(detached))}টি লেনদেন থেকে সরানো হয়েছে। কোনো লেনদেন মুছে ফেলা হয়নি।`,
    };
  }

  /**
   * Fold one tag into another.
   *
   * People make পরিবার on Tuesday and পারিবারিক on Friday and mean the same
   * thing by both. Without this the only repair is opening every transaction and
   * re-tagging it by hand, which nobody does — so the two live on and every
   * by-tag report is quietly split down the middle.
   *
   * The source's name and aliases move onto the survivor, so somebody who has
   * been typing `poribar` for a year keeps finding their money.
   */
  async merge(
    workspaceId: string,
    actorUserId: string,
    sourceId: string,
    intoTagId: string,
  ): Promise<{
    from: { id: string; name: string };
    into: { id: string; name: string };
    movedTransactionCount: number;
    alreadyTaggedCount: number;
    aliasesAdded: number;
    message: string;
  }> {
    if (sourceId === intoTagId) {
      throw new BadRequestException('একটি ট্যাগ নিজের সাথে মেলানো যায় না');
    }

    const [source, target] = await Promise.all([
      this.prisma.tag.findFirst({ where: { id: sourceId, workspaceId, deletedAt: null } }),
      this.prisma.tag.findFirst({ where: { id: intoTagId, workspaceId, deletedAt: null } }),
    ]);
    /* One message for both, and a 404 rather than a 403. A workspace must not be
     * able to learn that a tag id exists somewhere else by the shape of the
     * refusal it gets back. */
    if (!source || !target) throw new NotFoundException('ট্যাগ পাওয়া যায়নি');

    const aliases = mergedAliases(target, source);

    const result = await this.prisma.$transaction(async (tx) => {
      const links = await tx.transactionTag.findMany({
        where: { tagId: sourceId, workspaceId },
        select: { transactionId: true },
      });

      /* `skipDuplicates` is doing real work: a transaction already carrying both
       * tags collides on the `(transactionId, tagId)` primary key, and that is
       * the common case rather than an edge one — the whole reason somebody
       * merges is that they have been using the two interchangeably. The rows
       * actually inserted are the ones that genuinely moved. */
      const { count: moved } = await tx.transactionTag.createMany({
        data: links.map((link) => ({
          transactionId: link.transactionId,
          tagId: intoTagId,
          workspaceId,
        })),
        skipDuplicates: true,
      });

      await tx.transactionTag.deleteMany({ where: { tagId: sourceId, workspaceId } });
      await tx.tag.update({ where: { id: intoTagId }, data: { searchAliases: aliases.list } });
      await tx.tag.update({ where: { id: sourceId }, data: { deletedAt: new Date() } });

      return { moved, alreadyBoth: links.length - moved };
    });

    const fromName = source.nameBn ?? source.name;
    const intoName = target.nameBn ?? target.name;

    this.audit.emit({
      workspaceId,
      actorUserId,
      action: TAG_MERGED,
      entity: 'Tag',
      /* Filed against the survivor, not the tag that disappeared. "What happened
       * to পারিবারিক?" is the question this row has to answer, and an entityId
       * pointing at a tag that no longer appears anywhere answers nothing. */
      entityId: intoTagId,
      before: { name: fromName, id: sourceId },
      after: {
        name: intoName,
        movedTransactionCount: result.moved,
        alreadyTaggedCount: result.alreadyBoth,
      },
    });

    return {
      from: { id: sourceId, name: fromName },
      into: { id: intoTagId, name: intoName },
      movedTransactionCount: result.moved,
      alreadyTaggedCount: result.alreadyBoth,
      aliasesAdded: aliases.added,
      message: `"${fromName}" ট্যাগটি "${intoName}"-এ মেলানো হয়েছে — ${toBengaliDigits(String(result.moved))}টি লেনদেন সরানো হয়েছে।`,
    };
  }

  /**
   * Money and transaction counts per tag, in one grouped query.
   *
   * Shared with `GET /reports/by-tag` on purpose: the tag list and the tag report
   * must not be able to disagree about what a tag is worth. Pass a range for a
   * period, omit it for all time.
   *
   * The ledger join is a LEFT JOIN and that is the load-bearing detail. A
   * transfer between two of the user's own accounts has no income or expense
   * leg, so an inner join would drop it — and a tag put on a bank transfer would
   * report zero transactions, which reads as "this tag is unused" rather than
   * "this tag is on money that never left the household". The sums still only
   * pick up the two nominal accounts; only the count sees everything.
   */
  async tagTotals(
    workspaceId: string,
    range?: { gte: Date; lt: Date },
  ): Promise<Map<string, TagTotals>> {
    const system = await this.accounts.systemAccounts(workspaceId);
    const period = range
      ? Prisma.sql`AND t."date" >= ${range.gte} AND t."date" < ${range.lt}`
      : Prisma.empty;

    const rows = await this.prisma.$queryRaw<
      {
        tag_id: string;
        income: bigint;
        expense: bigint;
        income_count: number;
        expense_count: number;
        txn_count: number;
      }[]
    >(Prisma.sql`
      SELECT tt."tagId" AS tag_id,
             COALESCE(SUM(CASE WHEN e."accountId" = ${system.incomeAccountId}
                               THEN e."amountMinor" ELSE 0 END), 0)::bigint AS income,
             COALESCE(SUM(CASE WHEN e."accountId" = ${system.expenseAccountId}
                               THEN e."amountMinor" ELSE 0 END), 0)::bigint AS expense,
             COUNT(DISTINCT CASE WHEN e."accountId" = ${system.incomeAccountId}
                                 THEN t."id" END)::int AS income_count,
             COUNT(DISTINCT CASE WHEN e."accountId" = ${system.expenseAccountId}
                                 THEN t."id" END)::int AS expense_count,
             COUNT(DISTINCT t."id")::int AS txn_count
      FROM "TransactionTag" tt
      JOIN "Transaction" t
        ON t."id" = tt."transactionId"
       AND t."workspaceId" = ${workspaceId}
       AND t."deletedAt" IS NULL
      LEFT JOIN "LedgerEntry" e
        ON e."transactionId" = t."id"
       AND e."workspaceId" = ${workspaceId}
       AND e."accountId" IN (${system.incomeAccountId}, ${system.expenseAccountId})
      WHERE tt."workspaceId" = ${workspaceId}
      ${period}
      GROUP BY tt."tagId"
    `);

    return new Map(
      rows.map((row) => [
        row.tag_id,
        {
          incomeMinor: minorToNumber(BigInt(row.income)),
          expenseMinor: minorToNumber(BigInt(row.expense)),
          incomeCount: Number(row.income_count),
          expenseCount: Number(row.expense_count),
          transactionCount: Number(row.txn_count),
        },
      ]),
    );
  }

  /**
   * Two tags may not share a name, in either language.
   *
   * The database enforces it on `name` alone (`@@unique([workspaceId, name])`),
   * which is not enough: a picker showing পরিবার twice — once as an English
   * tag's Bengali label and once as a Bengali tag's name — is ambiguous whatever
   * the underlying columns say.
   */
  private async assertNameFree(
    workspaceId: string,
    name: string,
    nameBn: string | null,
    exceptId?: string,
  ): Promise<void> {
    const wanted = [name, ...(nameBn ? [nameBn] : [])];
    const clash = await this.prisma.tag.findFirst({
      where: {
        workspaceId,
        deletedAt: null,
        ...(exceptId ? { id: { not: exceptId } } : {}),
        OR: [{ name: { in: wanted } }, { nameBn: { in: wanted } }],
      },
    });
    if (clash) throw new BadRequestException('এই নামে একটি ট্যাগ আগে থেকেই আছে');
  }

  /**
   * The abuse ceiling, and why there is no `tags.max` entitlement.
   *
   * `packages/core/src/entitlements.ts` makes the catalogue data: a key lives in
   * the `Feature` table, and `limitFor` resolves an unknown key to **0 — off**,
   * deliberately, so that creating a feature does not hand it to everyone.
   * Naming `tags.max` here without a matching `Feature` row and a grant on every
   * plan would therefore 402 the first `POST /tags` in every workspace in the
   * system. Adding those rows is a catalogue and pricing decision (which tier
   * gets how many), not something to invent inside a tagging change.
   *
   * It is also the wrong shape for a paywall. Tags are how a user describes
   * their own money; metering them sells the ability to be organised, and the
   * feature that makes tags worth paying for is the *report*, which is where a
   * flag would belong if anyone wants one later.
   */
  private async assertRoomForOneMore(workspaceId: string): Promise<void> {
    const count = await this.prisma.tag.count({ where: { workspaceId, deletedAt: null } });
    if (count >= MAX_TAGS_PER_WORKSPACE) {
      throw new BadRequestException(
        `একটি হিসাবে সর্বোচ্চ ${toBengaliDigits(String(MAX_TAGS_PER_WORKSPACE))}টি ট্যাগ রাখা যায় — অপ্রয়োজনীয় ট্যাগগুলো মুছে ফেলুন বা মিলিয়ে নিন`,
      );
    }
  }
}

// --- helpers ------------------------------------------------------------------

function toView(
  row: {
    id: string;
    name: string;
    nameBn: string | null;
    color: string | null;
    icon: string | null;
    sortOrder: number;
    searchAliases: string[];
  },
  totals: TagTotals | undefined,
): TagView {
  const incomeMinor = totals?.incomeMinor ?? 0;
  const expenseMinor = totals?.expenseMinor ?? 0;
  return {
    id: row.id,
    name: row.name,
    nameBn: row.nameBn,
    color: row.color,
    icon: row.icon,
    sortOrder: row.sortOrder,
    searchAliases: row.searchAliases,
    transactionCount: totals?.transactionCount ?? 0,
    incomeMinor,
    expenseMinor,
    netMinor: incomeMinor - expenseMinor,
  };
}

function trimOrNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function requireName(value: string | undefined): string {
  const name = value?.trim() ?? '';
  if (name === '') throw new BadRequestException('ট্যাগের নাম দিন');
  return name;
}

/**
 * Clear any *deleted* tag squatting on a name that is about to be used.
 *
 * `@@unique([workspaceId, name])` counts soft-deleted rows, so without this a
 * user who deletes রমজান in April cannot create it again next Ramadan — the
 * insert fails on a row they cannot see and have no endpoint to reach. The
 * tombstone is safe to destroy: `remove` already detached every transaction from
 * it, so it holds no relationships, and the audit line for the delete recorded
 * its name. It exists only to keep the id resolvable, and that is worth less
 * than being able to reuse the word.
 */
async function releaseName(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  names: readonly string[],
): Promise<void> {
  await tx.tag.deleteMany({
    where: { workspaceId, deletedAt: { not: null }, name: { in: [...names] } },
  });
}

/**
 * The survivor's aliases after a merge: its own, plus the name and aliases of
 * the tag that is disappearing.
 *
 * Capped at `MAX_SEARCH_ALIASES` for the reason the cap exists at all — every
 * alias is a key set built on every search request. When the merge would push
 * the list over, the survivor's own aliases are kept and the incoming ones are
 * dropped from the end, and the response reports how many actually landed rather
 * than claiming a merge did more than it did.
 */
function mergedAliases(
  target: { searchAliases: string[] },
  source: { name: string; nameBn: string | null; searchAliases: string[] },
): { list: string[]; added: number } {
  const out: string[] = [];
  const seen = new Set<string>();

  const push = (value: string | null): void => {
    const alias = value?.trim() ?? '';
    if (alias === '') return;
    const key = alias.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(alias);
  };

  for (const alias of target.searchAliases) push(alias);
  const before = out.length;
  /* The dead tag's own names first: `poribar` typed into the search box has to
   * keep working, and that matters more than any alias it was carrying. */
  push(source.name);
  push(source.nameBn);
  for (const alias of source.searchAliases) push(alias);

  const list = out.slice(0, MAX_SEARCH_ALIASES);
  return { list, added: Math.max(0, list.length - before) };
}

// --- search -------------------------------------------------------------------

/**
 * Match and rank the workspace's tags against `q`, in memory.
 *
 * The same shape as `searchCategories`, and in memory for the same reason: a
 * workspace holds a few dozen tags, they are already loaded to attach the
 * counts, and ranking them is not measurable next to the round trip.
 *
 * Pushing `q` into SQL as `WHERE name ILIKE '%…%'` would destroy the feature,
 * exactly as it would for categories. Postgres cannot transliterate: `lower()`
 * is a no-op on a script with no case, `unaccent` has no Bengali rules, and the
 * trigram similarity between `পরিবার` and `poribar` is zero because they share
 * no trigrams. `?q=poribar` finds পরিবার only because the fold runs here.
 *
 * No hierarchy to preserve, so no `keepHierarchy` and no `matched` flag: tags
 * are flat, and every row in a filtered response is a hit.
 */
function searchTags(views: readonly TagView[], rawQuery: string): TagView[] {
  const docs: SearchDoc<TagView>[] = views.map((tag) => ({
    id: tag.id,
    row: tag,
    /* The user's own arrangement, the last tie-break before `id`. */
    order: tag.sortOrder,
    fields: [
      searchField('nameBn', 'PRIMARY', tag.nameBn),
      searchField('name', 'PRIMARY', tag.name),
    ],
    /* The one thing transliteration cannot do. `poribar` reaches পরিবার by
     * letter mapping; `family` never will, because they are two different words
     * that happen to mean the same thing. SECONDARY for the ordering reason
     * documented on `SearchAliases.weight` in @hishab/core. */
    aliases: searchAliasField('searchAliases', 'SECONDARY', tag.searchAliases),
  }));

  const result = searchDocs(docs, rawQuery);

  /* A one-character query is not a filter: it matches nearly every row at the
   * weakest tier, which is indistinguishable from no filter and far more
   * surprising. Hand back the natural list rather than a ranked pretence. */
  if (!result.filtered) return [...views];

  /* Suggestions appended rather than interleaved — the matcher keeps the bands
   * apart, and only fills the bucket when the real matches nearly ran out. */
  return [...result.hits, ...result.suggestions].map((hit) => hit.row);
}

// --- query parameters ---------------------------------------------------------

function parseSearchQuery(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined;
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
