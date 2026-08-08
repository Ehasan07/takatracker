import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { SYSTEM_ACCOUNT_KEYS, type SystemAccounts } from '@hishab/core';
import { type CreateAccountInput, type UpdateAccountInput } from '@hishab/shared';
import type { Account, AccountType } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { PrismaService } from '../prisma/prisma.service';
import { minorToNumber } from '../common/bigint-json';

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
  ): Promise<AccountWithBalance> {
    const existing = await this.prisma.account.findFirst({
      where: { id, workspaceId, deletedAt: null },
      include: { loanControl: { select: { loanNumber: true } } },
    });
    if (!existing) throw new NotFoundException('অ্যাকাউন্ট পাওয়া যায়নি');
    if (existing.systemKey)
      throw new BadRequestException('সিস্টেম অ্যাকাউন্ট সম্পাদনা করা যায় না');
    // A loan owns its control account. Renaming or retyping it here would leave
    // the loan screen describing something that no longer exists.
    if (existing.loanControl)
      throw new BadRequestException(
        `এই অ্যাকাউন্টটি ঋণ #${existing.loanControl.loanNumber}-এর, ঋণের পাতা থেকে বদলাতে হবে`,
      );

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
    const existing = await this.prisma.account.findFirst({
      where: { id, workspaceId },
      include: { loanControl: { select: { loanNumber: true, status: true } } },
    });
    if (!existing) throw new NotFoundException('অ্যাকাউন্ট পাওয়া যায়নি');
    if (existing.systemKey) throw new BadRequestException('সিস্টেম অ্যাকাউন্ট আর্কাইভ করা যায় না');
    // Archiving a live loan's control account would hide a debt that is still
    // owed. Closing the loan archives it.
    if (existing.loanControl && existing.loanControl.status === 'ACTIVE')
      throw new BadRequestException(
        `ঋণ #${existing.loanControl.loanNumber} এখনও চলমান, আগে সেটি শেষ বা বাতিল করুন`,
      );
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
