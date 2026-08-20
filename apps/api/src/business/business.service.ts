import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { BUSINESS_CATEGORY_SEED, COST_OF_GOODS_SOLD_BN } from '@hishab/core';
import { fromLocalDateString, sumMinor, toLocalDateString } from '@hishab/shared';
import { AuditService } from '../audit/audit.service';
import { minorToNumber } from '../common/bigint-json';
import { PrismaService } from '../prisma/prisma.service';
import { TransactionsService, type TenantContext } from '../transactions/transactions.service';

/**
 * A personal business inside a household's books.
 *
 * ## What this module is for
 *
 * Two jobs, and both exist because the accounting is right but the *typing* is
 * not something a shopkeeper should have to get right by hand:
 *
 *  - **Setting up.** Eighteen categories in the right shape, a tag to mark the
 *    venture with, in one press.
 *  - **The month-end count.** Turning "I counted ৳50,000 of stock on the shelf"
 *    into the one entry that makes the month's profit true.
 *
 * ## Why the count is a first-class endpoint and not advice
 *
 * The arithmetic is not hard — opening plus purchases less closing — but it is
 * the step that decides whether a shop's books mean anything, and it is the one
 * a person is most likely to skip or get backwards. Recording stock as an
 * expense when it is bought makes a heavy-buying month look like a loss and the
 * month after it look like a windfall; both are false, and neither is visible
 * as a mistake. Here the owner types one number they have actually counted and
 * the entry that follows from it is written for them.
 */
