import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { LoansModule } from '../loans/loans.module';
import { TagsModule } from '../tags/tags.module';
import { PartyDueController } from './party-due.controller';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  // TagsModule for `tagTotals` — see the note on `TagsModule`'s export.
  //
  // LoansModule for `LoansService.partyDues`: the party due report is the loan
  // subsidiary ledger asked of every counterparty at once, and computing it
  // here from raw rows would be a second implementation of interest, repayment
  // and settlement — one that could disagree with the screen a user opens to
  // check a figure.
  imports: [AccountsModule, TagsModule, LoansModule],
  controllers: [ReportsController, PartyDueController],
  providers: [ReportsService],
})
export class ReportsModule {}
