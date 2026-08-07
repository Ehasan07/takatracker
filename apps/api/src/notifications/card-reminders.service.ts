import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  activeCycle,
  clampLeadDays,
  daysUntilDue,
  decideReminder,
  describeDueDistance,
  type CardCycle,
} from '@hishab/core';
import { formatLedgerDate, formatMinor, isDebitNormal, toLocalDateString } from '@hishab/shared';
import type { Account, Workspace } from '@prisma/client';
import { minorToNumber } from '../common/bigint-json';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramClient } from './telegram.client';

const APP_URL = process.env.APP_URL ?? 'https://takatracker.com';
const BINDING_TTL_MS = 15 * 60 * 1000;
const MAX_FAILED_DAYS = 3;

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

@Injectable()
export class CardRemindersService {
  private readonly logger = new Logger(CardRemindersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramClient,
  ) {}

  // --- connection ----------------------------------------------------------

  /**
   * Start the binding handshake. Returns a deep link the user taps; Telegram
   * then delivers `/start <token>` to our webhook and we learn their chat id.
   * Nothing is typed, and no credential changes hands.
   */
  async beginBinding(
    workspaceId: string,
    userId: string,
  ): Promise<{ url: string; expiresAt: Date }> {
    const username = this.telegram.sharedBotUsername;
    if (!username) {
      throw new BadRequestException('টেলিগ্রাম বট এখনো কনফিগার করা হয়নি');
    }

    const token = randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + BINDING_TTL_MS);

    await this.prisma.telegramConnection.upsert({
      where: { workspaceId_userId: { workspaceId, userId } },
      create: {
        workspaceId,
        userId,
        mode: 'SHARED_BOT',
        bindingTokenHash: sha256(token),
        bindingExpiresAt: expiresAt,
        status: 'PENDING',
      },
      update: {
        bindingTokenHash: sha256(token),
        bindingExpiresAt: expiresAt,
        status: 'PENDING',
        revokedAt: null,
        lastError: null,
        failureCount: 0,
      },
    });

