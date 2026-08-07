import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { CardRemindersService } from './card-reminders.service';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Sweeps every hour and sends to each workspace at 09:00 in its own timezone.
 *
 * A plain interval rather than a queue: the job is idempotent by the day
 * (`CardReminderCycle.lastSentOn`), so a restart, an overlap or a second
 * instance cannot produce a duplicate message. Adding BullMQ and a separate
 * worker process would buy scheduling guarantees this job does not need.
 */
@Injectable()
export class ReminderScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReminderScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly reminders: CardRemindersService) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test' || process.env.DISABLE_REMINDER_SCHEDULER === 'true') {
      return;
    }
    // Give the app a moment to finish booting before the first sweep.
    this.timer = setInterval(() => void this.tick(), HOUR_MS);
    setTimeout(() => void this.tick(), 30_000).unref();
    this.logger.log('Credit-card reminder sweep scheduled hourly');
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return; // a slow sweep must not overlap itself
    this.running = true;
    try {
      const { checked, sent } = await this.reminders.runDueReminders();
      if (sent > 0) this.logger.log(`Card reminders: ${sent} sent of ${checked} card(s) checked`);
    } catch (err) {
      this.logger.error(`Reminder sweep failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
