import { HttpException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  nextDueDate,
  renewalStatus,
  type RenewalRecurrence,
  type RenewalUrgency,
} from '@hishab/core';
import { fromLocalDateString, toLocalDateString } from '@hishab/shared';
import { AuditService } from '../audit/audit.service';
import { minorToNumber } from '../common/bigint-json';
import { PrismaService } from '../prisma/prisma.service';
import { TransactionsService, type TenantContext } from '../transactions/transactions.service';
import type {
  CompleteObligationInput,
  CompletePaymentInput,
  CreateObligationInput,
  UpdateObligationInput,
} from './renewals.controller';

/**
 * Papers that expire, and telling somebody before they do.
 *
 * ## Why this is not a transaction
 *
 * Khajna is owed whether or not it has been paid, and the payment when it comes
 * is an ordinary expense like any other. Modelling the obligation as a ledger
 * entry would either put money in the books that has not moved, or lose the
 * deadline the moment it was paid. It is a calendar with money attached, and
 * the two halves stay separate.
 *
 * ## Marking one done rolls it forward
 *
 * A yearly obligation completed on the 21st falls due again on the 21st a year
 * later — counted from the day it was done, not the day it was due, because
 * that is what the department does: a fitness certificate issued three weeks
 * late is valid for a year from issue. Counting from the missed deadline would
 * shorten every following period and keep somebody permanently behind.
 *
 * ## The fee is offered, not assumed
 *
 * Completing one can *also* book the payment as an expense, if the caller sends
 * one. That is the only thing that crosses the line above, and it crosses it
 * only when asked: the reason the fee was never booked automatically — five
 * years of back khajna becoming five transactions dated today — is an argument
 * against assuming, not against offering.
 */

export interface ObligationView {
  id: string;
  accountId: string | null;
  accountName: string | null;
  kind: string;
  title: string;
  recurrence: RenewalRecurrence;
  dueDate: string;
  reminderLeadDays: number;
  estimatedCostMinor: number;
  lastCompletedOn: string | null;
  documentRef: string | null;
  note: string | null;
  isMuted: boolean;
  status: string;
  /** Where it stands today, so the screen does no date arithmetic of its own. */
  daysLeft: number;
  urgency: RenewalUrgency;
}

/**
 * What became of the optional fee.
 *
 * Always reported, never inferred from a status code, because the two halves of
 * this action can disagree: the date rolls forward whatever happens to the
 * money, so a 200 alone cannot tell a screen whether the expense was written.
 * `booked: false` carries the reason in Bengali, ready to show.
 */
export interface FeeOutcome {
  booked: boolean;
  transactionId: string | null;
  message: string | null;
}

/** The obligation as it now stands, plus what happened to the fee. */
export interface CompletedObligationView extends ObligationView {
  /** `null` when no payment was offered — the behaviour renewals shipped with. */
  fee: FeeOutcome | null;
}

@Injectable()
export class RenewalsService {
  private readonly logger = new Logger(RenewalsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    /* The only door to the ledger. Writing entries here would be a second way
       for the books to be wrong — and the second way is the one that skips the
       double-entry guard, the plan meter, the audit row and the ownership
       checks that live on the other side of this. */
    private readonly transactions: TransactionsService,
  ) {}

  private present(
    row: {
      id: string;
      accountId: string | null;
      kind: string;
      title: string;
      recurrence: string;
      dueDate: Date;
      reminderLeadDays: number;
      estimatedCostMinor: bigint;
      lastCompletedOn: Date | null;
      documentRef: string | null;
      note: string | null;
      isMuted: boolean;
      status: string;
      account?: { name: string } | null;
    },
    timezone: string,
    today: string,
  ): ObligationView {
    const dueDate = toLocalDateString(row.dueDate, timezone);
    const { daysLeft, urgency } = renewalStatus(today, dueDate, row.reminderLeadDays);

    return {
      id: row.id,
      accountId: row.accountId,
      accountName: row.account?.name ?? null,
      kind: row.kind,
      title: row.title,
      recurrence: row.recurrence as RenewalRecurrence,
      dueDate,
      reminderLeadDays: row.reminderLeadDays,
      estimatedCostMinor: minorToNumber(row.estimatedCostMinor),
      lastCompletedOn: row.lastCompletedOn
        ? toLocalDateString(row.lastCompletedOn, timezone)
        : null,
      documentRef: row.documentRef,
      note: row.note,
      isMuted: row.isMuted,
      status: row.status,
      daysLeft,
      urgency,
    };
  }

