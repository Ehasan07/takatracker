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
  exports: [CardRemindersService],
})
export class NotificationsModule {}
