import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
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
   *
   * Summed by `savingsPlanId`, so it counts an ordinary income row somebody
   * filed against this certificate from the khata exactly as it counts one
   * recorded from the savings screen. There is no second place to keep in step.
   */
  profitReceivedMinor: number;
  /**
   * When this instrument actually hands the profit over.
   *
   * The distinction matters more than it looks. A **Sanchayapatra** credits a
   * bank account every month or quarter, so "মুনাফা পেয়েছি" is a thing that
   * genuinely happens forty-eight times over its life. A **DPS pays nothing at
   * all before maturity** — principal and profit arrive together at the end —
   * and a screen that offered to record profit received on a running DPS would
   * be inviting somebody to book income that has neither been earned nor
   * received. That overstates the year and carries into the tax worksheet,
   * which is the kind of wrong that costs money.
   *
   * So the instrument says which it is, once, here — rather than five screens
   * each deciding from `planType` and drifting apart.
   */
  profitPayout: ProfitPayout;
  /**
   * What the plan's own rate says has built up so far, and has **not** been
   * received.
   *
   * Derived, never posted. `projectSavings` recomputed over the months elapsed
   * rather than the whole term: the first year of a five-year DPS has earned
   * roughly a year's profit on roughly a year's deposits, and saying so is what
   * lets somebody see a running DPS growing without being handed a button that
   * books income.
   *
   * It is an estimate off the advertised rate, and it is gross — the same two
   * caveats `projection` carries, for the same reasons. Nothing anywhere adds
   * it to a balance, an income statement or a tax worksheet, because under this
   * ledger's cash basis unreceived profit is not income and not an asset.
   */
  accruedProfitMinor: number;
}

/**
 * `PERIODIC` — the money lands in a bank account as it goes (Sanchayapatra).
 * `AT_MATURITY` — nothing arrives until the end (DPS, FDR, and the rest).
 */
export type ProfitPayout = 'PERIODIC' | 'AT_MATURITY';

/**
 * Which instruments actually pay out before they mature.
 *
 * Only the Sanchayapatra, and deliberately only by `planType` rather than by
 * anything cleverer. `frequency` on a plan is the *instalment* rhythm — how
 * often the saver pays in — and reading it as a payout rhythm is exactly the
 * guess that would put a "profit received" button back on a monthly DPS.
 */
const PERIODIC_PAYOUT_TYPES: ReadonlySet<SavingsPlanType> = new Set(['SANCHAYPATRA']);

export interface SavingsPlanDetail extends SavingsPlanView {
  installments: SavingsInstallmentView[];
}

/**
 * What became of the instalment's money.
 *
 * Always reported, never inferred from a status code, because the two halves of
 * "জমা দিলাম" can disagree: the instalment is marked paid whatever happens to
 * the ledger, so a 200 alone cannot tell a screen whether the transfer was
 * written. `null` means none was asked for — the behaviour this endpoint has
 * always had — and `booked: false` carries the reason in Bengali, ready to
 * show. The same shape, and the same reasoning, as `RenewalsService`'s fee.
 */
export interface DepositOutcome {
  booked: boolean;
  transactionId: string | null;
  /** What actually moved, in poisha. Null when nothing did. */
  amountMinor: number | null;
  message: string | null;
}

/** The plan as it now stands, plus what happened to the money. */
export interface PaidInstallmentView extends SavingsPlanDetail {
  /** `null` when no account was named — the status moved, the books did not. */
  deposit: DepositOutcome | null;
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

/**
 * Whole months from one local date to another, never negative.
 *
 * Whole, because a fortnight into the first month a DPS has earned nothing a
 * bank would credit: the day-of-month check is what stops "১ মাস জমেছে"
 * appearing the day after a plan is opened. The same convention `addMonths`
 * above follows, read backwards.
 */
function monthsElapsed(fromIso: string, toIso: string): number {
  const months =
    (Number(toIso.slice(0, 4)) - Number(fromIso.slice(0, 4))) * 12 +
    (Number(toIso.slice(5, 7)) - Number(fromIso.slice(5, 7)));
  const partial = Number(toIso.slice(8, 10)) < Number(fromIso.slice(8, 10)) ? 1 : 0;
  return Math.max(0, months - partial);
}

type PlanWithInstallments = SavingsPlan & { installments: SavingsInstallment[] };

@Injectable()
export class SavingsService {
  private readonly logger = new Logger(SavingsService.name);

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

    /* One "today" for the whole list. Ten plans read from ten `new Date()`
       calls could straddle midnight and answer with two different accruals in
       one response. */
    const today = toLocalDateString(new Date(), timezone);