  /** Soonest first, which is the only order this list is ever read in. */
  async list(workspaceId: string, timezone: string): Promise<ObligationView[]> {
    const today = toLocalDateString(new Date(), timezone);
    const rows = await this.prisma.assetObligation.findMany({
      where: { workspaceId, deletedAt: null },
      include: { account: { select: { name: true } } },
      orderBy: [{ status: 'asc' }, { dueDate: 'asc' }],
    });
    return rows.map((row) => this.present(row, timezone, today));
  }

  async create(
    workspaceId: string,
    userId: string,
    input: CreateObligationInput,
    timezone: string,
  ): Promise<ObligationView> {
    const created = await this.prisma.assetObligation.create({
      data: {
        workspaceId,
        accountId: input.accountId ?? null,
        kind: input.kind,
        title: input.title,
        recurrence: input.recurrence,
        dueDate: fromLocalDateString(input.dueDate, timezone),
        reminderLeadDays: input.reminderLeadDays,
        estimatedCostMinor: BigInt(input.estimatedCostMinor),
        documentRef: input.documentRef ?? null,
        note: input.note ?? null,
      },
      include: { account: { select: { name: true } } },
    });

    this.audit.emit({
      workspaceId,
      actorUserId: userId,
      action: 'obligation.created',
      entity: 'AssetObligation',
      entityId: created.id,
      after: { title: created.title, kind: created.kind },
    });

    return this.present(created, timezone, toLocalDateString(new Date(), timezone));
  }

  async update(
    workspaceId: string,
    userId: string,
    id: string,
    input: UpdateObligationInput,
    timezone: string,
  ): Promise<ObligationView> {
    await this.require(workspaceId, id);

    const updated = await this.prisma.assetObligation.update({
      where: { id },
      data: {
        accountId: input.accountId === undefined ? undefined : (input.accountId ?? null),
        kind: input.kind,
        title: input.title,
        recurrence: input.recurrence,
        dueDate: input.dueDate ? fromLocalDateString(input.dueDate, timezone) : undefined,
        reminderLeadDays: input.reminderLeadDays,
        estimatedCostMinor:
          input.estimatedCostMinor === undefined ? undefined : BigInt(input.estimatedCostMinor),
        documentRef: input.documentRef,
        note: input.note,
        isMuted: input.isMuted,
        /* A date somebody moved is a date they want to hear about again, even if
           a reminder already went out today. */
        lastRemindedOn: input.dueDate ? null : undefined,
      },
      include: { account: { select: { name: true } } },
    });

    this.audit.emit({
      workspaceId,
      actorUserId: userId,
      action: 'obligation.updated',
      entity: 'AssetObligation',
      entityId: id,
      after: { title: updated.title, dueDate: updated.dueDate.toISOString() },
    });

    return this.present(updated, timezone, toLocalDateString(new Date(), timezone));
  }

