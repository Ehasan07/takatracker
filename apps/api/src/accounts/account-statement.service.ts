import { Injectable, NotFoundException } from '@nestjs/common';
import type { AccountType } from '@prisma/client';
import { buildStatement, nextDateKey } from '@hishab/core';
import {
  displayName,
  fromLocalDateString,
  isDebitNormal,
  sumMinor,
  toLocalDateString,
  type Locale,
} from '@hishab/shared';
import { minorToNumber } from '../common/bigint-json';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../transactions/transactions.service';

/**
 * A statement of account: the bank-statement view of one account.
 *
 * ## What it is, in accounting terms
 *
 * This is the ledger account itself, presented in running-balance form — the
 * same document a bank issues and an accountant calls a statement of account:
 *
 *     opening balance
 *     + every entry, dated, with its debit or credit
 *     = closing balance
 *
 * and the arithmetic proof that ties it together:
 *
 *     opening + total debits − total credits = closing
 *
 * The service returns that proof's three totals rather than leaving the reader
 * to add a hundred rows. A statement whose columns do not foot is not a
 * statement, so the numbers are computed here once and shown, not recomputed by
 * each client.
 *
 * ## Debit and credit, not "in" and "out"
 *
 * Every entry is already stored as a debit or a credit — that is what the
 * double entry *is* — so those are the two columns. Renaming them "in" and
 * "out" would be a lie on half the accounts in the chart: money spent on a
 * credit card increases what you owe, and calling that "in" because the balance
 * grew would teach the reader the wrong thing about their own books.
 *
 * What the presentation does instead is carry `debitNormal`, so a screen can
 * say which side is the natural one for *this* account and print the balance
 * with the right Dr/Cr sense. A bank account is debit-normal: debits are
 * deposits. A credit card is credit-normal: credits are purchases.
 *
 * ## The sign convention, and why the balance can be negative
 *
 * Balances here are signed the way `AccountsService.balances` signs them —
 * debits add, credits subtract, whatever the account type — so a liability
 * carries a negative number. That is not a display choice, it is the invariant
 * every other total in this system is built on, and a statement that flipped
 * the sign locally would be the one document that disagrees with the balance
 * sheet. `debitNormal` is what a presenter uses to show it the way a reader
 * expects.
 *
 * ## What counts as being in the window
 *
 * The ledger date, never `createdAt`: a bill entered three weeks late belongs
 * to the day it was paid, which is the day a reader is looking for it. Deleted
 * transactions never appear at any date, for the reason set out at length in
 * `AccountsService.balances` — the books say they never happened.
 */

export interface AccountStatementRow {
  /** `YYYY-MM-DD` in the workspace's timezone. */
  date: string;
  transactionId: string;
  /** The transaction's own words, or the payee, or the category. */
  description: string;
  /**
   * The other side of the entry — the account or category the money faced.
   *
   * This is the "particulars" column of a hand-kept ledger, and it is the
   * single most useful thing on the page: `৳৫,০০০ · ব্যাংক` on a cash statement
   * says a withdrawal, the same amount with `বাজার` says the money is gone.
   */
  contra: string;
  debitMinor: number;
  creditMinor: number;
  /** Running balance after this row, signed. */
  balanceMinor: number;
}

export interface AccountStatementResponse {
  account: {
    id: string;
    name: string;
    type: AccountType;
    currency: string;
    institution: string | null;
    accountNumberMasked: string | null;
  };
  /** Both null means the whole life of the account. */
  from: string | null;
  to: string | null;
  openingMinor: number;
  rows: AccountStatementRow[];
  closingMinor: number;
  totalDebitMinor: number;
  totalCreditMinor: number;
  /** True when a debit increases this account — cash, bank, wallet, savings. */
  debitNormal: boolean;
}

export interface AccountStatementRange {
  from?: string;
  to?: string;
}

@Injectable()
export class AccountStatementService {
  constructor(private readonly prisma: PrismaService) {}

