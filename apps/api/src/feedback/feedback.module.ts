import { Module } from '@nestjs/common';
import { SuperAdminGuard } from '../admin/super-admin.guard';
import { FeedbackAdminController } from './feedback-admin.controller';
import { FeedbackController } from './feedback.controller';
import { FeedbackService } from './feedback.service';

/**
 * Two doors onto one small table: anybody may write, only an operator may read.
 *
 * `SuperAdminGuard` is provided here rather than imported, because `AdminModule`
 * deliberately exports nothing — it is not `@Global`, and nothing outside that
 * directory is allowed to inject `AdminService`. Providing the guard class is
 * not a hole in that: it depends on `PrismaService` alone, it reads one flag,
 * and instantiating a second copy of it cannot weaken the check. The
 * alternative — exporting it from `AdminModule` — would make the admin module
 * something other modules import from, which is the shape its own comment says
 * to avoid.
 *
 * `PrismaModule` is already global, which is how the service reaches the
 * database and how the guard reaches the flag. Nothing is exported: no other
 * module has any business writing to this table on a user's behalf.
 *
 * Nothing is audited. `AUDIT_ACTIONS` is a closed union owned by the audit
 * module and every action in it is something done *to* a workspace's books;
 * feedback is neither, and the row itself — with its author, its timestamp and
 * its verbatim text — is a better record than an audit line pointing at it.
 */
@Module({
  controllers: [FeedbackController, FeedbackAdminController],
  providers: [FeedbackService, SuperAdminGuard],
})
export class FeedbackModule {}
