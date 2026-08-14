import { Module, forwardRef } from '@nestjs/common';
import { TransactionsModule } from '../transactions/transactions.module';
import { AccountStatementService } from './account-statement.service';
import { AccountsController } from './accounts.controller';
import { AccountsService } from './accounts.service';

@Module({
  imports: [forwardRef(() => TransactionsModule)],
  controllers: [AccountsController],
  providers: [AccountsService, AccountStatementService],
  exports: [AccountsService, AccountStatementService],
})
export class AccountsModule {}
