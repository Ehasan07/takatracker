import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { PeopleModule } from '../people/people.module';
import { MigrationController } from './migration.controller';
import { MigrationService } from './migration.service';
import { WalletClient } from './wallet.client';

@Module({
  /* For `PeopleService`: a category that turns out to be a person is made one
     through the same path the contacts screen uses, so it gets its P-0001 code
     and its duplicate check.
   *
   * For `AccountsService.systemAccounts()`: an imported record posts against
   * the same hidden nominal accounts a hand-typed one does. */
  imports: [PeopleModule, AccountsModule],
  controllers: [MigrationController],
  providers: [MigrationService, WalletClient],
  exports: [MigrationService],
})
export class MigrationModule {}
