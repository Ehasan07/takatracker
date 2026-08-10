import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { TagsController } from './tags.controller';
import { TagsService } from './tags.service';

/**
 * `AccountsModule` is here for `systemAccounts` — the two hidden nominal
 * accounts are what tell an income leg from an expense leg, and a tag's totals
 * are meaningless without that distinction.
 *
 * `TagsService` is exported because `ReportsService` uses `tagTotals` for
 * `GET /reports/by-tag`. Sharing that one query is deliberate: a tag list and a
 * tag report that computed their own totals would eventually disagree, and the
 * user would have no way to tell which screen was lying.
 */
@Module({
  imports: [AccountsModule],
  controllers: [TagsController],
  providers: [TagsService],
  exports: [TagsService],
})
export class TagsModule {}
