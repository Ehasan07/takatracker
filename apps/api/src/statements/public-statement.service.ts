import { Injectable, NotFoundException } from '@nestjs/common';
import { groupPositions, suggestSettlements } from '@hishab/core';
import { fromLocalDateString, toLocalDateString, type Locale } from '@hishab/shared';
import { minorToNumber } from '../common/bigint-json';
import { LoansService } from '../loans/loans.service';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../transactions/transactions.service';
import type { ResolvedShare } from './statement-share.service';

/**
 * The statement behind a share link.
 *
 * ## Everything is scoped by the row, never by a request
 *
 * There is no signed-in user here. `workspaceId` and `subjectId` come from the
 * `StatementShare` row and from nowhere else, and every query below filters on
 * both. The dates likewise: they are the row's, so the reader cannot widen the
 * window by editing anything.
 *
 * ## Person and loan reuse what the app already had
 *
 * `personLedger` and `statement` are the same methods the owner's own screens
 * call, with the same running balance and the same date splitting — already
 * built and already tested. A second implementation for the public page would
 * eventually disagree with the private one about somebody's balance, and the
 * version a creditor is holding is the worst one to be wrong.
 *
 * Savings and insurance had no statement at all. Theirs is built here, and
 * deliberately plainly: a list of instalments in the window and what is paid
 * against them.
 */

export type PublicStatement = {
  kind: ResolvedShare['kind'];
  /** Whose books these are. The reader needs to know who sent it. */
  workspaceName: string;
  currency: string;
  locale: Locale;
  from: string | null;
  to: string | null;
  /**
   * A short code printed on the document, so a phone call about it has
   * something to quote. Derived from the share row's id — which is not the
   * secret; the token is — and never enough on its own to reach anything.
   */
  reference: string;
  /** When this link stops working, so the reader knows to print it. */
  expiresAt: string;
  /** When this copy was drawn. A statement with no issue date is a screenshot. */
  issuedAt: string;
  /** The name at the top: the person, the loan number, the plan, the insurer. */
  title: string;
  subtitle: string | null;
  /** Rendered as-is by the page. Shapes differ per kind. */
  data: unknown;
};