    // The schedule rows are loaded because progress cannot be summarised
    // without them, but they are not shipped: a list of ten DPS plans would
    // otherwise carry a thousand instalments to draw ten progress rings.
    return plans.map((plan) => ({
      ...SavingsService.summarise(plan, timezone, today),
      profitReceivedMinor: profit.get(plan.id) ?? 0,
    }));
  }

  async findOne(workspaceId: string, id: string, timezone: string): Promise<SavingsPlanDetail> {
    const plan = await this.requirePlan(workspaceId, id);
    return {
      ...SavingsService.detail(plan, timezone, toLocalDateString(new Date(), timezone)),
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
    if (input.linkedAccountId) await this.assertSavingsAccount(workspaceId, input.linkedAccountId);

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

    return SavingsService.detail(created, timezone, toLocalDateString(new Date(), timezone));
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
    if (input.linkedAccountId) await this.assertSavingsAccount(workspaceId, input.linkedAccountId);

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

  /**
   * "জমা দিলাম" — the instalment is paid, and the money can go with it.
   *
   * ## The mistake this exists to stop
   *
   * A DPS instalment is **not an expense**. Nothing is consumed and nobody is
   * owed: ৳2,000 leaves the current account and arrives in the savings account,
   * one asset becoming another. Booked as an expense it understates net worth
   * by every poisha ever saved and overstates that month's spending by the
   * instalment — wrong in both directions at once, and wrong in the direction
   * that makes somebody think they are doing worse than they are.
   *
   * So when money moves here it moves as a `TRANSFER`, through
   * `TransactionsService.create` like every other row this module writes, which
   * is what gets the double-entry expansion, the ownership checks and the
   * entitlement meter without any of them being reimplemented.
   *
   * ## Optional means optional
   *
   * Marking an instalment paid touched no ledger for as long as this endpoint
   * has existed, and it still does not unless the caller names an account for
   * the money to leave. There is no inference from the plan's link alone: a
   * linked plan whose instalment is marked paid with no `fromAccountId` behaves
   * exactly as it did yesterday. The link makes the offer possible; the caller
   * accepts it.
   *
   * ## The status first, the money second
   *
   * In that order, the same as `RenewalsService.complete`, and for the same
   * reason. A plan ceiling, an account archived between the screen loading and
   * the button being pressed — any of them fails the transfer, and none of them
   * is a reason to lose the fact that the instalment was paid. The failure comes
   * back as a `deposit` the screen can report, not as an error that undoes the
   * tick. The reverse order would leave a transfer booked against an instalment
   * still showing as owed.
   */
  async payInstallment(
    ctx: TenantContext,
    planId: string,
    installmentId: string,
    input: PayInstallmentInput,
  ): Promise<PaidInstallmentView> {
    const { workspaceId, timezone } = ctx;
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

    /* Refused before anything is written, because both of these are somebody
       asking for a transfer that cannot exist — not a bookkeeping failure to be
       reported afterwards. Silently ignoring the account they named would mark
       the instalment paid and leave them believing the money moved. */
    if (input.fromAccountId) {
      if (!plan.linkedAccountId) {
        throw new BadRequestException(
          'এই সঞ্চয়ের সঙ্গে কোনো সঞ্চয় হিসাব যুক্ত নেই — আগে সম্পাদনা করে একটি বেছে নিন',
        );
      }
      if (input.fromAccountId === plan.linkedAccountId) {
        throw new BadRequestException('একই অ্যাকাউন্টে সরানো যায় না — অন্য একটি বেছে নিন');
      }
    }

    const paidOn = input.paidDate ?? toLocalDateString(new Date(), timezone);
    const paidDate = fromLocalDateString(paidOn, timezone);

    await this.prisma.savingsInstallment.update({
      where: { id: installment.id },
      data: { status: 'PAID', paidDate, transactionId: input.transactionId ?? undefined },
    });

    const deposit =
      input.fromAccountId && plan.linkedAccountId
        ? await this.bookDeposit(ctx, plan, {
            fromAccountId: input.fromAccountId,
            toAccountId: plan.linkedAccountId,
            /* The schedule's figure unless the caller overrode it. A late
               instalment collects a penalty and a bank sometimes takes the
               excise duty out of the same debit, so what gets booked is what
               the statement says — never what the schedule hoped for. */
            amountMinor: input.amountMinor ?? minorToNumber(installment.expectedMinor),
            date: paidOn,
          })
        : null;

    /* The transaction id lands on the instalment row, which is what the column
       has been there for since the schema was written: the tick and the money
       that backs it are one fact, and a screen showing "জমা হয়েছে" should be
       able to reach the ledger row without searching for it. */
    if (deposit?.transactionId) {
      await this.prisma.savingsInstallment.update({
        where: { id: installment.id },
        data: { transactionId: deposit.transactionId },
      });
    }

    this.audit.emit({
      workspaceId,
      actorUserId: ctx.id,
      action: 'savings.installment_paid' as never,
      entity: 'SavingsInstallment',
      entityId: installment.id,
      before: { status: installment.status },
      after: {
        status: 'PAID',
        planId: plan.id,
        expectedMinor: minorToNumber(installment.expectedMinor),
        paidDate: paidOn,
        /* On the same line as the tick, because "was this instalment actually
           paid out of the bank?" is one question and two audit rows somebody
           has to correlate is not an answer. */
        depositTransactionId: deposit?.transactionId ?? null,
      },
    });

    return { ...(await this.findOne(workspaceId, plan.id, timezone)), deposit };
  }

  /**
   * Move the instalment from the account it left into the plan's own account.
   *
   * A `TRANSFER`, and the only kind of row this may ever write. Every argument
   * for it is in `payInstallment` above; what belongs here is the reason nothing
   * thrown escapes: the instalment is already marked paid by the time this runs,
   * and turning a ledger refusal into a 402 would tell somebody their deposit
   * did not go through when the schedule says it did.
   */
  private async bookDeposit(
    ctx: TenantContext,
    plan: SavingsPlan,
    move: { fromAccountId: string; toAccountId: string; amountMinor: number; date: string },
  ): Promise<DepositOutcome> {
    try {
      const created = await this.transactions.create(ctx, {
        date: move.date,
        type: 'TRANSFER',
        amountMinor: move.amountMinor,
        accountId: move.fromAccountId,
        counterAccountId: move.toAccountId,
        /* The instrument's own name, so the row is recognisable in the khata a
           year later without opening anything. */
        description: `${plan.planName} — কিস্তি`,
        savingsPlanId: plan.id,
        source: 'MANUAL',
      });
      return {
        booked: true,
        transactionId: created.id,
        amountMinor: move.amountMinor,
        message: null,
      };
    } catch (err) {
      /* Logged, because the person is shown one sentence and somebody will
         eventually have to know which of the several refusals it was. */
      this.logger.warn(
        `Savings instalment not booked for workspace ${ctx.workspaceId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return {
        booked: false,
        transactionId: null,
        amountMinor: null,
        message: depositFailureMessage(err),
      };
    }
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
   * ## When it may honestly be called, and who decides
   *
   * Only when profit has actually been *received*. On a Sanchayapatra that is
   * every month or quarter; on a **DPS it is only at maturity**, because a DPS
   * pays nothing at all before then — principal and profit arrive together at
   * the end. Booking "profit received" on a running DPS would file income that
   * has neither been earned nor received, overstating the year and carrying
   * into the tax worksheet.
   *
   * That judgement is made by the screen, which knows the plan's type, its
   * status and whether its maturity date has passed — `profitPayout` on the
   * view exists to make it. It is deliberately **not** enforced here. A bank
   * that credits a DPS's profit yearly, a plan closed early with the profit
   * paid out, a person catching up a year of backdated payouts: all are real,
   * all are somebody telling us money arrived, and a server that refused them
   * would be overruling the only person who can see the passbook.
   *
   * The ordinary income sheet in the khata now carries a "কোন সঞ্চয় থেকে"
   * picker writing the same `savingsPlanId`, and that is the primary route.
   * This endpoint is the shortcut from the instrument's own screen; both land
   * in `profitTotal`, which sums by plan id and cannot tell them apart.
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

  /**
   * The account a plan may be linked to: this workspace's, real, and a savings
   * account.
   *
   * The type check is the point. A link is what lets an instalment be booked as
   * a transfer *into* somewhere, and the only somewhere that makes sense is the
   * account the bank actually holds the DPS in — `buildBalanceSheet` classifies
   * `SAVINGS` as money the household owns, which is exactly what the deposits
   * should become. Pointing the link at the current account instead would let
   * somebody book a transfer from an account into itself, or quietly move money
   * sideways month after month and wonder why nothing accumulated.
   *
   * `systemKey: null` for the reason every other write path checks it: the
   * nominal accounts that make the double entry balance are not somebody's
   * savings, and `TransactionsService.create` would refuse one anyway.
   */
  private async assertSavingsAccount(workspaceId: string, accountId: string): Promise<void> {
    const account = await this.prisma.account.findFirst({
      where: { id: accountId, workspaceId, deletedAt: null, systemKey: null },
      select: { id: true, type: true },
    });
    if (!account) throw new NotFoundException('অ্যাকাউন্ট পাওয়া যায়নি');
    if (account.type !== 'SAVINGS') {
      throw new BadRequestException(
        'সঞ্চয়ের টাকা যে হিসাবে জমা হয় সেটি বেছে নিন — “সঞ্চয়ী” ধরনের একটি অ্যাকাউন্ট',
      );
    }
  }

  private async assertTransaction(workspaceId: string, transactionId: string): Promise<void> {
    const tx = await this.prisma.transaction.findFirst({
      where: { id: transactionId, workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!tx) throw new NotFoundException('লেনদেন পাওয়া যায়নি');
  }

  private static detail(
    plan: PlanWithInstallments,
    timezone: string,
    today: string,
  ): SavingsPlanDetail {
    const installments = SavingsService.presentInstallments(plan, timezone);
    return {
      ...SavingsService.presentPlan(plan, installments, timezone, today),
      installments,
    };
  }

  private static summarise(
    plan: PlanWithInstallments,
    timezone: string,
    today: string,
  ): SavingsPlanView {
    return SavingsService.presentPlan(
      plan,
      SavingsService.presentInstallments(plan, timezone),
      timezone,
      today,
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
    today: string,
  ): SavingsPlanView {
    const startDate = toLocalDateString(plan.startDate, timezone);
    const input = {
      installmentMinor: minorToNumber(plan.installmentMinor),
      principalMinor: minorToNumber(plan.principalMinor),
      frequency: plan.frequency,
      profitRateBps: plan.profitRateBps,
      profitCalc: plan.profitCalc,
    };

    /* The same projection, over the months that have actually gone by rather
       than the whole term. A five-year DPS eighteen months in has earned
       roughly eighteen months of profit on eighteen months of instalments, and
       `projectSavings` already knows how to say that — it is handed a shorter
       term, nothing more. Capped at the term so a plan somebody forgot to close
       does not keep growing for ever. */
    const elapsedMonths = Math.min(monthsElapsed(startDate, today), plan.termMonths);

    return {
      /* Zero here, and overwritten by `list` and `findOne` with the real
         figure. This is a pure function over one plan row and profit is a
         question for the ledger, so it cannot be answered at this level —
         but leaving the field off the type would let a caller forget it. */
      profitReceivedMinor: 0,
      profitPayout: PERIODIC_PAYOUT_TYPES.has(plan.planType) ? 'PERIODIC' : 'AT_MATURITY',
      accruedProfitMinor: projectSavings({ ...input, termMonths: elapsedMonths }).profitMinor,
      id: plan.id,
      planName: plan.planName,
      institution: plan.institution,
      planType: plan.planType,
      installmentMinor: minorToNumber(plan.installmentMinor),
      principalMinor: minorToNumber(plan.principalMinor),
      frequency: plan.frequency,
      termMonths: plan.termMonths,
      startDate,
      maturityDate: plan.maturityDate ? toLocalDateString(plan.maturityDate, timezone) : null,
      profitRateBps: plan.profitRateBps,
      profitCalc: plan.profitCalc,
      linkedAccountId: plan.linkedAccountId,
      status: plan.status,
      note: plan.note,
      projection: projectSavings({ ...input, termMonths: plan.termMonths }),
      /* The dates matter only for a lump sum — an FDR or a Sanchayapatra has no
         instalments to count, so its progress is the calendar. See
         `summariseProgress`. */
      progress: summariseProgress(installments, {
        startDate: plan.startDate,
        maturityDate: plan.maturityDate,
      }),
      /* A missed instalment is still owed, so it is what comes next. Skipping
       * past it would point the saver at a later date and quietly drop the
       * payment they actually have to make. */
      nextDueDate:
        installments.find((row) => row.status === 'DUE' || row.status === 'MISSED')?.dueDate ??
        null,
    };
  }
}

/**
 * Why the instalment's money did not get moved, in the language the screen is
 * in.
 *
 * Every refusal the ledger raises — an account that was archived, a workspace
 * at its monthly transaction ceiling — is already a Bengali sentence on the
 * exception, so it is passed through rather than replaced with something
 * vaguer. Anything that is not an `HttpException` is a fault nobody has phrased
 * for a reader, and the person gets the one true thing that can be said about
 * it: the instalment is ticked, the money is not.
 */
function depositFailureMessage(err: unknown): string {
  if (err instanceof HttpException) return err.message;
  return 'কিস্তিটি জমা হিসেবে চিহ্নিত হয়েছে, তবে টাকাটা খাতায় সরানো যায়নি';
}
