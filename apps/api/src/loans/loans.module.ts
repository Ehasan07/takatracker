import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { LoanInterestAccrualService } from './loan-interest-accrual.service';
import { LoansController } from './loans.controller';
import { LoansService } from './loans.service';

/**
 * AccountsModule is here for `systemAccounts()`: the interest accrual posts to
 * SYSTEM_INCOME or SYSTEM_EXPENSE, the same nominal accounts every ordinary
 * income and expense entry uses.
 *
 * `LoanInterestAccrualService` runs its own hourly sweep — it implements
 * `OnModuleInit`, so registering it here is what starts it. It is exported so
 * the e2e suite can drive the sweep at a date of its choosing rather than
 * waiting an hour to find out whether it works.
 */
@Module({
  imports: [AccountsModule],
  controllers: [LoansController],
  providers: [LoansService, LoanInterestAccrualService],
  exports: [LoansService, LoanInterestAccrualService],
})
export class LoansModule {}
