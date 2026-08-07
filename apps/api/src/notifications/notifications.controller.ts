import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { zodPipe } from '../common/zod.pipe';
import { CardRemindersService } from './card-reminders.service';

const settingsSchema = z.object({
  leadDays: z.number().int().min(1).max(28).optional(),
  autoMuteOnPayment: z.boolean().optional(),
});

const enableSchema = z.object({ enabled: z.boolean() });

@Controller('notifications/telegram')
@UseGuards(JwtAuthGuard)
export class TelegramController {
  constructor(private readonly reminders: CardRemindersService) {}

  @Get()
  status(@CurrentUser() user: AuthUser) {
    return this.reminders.status(user.workspaceId, user.id);
  }

  /** Returns the deep link the user taps. No credential is ever typed. */
  @Post('bind')
  bind(@CurrentUser() user: AuthUser) {
    return this.reminders.beginBinding(user.workspaceId, user.id);
  }

  @Post('test')
  @HttpCode(200)
  test(@CurrentUser() user: AuthUser) {
    return this.reminders.sendTest(user.workspaceId, user.id);
  }

  @Post('enabled')
  @HttpCode(200)
  async setEnabled(
    @CurrentUser() user: AuthUser,
    @Body(zodPipe(enableSchema)) body: { enabled: boolean },
  ) {
    await this.reminders.setEnabled(user.workspaceId, user.id, body.enabled);
    return { enabled: body.enabled };
  }

  @Post('settings')
  @HttpCode(200)
  async settings(
    @CurrentUser() user: AuthUser,
    @Body(zodPipe(settingsSchema)) body: z.infer<typeof settingsSchema>,
  ) {
    await this.reminders.updateSettings(user.workspaceId, body);
    return this.reminders.status(user.workspaceId, user.id);
  }

  @Delete()
  @HttpCode(204)
  async disconnect(@CurrentUser() user: AuthUser): Promise<void> {
    await this.reminders.disconnect(user.workspaceId, user.id);
  }
}

@Controller('cards')
@UseGuards(JwtAuthGuard)
export class CardRemindersController {
  constructor(private readonly reminders: CardRemindersService) {}

  /** Stop this billing cycle's reminders. Next month starts again on its own. */
  @Post(':accountId/mute-reminders')
  @HttpCode(200)
  mute(@CurrentUser() user: AuthUser, @Param('accountId') accountId: string) {
    return this.reminders.mute(user.workspaceId, user.id, accountId, 'MANUAL');
  }
}

/**
 * Telegram's own callbacks. Unauthenticated by nature, so the shared secret
 * header is the only thing standing between this and the open internet.
 */
@Controller('telegram')
export class TelegramWebhookController {
  constructor(private readonly reminders: CardRemindersService) {}

  @Post('webhook')
  @HttpCode(200)
  async webhook(
    @Headers('x-telegram-bot-api-secret-token') secret: string | undefined,
    @Body()
    update: {
      message?: { chat?: { id?: number }; text?: string };
      callback_query?: { id: string; data?: string; message?: { chat?: { id?: number } } };
    },
  ): Promise<{ ok: boolean }> {
    if (!this.reminders.verifyWebhookSecret(secret)) throw new UnauthorizedException();

    const text = update.message?.text ?? '';
    const chatId = update.message?.chat?.id;

    if (chatId && text.startsWith('/start ')) {
      await this.reminders.completeBinding(text.slice('/start '.length).trim(), String(chatId));
      return { ok: true };
    }

    const callback = update.callback_query;
    if (callback?.data?.startsWith('mute:')) {
      await this.reminders.handleMuteCallback(callback.data.slice('mute:'.length));
      return { ok: true };
    }

    // Anything else is ignored on purpose; this endpoint has no other commands.
    return { ok: true };
  }
}