  /**
   * Done — roll it forward, or close it if it happens only once, and book the
   * fee if the caller asked for that too.
   *
   * ## The date first, the money second
   *
   * In that order, and not the other way round. A plan limit, a category that
   * was deleted between the screen loading and the button being pressed, a
   * wallet belonging to another workspace — any of them fails the expense, and
   * none of them is a reason to lose the fact that the khajna was paid. So the
   * obligation is rolled forward and committed before the ledger is touched,
   * and the failure comes back as a `fee` the screen can report rather than as
   * an error that undoes the completion.
   *
   * The reverse order would be worse in exactly the way that matters: an expense
   * written against an obligation that still says it is overdue.
   */
  async complete(
    ctx: TenantContext,
    id: string,
    input: CompleteObligationInput,
  ): Promise<CompletedObligationView> {
    const { workspaceId, timezone } = ctx;
    const existing = await this.require(workspaceId, id);
    const today = toLocalDateString(new Date(), timezone);
    const done = input.completedOn ?? today;

    const next = nextDueDate(existing.recurrence as RenewalRecurrence, done);

    const updated = await this.prisma.assetObligation.update({
      where: { id },
      data: {
        lastCompletedOn: fromLocalDateString(done, timezone),
        ...(next
          ? { dueDate: fromLocalDateString(next, timezone), lastRemindedOn: null }
          : { status: 'DONE' }),
      },
      include: { account: { select: { name: true } } },
    });

    const fee = input.payment ? await this.bookFee(ctx, existing.title, done, input.payment) : null;

    this.audit.emit({
      workspaceId,
      actorUserId: ctx.id,
      action: 'obligation.completed',
      entity: 'AssetObligation',
      entityId: id,
      /* The fee's fate is on the same line as the completion, because a reader
         asking "was this khajna paid out of the bank or not?" is asking one
         question, and two audit rows they have to correlate is not an answer. */
      after: {
        completedOn: done,
        nextDueDate: next,
        feeTransactionId: fee?.transactionId ?? null,
      },
    });

    return { ...this.present(updated, timezone, today), fee };
  }

  /**
   * Write the fee as an ordinary expense, dated the day it was paid.
   *
   * Through `TransactionsService.create`, which is the same door the app's own
   * entry sheet uses, so this gets the double-entry expansion, the plan meter,
   * the ownership checks and its own audit row without reimplementing any of
   * them.
   *
   * Nothing thrown here escapes: the completion is already committed by the time
   * this runs, and turning a bookkeeping failure into a 402 would tell the
   * person their renewal did not go through when it did.
   */
  private async bookFee(
    ctx: TenantContext,
    title: string,
    /* `completedOn`, never today. The whole point of offering the option is
       that the person is telling us when the money moved — dating a five-year-old
       khajna payment to this morning would put it in the wrong month of every
       report and make this year look poorer than it was. */
    date: string,
    payment: CompletePaymentInput,
  ): Promise<FeeOutcome> {
    try {
      const created = await this.transactions.create(ctx, {
        date,
        type: 'EXPENSE',
        amountMinor: payment.amountMinor,
        accountId: payment.accountId,
        categoryId: payment.categoryId,
        /* The paper's own name — "গাড়ির ফিটনেস", "বসিলার জমির খাজনা". It is
           what the person would have typed into the khata by hand, and it is
           what makes the row recognisable there a year later. */
        description: title,
        source: 'MANUAL',
      });
      return { booked: true, transactionId: created.id, message: null };
    } catch (err) {
      /* Logged, because the person is only shown one sentence and somebody will
         eventually have to know which of the several possible refusals it was. */
      this.logger.warn(
        `Renewal fee not booked for workspace ${ctx.workspaceId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { booked: false, transactionId: null, message: feeFailureMessage(err) };
    }
  }

  async remove(workspaceId: string, userId: string, id: string): Promise<{ id: string }> {
    await this.require(workspaceId, id);
    await this.prisma.assetObligation.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    this.audit.emit({
      workspaceId,
      actorUserId: userId,
      action: 'obligation.deleted',
      entity: 'AssetObligation',
      entityId: id,
    });
    return { id };
  }

  private async require(workspaceId: string, id: string) {
    const row = await this.prisma.assetObligation.findFirst({
      where: { id, workspaceId, deletedAt: null },
    });
    if (!row) throw new NotFoundException('নবায়নের তথ্যটি পাওয়া যায়নি');
    return row;
  }
}

/**
 * Why the fee did not get written, in the language the screen is in.
 *
 * Every refusal the ledger raises — a missing category, an account belonging to
 * somebody else, the month's transaction ceiling — is already a Bengali
 * sentence on the exception, so it is passed through rather than replaced with
 * something vaguer. Anything that is not an `HttpException` is a fault nobody
 * has phrased for a reader, and the person gets the one true thing that can be
 * said about it: the date moved, the money did not.
 */
function feeFailureMessage(err: unknown): string {
  if (err instanceof HttpException) return err.message;
  return 'তারিখ এগিয়ে গেছে, তবে খরচটি খাতায় লেখা যায়নি';
}
