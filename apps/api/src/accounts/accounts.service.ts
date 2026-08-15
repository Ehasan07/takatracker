import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { SYSTEM_ACCOUNT_KEYS, buildBalanceSheet, type SystemAccounts } from '@hishab/core';
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

  /**
   * Signed balance per account: opening balance plus every live ledger entry.
   *
   * ## `before` — the same sum, stopped at a date
   *
   * Pass the instant the day *after* the as-of day begins in the workspace's
   * timezone (`fromLocalDateString(nextDateKey(asOf), tz)`) and every entry
   * dated strictly before it counts. That is the whole difference: opening
   * balance plus history up to that moment, summed forwards.
   *
   * It is deliberately not "current balance minus everything since". The two
   * agree only in a workspace where nothing was ever soft-deleted and nothing
   * was ever back-dated, and this application supports both — subtracting
   * backwards would credit a June sheet with a July deletion and miss a July
   * entry dated in June. One summing convention, one place, so the wallet and
   * the balance sheet can never quietly disagree.
   *
   * The map's keys are the accounts the books say were in use at `before` — see
   * the account query below. Callers read the keyset for that rather than each
   * re-deriving the rule.
   */
  async balances(workspaceId: string, before?: Date): Promise<Map<string, number>> {
    const grouped = await this.prisma.ledgerEntry.groupBy({
      by: ['accountId', 'direction'],
      where: {
        workspaceId,
        transaction: {
          /* Unfiltered by `before` on purpose. A transaction deleted *after* the
           * as-of date is still deleted: the books say it never happened, not
           * that it happened until March. The other reading — restore it for
           * dates before the deletion — treats a correction as an event, so
           * fixing a typo entered in January would silently rewrite what every
           * month since then was worth. Deletion here is "this was never real",
           * which is what the soft delete is for; something that really did
           * happen and then stopped is a second transaction, not a deletion. */
          deletedAt: null,
          // The ledger date, not `createdAt`: a bill entered late still belongs
          // to the day it was paid, which is what a balance sheet is asking.
          ...(before ? { date: { lt: before } } : {}),
        },
      },
      _sum: { amountMinor: true },
    });

    const accounts = await this.prisma.account.findMany({
      where: { workspaceId },
      select: { id: true, type: true, openingBalance: true, createdAt: true },
    });

    /* Which accounts a dated sheet lists.
     *
     * `isArchived` is not consulted, here or anywhere in this method: an account
     * archived in July still held money in June and belongs on June's sheet.
     * Nor is `deletedAt` — unchanged from before, and callers that care filter
     * it themselves.
     *
     * An account opened after the day should not appear, and the only column
     * that speaks to that is `createdAt`. But `createdAt` records when the
     * *row* was inserted, not when the account was opened, and there is no
     * column for the latter. Somebody who signs up in August and back-fills
     * three months created every one of their accounts in August: on
     * `createdAt` alone their June and July sheets come back empty, which is
     * precisely the reader this endpoint exists for. So the rule is drawn to be
     * unable to move a number — an account is dropped only when it is
     * *certainly* zero on the day:
     *
     *   created after it, and no live entry by then, and no opening balance.
     *
     * That keeps a ৳0 ডিপিএস line off June's breakdown, which is what "should
     * not appear" is really asking for, while a back-filled নগদ with June
     * transactions and a গাড়ির ঋণ carrying an opening balance both stay where
     * the reader expects them. The residue is an account genuinely opened in
     * July with an opening balance: it shows that balance in June too. An
     * `openingBalance` carries no date — it means "before this ledger begins" —
     * so any date attached to it is invented, and the alternative invents a
     * jump in net worth with no transaction behind it.
     *
     * Costs nothing: `grouped` is already the set of accounts with a live entry
     * on or before the day. */
    const usedByThen = new Set(grouped.map((row) => row.accountId));
    const asOfThen = accounts.filter(
      (a) =>
        !before || a.createdAt < before || usedByThen.has(a.id) || a.openingBalance !== BigInt(0),
    );

    const out = new Map<string, number>();
    for (const acc of asOfThen) out.set(acc.id, minorToNumber(acc.openingBalance));

    const typeById = new Map(asOfThen.map((a) => [a.id, a.type]));
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

  /**
   * Where this workspace stands right now, in two numbers.
   *
   * ## Why it is here and not on the reports service
   *
   * The dashboard needs it, and the dashboard is not a report. Injecting
   * `ReportsService` into the transactions controller to reach it closed a
   * module cycle — accounts → transactions → reports → accounts — that Nest
   * refuses to build. The balances and the account types are already this
   * service's own data, so this is where the question belongs.
   *
   * The *classification* is not duplicated: both this and the balance sheet
   * call `buildBalanceSheet`, so the rule about whether a DPS is money is
   * stated once, in `packages/core`, and neither screen can drift from it.
   *
   * Unlike `list`, this reads every account including the hidden control
   * accounts — money lent out is part of what somebody is worth, and leaving it
   * out was half of what made the old dashboard figure wrong.
   */
  async position(workspaceId: string): Promise<{
    liquidMinor: number;
    netWorthMinor: number;
    assetsMinor: number;
    liabilitiesMinor: number;
  }> {
    const accounts = await this.prisma.account.findMany({
      where: { workspaceId, deletedAt: null },
      select: { id: true, name: true, type: true },
    });
    const balances = await this.balances(workspaceId);
    const sheet = buildBalanceSheet(
      accounts.map((a) => ({ ...a, balanceMinor: balances.get(a.id) ?? 0 })),
    );
    return {
      liquidMinor: sheet.liquidMinor,
      netWorthMinor: sheet.netWorthMinor,
      assetsMinor: sheet.assetsMinor,
      liabilitiesMinor: sheet.liabilitiesMinor,
    };
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
    /* Not by hand.
     *
     * `ঋণ` already records what somebody owes — against a person, in a
     * direction, with instalments — under one control account per direction,
     * which is where these two types are used and how IAS 32.42 wants it:
     * receivable and payable kept apart rather than netted.
     *
     * A hand-made one was a second, weaker way to say the same thing, and the
     * two together let one debt be written twice: fifty thousand in ঋণ and
     * fifty thousand in an account of the same name is a lakh of net worth
     * nobody has. The control accounts are made through
     * `ensureControlAccount`, which does not come through here. */
    if (input.type === 'RECEIVABLE' || input.type === 'PAYABLE') {
      throw new BadRequestException(
        'পাওনা বা দেনা অ্যাকাউন্ট হিসেবে নয় — ঋণ পাতা থেকে ব্যক্তির নামে লিখুন',
      );
    }

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
