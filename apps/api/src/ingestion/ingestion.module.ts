import { Module, forwardRef } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { InsuranceModule } from '../insurance/insurance.module';
import { LoansModule } from '../loans/loans.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SavingsModule } from '../savings/savings.module';
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
  /* SavingsModule for `claimInstalment`: an accepted transfer into a DPS is
     that month's instalment, and the schedule has to be told or the saver is
     asked to pay money they have already paid. One-way — savings knows nothing
     of the inbox — so no forwardRef is needed. */
  /* LoansModule for ধার: a repayment read out of an SMS has to move the
     outstanding balance and close the loan when it reaches zero, and that is
     the loans module's job — the inbox only decides that this message is one.
     One-way, so no forwardRef. */
  /* InsuranceModule for premiums: an accepted receipt settles an instalment of
     a policy, and leaving that to be noticed by hand is how the বীমা screen
     ends up asking for money that was paid weeks ago. One-way, like savings. */
  imports: [
    AccountsModule,
    InsuranceModule,
    LoansModule,
    NotificationsModule,
    SavingsModule,
    forwardRef(() => TransactionsModule),
  ],
  controllers: [IngestionWebhookController, IngestionController],
  providers: [IngestionService, AiSuggestService],
  exports: [IngestionService, AiSuggestService],
})
export class IngestionModule {}
