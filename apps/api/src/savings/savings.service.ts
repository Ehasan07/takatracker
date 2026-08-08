import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  buildInstalmentSchedule,
  clampDayToMonth,
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
}

export interface SavingsPlanDetail extends SavingsPlanView {
  installments: SavingsInstallmentView[];
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
  ) {}

  async list(workspaceId: string, timezone: string): Promise<SavingsPlanView[]> {
    const plans = await this.prisma.savingsPlan.findMany({
      where: { workspaceId, deletedAt: null },
      orderBy: [{ status: 'asc' }, { startDate: 'desc' }],
      include: { installments: { orderBy: { dueDate: 'asc' } } },
    });

    // The schedule rows are loaded because progress cannot be summarised
    // without them, but they are not shipped: a list of ten DPS plans would
    // otherwise carry a thousand instalments to draw ten progress rings.
    return plans.map((plan) => SavingsService.summarise(plan, timezone));
  }

  async findOne(workspaceId: string, id: string, timezone: string): Promise<SavingsPlanDetail> {
    return SavingsService.detail(await this.requirePlan(workspaceId, id), timezone);
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
