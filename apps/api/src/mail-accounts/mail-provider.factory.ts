import { Injectable } from '@nestjs/common';
import type { MailProvider as MailProviderKind } from '@prisma/client';
import { ImapMailProvider } from './imap.provider';
import { GmailOAuthProvider, OutlookOAuthProvider } from './oauth.provider';
import type { MailProvider } from './mail-provider';

/**
 * Enum value in, provider out.
 *
 * One `switch` and no registry object, because the enum is closed: adding a
 * fourth `MailProvider` value means a migration, and this switch failing to
 * compile at that moment is the reminder you want. `noFallthroughCasesInSwitch`
 * and the exhaustive return type together mean a new enum member cannot be
 * quietly forgotten here.
 *
 * It is a Nest provider rather than a bare function so a test module can swap
 * the whole thing with `overrideProvider(MailProviderFactory)` and drive the
 * sync worker against a fake mailbox — no environment flag, no branch in
 * production code that only exists for tests.
 */
@Injectable()
export class MailProviderFactory {
  constructor(
    private readonly imap: ImapMailProvider,
    private readonly gmail: GmailOAuthProvider,
    private readonly outlook: OutlookOAuthProvider,
  ) {}

  for(kind: MailProviderKind): MailProvider {
    switch (kind) {
      case 'IMAP':
        return this.imap;
      case 'GMAIL_OAUTH':
        return this.gmail;
      case 'OUTLOOK_OAUTH':
        return this.outlook;
    }
  }

  /**
   * Why this deployment cannot talk to that kind of mailbox, or null if it can.
   *
   * Read straight off the provider rather than kept in a table here — see
   * `MailProvider.unavailableReason`. IMAP answers null — it is implemented, on
   * `imapflow`. Both OAuth providers still answer with a sentence.
   *
   * The connect endpoint asks first so it can refuse with 503 and an
   * explanation, instead of letting `verify()` throw and dressing a missing
   * dependency up as a credential problem.
   */
  unavailableReason(kind: MailProviderKind): string | null {
    return this.for(kind).unavailableReason;
  }
}