  async statement(
    ctx: TenantContext,
    accountId: string,
    range: AccountStatementRange,
    locale: Locale = 'bn',
  ): Promise<AccountStatementResponse> {
    const account = await this.prisma.account.findFirst({
      where: { id: accountId, workspaceId: ctx.workspaceId, deletedAt: null },
    });
    if (!account) throw new NotFoundException('অ্যাকাউন্টটি পাওয়া যায়নি');

    const from = range.from ?? null;
    const to = range.to ?? null;

    /* Local midnights, resolved through the calendar rather than by adding
       86,400,000 milliseconds — a day is not a fixed number of hours across an
       offset change, and a statement that loses the first or last entry of a
       month is worse than no statement. */
    const startsAt = from ? fromLocalDateString(from, ctx.timezone) : null;
    const endsBefore = to ? fromLocalDateString(nextDateKey(to), ctx.timezone) : null;

    const openingMinor = await this.openingBalance(ctx.workspaceId, account.id, startsAt);

    const entries = await this.prisma.ledgerEntry.findMany({
      where: {
        workspaceId: ctx.workspaceId,
        accountId: account.id,
        transaction: {
          deletedAt: null,
          ...(startsAt || endsBefore
            ? {
                date: {
                  ...(startsAt ? { gte: startsAt } : {}),
                  ...(endsBefore ? { lt: endsBefore } : {}),
                },
              }
            : {}),
        },
      },
      include: {
        category: true,
        transaction: {
          include: {
            /* The other side of the entry, for the particulars column. The
               account's own row comes back too and is filtered out below —
               asking for `NOT { accountId }` would drop the contra of a
               transaction that touches this account twice, which a transfer
               correction does. */
            entries: { include: { account: true, category: true } },
            person: true,
          },
        },
      },
      /* Date first, then insertion order. Two entries on the same day have no
         other ordering in the data, and a running balance that reshuffles
         between two requests is a statement nobody can reconcile against. */
      orderBy: [{ transaction: { date: 'asc' } }, { transaction: { createdAt: 'asc' } }],
    });

    const built = buildStatement(
      openingMinor,
      entries.map((entry) => ({
        date: entry.transaction.date,
        description: AccountStatementService.describe(entry, locale),
        deltaMinor:
          entry.direction === 'DEBIT'
            ? minorToNumber(entry.amountMinor)
            : -minorToNumber(entry.amountMinor),
      })),
    );

    /* `buildStatement` sorts by date, and the query already did — in the same
       direction, and stably, so row *i* still belongs to entry *i*. */
    const rows: AccountStatementRow[] = built.rows.map((row, index) => {
      const entry = entries[index]!;
      return {
        date: toLocalDateString(entry.transaction.date, ctx.timezone),
        transactionId: entry.transactionId,
        description: row.description,
        contra: AccountStatementService.contra(entry, account.id, locale),
        debitMinor: row.debitMinor,
        creditMinor: row.creditMinor,
        balanceMinor: row.balanceMinor,
      };
    });

    return {
      account: {
        id: account.id,
        name: account.name,
        type: account.type,
        currency: account.currency,
        institution: account.institution,
        accountNumberMasked: account.accountNumberMasked,
      },
      from,
      to,
      openingMinor: built.openingMinor,
      rows,
      closingMinor: built.closingMinor,
      totalDebitMinor: sumMinor(rows.map((r) => r.debitMinor)),
      totalCreditMinor: sumMinor(rows.map((r) => r.creditMinor)),
      debitNormal: isDebitNormal(account.type),
    };
  }

  /**
   * What the account was worth the instant before the window opens.
   *
   * Deliberately its own query rather than a slice of the rows: a statement for
   * March must not have to read January and February to know where it starts,
   * and on an account with years of history that difference is the whole
   * response time.
   *
   * With no window it is zero, and that is not a loss of information. It used
   * to seed from `Account.openingBalance`, a dateless column outside the
   * ledger; the account's opening balance is an `OPENING_BALANCE` transaction
   * now, so on a whole-life statement it is the first *row* — visible, dated
   * and reconcilable — and on a windowed one it is folded into this figure by
   * the same query that folds in every other entry before the window.
   */
  private async openingBalance(
    workspaceId: string,
    accountId: string,
    startsAt: Date | null,
  ): Promise<number> {
    if (!startsAt) return 0;

    const grouped = await this.prisma.ledgerEntry.groupBy({
      by: ['direction'],
      where: {
        workspaceId,
        accountId,
        transaction: { deletedAt: null, date: { lt: startsAt } },
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

  /** The transaction's own words, falling back to whom or what it was for. */
  private static describe(
    entry: {
      category: { name: string; nameBn: string | null } | null;
      transaction: {
        description: string | null;
        payee: string | null;
        person: { name: string } | null;
      };
    },
    locale: Locale,
  ): string {
    const { description, payee, person } = entry.transaction;
    if (description?.trim()) return description.trim();
    if (payee?.trim()) return payee.trim();
    if (person) return person.name;
    if (entry.category) return displayName(entry.category, locale);
    return '';
  }

  /**
   * The account or category on the other side.
   *
   * A simple transaction has exactly one other entry and this is its name. A
   * split across several categories has more, and they are joined — a reader
   * looking at `বাজার, যাতায়াত` learns more than one that says "several".
   */
  private static contra(
    entry: {
      transaction: {
        entries: {
          accountId: string;
          account: { name: string };
          category: { name: string; nameBn: string | null } | null;
        }[];
      };
    },
    accountId: string,
    locale: Locale,
  ): string {
    const others = entry.transaction.entries.filter((other) => other.accountId !== accountId);

    const names = others.map((other) =>
      /* A category, when there is one: `বাজার` is what the money was for, and
         it is more use than `SYSTEM_EXPENSE`, which is the nominal account
         every expense in the workspace posts to. Without a category — a
         transfer, a loan movement — the account's own name is the answer. */
      other.category ? displayName(other.category, locale) : other.account.name,
    );

    return [...new Set(names)].join(', ');
  }
}
