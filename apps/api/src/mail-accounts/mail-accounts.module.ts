import { Module } from '@nestjs/common';
import { ImapMailProvider } from './imap.provider';
import { MailAccountsController, MailMessagesController } from './mail-accounts.controller';
import { MailAccountsService } from './mail-accounts.service';
import { MailMessagesService } from './mail-messages.service';
import { MailProviderFactory } from './mail-provider.factory';
import { MailSyncScheduler } from './mail-sync.scheduler';
import { MailSyncService } from './mail-sync.service';
import { GmailOAuthProvider, OutlookOAuthProvider } from './oauth.provider';

/**
 * The mailbox connector.
 *
 * No imports: Prisma, audit and entitlements are all global modules, and this
 * module deliberately depends on nothing else in the application. Mail is read
 * and stored; it does not create transactions, touch the ledger, or reach into
 * ingestion. Turning a message into a `TransactionDraft` is the obvious next
 * step and it belongs on the ingestion side of that seam, where a human already
 * approves every draft before it becomes an entry.
 *
 * ## Wiring
 *
 * TODO(main): `app.module.ts` is not edited by this change. Add
 * `MailAccountsModule` to its `imports` array — nothing else is needed, and
 * until then `/mail-accounts` and `/mail-messages` are not routed.
 *
 * ## The three layers, and why they are separate providers
 *
 *  - `MailAccountsService` / `MailMessagesService` — request-path. Database only.
 *  - `MailSyncService` — reads mailboxes. Never reachable from a controller.
 *  - `MailSyncScheduler` — decides when, and is the only thing holding a timer.
 *    Off entirely under `NODE_ENV=test` or `DISABLE_MAIL_SYNC=true`, so the e2e
 *    suite boots this module without any of it opening a socket.
 *
 * The provider classes are registered individually rather than behind a single
 * token so `MailProviderFactory` can inject all three and a test can override
 * exactly one. Overriding `MailProviderFactory` itself is the other seam: it is
 * how `MailSyncService` can be driven against a fake mailbox without an
 * environment flag or a branch in production code.
 */
@Module({
  controllers: [MailAccountsController, MailMessagesController],
  providers: [
    ImapMailProvider,
    GmailOAuthProvider,
    OutlookOAuthProvider,
    MailProviderFactory,
    MailSyncService,
    MailSyncScheduler,
    MailAccountsService,
    MailMessagesService,
  ],
  exports: [MailAccountsService, MailMessagesService, MailSyncService],
})
export class MailAccountsModule {}