@Injectable()
export class PublicStatementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly loans: LoansService,
  ) {}

  async render(share: ResolvedShare): Promise<PublicStatement> {
    const workspace = await this.prisma.workspace.findFirst({
      where: { id: share.workspaceId, deletedAt: null, status: 'ACTIVE' },
      select: { id: true, name: true, currency: true, timezone: true, locale: true },
    });
    /* A workspace that has been closed or suspended stops answering for its
       links too. Same 404 as a bad token — the reader learns nothing. */
    if (!workspace) throw new NotFoundException('লিংকটি আর কাজ করছে না।');

    const locale: Locale = workspace.locale === 'en' ? 'en' : 'bn';
    const ctx: TenantContext = {
      /* No user did this — a link did. `id` records authorship on writes and
         this path performs none, so the empty string is honest rather than a
         borrowed identity. */
      id: '',
      workspaceId: workspace.id,
      timezone: workspace.timezone,
      locale,
    };
    const range = { from: share.from ?? undefined, to: share.to ?? undefined };
    const head = {
      workspaceName: workspace.name,
      currency: workspace.currency,
      locale,
      from: share.from,
      to: share.to,
      /* The tail of the id, upper-cased: short enough to read down a phone,
         long enough to tell two of somebody's links apart. */
      reference: share.id.slice(-8).toUpperCase(),
      expiresAt: share.expiresAt,
      issuedAt: new Date().toISOString(),
    };

    if (share.kind === 'PERSON') {
      const ledger = await this.loans.personLedger(ctx, share.subjectId, range);
      return {
        ...head,
        kind: share.kind,
        title: ledger.person.name,
        subtitle: ledger.person.relation ?? null,
        data: ledger,
      };
    }

    if (share.kind === 'LOAN') {
      const statement = await this.loans.statement(ctx, share.subjectId, range);
      return {
        ...head,
        kind: share.kind,
        title: statement.loan.personName ?? statement.loan.loanNumber,
        subtitle: statement.loan.loanNumber,
        data: statement,
      };
    }

    if (share.kind === 'SAVINGS') {
      return { ...head, kind: share.kind, ...(await this.savings(share, workspace.timezone)) };
    }

    if (share.kind === 'GROUP') {
      return { ...head, kind: share.kind, ...(await this.group(share, workspace.timezone)) };
    }

    return { ...head, kind: share.kind, ...(await this.insurance(share, workspace.timezone)) };
  }

  /**
   * A savings plan's instalments over the window.
   *
   * Every row filters on `workspaceId` as well as `planId`. The plan id came
   * from a share row that was checked when the link was made, but a query that
   * only trusts the id would be one bad join away from another tenant's rows —
   * and this is the one endpoint with nobody signed in to catch it.
   */
  private async savings(share: ResolvedShare, timezone: string) {
    const plan = await this.prisma.savingsPlan.findFirst({
      where: { id: share.subjectId, workspaceId: share.workspaceId, deletedAt: null },
    });
    if (!plan) throw new NotFoundException('লিংকটি আর কাজ করছে না।');

    const rows = await this.prisma.savingsInstallment.findMany({
      where: {
        workspaceId: share.workspaceId,
        planId: plan.id,
        ...PublicStatementService.dateWindow('dueDate', share, timezone),
      },
      orderBy: { dueDate: 'asc' },
    });

    let paidMinor = 0;
    let dueMinor = 0;
    const items = rows.map((row) => {
      const amount = minorToNumber(row.expectedMinor);
      if (row.status === 'PAID') paidMinor += amount;
      else dueMinor += amount;
      return {
        dueDate: toLocalDateString(row.dueDate, timezone),
        expectedMinor: amount,
        paidDate: row.paidDate ? toLocalDateString(row.paidDate, timezone) : null,
        status: row.status,
      };
    });

    return {
      title: plan.planName,
      subtitle: plan.institution,
      data: {
        plan: {
          planName: plan.planName,
          institution: plan.institution,
          planType: plan.planType,
          installmentMinor: minorToNumber(plan.installmentMinor),
          frequency: plan.frequency,
          startDate: toLocalDateString(plan.startDate, timezone),
          maturityDate: plan.maturityDate ? toLocalDateString(plan.maturityDate, timezone) : null,
        },
        items,
        paidMinor,
        dueMinor,
        totalMinor: paidMinor + dueMinor,
      },
    };
  }

  /**
   * A whole trip or event: what it cost, and who carried what share.
   *
   * ## What the reader is given, and what they are not
   *
   * Everybody on the trip already knows what the trip cost and roughly who paid
   * for what — that is the point of having been on it. So this shows the whole
   * group: every bill, who paid it, and each member's total paid, total share
   * and where they stand. Withholding that would make the page useless for the
   * one thing anybody opens it for, which is checking their own number against
   * everybody else's.
   *
   * What it does not carry is anything from outside the group. No account
   * balances, no other people, no other spending — the owner's ledger stays
   * theirs. The share row names one group and the queries filter on it.
   *
   * ## Why it reuses the statement link rather than growing its own
   *
   * Expiry, revocation, the view counter, the single-sentence 404, `noindex`,
   * the rate limit and the hashed token are all already built and tested. A
   * second kind of public link would be a second place for each of those to be
   * got wrong.
   */
  private async group(share: ResolvedShare, timezone: string) {
    const group = await this.prisma.splitGroup.findFirst({
      where: { id: share.subjectId, workspaceId: share.workspaceId, deletedAt: null },
      select: { id: true, name: true, purpose: true },
    });
    if (!group) throw new NotFoundException('লিংকটি আর কাজ করছে না।');

    const [members, expenses, settlements] = await Promise.all([
      this.prisma.splitGroupMember.findMany({
        where: { groupId: group.id, workspaceId: share.workspaceId },
        orderBy: [{ isSelf: 'desc' }, { createdAt: 'asc' }],
        select: { id: true, displayName: true, isSelf: true, removedAt: true },
      }),
      this.prisma.sharedExpense.findMany({
        where: {
          workspaceId: share.workspaceId,
          groupId: group.id,
          deletedAt: null,
          ...PublicStatementService.dateWindow('date', share, timezone),
        },
        orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
        select: {
          id: true,
          date: true,
          description: true,
          totalMinor: true,
          payerMemberId: true,
          shares: { select: { memberId: true, amountMinor: true } },
        },
      }),
      this.prisma.splitSettlement.findMany({
        where: {
          workspaceId: share.workspaceId,
          groupId: group.id,
          deletedAt: null,
          ...PublicStatementService.dateWindow('date', share, timezone),
        },
        orderBy: { date: 'asc' },
        select: { fromMemberId: true, toMemberId: true, amountMinor: true },
      }),
    ]);

    const nameOf = new Map(members.map((m) => [m.id, m.displayName]));
    const paid = new Map<string, number>();
    const owed = new Map<string, number>();
    let totalMinor = 0;

    for (const expense of expenses) {
      const total = minorToNumber(expense.totalMinor);
      totalMinor += total;
      paid.set(expense.payerMemberId, (paid.get(expense.payerMemberId) ?? 0) + total);
      for (const share_ of expense.shares) {
        owed.set(
          share_.memberId,
          (owed.get(share_.memberId) ?? 0) + minorToNumber(share_.amountMinor),
        );
      }
    }

    const positions = groupPositions(
      expenses.map((e) => ({
        payerMemberId: e.payerMemberId,
        shares: e.shares.map((x) => ({
          memberId: x.memberId,
          amountMinor: minorToNumber(x.amountMinor),
        })),
      })),
      settlements.map((x) => ({
        fromMemberId: x.fromMemberId,
        toMemberId: x.toMemberId,
        amountMinor: minorToNumber(x.amountMinor),
      })),
    );
    const netOf = new Map(positions.map((p) => [p.memberId, p.netMinor]));

    return {
      title: group.name,
      subtitle: null,
      data: {
        totalMinor,
        /* Suggested payments are on here too: the reason somebody sends this
           link is usually to say "so you owe Karim ৳2,000", and making the
           reader work that out from three columns invites them to get it
           wrong. */
        settleUp: suggestSettlements(positions).map((s) => ({
          from: nameOf.get(s.fromMemberId) ?? '',
          to: nameOf.get(s.toMemberId) ?? '',
          amountMinor: s.amountMinor,
        })),
        members: members.map((m) => ({
          name: m.displayName,
          paidMinor: paid.get(m.id) ?? 0,
          shareMinor: owed.get(m.id) ?? 0,
          netMinor: netOf.get(m.id) ?? 0,
          left: m.removedAt !== null,
        })),
        expenses: expenses.map((e) => ({
          date: toLocalDateString(e.date, timezone),
          description: e.description,
          payer: nameOf.get(e.payerMemberId) ?? '',
          totalMinor: minorToNumber(e.totalMinor),
        })),
      },
    };
  }

  /** The same shape for premiums. Insurers ask for exactly this. */
  private async insurance(share: ResolvedShare, timezone: string) {
    const policy = await this.prisma.insurancePolicy.findFirst({
      where: { id: share.subjectId, workspaceId: share.workspaceId, deletedAt: null },
    });
    if (!policy) throw new NotFoundException('লিংকটি আর কাজ করছে না।');

    const rows = await this.prisma.premiumPayment.findMany({
      where: {
        workspaceId: share.workspaceId,
        policyId: policy.id,
        ...PublicStatementService.dateWindow('dueDate', share, timezone),
      },
      orderBy: { dueDate: 'asc' },
    });

    let paidMinor = 0;
    let dueMinor = 0;
    const items = rows.map((row) => {
      const amount = minorToNumber(row.amountMinor);
      if (row.status === 'PAID') paidMinor += amount;
      else dueMinor += amount;
      return {
        dueDate: toLocalDateString(row.dueDate, timezone),
        expectedMinor: amount,
        paidDate: row.paidDate ? toLocalDateString(row.paidDate, timezone) : null,
        status: row.status,
      };
    });

    return {
      title: policy.insurer,
      /* The masked number only. A policy number in full, on a page reachable by
         URL alone, is the one field on here worth stealing. */
      subtitle: policy.policyNumberMasked,
      data: {
        policy: {
          insurer: policy.insurer,
          policyNumberMasked: policy.policyNumberMasked,
          policyType: policy.policyType,
          premiumMinor: minorToNumber(policy.premiumMinor),
          sumAssuredMinor: minorToNumber(policy.sumAssuredMinor),
          frequency: policy.frequency,
          startDate: toLocalDateString(policy.startDate, timezone),
          maturityDate: policy.maturityDate
            ? toLocalDateString(policy.maturityDate, timezone)
            : null,
        },
        items,
        paidMinor,
        dueMinor,
        totalMinor: paidMinor + dueMinor,
      },
    };
  }

  /**
   * The share's own window as a Prisma filter, or nothing when it has none.
   *
   * `to` is inclusive of the whole day, which is what somebody typing a date
   * means. `lt` on the following midnight rather than `lte` on the date, so a
   * row stamped at any time on the last day is inside.
   */
  private static dateWindow(field: 'dueDate' | 'date', share: ResolvedShare, timezone: string) {
    if (!share.from && !share.to) return {};
    const gte = share.from ? fromLocalDateString(share.from, timezone) : undefined;
    const lt = share.to
      ? new Date(fromLocalDateString(share.to, timezone).getTime() + 86_400_000)
      : undefined;
    return { [field]: { ...(gte ? { gte } : {}), ...(lt ? { lt } : {}) } };
  }
}
