import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { MONTHS_PER_PERIOD, clampDayToMonth } from '@hishab/core';
import { fromLocalDateString, sumMinor, toLocalDateString } from '@hishab/shared';
import type {
  InstalmentStatus,
  InsurancePolicy,
  PlanFrequency,
  PolicyStatus,
  PremiumPayment,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { minorToNumber } from '../common/bigint-json';
import { PrismaService } from '../prisma/prisma.service';
import type { CreatePolicyInput, PayPremiumInput, UpdatePolicyInput } from './insurance.controller';

export interface PremiumPaymentView {
  id: string;
  /** 1-based position in the schedule, so the UI can say "৩য় প্রিমিয়াম". */
  index: number;
  dueDate: string;
  amountMinor: number;
  paidDate: string | null;
  status: InstalmentStatus;
  transactionId: string | null;
}

export interface InsurancePolicyView {
  id: string;
  insurer: string;
  policyNumberMasked: string | null;
  policyType: string | null;
  sumAssuredMinor: number;
  premiumMinor: number;
  frequency: PlanFrequency;
  startDate: string;
  maturityDate: string | null;
  nomineeName: string | null;
  status: PolicyStatus;
  note: string | null;
  premiumCount: number;
  paidCount: number;
  paidMinor: number;
  /** The premium the policyholder owes next. Null once the term is settled. */
  nextDue: PremiumPaymentView | null;
}

export interface InsurancePolicyDetail extends InsurancePolicyView {
  premiums: PremiumPaymentView[];
}

const pad = (value: number, width: number): string => String(value).padStart(width, '0');

/**
 * Month arithmetic on the local calendar date. A policy taken out on the 31st
 * falls due on the 30th in a short month rather than spilling into the next
 * one, which would walk the whole schedule forward a day at a time.
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

/** Whole months from one local date to another; a part-month does not count. */
function monthsBetween(from: string, to: string): number {
  const months =
    (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 +
    (Number(to.slice(5, 7)) - Number(from.slice(5, 7)));
  return Number(to.slice(8, 10)) < Number(from.slice(8, 10)) ? months - 1 : months;
}

type PolicyWithPremiums = InsurancePolicy & { premiums: PremiumPayment[] };

@Injectable()
export class InsuranceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(workspaceId: string, timezone: string): Promise<InsurancePolicyView[]> {
    const policies = await this.prisma.insurancePolicy.findMany({
      where: { workspaceId, deletedAt: null },
      orderBy: [{ status: 'asc' }, { startDate: 'desc' }],
      include: { premiums: { orderBy: { dueDate: 'asc' } } },
    });

    // The schedule is loaded to find the next due date and is then dropped:
    // a list only needs the one row the user is about to be reminded about.
    return policies.map((policy) => InsuranceService.summarise(policy, timezone));
  }

  async findOne(workspaceId: string, id: string, timezone: string): Promise<InsurancePolicyDetail> {
    return InsuranceService.detail(await this.requirePolicy(workspaceId, id), timezone);
  }

  async create(
    workspaceId: string,
    actorUserId: string,
    input: CreatePolicyInput,
    timezone: string,
  ): Promise<InsurancePolicyDetail> {
    const termMonths = InsuranceService.resolveTerm(input);
    const maturityDate = input.maturityDate ?? addMonths(input.startDate, termMonths);
    if (maturityDate <= input.startDate) {
      throw new BadRequestException('মেয়াদপূর্তির তারিখ শুরুর তারিখের পরে হতে হবে');
    }

    const monthsPerPeriod = MONTHS_PER_PERIOD[input.frequency];
    // A policy recorded only to track its sum assured has no premium schedule
    // to keep, so it gets no rows rather than a term's worth of zero-taka dues.
    const count = input.premiumMinor > 0 ? Math.floor(termMonths / monthsPerPeriod) : 0;

    const created = await this.prisma.insurancePolicy.create({
      data: {
        workspaceId,
        insurer: input.insurer,
        policyNumberMasked: input.policyNumberMasked,
        policyType: input.policyType,
        sumAssuredMinor: BigInt(input.sumAssuredMinor),
        premiumMinor: BigInt(input.premiumMinor),
        frequency: input.frequency,
        startDate: fromLocalDateString(input.startDate, timezone),
        maturityDate: fromLocalDateString(maturityDate, timezone),
        nomineeName: input.nomineeName,
        note: input.note,
        premiums: {
          create: Array.from({ length: count }, (_, i) => ({
            workspaceId,
            dueDate: fromLocalDateString(addMonths(input.startDate, i * monthsPerPeriod), timezone),
            amountMinor: BigInt(input.premiumMinor),
          })),
        },
      },
      include: { premiums: { orderBy: { dueDate: 'asc' } } },
    });

    this.audit.emit({
      workspaceId,
      actorUserId,
      // Not in the AUDIT_ACTIONS union yet; the cast keeps the emitted string
      // honest until it is added there.
      action: 'insurance.policy_created' as never,
      entity: 'InsurancePolicy',
      entityId: created.id,
      after: { insurer: created.insurer, termMonths, premiums: count },
    });

    return InsuranceService.detail(created, timezone);
  }

  /**
   * Field edits only. The premium rows already on disk record which years were
   * actually paid, so a corrected term or frequency changes the policy without
   * rewriting that history.
   */
  async update(
    workspaceId: string,
    actorUserId: string,
    id: string,
    input: UpdatePolicyInput,
    timezone: string,
  ): Promise<InsurancePolicyDetail> {
    const existing = await this.requirePolicy(workspaceId, id);

    const existingStart = toLocalDateString(existing.startDate, timezone);
    const existingMaturity = maturityOf(existing, timezone);
    const startDate = input.startDate ?? existingStart;

    /* Maturity moves only when the caller says so — directly, by giving a new
     * term, or by moving the start, which carries the original term with it.
     * A date copied off the policy document survives every unrelated edit. */
    let maturityDate: string | undefined;
    if (input.maturityDate) {
      maturityDate = input.maturityDate;
    } else if (input.termMonths !== undefined) {
      maturityDate = addMonths(startDate, input.termMonths);
    } else if (input.startDate && existingMaturity) {
      maturityDate = addMonths(startDate, monthsBetween(existingStart, existingMaturity));
    }

    if (maturityDate !== undefined && maturityDate <= startDate) {
      throw new BadRequestException('মেয়াদপূর্তির তারিখ শুরুর তারিখের পরে হতে হবে');
    }

    await this.prisma.insurancePolicy.update({
      where: { id: existing.id },
      data: {
        insurer: input.insurer,
        policyNumberMasked: input.policyNumberMasked,
        policyType: input.policyType,
        sumAssuredMinor:
          input.sumAssuredMinor === undefined ? undefined : BigInt(input.sumAssuredMinor),
        premiumMinor: input.premiumMinor === undefined ? undefined : BigInt(input.premiumMinor),
        frequency: input.frequency,
        startDate: input.startDate ? fromLocalDateString(input.startDate, timezone) : undefined,
        maturityDate: maturityDate ? fromLocalDateString(maturityDate, timezone) : undefined,
        nomineeName: input.nomineeName,
        status: input.status,
        note: input.note,
      },
    });

    this.audit.emit({
      workspaceId,
      actorUserId,
      action: 'insurance.policy_updated',
      entity: 'InsurancePolicy',
      entityId: existing.id,
      before: { insurer: existing.insurer, status: existing.status },
      after: {
        insurer: input.insurer ?? existing.insurer,
        status: input.status ?? existing.status,
      },
    });

    return this.findOne(workspaceId, existing.id, timezone);
  }

  async payPremium(
    workspaceId: string,
    actorUserId: string,
    policyId: string,
    premiumId: string,
    input: PayPremiumInput,
    timezone: string,
  ): Promise<InsurancePolicyDetail> {
    const policy = await this.requirePolicy(workspaceId, policyId);

    // Scoped by workspace *and* policy: an id borrowed from another policy has
    // to be as invisible as one borrowed from another workspace.
    const premium = await this.prisma.premiumPayment.findFirst({
      where: { id: premiumId, policyId: policy.id, workspaceId },
    });
    if (!premium) throw new NotFoundException('প্রিমিয়াম পাওয়া যায়নি');
    if (premium.status === 'PAID') {
      throw new BadRequestException('এই প্রিমিয়াম আগেই পরিশোধ করা হয়েছে');
    }
    if (input.transactionId) await this.assertTransaction(workspaceId, input.transactionId);

    const paidDate = input.paidDate
      ? fromLocalDateString(input.paidDate, timezone)
      : fromLocalDateString(toLocalDateString(new Date(), timezone), timezone);

    await this.prisma.premiumPayment.update({
      where: { id: premium.id },
      data: {
        status: 'PAID',
        paidDate,
        // A premium paid short or late is still recorded at what was actually
        // handed over, not at what the schedule expected.
        amountMinor: input.amountMinor === undefined ? undefined : BigInt(input.amountMinor),
        transactionId: input.transactionId ?? undefined,
      },
    });

    this.audit.emit({
      workspaceId,
      actorUserId,
      action: 'insurance.premium_paid' as never,
      entity: 'PremiumPayment',
      entityId: premium.id,
      before: { status: premium.status },
      after: {
        status: 'PAID',
        policyId: policy.id,
        amountMinor: input.amountMinor ?? minorToNumber(premium.amountMinor),
        paidDate: toLocalDateString(paidDate, timezone),
      },
    });

    return this.findOne(workspaceId, policy.id, timezone);
  }

  /**
   * Soft delete. A lapsed policy is still the explanation for years of premium
   * payments leaving the bank account, so the rows stay behind `deletedAt`.
   */
  async remove(workspaceId: string, actorUserId: string, id: string): Promise<{ id: string }> {
    const existing = await this.requirePolicy(workspaceId, id);

    await this.prisma.insurancePolicy.update({
      where: { id: existing.id },
      data: { deletedAt: new Date() },
    });

    this.audit.emit({
      workspaceId,
      actorUserId,
      action: 'insurance.policy_deleted',
      entity: 'InsurancePolicy',
      entityId: existing.id,
      before: { insurer: existing.insurer, status: existing.status },
      after: { deleted: true },
    });

    return { id: existing.id };
  }

  /**
   * The term is not a column — the schema stores start and maturity — so a
   * caller gives either, and the two must agree on how many premiums exist.
   */
  private static resolveTerm(input: CreatePolicyInput): number {
    /* The maturity date is the fact on the policy document; a term in months is
     * the convenient way to type it. When both arrive, the date wins and the
     * term is derived from it — otherwise a policy maturing in 2030 could be
     * given premiums scheduled out to 2046, and both figures would be shown as
     * if they agreed. */
    if (input.maturityDate) return monthsBetween(input.startDate, input.maturityDate);
    if (input.termMonths !== undefined) return input.termMonths;
    if (!input.maturityDate) {
      throw new BadRequestException('মেয়াদ (মাস) অথবা মেয়াদপূর্তির তারিখ — একটি দিতে হবে');
    }
    const months = monthsBetween(input.startDate, input.maturityDate);
    if (months < 1) throw new BadRequestException('মেয়াদ অন্তত এক মাস হতে হবে');
    return months;
  }

  private async requirePolicy(workspaceId: string, id: string): Promise<PolicyWithPremiums> {
    const policy = await this.prisma.insurancePolicy.findFirst({
      where: { id, workspaceId, deletedAt: null },
      include: { premiums: { orderBy: { dueDate: 'asc' } } },
    });
    if (!policy) throw new NotFoundException('বীমা পলিসি পাওয়া যায়নি');
    return policy;
  }

  private async assertTransaction(workspaceId: string, transactionId: string): Promise<void> {
    const tx = await this.prisma.transaction.findFirst({
      where: { id: transactionId, workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!tx) throw new NotFoundException('লেনদেন পাওয়া যায়নি');
  }

  private static detail(policy: PolicyWithPremiums, timezone: string): InsurancePolicyDetail {
    const premiums = InsuranceService.presentPremiums(policy, timezone);
    return { ...InsuranceService.presentPolicy(policy, premiums, timezone), premiums };
  }

  private static summarise(policy: PolicyWithPremiums, timezone: string): InsurancePolicyView {
    return InsuranceService.presentPolicy(
      policy,
      InsuranceService.presentPremiums(policy, timezone),
      timezone,
    );
  }

  private static presentPremiums(
    policy: PolicyWithPremiums,
    timezone: string,
  ): PremiumPaymentView[] {
    return policy.premiums.map((row, i) => ({
      id: row.id,
      index: i + 1,
      dueDate: toLocalDateString(row.dueDate, timezone),
      amountMinor: minorToNumber(row.amountMinor),
      paidDate: row.paidDate ? toLocalDateString(row.paidDate, timezone) : null,
      status: row.status,
      transactionId: row.transactionId,
    }));
  }

  private static presentPolicy(
    policy: InsurancePolicy,
    premiums: PremiumPaymentView[],
    timezone: string,
  ): InsurancePolicyView {
    const paid = premiums.filter((row) => row.status === 'PAID');

    return {
      id: policy.id,
      insurer: policy.insurer,
      policyNumberMasked: policy.policyNumberMasked,
      policyType: policy.policyType,
      sumAssuredMinor: minorToNumber(policy.sumAssuredMinor),
      premiumMinor: minorToNumber(policy.premiumMinor),
      frequency: policy.frequency,
      startDate: toLocalDateString(policy.startDate, timezone),
      maturityDate: maturityOf(policy, timezone),
      nomineeName: policy.nomineeName,
      status: policy.status,
      note: policy.note,
      premiumCount: premiums.length,
      paidCount: paid.length,
      paidMinor: sumMinor(paid.map((row) => row.amountMinor)),
      // A missed premium is still owed, so it stays the "next" one until it is
      // either paid or explicitly skipped.
      nextDue: premiums.find((row) => row.status === 'DUE' || row.status === 'MISSED') ?? null,
    };
  }
}

function maturityOf(policy: InsurancePolicy, timezone: string): string | null {
  return policy.maturityDate ? toLocalDateString(policy.maturityDate, timezone) : null;
}
