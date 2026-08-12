import { Module } from '@nestjs/common';
import { CardRemindersService } from './card-reminders.service';
import {
  CardRemindersController,
  TelegramController,
  TelegramWebhookController,
} from './notifications.controller';
import { ReminderScheduler } from './reminder.scheduler';
import { TelegramClient } from './telegram.client';

@Module({
  controllers: [TelegramController, CardRemindersController, TelegramWebhookController],
  providers: [TelegramClient, CardRemindersService, ReminderScheduler],
  /* `TelegramClient` is exported so the admin broadcast can reuse the bot that
   * already delivers reminders — one bot, one token, one rate budget. */
  exports: [CardRemindersService, TelegramClient],
})
export class NotificationsModule {}
