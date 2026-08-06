import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { SYSTEM_ACCOUNT_KEYS, type SystemAccounts } from '@hishab/core';
import { isDebitNormal, type CreateAccountInput, type UpdateAccountInput } from '@hishab/shared';
import type { Account, AccountType } from '@prisma/client';
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
}

@Injectable()
export class AccountsService {
  constructor(private readonly prisma: PrismaService) {}

  /** The three hidden nominal accounts, created at signup. */
  async systemAccounts(userId: string): Promise<SystemAccounts> {
    const rows = await this.prisma.account.findMany({
      where: { userId, systemKey: { not: null } },
      select: { id: true, systemKey: true },
    });
    const byKey = new Map(rows.map((r) => [r.systemKey, r.id]));
    const income = byKey.get(SYSTEM_ACCOUNT_KEYS.income);
    const expense = byKey.get(SYSTEM_ACCOUNT_KEYS.expense);
    const equity = byKey.get(SYSTEM_ACCOUNT_KEYS.equity);
    if (!income || !expense || !equity) {
      throw new NotFoundException('System accounts missing for this user');
    }
    return { incomeAccountId: income, expenseAccountId: expense, equityAccountId: equity };
  }

  /** Signed balance per account: opening balance plus every live ledger entry. */
  async balances(userId: string): Promise<Map<string, number>> {
    const grouped = await this.prisma.ledgerEntry.groupBy({
      by: ['accountId', 'direction'],
      where: { transaction: { userId, deletedAt: null } },
      _sum: { amountMinor: true },
    });

    const accounts = await this.prisma.account.findMany({
      where: { userId },
      select: { id: true, type: true, openingBalance: true },
    });

    const out = new Map<string, number>();
    for (const acc of accounts) out.set(acc.id, minorToNumber(acc.openingBalance));

    const typeById = new Map(accounts.map((a) => [a.id, a.type]));
    for (const row of grouped) {
      const type = typeById.get(row.accountId);
      if (!type) continue;
      const magnitude = minorToNumber(row._sum.amountMinor ?? 0n);
      const debitIncreases = isDebitNormal(type);
      const isDebit = row.direction === 'DEBIT';
      const signed = isDebit === debitIncreases ? magnitude : -magnitude;
      out.set(row.accountId, (out.get(row.accountId) ?? 0) + signed);
    }
    return out;
  }

  async list(userId: string, includeArchived = false): Promise<AccountWithBalance[]> {
    const accounts = await this.prisma.account.findMany({
      where: {
        userId,
        systemKey: null,
        deletedAt: null,
        ...(includeArchived ? {} : { isArchived: false }),
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    const balances = await this.balances(userId);
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
    };
  }

  async findOne(userId: string, id: string): Promise<AccountWithBalance> {
    const account = await this.prisma.account.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!account) throw new NotFoundException('অ্যাকাউন্ট পাওয়া যায়নি');
    const balances = await this.balances(userId);
    return AccountsService.present(account, balances.get(account.id) ?? 0);
  }

  async create(userId: string, input: CreateAccountInput): Promise<AccountWithBalance> {
    const account = await this.prisma.account.create({
      data: {
        userId,
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
      },
    });
    return AccountsService.present(account, input.openingBalance);
  }

  async update(userId: string, id: string, input: UpdateAccountInput): Promise<AccountWithBalance> {
    const existing = await this.prisma.account.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('অ্যাকাউন্ট পাওয়া যায়নি');
    if (existing.systemKey)
      throw new BadRequestException('সিস্টেম অ্যাকাউন্ট সম্পাদনা করা যায় না');

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
      },
    });
    return this.findOne(userId, id);
  }

  /** Archive rather than delete — history must stay intact. */
  async archive(userId: string, id: string): Promise<{ id: string; isArchived: boolean }> {
    const existing = await this.prisma.account.findFirst({ where: { id, userId } });
    if (!existing) throw new NotFoundException('অ্যাকাউন্ট পাওয়া যায়নি');
    if (existing.systemKey) throw new BadRequestException('সিস্টেম অ্যাকাউন্ট আর্কাইভ করা যায় না');
    await this.prisma.account.update({ where: { id }, data: { isArchived: true } });
    return { id, isArchived: true };
  }
}