@Injectable()
export class BusinessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transactions: TransactionsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The tag and the category tree, created once and safe to press twice.
   *
   * Idempotent by name, not by a flag on the workspace. Somebody who ran this,
   * renamed two categories and pressed it again should get the two they
   * renamed left alone and nothing duplicated — a `businessSetupDone` boolean
   * would answer a different question than the one being asked, which is "does
   * this workspace have these categories".
   */
  /**
   * Nothing here runs for a workspace that has not asked for a business.
   *
   * Checked on the server and not only by hiding a link. The switch is what
   * says these books have a business in them at all, and an endpoint that
   * wrote eighteen categories into a household that never asked would be a
   * feature arriving by URL.
   */
  private async assertEnabled(workspaceId: string): Promise<void> {
    const workspace = await this.prisma.workspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
      select: { businessEnabled: true },
    });
    if (!workspace?.businessEnabled) {
      throw new ForbiddenException('সেটিংস থেকে “ব্যক্তিগত ব্যবসা বা শেয়ার ট্রেডিং” চালু করুন');
    }
  }

  async setup(
    ctx: TenantContext,
    input: { name: string },
  ): Promise<{
    tagId: string;
    tagName: string;
    createdCategories: number;
    existingCategories: number;
    costOfGoodsSoldCategoryId: string;
  }> {
    await this.assertEnabled(ctx.workspaceId);
    const name = input.name.trim();
    if (!name) throw new BadRequestException('ব্যবসার একটা নাম দিন');

    /* `@@unique([workspaceId, name])` on Tag, so this is find-or-create rather
       than create-and-hope: pressing the button twice must not fail on a
       constraint, and must not end up with two tags the owner has to merge. */
    const tag =
      (await this.prisma.tag.findFirst({
        where: { workspaceId: ctx.workspaceId, name, deletedAt: null },
        select: { id: true, name: true },
      })) ??
      (await this.prisma.tag.create({
        data: { workspaceId: ctx.workspaceId, name, nameBn: name, icon: 'briefcase' },
        select: { id: true, name: true },
      }));

    const existing = await this.prisma.category.findMany({
      where: { workspaceId: ctx.workspaceId, deletedAt: null },
      select: { id: true, nameBn: true, name: true, kind: true, parentId: true },
    });
    /* Matched on the Bengali name within a kind, which is what a person reads
       and what the seed is written in. The English name is a fallback for a
       workspace whose books are kept in English. */
    const found = (kind: string, seed: { nameBn: string; name: string }, parentId: string | null) =>
      existing.find(
        (row) =>
          row.kind === kind &&
          row.parentId === parentId &&
          (row.nameBn === seed.nameBn || row.name === seed.name),
      );

    let created = 0;
    let reused = 0;
    let cogsId = '';

    for (const [groupIndex, group] of BUSINESS_CATEGORY_SEED.entries()) {
      const base = 900 + groupIndex * 100;
      let parent = found(group.kind, group, null);
      if (!parent) {
        parent = await this.prisma.category.create({
          data: {
            workspaceId: ctx.workspaceId,
            name: group.name,
            nameBn: group.nameBn,
            kind: group.kind,
            icon: group.icon,
            sortOrder: base,
            searchAliases: [...group.searchAliases],
          },
          select: { id: true, nameBn: true, name: true, kind: true, parentId: true },
        });
        created += 1;
      } else {
        reused += 1;
      }

      for (const [childIndex, child] of group.children.entries()) {
        const already = found(group.kind, child, parent.id);
        const row =
          already ??
          (await this.prisma.category.create({
            data: {
              workspaceId: ctx.workspaceId,
              name: child.name,
              nameBn: child.nameBn,
              kind: group.kind,
              icon: child.icon,
              parentId: parent.id,
              sortOrder: base + childIndex + 1,
              searchAliases: [...child.searchAliases],
            },
            select: { id: true, nameBn: true, name: true, kind: true, parentId: true },
          }));
        if (already) reused += 1;
        else created += 1;
        if (child.nameBn === COST_OF_GOODS_SOLD_BN) cogsId = row.id;
      }
    }

    this.audit.emit({
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.id,
      action: 'business.setup',
      entity: 'Tag',
      entityId: tag.id,
      after: { name: tag.name, createdCategories: created, existingCategories: reused },
    });

    return {
      tagId: tag.id,
      tagName: tag.name,
      createdCategories: created,
      existingCategories: reused,
      costOfGoodsSoldCategoryId: cogsId,
    };
  }

  /**
   * What the books say is on the shelf, on a given day.
   *
   * The inventory account already holds opening stock plus everything bought
   * into it, because a purchase is a transfer rather than a cost — so the
   * ledger figure *is* "opening + purchases", and the owner only has to supply
   * the third term. That is the whole reason the count asks for one number
   * instead of three.
   */
  async stockPreview(
    ctx: TenantContext,
    input: { accountId: string; date: string },
  ): Promise<{ accountId: string; accountName: string; date: string; ledgerMinor: number }> {
    await this.assertEnabled(ctx.workspaceId);
    const account = await this.requireAccount(ctx.workspaceId, input.accountId);
    return {
      accountId: account.id,
      accountName: account.name,
      date: input.date,
      ledgerMinor: await this.balanceAsOf(ctx, account.id, input.date),
    };
  }

  /**
   * The month-end entry: what was bought and is no longer there was sold.
   *
   * One expense against the inventory account — the stock leaves the balance
   * sheet and lands on the income statement as `বিক্রীত পণ্যের ব্যয়`, which is
   * where a shop's profit actually comes from. Tagged, so it reaches the
   * business's own statement and not merely the household's.
   */
  async stockCount(
    ctx: TenantContext,
    input: {
      accountId: string;
      date: string;
      countedMinor: number;
      tagId?: string;
      categoryId?: string;
    },
  ): Promise<{
    ledgerMinor: number;
    countedMinor: number;
    costOfGoodsSoldMinor: number;
    transactionId: string;
  }> {
    await this.assertEnabled(ctx.workspaceId);
    const account = await this.requireAccount(ctx.workspaceId, input.accountId);
    const ledgerMinor = await this.balanceAsOf(ctx, account.id, input.date);
    const cost = ledgerMinor - input.countedMinor;

    if (cost === 0) {
      throw new BadRequestException(
        'গোনা মজুদ আর খাতার মজুদ সমান — এই সময়ে কিছু বিক্রি হয়নি, তাই কোনো এন্ট্রি লাগবে না',
      );
    }
    /* Counted more than the books hold. Something came in that was never
       recorded, and the fix is that purchase — not an entry here. Writing the
       difference as income would turn a missing purchase into profit, which is
       the one direction this must never round. */
    if (cost < 0) {
      throw new BadRequestException(
        'গোনা মজুদ খাতার চেয়ে বেশি — কোনো ক্রয় লেখা হয়নি। আগে সেই ক্রয়টি লিখুন, তারপর গণনা দিন',
      );
    }

    const categoryId = input.categoryId ?? (await this.costOfGoodsSoldCategory(ctx.workspaceId));
    if (!categoryId) {
      throw new BadRequestException(
        'বিক্রীত পণ্যের ব্যয় নামে কোনো খাত নেই — আগে ব্যবসার খাতগুলো তৈরি করুন',
      );
    }

    const written = await this.transactions.create(ctx, {
      type: 'EXPENSE',
      date: input.date,
      amountMinor: cost,
      accountId: account.id,
      categoryId,
      source: 'MANUAL',
      description: `মজুদ গণনা — ${toLocalDateString(fromLocalDateString(input.date, ctx.timezone), ctx.timezone)}`,
      ...(input.tagId ? { tagIds: [input.tagId] } : {}),
    });

    this.audit.emit({
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.id,
      action: 'business.stock_counted',
      entity: 'Account',
      entityId: account.id,
      after: {
        date: input.date,
        ledgerMinor,
        countedMinor: input.countedMinor,
        costOfGoodsSoldMinor: cost,
        transactionId: written.id,
      },
    });

    return {
      ledgerMinor,
      countedMinor: input.countedMinor,
      costOfGoodsSoldMinor: cost,
      transactionId: written.id,
    };
  }

  /** The account holding the stock. Never a system account: those are machinery. */
  private async requireAccount(
    workspaceId: string,
    accountId: string,
  ): Promise<{ id: string; name: string }> {
    const account = await this.prisma.account.findFirst({
      where: { id: accountId, workspaceId, deletedAt: null, systemKey: null },
      select: { id: true, name: true },
    });
    if (!account) throw new NotFoundException('অ্যাকাউন্টটি পাওয়া যায়নি');
    return account;
  }

  /**
   * The account's balance at the end of a day.
   *
   * Debits less credits, which for the asset the stock sits in is what it is
   * worth. The window is half-open — everything strictly before the following
   * midnight — so a count dated the 31st includes what was bought on the 31st.
   */
  private async balanceAsOf(ctx: TenantContext, accountId: string, date: string): Promise<number> {
    const endsBefore = new Date(fromLocalDateString(date, ctx.timezone).getTime() + 86_400_000);
    const grouped = await this.prisma.ledgerEntry.groupBy({
      by: ['direction'],
      where: {
        workspaceId: ctx.workspaceId,
        accountId,
        transaction: { deletedAt: null, date: { lt: endsBefore } },
      },
      _sum: { amountMinor: true },
    });

    let balance = 0;
    for (const row of grouped) {
      const magnitude = minorToNumber(row._sum.amountMinor ?? 0n);
      balance = sumMinor([balance, row.direction === 'DEBIT' ? magnitude : -magnitude]);
    }
    return balance;
  }

  /** The seeded `বিক্রীত পণ্যের ব্যয়`, by name, so the count lands where it belongs. */
  private async costOfGoodsSoldCategory(workspaceId: string): Promise<string | null> {
    const row = await this.prisma.category.findFirst({
      where: {
        workspaceId,
        deletedAt: null,
        kind: 'EXPENSE',
        OR: [{ nameBn: COST_OF_GOODS_SOLD_BN }, { name: 'Cost of goods sold' }],
      },
      select: { id: true },
    });
    return row?.id ?? null;
  }
}
