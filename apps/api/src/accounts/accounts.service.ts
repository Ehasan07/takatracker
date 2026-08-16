import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  SYSTEM_ACCOUNT_KEYS,
  assertBalanced,
  buildBalanceSheet,
  expandSimpleTransaction,
  type EntryDraft,
  type SystemAccounts,
} from '@hishab/core';
import {
  fromLocalDateString,
  toLocalDateString,
  type CreateAccountInput,
  type UpdateAccountInput,
} from '@hishab/shared';
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

/**
 * The `externalRef` that marks an account's own opening balance transaction.
 *
 * One deterministic string per account, so "the account's opening balance" is a
 * lookup rather than a guess. Three things need to agree on it and now do: this
 * service when it writes one, this service when it edits one, and the data
 * migration that moved the old `Account.openingBalance` column into the ledger
 * (`20260816230000_opening_balance_to_ledger`), which uses the same value as
 * its idempotency guard.
 *
 * It is deliberately not "any OPENING_BALANCE transaction on this account". A
 * user may post those by hand from the transaction screen, and those are theirs
 * — this API field must not silently rewrite one.
 */
const openingBalanceRef = (accountId: string): string => `opening-balance:${accountId}`;

/** What the user sees in their transaction list for the row this service books. */
const OPENING_BALANCE_DESCRIPTION = 'প্রারম্ভিক জের';

export interface AccountWithBalance {
  id: string;
  name: string;
  type: AccountType;
  currency: string;
  /**
   * What was in the account before this ledger begins, in poisha.
   *
   * Read back off the ledger, not out of a column — there is no column. It is
   * the signed sum of this account's `OPENING_BALANCE` entries, which for an
   * account managed through this API is the one transaction
   * `openingBalanceRef` names. Kept on the response so the wallet screen, the
   * onboarding wizard and the CSV importer did not all have to change at once.
   */
  openingBalance: number;
  /**
   * The day that opening balance was true, `YYYY-MM-DD`, or null when there is
   * none. New: the old column had no date, which is the defect this replaces.
   */
  openingBalanceDate: string | null;
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
  /**
   * Credit cards only: what the bank allows, what is drawn, what is left.
   *
   * `undrawnMinor` is reported and never added to anything. It is not cash —
   * IAS 7.6 keeps that to what is held, and an undrawn facility is money the
   * bank still has and may withdraw. IAS 7.50(a) disclosure: a figure beside
   * the balance sheet, not a line inside it.
   */
  creditLimitMinor: number;
  drawnMinor: number;
  undrawnMinor: number;
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
   * Signed balance per account: every live ledger entry, and nothing else.
   *
   * "And nothing else" is load-bearing. An `Account.openingBalance` column used
   * to be added on top of this sum, which meant a figure inside every balance
   * had no transaction behind it and — because the column carried no date —
   * counted on every dated report ever run, including ones covering days before
   * the account existed. It is an `OPENING_BALANCE` transaction now, so it
   * arrives through `grouped` below like a salary does, and the sum has one
   * source.
   *
   * ## `before` — the same sum, stopped at a date
   *
   * Pass the instant the day *after* the as-of day begins in the workspace's
   * timezone (`fromLocalDateString(nextDateKey(asOf), tz)`) and every entry
   * dated strictly before it counts. That is the whole difference: history up
   * to that moment, summed forwards.
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
      select: { id: true, type: true, createdAt: true },
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
     *   created after it, and no live entry by then.
     *
     * That keeps a ৳0 ডিপিএস line off June's breakdown, which is what "should
     * not appear" is really asking for, while a back-filled নগদ with June
     * transactions stays where the reader expects it.
     *
     * There used to be a third arm — *and no opening balance* — because the
     * opening balance was a dateless column, so the only way to avoid inventing
     * a jump in net worth was to show it on every date, including dates before
     * the account existed. It is a dated transaction now, so it is simply one
     * of the live entries `grouped` already counts: an account opened in July
     * with a July opening balance is correctly absent from June, and the same
     * account with a June opening balance correctly appears in June.
     *
     * Costs nothing: `grouped` is already the set of accounts with a live entry
     * on or before the day. */
    const usedByThen = new Set(grouped.map((row) => row.accountId));
    const asOfThen = accounts.filter(
      (a) => !before || a.createdAt < before || usedByThen.has(a.id),
    );

    const out = new Map<string, number>();
    for (const acc of asOfThen) out.set(acc.id, 0);

