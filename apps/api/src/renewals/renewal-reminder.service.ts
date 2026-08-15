import { Injectable, Logger } from '@nestjs/common';
import { renewalStatus } from '@hishab/core';
import { toLocalDateString } from '@hishab/shared';
import { AuditService } from '../audit/audit.service';
import { TelegramClient } from '../notifications/telegram.client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Telling somebody their fitness certificate expires in three weeks.
 *
 * ## Once a day, whatever else happens
 *
 * The guard is a `YYYY-MM-DD` stamp of the day a reminder last went out, in the
 * workspace's own timezone — the same one the card reminders use, and copied
 * deliberately. A timestamp plus a duration would let a restart, an overlapping
 * sweep or a second instance send twice; comparing local dates cannot.
 *
 * ## It keeps going after the date has passed
 *
 * A khajna payment that was due last week is more urgent than one due next
 * month, so an overdue obligation keeps reminding until it is marked done or
 * muted. Going quiet at exactly the moment the fine starts accruing would be
 * the worst possible behaviour — and the daily guard is what keeps that from
 * becoming a nag.
 *
 * ## Nine in the morning where the person lives
 *
 * Not where the server is. The sweep runs hourly and each workspace is only
 * considered in its own local nine o'clock.
 */
@Injectable()
export class RenewalReminderService {
  private readonly logger = new Logger(RenewalReminderService.name);
  private static readonly SEND_HOUR_LOCAL = 9;

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramClient,
    private readonly audit: AuditService,
  ) {}

  private localHour(now: Date, timezone: string): number {
    return Number(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone,
        hour: '2-digit',
        hour12: false,
      }).format(now),
    );
  }

  async runDueReminders(
    now = new Date(),
    force = false,
  ): Promise<{ checked: number; sent: number }> {
    const rows = await this.prisma.assetObligation.findMany({
      where: {
        status: 'ACTIVE',
        isMuted: false,
        deletedAt: null,
        workspace: { deletedAt: null, status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] } },
      },
      include: { workspace: true, account: { select: { name: true } } },
    });

    let sent = 0;
    for (const row of rows) {
      try {
        if (
          !force &&
          this.localHour(now, row.workspace.timezone) !== RenewalReminderService.SEND_HOUR_LOCAL
        ) {
          continue;
        }
        if (await this.remindOne(row, now)) sent += 1;
      } catch (err) {
        this.logger.warn(`Renewal reminder ${row.id} failed: ${(err as Error).message}`);
      }
    }
    return { checked: rows.length, sent };
  }

  private async remindOne(
    row: {
      id: string;
      workspaceId: string;
      title: string;
      dueDate: Date;
      reminderLeadDays: number;
      lastRemindedOn: string | null;
      estimatedCostMinor: bigint;
      documentRef: string | null;
      workspace: { timezone: string };
      account: { name: string } | null;
    },
    now: Date,
  ): Promise<boolean> {
    const timezone = row.workspace.timezone;
    const today = toLocalDateString(now, timezone);
    if (row.lastRemindedOn === today) return false;

    const dueDate = toLocalDateString(row.dueDate, timezone);
    const status = renewalStatus(today, dueDate, row.reminderLeadDays);
    if (!status.shouldRemind) return false;

    const connections = await this.prisma.telegramConnection.findMany({
      where: {
        workspaceId: row.workspaceId,
        isEnabled: true,
        status: 'ACTIVE',
        chatId: { not: null },
      },
    });
    if (connections.length === 0) return false;

    const token = this.telegram.sharedBotToken;
    if (!token) return false;

    const text = this.compose(row, status.daysLeft, dueDate);
    let anySent = false;
    for (const connection of connections) {
      const result = await this.telegram.sendMessage(token, connection.chatId as string, text);
      if (result.ok) anySent = true;
    }

    /* Stamped only when something actually went out. Marking the day on a
       failed send would swallow the reminder until tomorrow. */
    if (anySent) {
      await this.prisma.assetObligation.update({
        where: { id: row.id },
        data: { lastRemindedOn: today },
      });
      this.audit.emit({
        workspaceId: row.workspaceId,
        action: 'obligation.reminded',
        entity: 'AssetObligation',
        entityId: row.id,
        after: { dueDate, daysLeft: status.daysLeft },
      });
    }
    return anySent;
  }

  private compose(
    row: { title: string; documentRef: string | null; account: { name: string } | null },
    daysLeft: number,
    dueDate: string,
  ): string {
    const what = row.account?.name ? `${row.title} — ${row.account.name}` : row.title;
    /* Said in the words somebody uses: "গেছে" for a date that has passed, a
       count of days for one that has not. */
    const when =
      daysLeft < 0
        ? `মেয়াদ ${Math.abs(daysLeft)} দিন আগে শেষ হয়েছে (${dueDate})`
        : daysLeft === 0
          ? `আজই শেষ দিন (${dueDate})`
          : `আর ${daysLeft} দিন বাকি (${dueDate})`;

    const ref = row.documentRef ? `\nনম্বর: ${row.documentRef}` : '';
    return `⏳ ${what}\n${when}${ref}`;
  }
}
