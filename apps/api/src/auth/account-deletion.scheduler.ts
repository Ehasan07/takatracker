import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { AccountDeletionService } from './account-deletion.service';

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

/**
 * Erases the accounts whose grace period has run out.
 *
 * Six-hourly rather than hourly, and a plain interval rather than a queue, for
 * the same reasons the reminder sweep uses one: the job is idempotent — a
 * second pass finds nothing left to delete — so a restart, an overlap or a
 * second instance cannot do harm. What it must never do is run *early*, and it
 * cannot: the query asks for a scheduled date already in the past.
 *
 * The first pass waits a minute after boot. A deletion is the least urgent
 * thing this process does and the most permanent, so it goes last.
 */
@Injectable()
export class AccountDeletionScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AccountDeletionScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly deletion: AccountDeletionService) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test' || process.env.DISABLE_DELETION_SWEEP === 'true') return;
    this.timer = setInterval(() => void this.tick(), SIX_HOURS_MS);
    setTimeout(() => void this.tick(), 60_000).unref();
    this.logger.log('Account erasure sweep scheduled every six hours');
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.deletion.runDueDeletions();
    } catch (err) {
      this.logger.error(`Erasure sweep failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
