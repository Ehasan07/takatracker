import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { SYSTEM_ACCOUNT_KEYS, type SystemAccounts } from '@hishab/core';
import { type CreateAccountInput, type UpdateAccountInput } from '@hishab/shared';
import { Prisma } from '@prisma/client';
import type { Account, AccountType, LoanDirection } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { PrismaService } from '../prisma/prisma.service';
import { minorToNumber } from '../common/bigint-json';

/**
 * The workspace's two loan control accounts.
 *
 * Not in `@hishab/core`'s `SYSTEM_ACCOUNT_KEYS` with the three nominal ones,
 * because these are not nominal: they hold real balances that belong on the
 * balance sheet. They share the `systemKey` mechanism only for what it buys —
 * one row per workspace enforced by `@@unique([workspaceId, systemKey])`, and
 * exclusion from the wallet list and the plan's account limit.
 */
export const LOAN_CONTROL_ACCOUNT_KEYS = {
  receivable: 'SYSTEM_LOAN_RECEIVABLE',
  payable: 'SYSTEM_LOAN_PAYABLE',
} as const;

const LOAN_CONTROL_ACCOUNT_SEED: Record<
  LoanDirection,
  { systemKey: string; name: string; type: AccountType }
> = {
  LENT: {
    systemKey: LOAN_CONTROL_ACCOUNT_KEYS.receivable,
    name: 'ঋণ পাওনা',
    type: 'RECEIVABLE',
  },
  BORROWED: {
    systemKey: LOAN_CONTROL_ACCOUNT_KEYS.payable,
    name: 'ঋণ দেনা',
    type: 'PAYABLE',
  },
};

/** Control accounts sort below the accounts a user actually picks from. */
const CONTROL_ACCOUNT_SORT_ORDER = 900;

export interface AccountWithBalance {
  id: string;
  name: string;
  type: AccountType;
  currency: string;
  openingBalance: number;
  balanceMinor: number;
  institution: string | null;
  accountNumberMasked: string | null;
  matchHints: string[];
  isArchived: boolean;
  sortOrder: number;
  icon: string | null;
  color: string | null;
  statementDayOfMonth: number | null;
  dueDayOfMonth: number | null;
  reminderLeadDays: number | null;
}

