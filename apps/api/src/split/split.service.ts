import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type SplitMethod as PrismaSplitMethod } from '@prisma/client';
import {
  SplitError,
  assertBalanced,
  groupPositions,
  splitExpense,
  suggestSettlements,
  type EntryDraft,
  type SplitInput,
} from '@hishab/core';
import { fromLocalDateString, toLocalDateString } from '@hishab/shared';
import { AccountsService } from '../accounts/accounts.service';
import { AuditService } from '../audit/audit.service';
import { minorToNumber } from '../common/bigint-json';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../transactions/transactions.service';

/**
 * Spending together: trips, flats, office lunches, a family fund.
 *
 * ## A shared expense is a loan the app already knows how to keep
 *
 * Four people eat, I pay ৳3,000, my share is ৳750. The other ৳2,250 is not my
 * expense — it is money three people owe me, and this product has kept track of
 * money owed since the loan ledger shipped. So the entries are:
 *
 *     DEBIT   expense nominal (my category)    ৳750     ← only my share is spending
 *     DEBIT   ঋণ পাওনা  (receivable control)     ৳2,250   ← what they owe me
 *     CREDIT  cash / bank                      ৳3,000
 *
 * and when somebody else pays, I book my share against the payable instead, with
 * no cash moving until the debt is actually settled:
 *
 *     DEBIT   expense nominal                  ৳750
 *     CREDIT  ঋণ দেনা  (payable control)         ৳750
 *
 * That is ordinary double entry with a control account and a subsidiary ledger
 * behind it — the oldest arrangement in bookkeeping, and the reason this feature
 * needed one new calculator rather than a second accounting system. It also
 * means shared spending shows up correctly everywhere else for free: only the
 * owner's own share reaches the expense report, the budget that is coming, and
 * the income statement.
 *
 * ## What lands in whose books
 *
 * Nothing is ever posted to a group. A group records who was there and how the
 * bill divided; every entry belongs to the workspace that owns it. A member who
 * has no account here is a `Person` — the same row the loan ledger uses — so a
 * flatmate who is on the trip *and* borrowed money last year is one person with
 * one balance, not two.
 *
 * A bill the owner was not on at all produces no entry in their books, and
 * `transactionId` stays null. It is still recorded, because the group's balances
 * have to stay right, and because the owner is the one keeping the book.
 */

/** Every amount in this file is in the workspace's currency. */
const CURRENCY = 'BDT';

export interface CreateGroupInput {
  name: string;
  purpose?: 'TRIP' | 'HOUSEHOLD' | 'OFFICE' | 'EVENT' | 'OTHER';
  currency?: string;
  note?: string;
  /** People to start with. A member row for the owner is always created. */
  members?: { personId?: string; name?: string; shareWeight?: number }[];
}

export interface CreateExpenseInput {
  description: string;
  date: string;
  totalMinor: number;
  payerMemberId: string;
  splitMethod: PrismaSplitMethod;
  shares: { memberId: string; amountMinor?: number; percentBps?: number; shareWeight?: number }[];
  categoryId?: string;
  /** Required when the owner paid: which account the money left. */
  accountId?: string;
  note?: string;
  attachmentIds?: string[];
}

export interface SettleInput {
  fromMemberId: string;
  toMemberId: string;
  amountMinor: number;
  date: string;
  accountId?: string;
  note?: string;
}

const draft = (
  accountId: string,
  direction: 'DEBIT' | 'CREDIT',
  amountMinor: number,
  categoryId?: string | null,
): EntryDraft => ({
  accountId,
  direction,
  amountMinor,
  currency: CURRENCY,
  fxRate: 1,
  categoryId,
});

const entryData = (
  entry: EntryDraft,
  workspaceId: string,
): Prisma.LedgerEntryCreateWithoutTransactionInput => ({
  workspace: { connect: { id: workspaceId } },
  account: { connect: { id: entry.accountId } },
  category: entry.categoryId ? { connect: { id: entry.categoryId } } : undefined,
  amountMinor: BigInt(entry.amountMinor),
  direction: entry.direction,
  currency: entry.currency,
  fxRate: entry.fxRate,
});

