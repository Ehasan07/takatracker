import { Injectable, NotFoundException } from '@nestjs/common';
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
import type { CreateObligationInput, UpdateObligationInput } from './renewals.controller';

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

@Injectable()
export class RenewalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
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
   * Done — roll it forward, or close it if it happens only once.
   *
   * The fee is not booked here. Somebody clearing five years of back khajna in
   * one sitting does not want five transactions dated today, so the screen
   * offers to record the expense separately and this only moves the date.
   */
  async complete(
    workspaceId: string,
    userId: string,
    id: string,
    completedOn: string | undefined,
    timezone: string,
  ): Promise<ObligationView> {
    const existing = await this.require(workspaceId, id);
    const today = toLocalDateString(new Date(), timezone);
    const done = completedOn ?? today;

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

    this.audit.emit({
      workspaceId,
      actorUserId: userId,
      action: 'obligation.completed',
      entity: 'AssetObligation',
      entityId: id,
      after: { completedOn: done, nextDueDate: next },
    });

    return this.present(updated, timezone, today);
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
