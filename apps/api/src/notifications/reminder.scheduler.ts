import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { RenewalReminderService } from '../renewals/renewal-reminder.service';
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

  constructor(
    private readonly reminders: CardRemindersService,
    /* One sweep, two questions. A second scheduler would mean a second thing to
       forget to start, and both are answering "is anything due today". */
    private readonly renewals: RenewalReminderService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test' || process.env.DISABLE_REMINDER_SCHEDULER === 'true') {
      return;
    }
    // Give the app a moment to finish booting before the first sweep.
    this.timer = setInterval(() => void this.tick(), HOUR_MS);
    setTimeout(() => void this.tick(), 30_000).unref();
    this.logger.log('Reminder sweep scheduled hourly — cards and renewals');
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return; // a slow sweep must not overlap itself
    this.running = true;
    try {
      const cards = await this.reminders.runDueReminders();
      if (cards.sent > 0) {
        this.logger.log(`Card reminders: ${cards.sent} sent of ${cards.checked} card(s) checked`);
      }

      /* Separately, so a failure in one does not silence the other — a card
         bill and a fitness certificate have nothing to do with each other. */
      try {
        const renewals = await this.renewals.runDueReminders();
        if (renewals.sent > 0) {
          this.logger.log(
            `Renewal reminders: ${renewals.sent} sent of ${renewals.checked} checked`,
          );
        }
      } catch (err) {
        this.logger.error(`Renewal sweep failed: ${(err as Error).message}`);
      }
    } catch (err) {
      this.logger.error(`Reminder sweep failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