    return { url: `https://t.me/${username}?start=${token}`, expiresAt };
  }

  /** Called by the webhook when Telegram delivers `/start <token>`. */
  async completeBinding(token: string, chatId: string): Promise<boolean> {
    const candidate = await this.prisma.telegramConnection.findFirst({
      where: { bindingTokenHash: sha256(token), bindingExpiresAt: { gt: new Date() } },
    });
    if (!candidate) return false;

    await this.prisma.telegramConnection.update({
      where: { id: candidate.id },
      data: {
        chatId,
        // Reaching us proves the chat is real, which is the whole point of the
        // handshake: an unverified chat id is how someone else's card balance
        // ends up in a stranger's inbox.
        verifiedAt: new Date(),
        isEnabled: true,
        status: 'ACTIVE',
        bindingTokenHash: null,
        bindingExpiresAt: null,
        failureCount: 0,
        lastError: null,
      },
    });
    return true;
  }

  async status(workspaceId: string, userId: string) {
    const connection = await this.prisma.telegramConnection.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    const workspace = await this.prisma.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
      select: { creditCardReminderLeadDays: true, autoMuteOnCardPayment: true },
    });

    return {
      configured: Boolean(this.telegram.sharedBotUsername),
      botUsername: this.telegram.sharedBotUsername ?? null,
      // Never the token, and never the raw chat id — the last four digits are
      // enough for the user to recognise their own chat.
      connection: connection
        ? {
            status: connection.status,
            mode: connection.mode,
            isEnabled: connection.isEnabled,
            verifiedAt: connection.verifiedAt,
            chatIdMasked: connection.chatId ? `****${connection.chatId.slice(-4)}` : null,
            lastSentAt: connection.lastSentAt,
            lastError: connection.lastError,
          }
        : null,
      leadDays: workspace.creditCardReminderLeadDays,
      autoMuteOnPayment: workspace.autoMuteOnCardPayment,
    };
  }

  async setEnabled(workspaceId: string, userId: string, enabled: boolean): Promise<void> {
    const connection = await this.prisma.telegramConnection.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    if (!connection) throw new NotFoundException('টেলিগ্রাম সংযোগ নেই');
    if (enabled && !connection.verifiedAt) {
      throw new BadRequestException('আগে টেলিগ্রামে সংযুক্ত করুন');
    }
    await this.prisma.telegramConnection.update({
      where: { id: connection.id },
      data: { isEnabled: enabled, status: enabled ? 'ACTIVE' : 'DISABLED' },
    });
  }

  /** Revoke and forget in one action — no orphaned chat id left behind. */
  async disconnect(workspaceId: string, userId: string): Promise<void> {
    await this.prisma.telegramConnection.deleteMany({
      where: { workspaceId, userId },
    });
  }

  async sendTest(workspaceId: string, userId: string): Promise<{ ok: boolean; message: string }> {
    const connection = await this.prisma.telegramConnection.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    if (!connection?.chatId) throw new BadRequestException('আগে টেলিগ্রামে সংযুক্ত করুন');

    const token = this.tokenFor(connection.mode);
    if (!token) throw new BadRequestException('টেলিগ্রাম বট কনফিগার করা হয়নি');

    const result = await this.telegram.sendMessage(
      token,
      connection.chatId,
      '✅ <b>হিসাব</b> — সংযোগ ঠিক আছে।\nক্রেডিট কার্ডের পেমেন্ট রিমাইন্ডার এখানে আসবে।',
    );

    await this.recordOutcome(connection.id, result.ok, result.failure);
    return {
      ok: result.ok,
      message: result.ok ? 'বার্তা পাঠানো হয়েছে' : 'পাঠানো যায়নি — সংযোগ আবার দেখুন',
    };
  }

  private tokenFor(mode: 'SHARED_BOT' | 'OWN_BOT'): string | undefined {
    // OWN_BOT tokens land here once the secret store is wired (M28 brings the
    // envelope encryption this shares). Until then only the official bot sends.
    return mode === 'SHARED_BOT' ? this.telegram.sharedBotToken : undefined;
  }

  // --- settings ------------------------------------------------------------

  async updateSettings(
    workspaceId: string,
    input: { leadDays?: number; autoMuteOnPayment?: boolean },
  ): Promise<void> {
    await this.prisma.workspace.update({
      where: { id: workspaceId },
      data: {
        creditCardReminderLeadDays:
          input.leadDays === undefined ? undefined : clampLeadDays(input.leadDays),
        autoMuteOnCardPayment: input.autoMuteOnPayment,
      },
    });
  }

  // --- cycles --------------------------------------------------------------

  /** The current cycle row for a card, created on demand. */
  async currentCycle(workspace: Workspace, account: Account, now = new Date()) {
    if (account.dueDayOfMonth === null) return null;

    const cycle = activeCycle(
      now,
      account.dueDayOfMonth,
      account.reminderLeadDays ?? workspace.creditCardReminderLeadDays,
      workspace.timezone,
    );

    return this.prisma.cardReminderCycle.upsert({
      where: { accountId_cycleMonth: { accountId: account.id, cycleMonth: cycle.cycleMonth } },
      create: {
        workspaceId: workspace.id,
        accountId: account.id,
        cycleMonth: cycle.cycleMonth,
        dueDate: cycle.dueDate,
        windowStart: cycle.windowStart,
        windowEnd: cycle.windowEnd,
      },
      // Keep the dates in step if the user edits the due day mid-cycle.
      update: {
        dueDate: cycle.dueDate,
        windowStart: cycle.windowStart,
        windowEnd: cycle.windowEnd,
      },
    });
  }

  async mute(
    workspaceId: string,
    userId: string,
    accountId: string,
    reason: 'MANUAL' | 'PAID' = 'MANUAL',
  ): Promise<{ cycleMonth: string }> {
    const account = await this.prisma.account.findFirst({
      where: { id: accountId, workspaceId, deletedAt: null },
    });
    if (!account) throw new NotFoundException('অ্যাকাউন্ট পাওয়া যায়নি');

    const workspace = await this.prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    const row = await this.currentCycle(workspace, account);
    if (!row) throw new BadRequestException('এই কার্ডে পেমেন্টের তারিখ দেওয়া নেই');

    await this.prisma.cardReminderCycle.update({
      where: { id: row.id },
      data: { mutedAt: new Date(), mutedByUserId: userId, mutedReason: reason },
    });
    return { cycleMonth: row.cycleMonth };
  }

  /**
   * Money moving *into* a credit card is a payment, and a payment ends that
   * cycle's nagging. Called after a transaction is written; failures here must
   * never fail the transaction, which is why it swallows its own errors.
   */
  async autoMuteOnPayment(workspaceId: string, accountIds: string[]): Promise<void> {
    try {
      const workspace = await this.prisma.workspace.findUniqueOrThrow({
        where: { id: workspaceId },
      });
      if (!workspace.autoMuteOnCardPayment) return;

      const cards = await this.prisma.account.findMany({
        where: {
          id: { in: accountIds },
          workspaceId,
          type: 'CREDIT_CARD',
          dueDayOfMonth: { not: null },
          deletedAt: null,
        },
      });

      for (const card of cards) {
        // A credit card is credit-normal: the balance owed goes *down* when the
        // account is debited, which is what a payment does.
        const balance = await this.balanceOf(workspaceId, card);
        const row = await this.currentCycle(workspace, card);
        if (!row || row.mutedAt) continue;

        const paidThisCycle = await this.prisma.ledgerEntry.count({
          where: {
            workspaceId,
            accountId: card.id,
            direction: isDebitNormal(card.type) ? 'CREDIT' : 'DEBIT',
            transaction: {
              deletedAt: null,
              date: { gte: row.windowStart, lt: row.windowEnd },
            },
          },
        });

        if (paidThisCycle > 0 || balance <= 0) {
          await this.prisma.cardReminderCycle.update({
            where: { id: row.id },
            data: { mutedAt: new Date(), mutedReason: 'PAID' },
          });
        }
      }
    } catch (err) {
      this.logger.warn(`Auto-mute check failed: ${(err as Error).message}`);
    }
  }

  private async balanceOf(workspaceId: string, account: Account): Promise<number> {
    const grouped = await this.prisma.ledgerEntry.groupBy({
      by: ['direction'],
      where: { workspaceId, accountId: account.id, transaction: { deletedAt: null } },
      _sum: { amountMinor: true },
    });
    const debitIncreases = isDebitNormal(account.type);
    return grouped.reduce((sum, row) => {
      const magnitude = minorToNumber(row._sum.amountMinor ?? 0n);
      const isDebit = row.direction === 'DEBIT';
      return sum + (isDebit === debitIncreases ? magnitude : -magnitude);
    }, minorToNumber(account.openingBalance));
  }

  // --- sending -------------------------------------------------------------

  /** Hour of the day, in the workspace's own timezone, that reminders go out. */
  private static readonly SEND_HOUR_LOCAL = 9;

  private localHour(now: Date, timezone: string): number {
    return Number(
      new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', hour12: false })
        .format(now)
        .slice(0, 2),
    );
  }

  /**
   * One pass over every card in every workspace. Safe to run repeatedly — the
   * per-day guard in `decideReminder` is what makes that true, so an hourly
   * sweep still produces at most one message per card per day.
   */
  async runDueReminders(
    now = new Date(),
    force = false,
  ): Promise<{ checked: number; sent: number }> {
    const cards = await this.prisma.account.findMany({
      where: {
        type: 'CREDIT_CARD',
        dueDayOfMonth: { not: null },
        isArchived: false,
        deletedAt: null,
        workspace: { deletedAt: null, status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] } },
      },
      include: { workspace: true },
    });

    let sent = 0;
    for (const card of cards) {
      try {
        // Nine in the morning where the user actually lives, not where the
        // server happens to be.
        if (
          !force &&
          this.localHour(now, card.workspace.timezone) !== CardRemindersService.SEND_HOUR_LOCAL
        ) {
          continue;
        }
        if (await this.remindOne(card, card.workspace, now)) sent += 1;
      } catch (err) {
        this.logger.warn(`Reminder for account ${card.id} failed: ${(err as Error).message}`);
      }
    }
    return { checked: cards.length, sent };
  }

  private async remindOne(account: Account, workspace: Workspace, now: Date): Promise<boolean> {
    const connections = await this.prisma.telegramConnection.findMany({
      where: {
        workspaceId: workspace.id,
        isEnabled: true,
        status: 'ACTIVE',
        chatId: { not: null },
        revokedAt: null,
      },
    });
    if (connections.length === 0) return false;

    const row = await this.currentCycle(workspace, account, now);
    if (!row) return false;

    const decision = decideReminder({
      now,
      timezone: workspace.timezone,
      dueDayOfMonth: account.dueDayOfMonth,
      leadDays: account.reminderLeadDays ?? workspace.creditCardReminderLeadDays,
      lastSentOn: row.lastSentOn,
      mutedAt: row.mutedAt,
      hasActiveConnection: true,
      remindFrom: account.createdAt,
    });
    if (!decision.send || !decision.cycle) return false;

    const text = await this.composeMessage(workspace, account, decision.cycle, now);
    const token = this.telegram.sharedBotToken;
    if (!token) return false;

    let anySent = false;
    for (const connection of connections) {
      const result = await this.telegram.sendMessage(token, connection.chatId!, text, [
        { text: 'এই মাসের জন্য বন্ধ করুন', callbackData: `mute:${row.id}` },
      ]);
      await this.recordOutcome(connection.id, result.ok, result.failure);
      if (result.ok) anySent = true;
    }

    if (anySent) {
      await this.prisma.cardReminderCycle.update({
        where: { id: row.id },
        data: {
          lastSentOn: toLocalDateString(now, workspace.timezone),
          sentCount: { increment: 1 },
        },
      });
    }
    return anySent;
  }

  private async composeMessage(
    workspace: Workspace,
    account: Account,
    cycle: CardCycle,
    now: Date,
  ): Promise<string> {
    const outstanding = await this.balanceOf(workspace.id, account);
    const days = daysUntilDue(now, cycle.dueDate, workspace.timezone);
    const { bn, overdue } = describeDueDistance(days);

    const name = account.accountNumberMasked
      ? `${account.name} ${account.accountNumberMasked}`
      : account.name;

    return [
      overdue ? '🔴 <b>ক্রেডিট কার্ডের পেমেন্ট বকেয়া</b>' : '💳 <b>ক্রেডিট কার্ড পেমেন্ট বাকি</b>',
      '',
      `কার্ড: ${name}`,
      `বকেয়া: ${formatMinor(Math.abs(outstanding))}`,
      `শেষ তারিখ: ${formatLedgerDate(cycle.dueDate, 'bn', workspace.timezone)} (${bn})`,
      '',
      `${APP_URL}/accounts`,
    ].join('\n');
  }

  /**
   * Blocked or a bad chat id is permanent — stop sending. A rate limit or a
   * network blip is not. Three consecutive bad days disables the connection so
   * we never hammer Telegram, which would get the IP blocked.
   */
  private async recordOutcome(connectionId: string, ok: boolean, failure?: string): Promise<void> {
    if (ok) {
      await this.prisma.telegramConnection.update({
        where: { id: connectionId },
        data: { lastSentAt: new Date(), failureCount: 0, lastError: null, status: 'ACTIVE' },
      });
      return;
    }

    const permanent = failure === 'BLOCKED' || failure === 'BAD_CHAT' || failure === 'AUTH';
    const connection = await this.prisma.telegramConnection.update({
      where: { id: connectionId },
      data: { failureCount: { increment: 1 }, lastError: failure ?? 'UNKNOWN' },
    });

    if (permanent || connection.failureCount >= MAX_FAILED_DAYS) {
      await this.prisma.telegramConnection.update({
        where: { id: connectionId },
        data: { status: permanent ? 'AUTH_FAILED' : 'DISABLED', isEnabled: false },
      });
    }
  }

  // --- webhook -------------------------------------------------------------

  /** Constant-time compare, because this guards the whole webhook. */
  verifyWebhookSecret(provided: string | undefined): boolean {
    const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (!expected || !provided) return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async handleMuteCallback(cycleId: string): Promise<string> {
    const row = await this.prisma.cardReminderCycle.findUnique({ where: { id: cycleId } });
    if (!row) return 'পাওয়া যায়নি';
    if (row.mutedAt) return 'আগেই বন্ধ করা আছে';

    await this.prisma.cardReminderCycle.update({
      where: { id: row.id },
      data: { mutedAt: new Date(), mutedReason: 'MANUAL' },
    });
    return 'এই মাসের রিমাইন্ডার বন্ধ হলো';
  }
}
