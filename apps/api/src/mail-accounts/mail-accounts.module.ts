import { Module } from '@nestjs/common';
import { IngestionModule } from '../ingestion/ingestion.module';
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
 * One import, and it is the seam this module was always going to grow. Prisma,
 * audit and entitlements are global; `IngestionModule` is here because a synced
 * message now becomes a `TransactionDraft` exactly as a forwarded SMS does —
 * same parser registry, same dedup key, same review inbox, same audit action,
 * same rule that **nothing becomes a transaction until a human accepts it**.
 *
 * The dependency points this way round on purpose. Ingestion knows nothing about
 * mailboxes and must not: it is the shared pipeline, and every new source —
 * SMS today, mail now, a bank's own webhook later — is a caller of it rather
 * than a branch inside it. A second review queue for email would have avoided
 * this import and been twice the code and a worse product.
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
  imports: [IngestionModule],
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
