import { Module } from '@nestjs/common';
import { TransactionsModule } from '../transactions/transactions.module';
import { SavingsController } from './savings.controller';
import { SavingsService } from './savings.service';

/**
 * `TransactionsModule` is here for the profit payout: recording what a DPS or
 * Sanchayapatra paid books an income row, and it goes through
 * `TransactionsService.create` rather than writing entries directly, so it gets
 * the same double-entry expansion, the same ownership checks and the same
 * entitlement metering as a transaction typed by hand.
 */
@Module({
  imports: [TransactionsModule],
  controllers: [SavingsController],
  providers: [SavingsService],
  exports: [SavingsService],
})
export class SavingsModule {}
