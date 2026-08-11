import { Injectable } from '@nestjs/common';
import { AccountsService } from '../accounts/accounts.service';
import { minorToNumber } from '../common/bigint-json';
import { PrismaService } from '../prisma/prisma.service';

/**
 * What one tenant's money looks like, for an operator.
 *
 * ## What this is
 *
 * The first place in the admin module that reads a tenant's *figures* rather
 * than counting their rows. Everything before it ran `count` and `groupBy`;
 * this returns balances, net worth, savings and loan positions by name.
 *
 * That is a deliberate widening of what an operator can see, and it is
 * therefore audited as its own action — `admin.tenant_finance_viewed`, distinct
 * from `admin.tenant_viewed` — so "who has looked at somebody's balances" is one
 * query rather than a guess. Reusing the plainer action for both would have
 * made the two indistinguishable in the log, which is the same as not recording
 * the difference.
 *
 * ## What it is not
 *
 * It is not a transaction list. An operator gets positions and totals, not the
 * line-by-line story of what somebody bought — that is what the audited,
 * time-boxed impersonation session is for, and it leaves a much clearer record
 * of a support visit than a silent read of somebody's grocery history.
 *
 * ## Why it reuses `AccountsService.balances`
 *
 * A balance is not a column; it is opening balance plus every ledger entry, and
 * the rules about which entries count — soft deletes, archived accounts, the
 * ledger date rather than `createdAt` — are subtle enough that a second
 * implementation would eventually disagree with the first. An operator reading
 * one number while the customer reads another, both called "balance", is worse
 * than the operator seeing nothing.
 */

export interface AdminAccountView {
  id: string;
  name: string;
  type: string;
  /** Whatever the user typed for their own recognition — never a full number. */
  accountNumberMasked: string | null;
  institution: string | null;
  isArchived: boolean;
  balanceMinor: number;
}

export interface TenantFinance {
  currency: string;
  accounts: AdminAccountView[];
  /** Assets less liabilities, in the workspace's own currency. */
  netWorthMinor: number;
  assetsMinor: number;
  liabilitiesMinor: number;
  savings: {
    count: number;
    /** What has actually been paid in, not what was promised. */
    paidInMinor: number;
  };
  insurance: { count: number; premiumPaidMinor: number };
  loans: { lentOutstandingMinor: number; borrowedOutstandingMinor: number; count: number };
}

/** Account types that are somebody's money rather than somebody's debt. */
const ASSET_TYPES = new Set(['CASH', 'BANK', 'MOBILE_WALLET', 'ASSET', 'RECEIVABLE', 'SAVINGS']);

@Injectable()
export class AdminFinanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountsService,
  ) {}

  async forWorkspace(workspaceId: string): Promise<TenantFinance> {
    const [workspace, rows, balances, savings, insurance, loans] = await Promise.all([
      this.prisma.workspace.findUniqueOrThrow({
        where: { id: workspaceId },
        select: { currency: true },
      }),
      this.prisma.account.findMany({
        /* `systemKey: null` — the nominal income and expense accounts and the
         * two loan control accounts are bookkeeping machinery. Listing them
         * beside somebody's bank account would make the screen look like the
         * user has eight accounts when they opened three. */
        where: { workspaceId, deletedAt: null, systemKey: null },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        select: {
          id: true,
          name: true,
          type: true,
          accountNumberMasked: true,
          institution: true,
          isArchived: true,
        },
      }),
      this.accounts.balances(workspaceId),
      /* Paid instalments only. `expectedMinor` is what the scheme asks for and
       * `paidDate` is whether it arrived — summing the unpaid ones would report
       * money somebody has promised as money somebody has. */
      this.prisma.savingsInstallment.aggregate({
        where: { workspaceId, paidDate: { not: null } },
        _sum: { expectedMinor: true },
        _count: { _all: true },
      }),
      this.prisma.premiumPayment.aggregate({
        where: { workspaceId, paidDate: { not: null } },
        _sum: { amountMinor: true },
        _count: { _all: true },
      }),
      this.prisma.loan.findMany({
        where: { workspaceId, deletedAt: null, status: { not: 'CANCELLED' } },
        select: {
          direction: true,
          principalMinor: true,
          interestMinor: true,
          payments: { select: { amountMinor: true } },
        },
      }),
    ]);

    const accounts: AdminAccountView[] = rows.map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      accountNumberMasked: a.accountNumberMasked,
      institution: a.institution,
      isArchived: a.isArchived,
      balanceMinor: balances.get(a.id) ?? 0,
    }));

    /* Assets and liabilities separately rather than one signed total, because
     * "net worth: ৳2,000" hides whether that is ৳2,000 in the bank or ৳500,000
     * against ৳498,000 of debt — and those are different customers. */
    let assetsMinor = 0;
    let liabilitiesMinor = 0;
    for (const account of accounts) {
      if (ASSET_TYPES.has(account.type)) assetsMinor += account.balanceMinor;
      else liabilitiesMinor += account.balanceMinor;
    }

    let lentOutstandingMinor = 0;
    let borrowedOutstandingMinor = 0;
    for (const loan of loans) {
      const owed =
        minorToNumber(loan.principalMinor) +
        minorToNumber(loan.interestMinor) -
        loan.payments.reduce((sum, p) => sum + minorToNumber(p.amountMinor), 0);
      // A loan repaid past its balance is settled, not negative.
      const outstanding = Math.max(0, owed);
      if (loan.direction === 'LENT') lentOutstandingMinor += outstanding;
      else borrowedOutstandingMinor += outstanding;
    }

    return {
      currency: workspace.currency,
      accounts,
      assetsMinor,
      liabilitiesMinor,
      /* Liabilities are stored as their own signed balance, so this is a sum
       * rather than a subtraction — the same arithmetic `buildBalanceSheet`
       * does for the customer's own screen. */
      netWorthMinor: assetsMinor + liabilitiesMinor,
      savings: {
        count: savings._count._all,
        paidInMinor: minorToNumber(savings._sum.expectedMinor ?? 0n),
      },
      insurance: {
        count: insurance._count._all,
        premiumPaidMinor: minorToNumber(insurance._sum.amountMinor ?? 0n),
      },
      loans: { lentOutstandingMinor, borrowedOutstandingMinor, count: loans.length },
    };
  }
}
