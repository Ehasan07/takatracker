import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { CardRemindersService } from '../notifications/card-reminders.service';
import { TelegramClient } from '../notifications/telegram.client';
import { PrismaService } from '../prisma/prisma.service';
import { fileAgainst, type AdminActor } from './admin-audit';

/**
 * Send a message to customers over Telegram.
 *
 * ## Why Telegram and not push
 *
 * Web Push needs a subscription this product has never collected, and on an
 * iPhone it needs the app to have been added to the home screen first. The
 * Telegram binding already exists, already has a verified chat id per
 * workspace, and already delivers the credit-card reminders — so a broadcast is
 * a new *caller*, not new infrastructure. Push is worth building next; it is
 * not worth waiting for.
 *
 * ## Consent is the binding
 *
 * Nobody is messaged who has not connected Telegram themselves and left it
 * enabled. There is no address list to opt out of, because there is no address
 * list — `TelegramConnection.isEnabled` with a verified `chatId` *is* the
 * consent, given for reminders and now also carrying this. A person who
 * disconnects stops receiving both, immediately and without asking anybody.
 *
 * ## Rate
 *
 * Telegram's documented ceiling is about 30 messages a second across a bot, and
 * a burst past it earns a 429 with a `retry_after`. Sends are therefore paced
 * rather than fired in parallel — a broadcast that gets the bot throttled would
 * take the card reminders down with it, which is a worse outcome than a
 * broadcast that takes a minute.
 */

/** Comfortably under Telegram's ~30/second, and steady rather than bursty. */
const SEND_INTERVAL_MS = 60;

/** One message may not be longer than Telegram will accept in one piece. */
const MAX_MESSAGE = 3_000;

export interface BroadcastInput {
  /** HTML, the same subset `TelegramClient` already sends. */
  message: string;
  /** Named workspaces, or every eligible one when absent. */
  workspaceIds?: string[];
  /** Narrow to one plan — "tell everybody on free about the new tier". */
  planCode?: string;
  /** Compose and count without sending. The screen asks for this first. */
  dryRun?: boolean;
}

export interface BroadcastResult {
  dryRun: boolean;
  /** Connections that would receive it. */
  eligible: number;
  sent: number;
  failed: number;
  /** Workspaces skipped because nobody there has Telegram connected. */
  withoutTelegram: number;
}

@Injectable()
export class AdminBroadcastService {
  private readonly logger = new Logger(AdminBroadcastService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramClient,
    private readonly reminders: CardRemindersService,
    private readonly audit: AuditService,
  ) {}

  async send(actor: AdminActor, input: BroadcastInput): Promise<BroadcastResult> {
    const message = input.message.trim();
    if (!message) throw new BadRequestException('বার্তা লিখুন');
    if (message.length > MAX_MESSAGE) {
      throw new BadRequestException(`সর্বোচ্চ ${MAX_MESSAGE} অক্ষর`);
    }

    const token = this.telegram.sharedBotToken;
    if (!token && !input.dryRun) {
      throw new BadRequestException('টেলিগ্রাম বট কনফিগার করা হয়নি');
    }

    /* Only verified, enabled connections whose workspace is alive. A chat id
     * without `isEnabled` is somebody who turned notifications off, and sending
     * to them anyway would be the single fastest way to lose the binding — and
     * with it the reminders they did want. */
    const connections = await this.prisma.telegramConnection.findMany({
      where: {
        isEnabled: true,
        chatId: { not: null },
        status: 'ACTIVE',
        ...(input.workspaceIds?.length ? { workspaceId: { in: input.workspaceIds } } : {}),
        workspace: {
          deletedAt: null,
          status: 'ACTIVE',
          ...(input.planCode ? { plan: { code: input.planCode } } : {}),
        },
      },
      select: { id: true, workspaceId: true, chatId: true, mode: true },
    });

    const targeted = input.workspaceIds?.length
      ? input.workspaceIds.length
      : await this.prisma.workspace.count({
          where: {
            deletedAt: null,
            status: 'ACTIVE',
            ...(input.planCode ? { plan: { code: input.planCode } } : {}),
          },
        });

    const result: BroadcastResult = {
      dryRun: Boolean(input.dryRun),
      eligible: connections.length,
      sent: 0,
      failed: 0,
      withoutTelegram: Math.max(0, targeted - new Set(connections.map((c) => c.workspaceId)).size),
    };

    if (input.dryRun) return result;

    for (const connection of connections) {
      /* Own-bot tokens are not in the secret store yet, so those connections
       * cannot be sent to at all — counted as failures rather than silently
       * skipped, because "delivered to 40 of 45" has to be true. */
      const botToken = connection.mode === 'SHARED_BOT' ? token : undefined;
      if (!botToken || !connection.chatId) {
        result.failed += 1;
        continue;
      }

      const outcome = await this.telegram.sendMessage(botToken, connection.chatId, message);
      if (outcome.ok) result.sent += 1;
      else result.failed += 1;

      /* Through the reminder service's own bookkeeping, not a second copy of
       * it. A chat that blocked the bot is blocked whoever was sending, and two
       * implementations would eventually disagree about which failures are
       * permanent — which shows up as a connection something retries forever. */
      await this.reminders
        .recordOutcome(connection.id, outcome.ok, outcome.failure)
        .catch(() => undefined);

      /* Telegram's own `retry_after` when it says we are going too fast. The
       * pacing below is set well under the documented ceiling, but a shared bot
       * also carries the reminder traffic, so the two together can cross it —
       * and ignoring the number Telegram hands back is how a broadcast gets the
       * whole bot throttled for everybody. */
      const wait =
        outcome.failure === 'RATE_LIMITED'
          ? Math.min(60, outcome.retryAfterSeconds ?? 30) * 1000
          : SEND_INTERVAL_MS;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }

    /* Filed against the operator, like every other thing they do that is not
     * done *to* one tenant. Awaited rather than emitted: this reached real
     * people's phones, and a record of who sent what is the only thing that
     * makes a broadcast tool answerable. */
    await this.audit.record({
      ...fileAgainst(actor),
      action: 'admin.broadcast_sent',
      entity: 'Platform',
      after: {
        operator: actor.email,
        planCode: input.planCode ?? null,
        workspaces: input.workspaceIds?.length ?? null,
        eligible: result.eligible,
        sent: result.sent,
        failed: result.failed,
        /* The message itself, so "what did we tell them?" is answerable months
         * later without anybody having kept a copy. */
        message,
      },
    });

    this.logger.log(`Broadcast by ${actor.email}: ${result.sent} sent, ${result.failed} failed`);
    return result;
  }

  /** How many people a broadcast could reach right now, for the admin screen. */
  async reach(): Promise<{ connected: number; workspaces: number }> {
    const rows = await this.prisma.telegramConnection.findMany({
      where: {
        isEnabled: true,
        chatId: { not: null },
        status: 'ACTIVE',
        workspace: { deletedAt: null, status: 'ACTIVE' },
      },
      select: { workspaceId: true },
    });
    return { connected: rows.length, workspaces: new Set(rows.map((r) => r.workspaceId)).size };
  }
}
