import { Module, forwardRef } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrepaidController } from './prepaid.controller';
import { PrepaidService } from './prepaid.service';
import { TransactionsController } from './transactions.controller';
import { TransactionsService } from './transactions.service';

/**
 * `PrepaidController` is registered *before* `TransactionsController` on
 * purpose. Nest matches routes in registration order and
 * `GET /transactions/:id` would otherwise be tried first — it cannot actually
 * swallow `prepaid/spread`, which is two segments, but keeping the specific
 * routes ahead of the parameterised ones means the next route added here does
 * not have to rediscover that.
 */
@Module({
  imports: [forwardRef(() => AccountsModule), NotificationsModule],
  controllers: [PrepaidController, TransactionsController],
  providers: [TransactionsService, PrepaidService],
  exports: [TransactionsService],
})
export class TransactionsModule {}
