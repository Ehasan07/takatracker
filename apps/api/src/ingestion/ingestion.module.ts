import { Module, forwardRef } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { TransactionsModule } from '../transactions/transactions.module';
import { IngestionController, IngestionWebhookController } from './ingestion.controller';
import { AiSuggestService } from './ai-suggest.service';
import { IngestionService } from './ingestion.service';

/**
 * AccountsModule is here for `systemAccounts()`: an accepted draft becomes an
 * ordinary income or expense entry and posts to the same hidden nominal
 * accounts every manual one does.
 *
 * NotificationsModule is here for `autoMuteOnPayment()`: recording money into a
 * credit card ends that cycle's reminders, and it has to do so whether the
 * entry was typed by hand or accepted from the inbox — two write paths that
 * behave differently is how a user ends up being nagged about a bill they have
 * already paid.
 *
 * Prisma, audit and entitlements are all global modules and need no import.
 *
 * The webhook controller is listed first so its literal `webhook` route is
 * matched before anything else under `/ingestion`.
 */
@Module({
  /* TransactionsModule for the forwarder entry endpoint: an entry somebody has
   * already reviewed in an outside console goes through the same
   * `TransactionsService.create` the app's own entry sheet uses, rather than
   * building its own ledger rows. Two write paths is how a ledger drifts. */
  imports: [AccountsModule, NotificationsModule, forwardRef(() => TransactionsModule)],
  controllers: [IngestionWebhookController, IngestionController],
  providers: [IngestionService, AiSuggestService],
  exports: [IngestionService, AiSuggestService],
})
export class IngestionModule {}