@Injectable()
export class SplitService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountsService,
    private readonly audit: AuditService,
  ) {}

  // --- groups ---------------------------------------------------------------

  async createGroup(ctx: TenantContext, input: CreateGroupInput) {
    const name = input.name.trim();
    if (!name) throw new BadRequestException('গ্রুপের নাম দিন');

    const group = await this.prisma.$transaction(async (tx) => {
      const created = await tx.splitGroup.create({
        data: {
          workspaceId: ctx.workspaceId,
          name,
          purpose: input.purpose ?? 'OTHER',
          currency: input.currency ?? CURRENCY,
          note: input.note?.trim() || null,
          createdByUserId: ctx.id || null,
          /* The owner is a member of their own group, always and first. Without
             a line for themselves there is nowhere to put their own share, and
             every bill would look like it was entirely somebody else's. */
          members: {
            create: {
              workspaceId: ctx.workspaceId,
              isSelf: true,
              displayName: 'আমি',
            },
          },
        },
        include: { members: true },
      });

      for (const member of input.members ?? []) {
        await this.addMemberRow(tx, ctx, created.id, member);
      }
      return created;
    });

    await this.audit.record({
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.id,
      action: 'split.group_created',
      entity: 'SplitGroup',
      entityId: group.id,
      after: { name: group.name, purpose: group.purpose },
    });

    return this.findGroup(ctx, group.id);
  }

  private async addMemberRow(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    groupId: string,
    input: { personId?: string; name?: string; shareWeight?: number },
  ) {
    let personId = input.personId ?? null;
    let displayName = input.name?.trim() ?? '';

    if (personId) {
      const person = await tx.person.findFirst({
        where: { id: personId, workspaceId: ctx.workspaceId, deletedAt: null },
        select: { id: true, name: true },
      });
      if (!person) throw new NotFoundException('এই ব্যক্তিকে পাওয়া যায়নি');
      displayName = displayName || person.name;
    } else {
      if (!displayName) throw new BadRequestException('সদস্যের নাম দিন');
      /* A new name creates a `Person`, not a group-only row. The point is that
         what they owe follows them out of this group and into the party ledger
         beside anything else between the two of you. */
      const person = await tx.person.create({
        data: { workspaceId: ctx.workspaceId, name: displayName },
      });
      personId = person.id;
    }

    const existing = await tx.splitGroupMember.findFirst({
      where: { groupId, personId },
    });
    if (existing) {
      if (!existing.removedAt) throw new BadRequestException('এই ব্যক্তি আগে থেকেই গ্রুপে আছেন');
      return tx.splitGroupMember.update({
        where: { id: existing.id },
        data: { removedAt: null, shareWeight: input.shareWeight ?? 1 },
      });
    }

    return tx.splitGroupMember.create({
      data: {
        workspaceId: ctx.workspaceId,
        groupId,
        personId,
        displayName,
        shareWeight: input.shareWeight ?? 1,
      },
    });
  }

  async addMember(
    ctx: TenantContext,
    groupId: string,
    input: { personId?: string; name?: string; shareWeight?: number },
  ) {
    await this.requireGroup(ctx.workspaceId, groupId);
    await this.prisma.$transaction((tx) => this.addMemberRow(tx, ctx, groupId, input));
    return this.findGroup(ctx, groupId);
  }

  async removeMember(ctx: TenantContext, groupId: string, memberId: string) {
    await this.requireGroup(ctx.workspaceId, groupId);
    const member = await this.prisma.splitGroupMember.findFirst({
      where: { id: memberId, groupId, workspaceId: ctx.workspaceId },
    });
    if (!member) throw new NotFoundException('সদস্য পাওয়া যায়নি');
    if (member.isSelf) throw new BadRequestException('নিজেকে গ্রুপ থেকে সরানো যাবে না');

    /* Marked removed rather than deleted. Their name is on bills that already
       happened, and a balance that vanishes because somebody left the group is
       a balance that was never settled. */
    const onABill = await this.prisma.sharedExpenseShare.count({ where: { memberId } });
    if (onABill > 0) {
      await this.prisma.splitGroupMember.update({
        where: { id: memberId },
        data: { removedAt: new Date() },
      });
    } else {
      await this.prisma.splitGroupMember.delete({ where: { id: memberId } });
    }
    return this.findGroup(ctx, groupId);
  }

  async listGroups(ctx: TenantContext) {
    const groups = await this.prisma.splitGroup.findMany({
      where: { workspaceId: ctx.workspaceId, deletedAt: null },
      orderBy: [{ archivedAt: 'asc' }, { createdAt: 'desc' }],
      include: {
        members: { where: { removedAt: null } },
        _count: { select: { expenses: true } },
      },
    });

    /* One query for every group's balances rather than one per group: this is
       the screen somebody opens first, and it must not cost a round trip per
       row. */
    const ids = groups.map((g) => g.id);
    const positions = ids.length > 0 ? await this.positionsFor(ctx.workspaceId, ids) : new Map();

    return groups.map((group) => {
      const mine = positions.get(group.id)?.self ?? 0;
      return {
        id: group.id,
        name: group.name,
        purpose: group.purpose,
        currency: group.currency,
        note: group.note,
        memberCount: group.members.length,
        expenseCount: group._count.expenses,
        /* Positive: the group owes the owner. Negative: the owner owes it. */
        myNetMinor: mine,
        archivedAt: group.archivedAt?.toISOString() ?? null,
        createdAt: group.createdAt.toISOString(),
      };
    });
  }

  async findGroup(ctx: TenantContext, groupId: string) {
    const group = await this.requireGroup(ctx.workspaceId, groupId);
    const { positions, suggestions, members } = await this.balances(ctx, groupId);

    return {
      id: group.id,
      name: group.name,
      purpose: group.purpose,
      currency: group.currency,
      note: group.note,
      archivedAt: group.archivedAt?.toISOString() ?? null,
      createdAt: group.createdAt.toISOString(),
      members,
      positions,
      suggestions,
    };
  }

  async updateGroup(
    ctx: TenantContext,
    groupId: string,
    input: {
      name?: string;
      purpose?: CreateGroupInput['purpose'];
      note?: string | null;
      archived?: boolean;
    },
  ) {
    await this.requireGroup(ctx.workspaceId, groupId);
    await this.prisma.splitGroup.update({
      where: { id: groupId },
      data: {
        name: input.name?.trim() || undefined,
        purpose: input.purpose,
        note: input.note === undefined ? undefined : (input.note?.trim() ?? null) || null,
        archivedAt: input.archived === undefined ? undefined : input.archived ? new Date() : null,
      },
    });
    return this.findGroup(ctx, groupId);
  }

  async removeGroup(ctx: TenantContext, groupId: string) {
    await this.requireGroup(ctx.workspaceId, groupId);
    const spent = await this.prisma.sharedExpense.count({
      where: { groupId, deletedAt: null },
    });
    if (spent > 0) {
      throw new BadRequestException(
        'এই গ্রুপে খরচ লেখা আছে, তাই মুছে ফেলা যাবে না — চাইলে আর্কাইভ করে রাখুন',
      );
    }
    await this.prisma.splitGroup.update({
      where: { id: groupId },
      data: { deletedAt: new Date() },
    });
    await this.audit.record({
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.id,
      action: 'split.group_deleted',
      entity: 'SplitGroup',
      entityId: groupId,
    });
    return { id: groupId };
  }

  // --- expenses -------------------------------------------------------------

  /**
   * Record one bill and post whatever part of it belongs in the owner's books.
   *
   * The split is computed in `packages/core` and stored, not recomputed on read:
   * the method and its inputs can be edited later, and what somebody was told
   * they owed must not change because a rounding rule was tidied up afterwards.
   */
  async createExpense(ctx: TenantContext, groupId: string, input: CreateExpenseInput) {
    const group = await this.requireGroup(ctx.workspaceId, groupId);
    const members = await this.prisma.splitGroupMember.findMany({
      where: { groupId, workspaceId: ctx.workspaceId },
    });
    const byId = new Map(members.map((m) => [m.id, m]));

    const payer = byId.get(input.payerMemberId);
    if (!payer) throw new BadRequestException('যিনি টাকা দিয়েছেন তাঁকে গ্রুপে পাওয়া যায়নি');
    for (const share of input.shares) {
      if (!byId.get(share.memberId))
        throw new BadRequestException('ভাগের তালিকায় অচেনা সদস্য আছে');
    }

    let lines;
    try {
      lines = splitExpense(
        input.totalMinor,
        input.splitMethod,
        input.shares.map((s): SplitInput => ({
          memberId: s.memberId,
          amountMinor: s.amountMinor,
          percentBps: s.percentBps,
          shareWeight: s.shareWeight ?? byId.get(s.memberId)?.shareWeight ?? 1,
        })),
      );
    } catch (error) {
      /* The calculator's refusals are all things a person can fix on the form,
         so they become 400s with their own words rather than a 500. */
      if (error instanceof SplitError) throw new BadRequestException(error.message);
      throw error;
    }

    const self = members.find((m) => m.isSelf);
    const myShare = lines.find((l) => l.memberId === self?.id)?.amountMinor ?? 0;
    const othersMinor = input.totalMinor - myShare;
    const iPaid = payer.isSelf;

    if (iPaid && !input.accountId) {
      throw new BadRequestException('টাকা কোন অ্যাকাউন্ট থেকে গেছে সেটি বেছে নিন');
    }
    if (iPaid && input.accountId) {
      const account = await this.prisma.account.findFirst({
        where: { id: input.accountId, workspaceId: ctx.workspaceId, deletedAt: null },
        select: { id: true },
      });
      if (!account) throw new NotFoundException('অ্যাকাউন্ট পাওয়া যায়নি');
    }

    const date = fromLocalDateString(input.date, ctx.timezone);
    const entries = await this.entriesForExpense(ctx, {
      iPaid,
      totalMinor: input.totalMinor,
      myShareMinor: myShare,
      othersMinor,
      accountId: input.accountId,
      categoryId: input.categoryId ?? null,
    });

    const expense = await this.prisma.$transaction(async (tx) => {
      let transactionId: string | null = null;
      if (entries.length > 0) {
        assertBalanced(entries);
        const transaction = await tx.transaction.create({
          data: {
            workspaceId: ctx.workspaceId,
            date,
            type: 'EXPENSE',
            description: input.description.trim(),
            notes: input.note?.trim() || null,
            attachmentIds: input.attachmentIds ?? [],
            createdByUserId: ctx.id || null,
            entries: { create: entries.map((e) => entryData(e, ctx.workspaceId)) },
          },
        });
        transactionId = transaction.id;
      }

      return tx.sharedExpense.create({
        data: {
          workspaceId: ctx.workspaceId,
          groupId,
          description: input.description.trim(),
          date,
          totalMinor: BigInt(input.totalMinor),
          currency: group.currency,
          payerMemberId: input.payerMemberId,
          splitMethod: input.splitMethod,
          categoryId: input.categoryId ?? null,
          note: input.note?.trim() || null,
          attachmentIds: input.attachmentIds ?? [],
          transactionId,
          shares: {
            create: lines.map((line) => ({
              workspaceId: ctx.workspaceId,
              memberId: line.memberId,
              amountMinor: BigInt(line.amountMinor),
              percentBps: line.percentBps ?? null,
              shareWeight: line.shareWeight ?? null,
            })),
          },
        },
        include: { shares: true },
      });
    });

    await this.audit.record({
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.id,
      action: 'split.expense_added',
      entity: 'SharedExpense',
      entityId: expense.id,
      after: {
        groupId,
        totalMinor: input.totalMinor,
        myShareMinor: myShare,
        payerMemberId: input.payerMemberId,
        splitMethod: input.splitMethod,
      },
    });

    return this.presentExpense(expense, byId);
  }

  /**
   * The owner's side of a shared bill.
   *
   * Three shapes, and the third one is deliberately empty:
   *
   *  - **I paid.** My share is spending; everybody else's is a receivable; the
   *    cash left one account. Three entries, one transaction.
   *  - **Somebody else paid and I was on it.** My share is spending and I owe
   *    it. No cash moves — which is the point, and why a shared expense app that
   *    posts the whole bill to your account is lying to you about your balance.
   *  - **Somebody else paid and I was not on it.** Nothing. It is not my money
   *    and not my debt; it is a fact about the group, and it lives there.
   */
  private async entriesForExpense(
    ctx: TenantContext,
    args: {
      iPaid: boolean;
      totalMinor: number;
      myShareMinor: number;
      othersMinor: number;
      accountId?: string;
      categoryId: string | null;
    },
  ): Promise<EntryDraft[]> {
    const system = await this.accounts.systemAccounts(ctx.workspaceId);
    const entries: EntryDraft[] = [];

    if (args.iPaid) {
      if (args.myShareMinor > 0) {
        entries.push(draft(system.expenseAccountId, 'DEBIT', args.myShareMinor, args.categoryId));
      }
      if (args.othersMinor > 0) {
        const receivable = await this.accounts.loanControlAccount(ctx.workspaceId, 'LENT');
        entries.push(draft(receivable, 'DEBIT', args.othersMinor));
      }
      entries.push(draft(args.accountId as string, 'CREDIT', args.totalMinor));
      return entries;
    }

    if (args.myShareMinor > 0) {
      const payable = await this.accounts.loanControlAccount(ctx.workspaceId, 'BORROWED');
      entries.push(draft(system.expenseAccountId, 'DEBIT', args.myShareMinor, args.categoryId));
      entries.push(draft(payable, 'CREDIT', args.myShareMinor));
    }

    return entries;
  }

  async listExpenses(ctx: TenantContext, groupId: string) {
    await this.requireGroup(ctx.workspaceId, groupId);
    const [expenses, members] = await Promise.all([
      this.prisma.sharedExpense.findMany({
        where: { workspaceId: ctx.workspaceId, groupId, deletedAt: null },
        orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
        include: { shares: true },
      }),
      this.prisma.splitGroupMember.findMany({ where: { groupId, workspaceId: ctx.workspaceId } }),
    ]);
    const byId = new Map(members.map((m) => [m.id, m]));
    return expenses.map((e) => this.presentExpense(e, byId));
  }

  async removeExpense(ctx: TenantContext, groupId: string, expenseId: string) {
    await this.requireGroup(ctx.workspaceId, groupId);
    const expense = await this.prisma.sharedExpense.findFirst({
      where: { id: expenseId, groupId, workspaceId: ctx.workspaceId, deletedAt: null },
    });
    if (!expense) throw new NotFoundException('খরচটি পাওয়া যায়নি');

    const deletedAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      if (expense.transactionId) {
        /* Soft, like every reversal in this ledger: the row stays for anybody
           reading the history and the balance queries filter it out. */
        await tx.transaction.updateMany({
          where: { id: expense.transactionId, workspaceId: ctx.workspaceId },
          data: { deletedAt },
        });
      }
      await tx.sharedExpense.update({ where: { id: expense.id }, data: { deletedAt } });
    });

    await this.audit.record({
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.id,
      action: 'split.expense_deleted',
      entity: 'SharedExpense',
      entityId: expense.id,
      before: { groupId, totalMinor: minorToNumber(expense.totalMinor) },
    });

    return { id: expense.id };
  }

  // --- settling -------------------------------------------------------------

  /**
   * Money actually changing hands to clear a balance.
   *
   * Not an expense: nothing is consumed, a debt is discharged. When the owner is
   * one of the two sides it posts cash against the control account, which is
   * what makes the balance reach zero rather than merely look settled. Between
   * two other members it is a fact about the group and touches no ledger.
   */
  async settle(ctx: TenantContext, groupId: string, input: SettleInput) {
    await this.requireGroup(ctx.workspaceId, groupId);
    if (input.amountMinor <= 0)
      throw new BadRequestException('টাকার অঙ্ক শূন্যের চেয়ে বেশি হতে হবে');
    if (input.fromMemberId === input.toMemberId) {
      throw new BadRequestException('একই ব্যক্তি নিজেকে টাকা দিতে পারেন না');
    }

    const members = await this.prisma.splitGroupMember.findMany({
      where: { groupId, workspaceId: ctx.workspaceId },
    });
    const byId = new Map(members.map((m) => [m.id, m]));
    const from = byId.get(input.fromMemberId);
    const to = byId.get(input.toMemberId);
    if (!from || !to) throw new NotFoundException('সদস্য পাওয়া যায়নি');

    const iPay = from.isSelf;
    const iReceive = to.isSelf;
    if ((iPay || iReceive) && !input.accountId) {
      throw new BadRequestException('টাকা কোন অ্যাকাউন্টে গেল বা এল সেটি বেছে নিন');
    }

    const entries: EntryDraft[] = [];
    if (iPay && input.accountId) {
      const payable = await this.accounts.loanControlAccount(ctx.workspaceId, 'BORROWED');
      entries.push(draft(payable, 'DEBIT', input.amountMinor));
      entries.push(draft(input.accountId, 'CREDIT', input.amountMinor));
    } else if (iReceive && input.accountId) {
      const receivable = await this.accounts.loanControlAccount(ctx.workspaceId, 'LENT');
      entries.push(draft(input.accountId, 'DEBIT', input.amountMinor));
      entries.push(draft(receivable, 'CREDIT', input.amountMinor));
    }

    const date = fromLocalDateString(input.date, ctx.timezone);

    const settlement = await this.prisma.$transaction(async (tx) => {
      let transactionId: string | null = null;
      if (entries.length > 0) {
        assertBalanced(entries);
        const transaction = await tx.transaction.create({
          data: {
            workspaceId: ctx.workspaceId,
            date,
            type: 'TRANSFER',
            description: iPay
              ? `${to.displayName}-কে পরিশোধ`
              : `${from.displayName}-এর কাছ থেকে আদায়`,
            notes: input.note?.trim() || null,
            createdByUserId: ctx.id || null,
            entries: { create: entries.map((e) => entryData(e, ctx.workspaceId)) },
          },
        });
        transactionId = transaction.id;
      }

      return tx.splitSettlement.create({
        data: {
          workspaceId: ctx.workspaceId,
          groupId,
          fromMemberId: input.fromMemberId,
          toMemberId: input.toMemberId,
          amountMinor: BigInt(input.amountMinor),
          date,
          accountId: input.accountId ?? null,
          note: input.note?.trim() || null,
          transactionId,
        },
      });
    });

    await this.audit.record({
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.id,
      action: 'split.settled',
      entity: 'SplitSettlement',
      entityId: settlement.id,
      after: {
        groupId,
        fromMemberId: input.fromMemberId,
        toMemberId: input.toMemberId,
        amountMinor: input.amountMinor,
      },
    });

    return this.findGroup(ctx, groupId);
  }

  async listSettlements(ctx: TenantContext, groupId: string) {
    await this.requireGroup(ctx.workspaceId, groupId);
    const rows = await this.prisma.splitSettlement.findMany({
      where: { workspaceId: ctx.workspaceId, groupId, deletedAt: null },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    });
    return rows.map((row) => ({
      id: row.id,
      fromMemberId: row.fromMemberId,
      toMemberId: row.toMemberId,
      amountMinor: minorToNumber(row.amountMinor),
      date: toLocalDateString(row.date, ctx.timezone),
      note: row.note,
    }));
  }

  // --- balances -------------------------------------------------------------

  async balances(ctx: TenantContext, groupId: string) {
    const [members, expenses, settlements] = await Promise.all([
      this.prisma.splitGroupMember.findMany({
        where: { groupId, workspaceId: ctx.workspaceId },
        orderBy: [{ isSelf: 'desc' }, { createdAt: 'asc' }],
      }),
      this.prisma.sharedExpense.findMany({
        where: { workspaceId: ctx.workspaceId, groupId, deletedAt: null },
        select: { payerMemberId: true, shares: { select: { memberId: true, amountMinor: true } } },
      }),
      this.prisma.splitSettlement.findMany({
        where: { workspaceId: ctx.workspaceId, groupId, deletedAt: null },
        select: { fromMemberId: true, toMemberId: true, amountMinor: true },
      }),
    ]);

    const positions = groupPositions(
      expenses.map((e) => ({
        payerMemberId: e.payerMemberId,
        shares: e.shares.map((s) => ({
          memberId: s.memberId,
          amountMinor: minorToNumber(s.amountMinor),
        })),
      })),
      settlements.map((s) => ({
        fromMemberId: s.fromMemberId,
        toMemberId: s.toMemberId,
        amountMinor: minorToNumber(s.amountMinor),
      })),
    );

    const byMember = new Map(positions.map((p) => [p.memberId, p.netMinor]));

    return {
      members: members.map((m) => ({
        id: m.id,
        personId: m.personId,
        displayName: m.displayName,
        isSelf: m.isSelf,
        shareWeight: m.shareWeight,
        removedAt: m.removedAt?.toISOString() ?? null,
        netMinor: byMember.get(m.id) ?? 0,
      })),
      positions: members.map((m) => ({ memberId: m.id, netMinor: byMember.get(m.id) ?? 0 })),
      suggestions: suggestSettlements(
        members.map((m) => ({ memberId: m.id, netMinor: byMember.get(m.id) ?? 0 })),
      ),
    };
  }

  /** Every group's own-line balance in one pass, for the list screen. */
  private async positionsFor(workspaceId: string, groupIds: string[]) {
    const [members, expenses, settlements] = await Promise.all([
      this.prisma.splitGroupMember.findMany({
        where: { workspaceId, groupId: { in: groupIds } },
        select: { id: true, groupId: true, isSelf: true },
      }),
      this.prisma.sharedExpense.findMany({
        where: { workspaceId, groupId: { in: groupIds }, deletedAt: null },
        select: {
          groupId: true,
          payerMemberId: true,
          shares: { select: { memberId: true, amountMinor: true } },
        },
      }),
      this.prisma.splitSettlement.findMany({
        where: { workspaceId, groupId: { in: groupIds }, deletedAt: null },
        select: { groupId: true, fromMemberId: true, toMemberId: true, amountMinor: true },
      }),
    ]);

    const result = new Map<string, { self: number }>();
    for (const groupId of groupIds) {
      const selfId = members.find((m) => m.groupId === groupId && m.isSelf)?.id;
      const positions = groupPositions(
        expenses
          .filter((e) => e.groupId === groupId)
          .map((e) => ({
            payerMemberId: e.payerMemberId,
            shares: e.shares.map((s) => ({
              memberId: s.memberId,
              amountMinor: minorToNumber(s.amountMinor),
            })),
          })),
        settlements
          .filter((s) => s.groupId === groupId)
          .map((s) => ({
            fromMemberId: s.fromMemberId,
            toMemberId: s.toMemberId,
            amountMinor: minorToNumber(s.amountMinor),
          })),
      );
      result.set(groupId, {
        self: positions.find((p) => p.memberId === selfId)?.netMinor ?? 0,
      });
    }
    return result;
  }

  // --- helpers --------------------------------------------------------------

  private presentExpense(
    expense: {
      id: string;
      description: string;
      date: Date;
      totalMinor: bigint;
      payerMemberId: string;
      splitMethod: PrismaSplitMethod;
      categoryId: string | null;
      note: string | null;
      transactionId: string | null;
      shares: {
        memberId: string;
        amountMinor: bigint;
        percentBps: number | null;
        shareWeight: number | null;
      }[];
    },
    members: Map<string, { displayName: string; isSelf: boolean }>,
  ) {
    const selfShare = expense.shares.find((s) => members.get(s.memberId)?.isSelf);
    return {
      id: expense.id,
      description: expense.description,
      date: expense.date.toISOString().slice(0, 10),
      totalMinor: minorToNumber(expense.totalMinor),
      payerMemberId: expense.payerMemberId,
      payerName: members.get(expense.payerMemberId)?.displayName ?? '',
      payerIsSelf: members.get(expense.payerMemberId)?.isSelf ?? false,
      splitMethod: expense.splitMethod,
      categoryId: expense.categoryId,
      note: expense.note,
      transactionId: expense.transactionId,
      myShareMinor: selfShare ? minorToNumber(selfShare.amountMinor) : 0,
      shares: expense.shares.map((s) => ({
        memberId: s.memberId,
        name: members.get(s.memberId)?.displayName ?? '',
        amountMinor: minorToNumber(s.amountMinor),
        percentBps: s.percentBps,
        shareWeight: s.shareWeight,
      })),
    };
  }

  private async requireGroup(workspaceId: string, groupId: string) {
    const group = await this.prisma.splitGroup.findFirst({
      where: { id: groupId, workspaceId, deletedAt: null },
    });
    if (!group) throw new NotFoundException('গ্রুপটি পাওয়া যায়নি');
    return group;
  }
}
