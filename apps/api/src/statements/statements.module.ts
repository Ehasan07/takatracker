import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { AdsModule } from '../ads/ads.module';
import { LoansModule } from '../loans/loans.module';
import { PublicStatementController } from './public-statement.controller';
import { PublicStatementService } from './public-statement.service';
import { StatementShareController } from './statement-share.controller';
import { StatementShareService } from './statement-share.service';

/**
 * Statements that leave the app.
 *
 * `LoansModule` is imported rather than reimplemented: the person ledger and
 * the loan statement a creditor reads are the same code the owner's own screens
 * call. Two implementations would eventually disagree about a balance, and the
 * copy somebody outside the workspace is holding is the worst one to be wrong.
 */
@Module({
  imports: [LoansModule, AccountsModule, AdsModule],
  controllers: [StatementShareController, PublicStatementController],
  providers: [StatementShareService, PublicStatementService],
  exports: [StatementShareService],
})
export class StatementsModule {}
