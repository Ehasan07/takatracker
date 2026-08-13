import { Injectable, NotFoundException } from '@nestjs/common';
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
  private static dateWindow(field: 'dueDate', share: ResolvedShare, timezone: string) {
    if (!share.from && !share.to) return {};
    const gte = share.from ? fromLocalDateString(share.from, timezone) : undefined;
    const lt = share.to
      ? new Date(fromLocalDateString(share.to, timezone).getTime() + 86_400_000)
      : undefined;
    return { [field]: { ...(gte ? { gte } : {}), ...(lt ? { lt } : {}) } };
  }
}
