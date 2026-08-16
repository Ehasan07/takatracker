import { Module } from '@nestjs/common';
import { TransactionsModule } from '../transactions/transactions.module';
import { RenewalsController } from './renewals.controller';
import { RenewalsService } from './renewals.service';

/**
 * `TransactionsModule` is here for the optional fee: marking a renewal done can
 * also book the payment, and it does so through `TransactionsService.create` —
 * the same door the app's own entry sheet uses — rather than writing ledger
 * rows of its own.
 *
 * No `forwardRef`, and deliberately checked: `TransactionsModule` imports
 * `AccountsModule` and `NotificationsModule`, neither of which imports this
 * one. `NotificationsModule` *provides* `RenewalReminderService`, which is the
 * near miss — but it imports that provider's file directly, not this module,
 * and that file reaches only Prisma, the Telegram client and audit. The graph
 * stays a tree in this direction.
 */
@Module({
  imports: [TransactionsModule],
  controllers: [RenewalsController],
  providers: [RenewalsService],
  exports: [RenewalsService],
})
export class RenewalsModule {}
