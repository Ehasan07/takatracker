import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { LoansController } from './loans.controller';
import { LoansService } from './loans.service';

/**
 * AccountsModule is here for `systemAccounts()`: the interest leg of a
 * repayment posts to SYSTEM_INCOME or SYSTEM_EXPENSE, the same nominal
 * accounts every ordinary income and expense entry uses.
 */
@Module({
  imports: [AccountsModule],
  controllers: [LoansController],
  providers: [LoansService],
  exports: [LoansService],
})
export class LoansModule {}
