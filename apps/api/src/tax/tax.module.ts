import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { TaxController } from './tax.controller';
import { TaxService } from './tax.service';

/**
 * Income tax: a worksheet from the books, and a figure only when a year's rates
 * have been checked against the gazette.
 *
 * `AccountsModule` is here for two reads and nothing else — `systemAccounts`,
 * which names the nominal account every income entry credits, and `balances`,
 * which gives the position on a past date for the surcharge. This module writes
 * no ledger entries and holds no `forwardRef`: `AccountsModule` reaches
 * `TransactionsModule`, and neither reaches back here.
 */
@Module({
  imports: [AccountsModule],
  controllers: [TaxController],
  providers: [TaxService],
  exports: [TaxService],
})
export class TaxModule {}
