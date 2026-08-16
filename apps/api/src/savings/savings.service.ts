import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  buildInstalmentSchedule,
  clampDayToMonth,
  MONTHS_PER_PERIOD,
  projectSavings,
  summariseProgress,
  type SavingsProgress,
  type SavingsProjection,
} from '@hishab/core';
import { fromLocalDateString, toLocalDateString } from '@hishab/shared';
import type {
  InstalmentStatus,
  SavingsInstallment,
  SavingsPlan,
  SavingsPlanType,
  SavingsStatus,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { minorToNumber } from '../common/bigint-json';
import { PrismaService } from '../prisma/prisma.service';
import { TransactionsService, type TenantContext } from '../transactions/transactions.service';
import type {
  CreateSavingsPlanInput,
  PayInstallmentInput,
  UpdateSavingsPlanInput,
} from './savings.controller';

export interface SavingsInstallmentView {
  id: string;
  /** 1-based position in the schedule, so the UI can say "৫ম কিস্তি". */
  index: number;
  dueDate: string;
  expectedMinor: number;
  paidDate: string | null;
  status: InstalmentStatus;
  transactionId: string | null;
}

export interface SavingsPlanView {
  id: string;
  planName: string;
  institution: string | null;
  planType: SavingsPlanType;
  installmentMinor: number;
  principalMinor: number;
  frequency: SavingsPlan['frequency'];
  termMonths: number;
  startDate: string;
  maturityDate: string | null;
  profitRateBps: number;
  profitCalc: SavingsPlan['profitCalc'];
  linkedAccountId: string | null;
  status: SavingsStatus;
  note: string | null;
  projection: SavingsProjection;
  progress: SavingsProgress;
  /** The next instalment still owed, for a "পরবর্তী কিস্তি" line. */
  nextDueDate: string | null;
  /**
   * Every poisha of profit this instrument has actually paid out.
   *
   * Not the projection — `projection` above is what the plan *should* yield.
   * This is what arrived, summed off the ledger, and the two differ by source
   * tax and excise duty on every real Sanchayapatra.
   */
  profitReceivedMinor: number;
}

export interface SavingsPlanDetail extends SavingsPlanView {
  installments: SavingsInstallmentView[];
}

/** What one profit payout produced, for the screen's toast. */
export interface ProfitReceipt {
  transactionId: string;
  amountMinor: number;
  date: string;
  /** Every profit ever booked against this plan, this one included. */
  totalProfitMinor: number;
}

const pad = (value: number, width: number): string => String(value).padStart(width, '0');

/**
 * Month arithmetic on the local calendar date. A plan opened on the 31st falls
 * due on the 30th in a short month — the same clamping a credit-card due day
 * gets — rather than spilling into the next month and dragging the rest of the
 * schedule a day later each time.
 */
function addMonths(isoDate: string, months: number): string {
  const year = Number(isoDate.slice(0, 4));
  const month = Number(isoDate.slice(5, 7));
  const day = Number(isoDate.slice(8, 10));

  const zeroBased = year * 12 + (month - 1) + months;
  const nextYear = Math.floor(zeroBased / 12);
  const nextMonth = (zeroBased % 12) + 1;

  return `${pad(nextYear, 4)}-${pad(nextMonth, 2)}-${pad(clampDayToMonth(nextYear, nextMonth, day), 2)}`;
}

type PlanWithInstallments = SavingsPlan & { installments: SavingsInstallment[] };

@Injectable()
export class SavingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly transactions: TransactionsService,
  ) {}

  async list(workspaceId: string, timezone: string): Promise<SavingsPlanView[]> {
    const plans = await this.prisma.savingsPlan.findMany({
      where: { workspaceId, deletedAt: null },
      orderBy: [{ status: 'asc' }, { startDate: 'desc' }],
      include: { installments: { orderBy: { dueDate: 'asc' } } },
    });

    /* One grouped query for every plan's profit rather than one per plan: ten
       DPS rows would otherwise be ten round trips to draw ten numbers. */
    const profit = await this.profitByPlan(workspaceId);

    // The schedule rows are loaded because progress cannot be summarised
    // without them, but they are not shipped: a list of ten DPS plans would
    // otherwise carry a thousand instalments to draw ten progress rings.
    return plans.map((plan) => ({
      ...SavingsService.summarise(plan, timezone),
      profitReceivedMinor: profit.get(plan.id) ?? 0,
    }));
  }

  async findOne(workspaceId: string, id: string, timezone: string): Promise<SavingsPlanDetail> {
    const plan = await this.requirePlan(workspaceId, id);
    return {
      ...SavingsService.detail(plan, timezone),
      profitReceivedMinor: await this.profitTotal(workspaceId, plan.id),
    };
  }

  /**
   * Profit per plan, for the whole workspace, in one query.
   *
   * The same shape as `profitTotal` and for the same reasons — debit legs on
   * real accounts, soft-deleted rows excluded — but grouped, because the list
   * screen needs all of them at once.
   */
  private async profitByPlan(workspaceId: string): Promise<Map<string, number>> {
    const rows = await this.prisma.ledgerEntry.findMany({
      where: {
        workspaceId,
        direction: 'DEBIT',
        account: { systemKey: null },
        transaction: { savingsPlanId: { not: null }, type: 'INCOME', deletedAt: null },
      },
      select: { amountMinor: true, transaction: { select: { savingsPlanId: true } } },
    });

    const out = new Map<string, number>();
    for (const row of rows) {
      const planId = row.transaction.savingsPlanId;
      if (!planId) continue;
      out.set(planId, (out.get(planId) ?? 0) + minorToNumber(row.amountMinor));
    }
    return out;
  }

  async create(
    workspaceId: string,
    actorUserId: string,
    input: CreateSavingsPlanInput,
    timezone: string,
  ): Promise<SavingsPlanDetail> {
    if (input.installmentMinor === 0 && input.principalMinor === 0) {
      throw new BadRequestException('কিস্তির টাকা অথবা এককালীন জমা — অন্তত একটি দিতে হবে');
    }
    if (input.linkedAccountId) await this.assertAccount(workspaceId, input.linkedAccountId);

    const maturityDate = input.maturityDate ?? addMonths(input.startDate, input.termMonths);
    if (maturityDate <= input.startDate) {
      throw new BadRequestException('মেয়াদপূর্তির তারিখ শুরুর তারিখের পরে হতে হবে');
    }

    const schedule = buildInstalmentSchedule({
      installmentMinor: input.installmentMinor,
      principalMinor: input.principalMinor,
      frequency: input.frequency,
      termMonths: input.termMonths,
      profitRateBps: input.profitRateBps,
      profitCalc: input.profitCalc,
    });

    /* An instalment amount with no instalments is a contradiction the saver
     * cannot see: a yearly plan over six months schedules nothing, so the plan
     * would sit there with money attached, nothing to tick off, and progress
     * frozen at zero forever. Say so instead. */
    if (input.installmentMinor > 0 && schedule.length === 0) {
      throw new BadRequestException(
        'এই মেয়াদে একটিও কিস্তি পড়ে না — মেয়াদ বাড়ান অথবা কিস্তির হার বদলান',
      );
    }

    // The plan and its whole schedule land in one write: a plan with half a
    // schedule would quietly under-report what the saver still owes.
    const created = await this.prisma.savingsPlan.create({
      data: {
        workspaceId,
        planName: input.planName,
        institution: input.institution,
        planType: input.planType,
        installmentMinor: BigInt(input.installmentMinor),
        principalMinor: BigInt(input.principalMinor),
        frequency: input.frequency,
        termMonths: input.termMonths,
        startDate: fromLocalDateString(input.startDate, timezone),
        maturityDate: fromLocalDateString(maturityDate, timezone),
        profitRateBps: input.profitRateBps,
        profitCalc: input.profitCalc,
        linkedAccountId: input.linkedAccountId,
        note: input.note,
        installments: {
          create: schedule.map((row) => ({
            workspaceId,
            dueDate: fromLocalDateString(addMonths(input.startDate, row.monthOffset), timezone),
            expectedMinor: BigInt(row.expectedMinor),
          })),
        },
      },
      include: { installments: { orderBy: { dueDate: 'asc' } } },
    });

    this.audit.emit({
      workspaceId,
      actorUserId,
      // Not in the AUDIT_ACTIONS union yet; the cast keeps the emitted string
      // honest until it is added there.
      action: 'savings.plan_created' as never,
      entity: 'SavingsPlan',
      entityId: created.id,
      after: {
        planName: created.planName,
        planType: created.planType,
        installments: schedule.length,
      },
    });

    return SavingsService.detail(created, timezone);
  }

  /**
   * Field edits only. The instalment rows are deliberately left alone: they
   * carry which months were actually paid, and rebuilding them from a changed
   * term would erase that history to match a number the user just typed.
   */
  async update(
    workspaceId: string,
    actorUserId: string,
    id: string,
    input: UpdateSavingsPlanInput,
    timezone: string,
  ): Promise<SavingsPlanDetail> {
    const existing = await this.requirePlan(workspaceId, id);
    if (input.linkedAccountId) await this.assertAccount(workspaceId, input.linkedAccountId);

    const startDate = input.startDate ?? toLocalDateString(existing.startDate, timezone);
    const termMonths = input.termMonths ?? existing.termMonths;
    // Only rederive maturity when the caller actually moved the start or term;
    // a maturity date typed by hand off the passbook must survive other edits.
    const maturityDate =
      input.maturityDate ??
      (input.startDate !== undefined || input.termMonths !== undefined
        ? addMonths(startDate, termMonths)
        : undefined);

    if (maturityDate !== undefined && maturityDate <= startDate) {
      throw new BadRequestException('মেয়াদপূর্তির তারিখ শুরুর তারিখের পরে হতে হবে');
    }

    /* `create` refuses a plan whose term schedules no instalments at all — a
     * yearly plan over six months. `update` did not, so the same contradiction
     * could be edited back in: money attached, nothing to tick off, progress
     * frozen at zero, and no complaint, because the schedule is deliberately
     * never rebuilt. */
    const nextFrequency = input.frequency ?? existing.frequency;
    const nextInstallment = input.installmentMinor ?? minorToNumber(existing.installmentMinor);
    if (nextInstallment > 0 && Math.floor(termMonths / MONTHS_PER_PERIOD[nextFrequency]) === 0) {
      throw new BadRequestException(
        'এই মেয়াদে একটিও কিস্তি পড়ে না — মেয়াদ বাড়ান অথবা কিস্তির হার বদলান',
      );
    }

    await this.prisma.savingsPlan.update({
      where: { id: existing.id },
      data: {
        planName: input.planName,
        institution: input.institution,
        planType: input.planType,
        installmentMinor:
          input.installmentMinor === undefined ? undefined : BigInt(input.installmentMinor),
        principalMinor:
          input.principalMinor === undefined ? undefined : BigInt(input.principalMinor),
        frequency: input.frequency,
        termMonths: input.termMonths,
        startDate: input.startDate ? fromLocalDateString(input.startDate, timezone) : undefined,
        maturityDate: maturityDate ? fromLocalDateString(maturityDate, timezone) : undefined,
        profitRateBps: input.profitRateBps,
        profitCalc: input.profitCalc,
        linkedAccountId: input.linkedAccountId,
        status: input.status,
        note: input.note,
      },
    });

    this.audit.emit({
      workspaceId,
      actorUserId,
      action: 'savings.plan_updated',
      entity: 'SavingsPlan',
      entityId: existing.id,
      before: { planName: existing.planName, status: existing.status },
      after: {
        planName: input.planName ?? existing.planName,
        status: input.status ?? existing.status,
      },
    });

    return this.findOne(workspaceId, existing.id, timezone);
  }

  async payInstallment(
    workspaceId: string,
    actorUserId: string,
    planId: string,
    installmentId: string,
    input: PayInstallmentInput,
    timezone: string,
  ): Promise<SavingsPlanDetail> {
    const plan = await this.requirePlan(workspaceId, planId);

    // Scoped by workspace *and* plan: an id borrowed from another plan must be
    // as invisible as one borrowed from another workspace.
    const installment = await this.prisma.savingsInstallment.findFirst({
      where: { id: installmentId, planId: plan.id, workspaceId },
    });
    if (!installment) throw new NotFoundException('কিস্তি পাওয়া যায়নি');
    if (installment.status === 'PAID') {
      throw new BadRequestException('এই কিস্তি আগেই পরিশোধ করা হয়েছে');
    }
    if (input.transactionId) await this.assertTransaction(workspaceId, input.transactionId);

    const paidDate = input.paidDate
      ? fromLocalDateString(input.paidDate, timezone)
      : fromLocalDateString(toLocalDateString(new Date(), timezone), timezone);

    await this.prisma.savingsInstallment.update({
      where: { id: installment.id },
      data: { status: 'PAID', paidDate, transactionId: input.transactionId ?? undefined },
    });

    this.audit.emit({
      workspaceId,
      actorUserId,
      action: 'savings.installment_paid' as never,
      entity: 'SavingsInstallment',
      entityId: installment.id,
      before: { status: installment.status },
      after: {
        status: 'PAID',
        planId: plan.id,
        expectedMinor: minorToNumber(installment.expectedMinor),
        paidDate: toLocalDateString(paidDate, timezone),
      },
    });

    return this.findOne(workspaceId, plan.id, timezone);
  }

  /**
   * Profit arrived. Book it as income and remember which instrument paid it.
   *
   * ## Why this is a button and not "just add a transaction"
   *
   * A Sanchayapatra pays out every month or quarter into an ordinary bank
   * account. Recorded by hand that is an income row like any other, and the
   * ledger ends up knowing that ৳2,400 arrived in June while having no way to
   * say which of four certificates produced it. "How much did this one earn me
   * this year" is then unanswerable — which is the question somebody holding
   * four of them actually has.
   *
   * So the row is booked with `savingsPlanId` set, and the yearly total falls
   * out of a filter rather than out of arithmetic somebody does on paper.
   *
   * ## The accounting
   *
   * Interest income is income (IFRS 9). It is *not* a transfer, and this is the
   * distinction the whole feature turns on: money coming back out of a DPS at
   * maturity is mostly the depositor's own instalments returning — a transfer,
   * no income — and only the excess the bank added is earnings. Booking the
   * whole payout as income would inflate a year's income by the size of the
   * deposit and, worse, would carry into the tax worksheet.
   *
   * This method books only what the caller says is profit. The principal coming
   * home is an ordinary transfer the person makes between two accounts, and
   * nothing here pretends otherwise.
   *
   * ## The amount is theirs
   *
   * Never the projection. `projectSavings` says what the plan *should* yield;
   * the bank deducts source tax and excise duty and pays what it pays. The
   * figure booked is the one that landed, exactly as the renewal fee books what
   * was paid rather than what was estimated.
   */
  async recordProfit(
    ctx: TenantContext,
    id: string,
    input: { amountMinor: number; accountId: string; categoryId: string; date?: string },
  ): Promise<ProfitReceipt> {
    const plan = await this.requirePlan(ctx.workspaceId, id);
    const date = input.date ?? toLocalDateString(new Date(), ctx.timezone);

    const created = await this.transactions.create(ctx, {
      date,
      type: 'INCOME',
      amountMinor: input.amountMinor,
      accountId: input.accountId,
      categoryId: input.categoryId,
      /* The instrument's own name, so the row is recognisable in the khata a
         year later without opening anything. */
      description: `${plan.planName} — মুনাফা`,
      savingsPlanId: plan.id,
      source: 'MANUAL',
    });

    this.audit.emit({
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.id,
      action: 'savings.profit_recorded',
      entity: 'SavingsPlan',
      entityId: plan.id,
      after: { amountMinor: input.amountMinor, date, transactionId: created.id },
    });

    return {
      transactionId: created.id,
      amountMinor: input.amountMinor,
      date,
      totalProfitMinor: await this.profitTotal(ctx.workspaceId, plan.id),
    };
  }

  /**
   * Every poisha of profit this instrument has paid, ever.
   *
   * Summed from the ledger rather than from a running column on the plan: a
   * profit row can be edited or deleted like any other transaction, and a
   * denormalised total would drift the first time somebody corrected a typo.
   * Soft-deleted rows are excluded — a deleted transaction is money that did
   * not arrive.
   */
  async profitTotal(workspaceId: string, planId: string): Promise<number> {
    /* Summed off the ledger entries, because `Transaction` carries no amount —
       the money lives on its two legs and the row above them is only the story.
       An INCOME books DEBIT to the receiving account and CREDIT to the income
       nominal (`ledger.ts:182`), so the debit leg on a real account is what
       actually arrived. `systemKey: null` is what separates the two, and
       leaving it out would double every figure. */
    const rows = await this.prisma.ledgerEntry.aggregate({
      where: {
        workspaceId,
        direction: 'DEBIT',
        account: { systemKey: null },
        transaction: { savingsPlanId: planId, type: 'INCOME', deletedAt: null },
      },
      _sum: { amountMinor: true },
    });
    return minorToNumber(rows._sum.amountMinor ?? BigInt(0));
  }

  /**
   * The DPS matured: move the money home and close the plan.
   *
   * ## Why a transfer and not income
   *
   * What comes out of a matured DPS is mostly the depositor's own instalments
   * coming back. That is not earnings, it is the same money in a different
   * account, and booking it as income would inflate a year's income by the size
   * of the deposit and carry that error straight into the tax worksheet.
   *
   * The bank's share — the profit — is booked separately through
   * `recordProfit`, which is why that method exists and why this one refuses to
   * guess. Somebody who books the profit first and then transfers the total is
   * describing what actually happened; somebody who transfers the total and
   * calls it income is not.
   *
   * ## The amount is confirmed, never computed
   *
   * The caller sends the figure. The screen prefills it with the source
   * account's balance so that "empty it" is one tap, but the server does not
   * silently move whatever it happens to find: a balance read a moment before a
   * write is a race, and a transfer nobody typed a number for is a transfer
   * nobody checked.
   */
  async mature(
    ctx: TenantContext,
    id: string,
    input: { fromAccountId: string; toAccountId: string; amountMinor: number; date?: string },
  ): Promise<{ transactionId: string; status: SavingsStatus }> {
    const plan = await this.requirePlan(ctx.workspaceId, id);
    if (input.fromAccountId === input.toAccountId) {
      throw new BadRequestException('একই অ্যাকাউন্টে সরানো যায় না — অন্য একটি বেছে নিন');
    }

    const created = await this.transactions.create(ctx, {
      date: input.date ?? toLocalDateString(new Date(), ctx.timezone),
      type: 'TRANSFER',
      amountMinor: input.amountMinor,
      accountId: input.fromAccountId,
      counterAccountId: input.toAccountId,
      description: `${plan.planName} — মেয়াদপূর্তি`,
      savingsPlanId: plan.id,
      source: 'MANUAL',
    });

    /* MATURED, not CLOSED. The plan is finished but it is still the explanation
       for years of deposits and every profit row filed against it, and the
       yearly report has to keep finding it. */
    await this.prisma.savingsPlan.update({
      where: { id: plan.id },
      data: { status: 'MATURED' },
    });

    this.audit.emit({
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.id,
      action: 'savings.matured',
      entity: 'SavingsPlan',
      entityId: plan.id,
      before: { status: plan.status },
      after: { status: 'MATURED', amountMinor: input.amountMinor, transactionId: created.id },
    });

    return { transactionId: created.id, status: 'MATURED' };
  }

  /**
   * Soft delete. A closed DPS is still the explanation for years of deposits
   * leaving the bank account, so the rows stay readable behind `deletedAt`.
   */
  async remove(workspaceId: string, actorUserId: string, id: string): Promise<{ id: string }> {
    const existing = await this.requirePlan(workspaceId, id);

    await this.prisma.savingsPlan.update({
      where: { id: existing.id },
      data: { deletedAt: new Date() },
    });

    this.audit.emit({
      workspaceId,
      actorUserId,
      action: 'savings.plan_deleted',
      entity: 'SavingsPlan',
      entityId: existing.id,
      before: { planName: existing.planName, status: existing.status },
      after: { deleted: true },
    });

    return { id: existing.id };
  }

  private async requirePlan(workspaceId: string, id: string): Promise<PlanWithInstallments> {
    const plan = await this.prisma.savingsPlan.findFirst({
      where: { id, workspaceId, deletedAt: null },
      include: { installments: { orderBy: { dueDate: 'asc' } } },
    });
    if (!plan) throw new NotFoundException('সঞ্চয় পরিকল্পনা পাওয়া যায়নি');
    return plan;
  }

  private async assertAccount(workspaceId: string, accountId: string): Promise<void> {
    const account = await this.prisma.account.findFirst({
      where: { id: accountId, workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!account) throw new NotFoundException('অ্যাকাউন্ট পাওয়া যায়নি');
  }

  private async assertTransaction(workspaceId: string, transactionId: string): Promise<void> {
    const tx = await this.prisma.transaction.findFirst({
      where: { id: transactionId, workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!tx) throw new NotFoundException('লেনদেন পাওয়া যায়নি');
  }

  private static detail(plan: PlanWithInstallments, timezone: string): SavingsPlanDetail {
    const installments = SavingsService.presentInstallments(plan, timezone);
    return { ...SavingsService.presentPlan(plan, installments, timezone), installments };
  }

  private static summarise(plan: PlanWithInstallments, timezone: string): SavingsPlanView {
    return SavingsService.presentPlan(
      plan,
      SavingsService.presentInstallments(plan, timezone),
      timezone,
    );
  }

  private static presentInstallments(
    plan: PlanWithInstallments,
    timezone: string,
  ): SavingsInstallmentView[] {
    return plan.installments.map((row, i) => ({
      id: row.id,
      index: i + 1,
      dueDate: toLocalDateString(row.dueDate, timezone),
      expectedMinor: minorToNumber(row.expectedMinor),
      paidDate: row.paidDate ? toLocalDateString(row.paidDate, timezone) : null,
      status: row.status,
      transactionId: row.transactionId,
    }));
  }

  private static presentPlan(
    plan: SavingsPlan,
    installments: SavingsInstallmentView[],
    timezone: string,
  ): SavingsPlanView {
    return {
      /* Zero here, and overwritten by `list` and `findOne` with the real
         figure. This is a pure function over one plan row and profit is a
         question for the ledger, so it cannot be answered at this level —
         but leaving the field off the type would let a caller forget it. */
      profitReceivedMinor: 0,
      id: plan.id,
      planName: plan.planName,
      institution: plan.institution,
      planType: plan.planType,
      installmentMinor: minorToNumber(plan.installmentMinor),
      principalMinor: minorToNumber(plan.principalMinor),
      frequency: plan.frequency,
      termMonths: plan.termMonths,
      startDate: toLocalDateString(plan.startDate, timezone),
      maturityDate: plan.maturityDate ? toLocalDateString(plan.maturityDate, timezone) : null,
      profitRateBps: plan.profitRateBps,
      profitCalc: plan.profitCalc,
      linkedAccountId: plan.linkedAccountId,
      status: plan.status,
      note: plan.note,
      projection: projectSavings({
        installmentMinor: minorToNumber(plan.installmentMinor),
        principalMinor: minorToNumber(plan.principalMinor),
        frequency: plan.frequency,
        termMonths: plan.termMonths,
        profitRateBps: plan.profitRateBps,
        profitCalc: plan.profitCalc,
      }),
      progress: summariseProgress(installments),
      /* A missed instalment is still owed, so it is what comes next. Skipping
       * past it would point the saver at a later date and quietly drop the
       * payment they actually have to make. */
      nextDueDate:
        installments.find((row) => row.status === 'DUE' || row.status === 'MISSED')?.dueDate ??
        null,
    };
  }
}