@Injectable()
export class AccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
  ) {}

  /** The three hidden nominal accounts, created at signup. */
  async systemAccounts(workspaceId: string): Promise<SystemAccounts> {
    const rows = await this.prisma.account.findMany({
      where: { workspaceId, systemKey: { not: null } },
      select: { id: true, systemKey: true },
    });
    const byKey = new Map(rows.map((r) => [r.systemKey, r.id]));
    const income = byKey.get(SYSTEM_ACCOUNT_KEYS.income);
    const expense = byKey.get(SYSTEM_ACCOUNT_KEYS.expense);
    const equity = byKey.get(SYSTEM_ACCOUNT_KEYS.equity);
    if (!income || !expense || !equity) {
      throw new NotFoundException('System accounts missing for this workspace');
    }
    return { incomeAccountId: income, expenseAccountId: expense, equityAccountId: equity };
  }

  /**
   * The workspace's loan control account for one direction, made on first use.
   *
   * One RECEIVABLE (ঋণ পাওনা) and one PAYABLE (ঋণ দেনা) for the whole
   * workspace, never one per loan. *Accounts receivable* is a single line in a
   * chart of accounts; করিম and রহিম are rows in its subsidiary ledger, which
   * here is `GET /loans/people/:personId/ledger` — derived from the payments,
   * not stored. Ten loans must not mean ten accounts.
   *
   * Lazy rather than seeded at signup like the three nominal accounts, and lazy
   * **per direction** rather than in pairs. Both halves matter: the balance
   * sheet no longer filters on `systemKey`, so an unused ঋণ দেনা would print a
   * ৳0 liability to somebody who has only ever lent money — bookkeeping
   * machinery on a user's screen, which is the whole complaint this change
   * exists to answer. The migration creates them per direction for the same
   * reason.
   */
  async loanControlAccount(workspaceId: string, direction: LoanDirection): Promise<string> {
    return this.ensureSystemAccount(workspaceId, LOAN_CONTROL_ACCOUNT_SEED[direction]);
  }

  private async ensureSystemAccount(
    workspaceId: string,
    seed: { systemKey: string; name: string; type: AccountType },
  ): Promise<string> {
    const where = { workspaceId, systemKey: seed.systemKey };
    const existing = await this.prisma.account.findFirst({ where, select: { id: true } });
    if (existing) return existing.id;

    try {
      /* Deliberately not inside the caller's `$transaction`: a loan that fails
       * to save must not take the workspace's control account down with it,
       * and the account is workspace-level machinery that is correct whether
       * or not this particular loan lands. It also never passes through
       * `entitlements.assertWithinLimit` — a plan slot is for an account the
       * user opened, not for the bookkeeping behind the loan screen. */
      const created = await this.prisma.account.create({
        data: {
          workspaceId,
          name: seed.name,
          type: seed.type,
          systemKey: seed.systemKey,
          sortOrder: CONTROL_ACCOUNT_SORT_ORDER,
        },
        select: { id: true },
      });
      return created.id;
    } catch (err) {
      /* Two loans recorded in the same instant both find nothing and both
       * insert. `@@unique([workspaceId, systemKey])` picks a winner; the loser
       * takes the winner's account rather than failing a loan over a race. */
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const won = await this.prisma.account.findFirst({ where, select: { id: true } });
        if (won) return won.id;
      }
      throw err;
    }
  }

  /** Signed balance per account: opening balance plus every live ledger entry. */
  async balances(workspaceId: string): Promise<Map<string, number>> {
    const grouped = await this.prisma.ledgerEntry.groupBy({
      by: ['accountId', 'direction'],
      where: { workspaceId, transaction: { deletedAt: null } },
      _sum: { amountMinor: true },
    });

    const accounts = await this.prisma.account.findMany({
      where: { workspaceId },
      select: { id: true, type: true, openingBalance: true },
    });

    const out = new Map<string, number>();
    for (const acc of accounts) out.set(acc.id, minorToNumber(acc.openingBalance));

    const typeById = new Map(accounts.map((a) => [a.id, a.type]));
    for (const row of grouped) {
      const type = typeById.get(row.accountId);
      if (!type) continue;
      const magnitude = minorToNumber(row._sum.amountMinor ?? 0n);
      // Debits add, credits subtract, whatever the type — so a debt is negative,
      // matching `openingBalance`. See `signedEffect` in @hishab/core.
      const signed = row.direction === 'DEBIT' ? magnitude : -magnitude;
      out.set(row.accountId, (out.get(row.accountId) ?? 0) + signed);
    }
    return out;
  }

  /**
   * The wallet screen: the accounts the user actually opened.
   *
   * `systemKey: null` is what keeps bookkeeping machinery off it — the three
   * nominal accounts and the two loan control accounts. Adding a receivable to
   * a bank balance produces a number that means nothing, so the chart of
   * accounts and the wallet are different screens; the control accounts show up
   * on `GET /reports/balance-sheet`, where an asset and a liability are told
   * apart.
   */
  async list(workspaceId: string, includeArchived = false): Promise<AccountWithBalance[]> {
    const accounts = await this.prisma.account.findMany({
      where: {
        workspaceId,
        systemKey: null,
        deletedAt: null,
        ...(includeArchived ? {} : { isArchived: false }),
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    const balances = await this.balances(workspaceId);
    return accounts.map((a) => AccountsService.present(a, balances.get(a.id) ?? 0));
  }

  private static present(a: Account, balanceMinor: number): AccountWithBalance {
    return {
      id: a.id,
      name: a.name,
      type: a.type,
      currency: a.currency,
      openingBalance: minorToNumber(a.openingBalance),
      balanceMinor,
      institution: a.institution,
      accountNumberMasked: a.accountNumberMasked,
      matchHints: a.matchHints,
      isArchived: a.isArchived,
      sortOrder: a.sortOrder,
      icon: a.icon,
      color: a.color,
      statementDayOfMonth: a.statementDayOfMonth,
      dueDayOfMonth: a.dueDayOfMonth,
      reminderLeadDays: a.reminderLeadDays,
    };
  }

  async findOne(workspaceId: string, id: string): Promise<AccountWithBalance> {
    const account = await this.prisma.account.findFirst({
      where: { id, workspaceId, deletedAt: null },
    });
    if (!account) throw new NotFoundException('অ্যাকাউন্ট পাওয়া যায়নি');
    const balances = await this.balances(workspaceId);
    return AccountsService.present(account, balances.get(account.id) ?? 0);
  }

  async create(
    workspaceId: string,
    input: CreateAccountInput,
    timezone = 'Asia/Dhaka',
    actorUserId?: string,
  ): Promise<AccountWithBalance> {
    // Archived accounts do not count, so hitting the ceiling has a way out that
    // is not "delete your history".
    await this.entitlements.assertWithinLimit(workspaceId, 'accounts.max', timezone);

    const account = await this.prisma.account.create({
      data: {
        workspaceId,
        name: input.name,
        type: input.type,
        currency: input.currency,
        openingBalance: BigInt(input.openingBalance),
        institution: input.institution,
        accountNumberMasked: input.accountNumberMasked,
        matchHints: input.matchHints,
        icon: input.icon,
        color: input.color,
        sortOrder: input.sortOrder,
        statementDayOfMonth: input.statementDayOfMonth ?? null,
        dueDayOfMonth: input.dueDayOfMonth ?? null,
        reminderLeadDays: input.reminderLeadDays ?? null,
      },
    });
    this.audit.emit({
      workspaceId,
      actorUserId,
      action: 'account.created',
      entity: 'Account',
      entityId: account.id,
      after: { name: account.name, type: account.type },
    });
    return AccountsService.present(account, input.openingBalance);
  }

  async update(
    workspaceId: string,
    id: string,
    input: UpdateAccountInput,
    actorUserId?: string,
    timezone?: string,
  ): Promise<AccountWithBalance> {
    const existing = await this.prisma.account.findFirst({
      where: { id, workspaceId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('অ্যাকাউন্ট পাওয়া যায়নি');
    /* Covers the loan control accounts too, now that they are one shared pair
     * per workspace carrying a `systemKey` rather than one account per loan.
     * Renaming ঋণ পাওনা or retyping it to BANK would put every loan in the
     * workspace on the wrong side of the balance sheet at once. */
    if (existing.systemKey)
      throw new BadRequestException('সিস্টেম অ্যাকাউন্ট সম্পাদনা করা যায় না');

    /* Un-archiving adds an account back to the count, so it has to pass the same
     * limit `create` does. Without this, somebody at their ceiling could archive
     * one account, add a new one, then restore the old one and quietly end up
     * over the plan — the archive button would be a way around the limit. */
    if (existing.isArchived && input.isArchived === false) {
      await this.entitlements.assertWithinLimit(
        workspaceId,
        'accounts.max',
        timezone ?? 'Asia/Dhaka',
      );
    }

    await this.prisma.account.update({
      where: { id },
      data: {
        name: input.name,
        type: input.type,
        currency: input.currency,
        openingBalance:
          input.openingBalance === undefined ? undefined : BigInt(input.openingBalance),
        institution: input.institution,
        accountNumberMasked: input.accountNumberMasked,
        matchHints: input.matchHints,
        icon: input.icon,
        color: input.color,
        sortOrder: input.sortOrder,
        isArchived: input.isArchived,
        statementDayOfMonth: input.statementDayOfMonth,
        dueDayOfMonth: input.dueDayOfMonth,
        reminderLeadDays: input.reminderLeadDays,
      },
    });
    this.audit.emit({
      workspaceId,
      actorUserId,
      action: 'account.updated',
      entity: 'Account',
      entityId: id,
      before: { name: existing.name, type: existing.type, isArchived: existing.isArchived },
      after: {
        name: input.name ?? existing.name,
        isArchived: input.isArchived ?? existing.isArchived,
      },
    });
    return this.findOne(workspaceId, id);
  }

  /** Archive rather than delete — history must stay intact. */
  async archive(
    workspaceId: string,
    id: string,
    actorUserId?: string,
  ): Promise<{ id: string; isArchived: boolean }> {
    const existing = await this.prisma.account.findFirst({ where: { id, workspaceId } });
    if (!existing) throw new NotFoundException('অ্যাকাউন্ট পাওয়া যায়নি');
    /* Includes ঋণ পাওনা and ঋণ দেনা: they are shared by every loan in the
     * workspace, so archiving one would hide every debt still owed. A loan is
     * ended from the loan screen, which leaves the control account alone. */
    if (existing.systemKey) throw new BadRequestException('সিস্টেম অ্যাকাউন্ট আর্কাইভ করা যায় না');
    await this.prisma.account.update({ where: { id }, data: { isArchived: true } });
    this.audit.emit({
      workspaceId,
      actorUserId,
      action: 'account.archived',
      entity: 'Account',
      entityId: id,
      after: { name: existing.name },
    });
    return { id, isArchived: true };
  }
}
