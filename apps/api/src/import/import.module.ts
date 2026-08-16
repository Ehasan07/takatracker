import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { ExportController } from './export.controller';
import { ExportService } from './export.service';
import { ImportController } from './import.controller';
import { ImportService } from './import.service';
import { StatementService } from './statement.service';

/**
 * Spreadsheet import and export.
 *
 * Import and export live together because they are one feature seen from two
 * ends: the export writes the Bengali header row that `guessMapping` reads
 * back, so a user can pull their ledger into a spreadsheet, fix a month of
 * categories by hand, and put it straight back. Splitting them across modules
 * would let the two halves drift apart with nothing to notice.
 *
 * `AccountsModule` is here for `systemAccounts()`: every imported row is an
 * ordinary income or expense and posts against the same hidden nominal accounts
 * a hand-typed one does. Prisma, audit and entitlements are all global modules.
 */
@Module({
  imports: [AccountsModule],
  controllers: [ImportController, ExportController],
  providers: [ImportService, ExportService, StatementService],
  exports: [ImportService, ExportService, StatementService],
})
export class ImportModule {}
