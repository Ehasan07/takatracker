import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { SplitController } from './split.controller';
import { SplitService } from './split.service';

/**
 * AccountsModule for two things: the nominal expense account that the owner's
 * own share is debited to, and the receivable/payable control accounts that
 * carry everybody else's — the same pair the loan ledger posts to, on purpose.
 */
@Module({
  imports: [AccountsModule],
  controllers: [SplitController],
  providers: [SplitService],
  exports: [SplitService],
})
export class SplitModule {}