    const typeById = new Map(asOfThen.map((a) => [a.id, a.type]));
    for (const row of grouped) {
      const type = typeById.get(row.accountId);
      if (!type) continue;
      const magnitude = minorToNumber(row._sum.amountMinor ?? 0n);
      // Debits add, credits subtract, whatever the type — so a debt is
      // negative. See `signedEffect` in @hishab/core.
      const signed = row.direction === 'DEBIT' ? magnitude : -magnitude;
      out.set(row.accountId, (out.get(row.accountId) ?? 0) + signed);
    }
    return out;
  }

  /**
   * The opening balance and its date, per account, read back off the ledger.
   *
   * The API still carries `openingBalance` in and out — the wallet screen, the
   * onboarding wizard and the CSV importer all speak it — so somebody has to
   * turn the transaction back into the field. This is that somebody, and it is
   * the only place it happens.
   *
   * Restricted to the transaction `openingBalanceRef` names, not to every
   * `OPENING_BALANCE` transaction on the account. An account can carry several:
   * this API writes one, and a user may post more by hand from the transaction
   * screen for money that turned up from an older book. Summing all of them
   * into an editable field would mean a later PATCH silently rewrote entries
   * the user made deliberately — see `update`, which refuses instead.
   */
  private async openingBalanceEntries(
    workspaceId: string,
    accountIds?: readonly string[],
  ): Promise<Map<string, { amountMinor: number; date: Date }>> {
    const rows = await this.prisma.ledgerEntry.findMany({
      where: {
        workspaceId,
        ...(accountIds ? { accountId: { in: [...accountIds] } } : {}),
        transaction: {
          deletedAt: null,
          type: 'OPENING_BALANCE',
          // `startsWith` rather than an exact match, because one query answers
          // for every account on the wallet screen at once.
          externalRef: { startsWith: 'opening-balance:' },
        },
      },
      select: {
        accountId: true,
        direction: true,
        amountMinor: true,
        transaction: { select: { date: true, externalRef: true } },
      },
    });

    const out = new Map<string, { amountMinor: number; date: Date }>();
    for (const row of rows) {
      // Both legs come back; only the account's own leg is its opening balance.
      // The equity leg carries the same marker and must not be reported as
      // SYSTEM_EQUITY's own opening figure.
      if (row.transaction.externalRef !== openingBalanceRef(row.accountId)) continue;
      const magnitude = minorToNumber(row.amountMinor);
      out.set(row.accountId, {
        amountMinor: row.direction === 'DEBIT' ? magnitude : -magnitude,
        date: row.transaction.date,
      });
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
  async list(
    workspaceId: string,
    includeArchived = false,
    timezone = 'Asia/Dhaka',
  ): Promise<AccountWithBalance[]> {
    const accounts = await this.prisma.account.findMany({
      where: {
        workspaceId,
        systemKey: null,
        deletedAt: null,
        ...(includeArchived ? {} : { isArchived: false }),
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    const [balances, openings] = await Promise.all([
      this.balances(workspaceId),
      this.openingBalanceEntries(workspaceId),
    ]);
    return accounts.map((a) =>
      AccountsService.present(a, balances.get(a.id) ?? 0, openings.get(a.id), timezone),
    );
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
   *
   * ## Foreign currency is left out, and that is the honest answer today
   *
   * Only accounts kept in the workspace's own currency are summed. A USD
   * account holding $500 was being added to a taka net worth as ৳500 — the
   * balances are integers in *each account's* minor unit and nothing here ever
   * read `Account.currency`, so the figure was wrong by roughly the exchange
   * rate and gave no sign of it.
   *
   * Converting properly is not a filter, it is a feature: IAS 21.21 records a
   * transaction at the spot rate on its own date, and IAS 21.23(a) retranslates
   * monetary balances at the closing rate — which needs a rate per transaction
   * date and a rate per reporting date, both stored, plus somewhere to put the
   * difference the retranslation throws off (IAS 21.28, into profit or loss).
   * None of that exists: `LedgerEntry.fxRate` is an `Int` that every writer
   * sets to 1, and `FxService` is an unpersisted cache in front of a public
   * feed. Until it does, adding the number in is a made-up rate of 1.00 quietly
   * asserted, and the only defensible alternative to a wrong total is a total
   * that says what it covers.
   *
   * So the foreign account keeps its own balance in its own currency, stays on
   * every list, and is named on screen as excluded. The screens work out
   * *which* accounts those are from `GET /accounts`, which already carries
   * `currency` on every row — one rule, applied here to the totals and there to
   * the rows, and no third place for it to drift.
   *
   * The comparison is case-insensitive because `currency` is a free
   * `String(3)`: nothing upper-cases it on the way in, and `usd` is the same
   * money as `USD`.
   *
   * A `systemKey` account is never treated as foreign. The three nominal
   * accounts and the two loan control accounts are created without a currency,
   * so they carry the column's `BDT` default whatever the workspace was opened
   * in — that default is an unset field, not a statement about the money. Their
   * balances come from entries booked in the workspace's own currency, so a
   * USD-keeping workspace must not lose its ঋণ পাওনা out of net worth over a
   * column nobody ever filled in.
   */
  async position(workspaceId: string): Promise<{
    liquidMinor: number;
    netWorthMinor: number;
    assetsMinor: number;
    liabilitiesMinor: number;
  }> {
    const [workspace, accounts] = await Promise.all([
      this.prisma.workspace.findUniqueOrThrow({
        where: { id: workspaceId },
        select: { currency: true },
      }),
      this.prisma.account.findMany({
        where: { workspaceId, deletedAt: null },
        select: { id: true, name: true, type: true, currency: true, systemKey: true },
      }),
    ]);

    const home = workspace.currency.toUpperCase();
    const inBooks = accounts.filter(
      (a) => a.systemKey !== null || a.currency.toUpperCase() === home,
    );

    const balances = await this.balances(workspaceId);
    const sheet = buildBalanceSheet(
      inBooks.map((a) => ({ ...a, balanceMinor: balances.get(a.id) ?? 0 })),
    );
    return {
      liquidMinor: sheet.liquidMinor,
      netWorthMinor: sheet.netWorthMinor,
      assetsMinor: sheet.assetsMinor,
      liabilitiesMinor: sheet.liabilitiesMinor,
    };
  }

  private static present(
    a: Account,
    balanceMinor: number,
    /** The account's opening balance transaction, when it has one. */
    opening: { amountMinor: number; date: Date } | undefined,
    timezone: string,
  ): AccountWithBalance {
    /* Only a card has a limit. Anything else reports zero rather than an
       absence, so a caller never has to ask which kind it is holding. */
    const limit = a.type === 'CREDIT_CARD' ? minorToNumber(a.creditLimitMinor) : 0;
    const balance = balanceMinor;

    return {
      id: a.id,
      name: a.name,
      type: a.type,
      currency: a.currency,
      /* Zero rather than null when there is no opening balance transaction, so
         a client never has to branch on the difference between "nothing was
         carried in" and "nobody said". The date is null in that case, because
         there genuinely is no day to name. */
      openingBalance: opening?.amountMinor ?? 0,
      openingBalanceDate: opening ? toLocalDateString(opening.date, timezone) : null,
      balanceMinor,
      institution: a.institution,
      accountNumberMasked: a.accountNumberMasked,
      matchHints: a.matchHints,
      isArchived: a.isArchived,
      sortOrder: a.sortOrder,
      icon: a.icon,
      color: a.color,
      creditLimitMinor: limit,
      /* A card carries what is owed as a negative balance, so the drawn amount
         is the negative part and nothing else — a card in credit because
         something was refunded has drawn nothing. */
      drawnMinor: balance < 0 ? -balance : 0,
      /* Never below zero: over the limit is a fact about the debt, not spare
         room, and a negative "left to spend" would read as one. */
      undrawnMinor: Math.max(0, limit - (balance < 0 ? -balance : 0)),
      statementDayOfMonth: a.statementDayOfMonth,
      dueDayOfMonth: a.dueDayOfMonth,
      reminderLeadDays: a.reminderLeadDays,
    };
  }

  async findOne(
    workspaceId: string,
    id: string,
    timezone = 'Asia/Dhaka',
  ): Promise<AccountWithBalance> {
    const account = await this.prisma.account.findFirst({
      where: { id, workspaceId, deletedAt: null },
    });
    if (!account) throw new NotFoundException('অ্যাকাউন্ট পাওয়া যায়নি');
    const [balances, openings] = await Promise.all([
      this.balances(workspaceId),
      this.openingBalanceEntries(workspaceId, [id]),
    ]);
    return AccountsService.present(
      account,
      balances.get(account.id) ?? 0,
      openings.get(account.id),
      timezone,
    );
  }

  /**
   * Book, move or retire an account's opening balance transaction.
   *
   * ## Why it writes Prisma directly instead of calling `TransactionsService`
   *
   * `TransactionsService` already injects this service, for `systemAccounts`
   * and `balances`. Injecting it back would close a cycle Nest refuses to
   * build. The parts that matter are shared anyway: `expandSimpleTransaction`
   * decides the legs, `assertBalanced` checks them, and the deferred database
   * trigger checks them again at COMMIT — so this cannot write a shape the
   * transaction screen could not.
   *
   * It also, deliberately, does not meter against `transactions.monthly.max`.
   * Opening an account already costs an account slot; charging a second slot
   * for the balance that came with it would make the plan mean something
   * different depending on whether a user started at zero.
   *
   * Returns the amount actually on the books afterwards.
   */
  private async writeOpeningBalance(
    workspaceId: string,
    accountId: string,
    amountMinor: number,
    /** `YYYY-MM-DD`. */
    dateKey: string,
    timezone: string,
    actorUserId?: string,
  ): Promise<void> {
    const externalRef = openingBalanceRef(accountId);
    const date = fromLocalDateString(dateKey, timezone);

    const existing = await this.prisma.transaction.findFirst({
      where: { workspaceId, externalRef, deletedAt: null },
      select: {
        id: true,
        date: true,
        entries: { select: { accountId: true, direction: true, amountMinor: true } },
      },
    });

    /* Zero means "there was nothing in it". Nothing is not a transaction, so
       the row goes rather than being kept at zero — a ledger entry of zero is
       refused by `assertBalanced` and by the database CHECK anyway. Soft
       deleted, like every other retirement in this system, so the audit trail
       keeps it. */
    if (amountMinor === 0) {
      if (existing) {
        await this.prisma.transaction.update({
          where: { id: existing.id },
          data: { deletedAt: new Date() },
        });
        this.audit.emit({
          workspaceId,
          actorUserId,
          action: 'account.openingBalanceCleared',
          entity: 'Account',
          entityId: accountId,
          before: { transactionId: existing.id },
        });
      }
      return;
    }

    const system = await this.systemAccounts(workspaceId);
    const account = await this.prisma.account.findUniqueOrThrow({
      where: { id: accountId },
      select: { currency: true },
    });
    const entries = expandSimpleTransaction(
      {
        type: 'OPENING_BALANCE',
        amountMinor,
        accountId,
        currency: account.currency,
      },
      system,
    );
    assertBalanced(entries);

    if (!existing) {
      await this.prisma.transaction.create({
        data: {
          workspaceId,
          createdByUserId: actorUserId || null,
          date,
          type: 'OPENING_BALANCE',
          description: OPENING_BALANCE_DESCRIPTION,
          source: 'MANUAL',
          externalRef,
          entries: { create: entries.map((e) => this.toEntryData(e, workspaceId)) },
        },
      });
      this.audit.emit({
        workspaceId,
        actorUserId,
        action: 'account.openingBalanceSet',
        entity: 'Account',
        entityId: accountId,
        after: { amountMinor, date: dateKey },
      });
      return;
    }

    /* An edit replaces the legs of the transaction that is already there rather
       than adding a second one. Two OPENING_BALANCE transactions on one account
       would both be counted — the balance would be right only by accident, and
       the statement would show the opening figure twice.
     *
     * The legs are deleted and rewritten rather than updated in place because
     * changing the sign flips which account is debited, and there is no update
     * that expresses "these two rows swap roles". Both happen inside one
     * database transaction, so the balance trigger — deferred to COMMIT — sees
     * only the finished state. */
    await this.prisma.$transaction(async (tx) => {
      await tx.ledgerEntry.deleteMany({ where: { transactionId: existing.id } });
      await tx.transaction.update({
        where: { id: existing.id },
        data: {
          date,
          entries: { create: entries.map((e) => this.toEntryData(e, workspaceId)) },
        },
      });
    });

    const previous = existing.entries.find((e) => e.accountId === accountId);
    const previousMinor = previous
      ? (previous.direction === 'DEBIT' ? 1 : -1) * minorToNumber(previous.amountMinor)
      : 0;
    this.audit.emit({
      workspaceId,
      actorUserId,
      action: 'account.openingBalanceChanged',
      entity: 'Account',
      entityId: accountId,
      before: { amountMinor: previousMinor, date: toLocalDateString(existing.date, timezone) },
      after: { amountMinor, date: dateKey },
    });
  }

  private toEntryData(
    e: EntryDraft,
    workspaceId: string,
  ): Prisma.LedgerEntryCreateWithoutTransactionInput {
    return {
      workspace: { connect: { id: workspaceId } },
      account: { connect: { id: e.accountId } },
      amountMinor: BigInt(e.amountMinor),
      direction: e.direction,
      currency: e.currency,
      fxRate: e.fxRate,
    };
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
        institution: input.institution,
        accountNumberMasked: input.accountNumberMasked,
        matchHints: input.matchHints,
        icon: input.icon,
        color: input.color,
        sortOrder: input.sortOrder,
        creditLimitMinor: BigInt(input.creditLimitMinor ?? 0),
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

    /* The opening balance, if there is one, as a dated transaction against
     * equity — not as a column on the row above.
     *
     * Today by default, because that is the day somebody sitting in front of
     * the form is describing when they type what is in their wallet. A
     * back-filler who means an earlier day says so, and `openingBalanceDate` is
     * the field that lets them. Either way the figure now has a date, which is
     * the only reason two balance sheets can be compared (IAS 1.38).
     *
     * Deliberately after the account row is committed rather than inside one
     * `$transaction` with it: the ledger entries reference the account, and the
     * workspace-match trigger on `LedgerEntry` reads the transaction row back,
     * so the two writes are ordered anyway. If the second fails the account
     * exists with no opening balance, which the user can correct from the edit
     * sheet — the opposite order would lose the account entirely. */
    if (input.openingBalance !== 0) {
      await this.writeOpeningBalance(
        workspaceId,
        account.id,
        input.openingBalance,
        input.openingBalanceDate ?? toLocalDateString(new Date(), timezone),
        timezone,
        actorUserId,
      );
    }

    return this.findOne(workspaceId, account.id, timezone);
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

    const tz = timezone ?? 'Asia/Dhaka';

    /* Changing the opening balance edits the transaction that is already there.
     *
     * `openingBalanceDate` on its own moves that transaction to another day
     * without changing the amount — which is the correction somebody makes
     * after realising the figure was true in June, not today. Both are refused
     * outright when the account carries opening balances this API did not
     * write; see `assertOneOpeningBalance`. */
    const wantsAmount = input.openingBalance !== undefined;
    const wantsDate = input.openingBalanceDate !== undefined;
    if (wantsAmount || wantsDate) {
      const current = (await this.openingBalanceEntries(workspaceId, [id])).get(id);
      await this.assertSoleOpeningBalance(workspaceId, id);
      const amountMinor = input.openingBalance ?? current?.amountMinor ?? 0;
      const dateKey =
        input.openingBalanceDate ??
        (current ? toLocalDateString(current.date, tz) : toLocalDateString(new Date(), tz));

      const unchanged =
        amountMinor === (current?.amountMinor ?? 0) &&
        (current ? toLocalDateString(current.date, tz) === dateKey : amountMinor === 0);
      // A PATCH that says the same thing must not rewrite the ledger row: it
      // would move `updatedAt` and add an audit line for nothing.
      if (!unchanged) {
        await this.writeOpeningBalance(workspaceId, id, amountMinor, dateKey, tz, actorUserId);
      }
    }

    await this.prisma.account.update({
      where: { id },
      data: {
        name: input.name,
        type: input.type,
        currency: input.currency,
        institution: input.institution,
        accountNumberMasked: input.accountNumberMasked,
        matchHints: input.matchHints,
        icon: input.icon,
        color: input.color,
        sortOrder: input.sortOrder,
        isArchived: input.isArchived,
        creditLimitMinor:
          input.creditLimitMinor === undefined ? undefined : BigInt(input.creditLimitMinor),
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
    return this.findOne(workspaceId, id, tz);
  }

  /**
   * Refuse to edit an opening balance through this field when the account
   * carries more than one.
   *
   * A user can post `OPENING_BALANCE` transactions from the transaction screen
   * — money surfacing from an older book, a second tranche remembered later —
   * and those are theirs. `openingBalance` on this endpoint addresses exactly
   * one row, the one `openingBalanceRef` names. If there are others, any answer
   * this method could give is wrong: rewriting the marked one leaves the field
   * disagreeing with the account's real opening figure, and rewriting all of
   * them destroys entries somebody entered on purpose. So it says so, and sends
   * the user to the screen where the rows are individually visible — which they
   * now are, which is the point of the change.
   */
  private async assertSoleOpeningBalance(workspaceId: string, accountId: string): Promise<void> {
    const others = await this.prisma.transaction.count({
      where: {
        workspaceId,
        deletedAt: null,
        type: 'OPENING_BALANCE',
        entries: { some: { accountId } },
        /* `NOT (externalRef = ref)` is NULL for a null `externalRef`, and a
           NULL predicate excludes the row — so a hand-entered transaction,
           which carries no reference at all, is exactly the one a bare `not`
           would miss. Spelled out as a two-armed OR so it cannot. */
        OR: [{ externalRef: null }, { externalRef: { not: openingBalanceRef(accountId) } }],
      },
    });
    if (others > 0) {
      throw new BadRequestException(
        'এই অ্যাকাউন্টে একাধিক প্রারম্ভিক জেরের লেনদেন আছে — লেনদেন তালিকা থেকে সেগুলো সম্পাদনা করুন',
      );
    }
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
