import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { TransactionsModule } from '../transactions/transactions.module';
import { BusinessController } from './business.controller';
import { BusinessService } from './business.service';

/**
 * `TransactionsModule` is here because the stock count writes a real ledger
 * entry and must write it the way every other entry is written — through the
 * same validation, the same metering, the same audit trail. A module that
 * reached for Prisma directly would be a second door into the ledger, and the
 * one thing this codebase does not want is two ways to post an expense.
 */
@Module({
  imports: [TransactionsModule, AuditModule],
  controllers: [BusinessController],
  providers: [BusinessService],
})
export class BusinessModule {}
