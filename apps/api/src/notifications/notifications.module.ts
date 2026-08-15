import { Module } from '@nestjs/common';
import { RenewalReminderService } from '../renewals/renewal-reminder.service';
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
  /* The renewal reminder lives here rather than in `RenewalsModule`: it needs
     the Telegram client, which this module owns, and importing this module
     from there to get it would be a cycle. Renewals keep their CRUD; the thing
     that *sends* is a notification. */
  providers: [TelegramClient, CardRemindersService, RenewalReminderService, ReminderScheduler],
  /* `TelegramClient` is exported so the admin broadcast can reuse the bot that
   * already delivers reminders — one bot, one token, one rate budget. */
  exports: [CardRemindersService, TelegramClient],
})
export class NotificationsModule {}
