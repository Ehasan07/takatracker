import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { TagsModule } from '../tags/tags.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  // TagsModule for `tagTotals` — see the note on `TagsModule`'s export.
  imports: [AccountsModule, TagsModule],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
