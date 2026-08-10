/**
 * The shapes `mail-accounts` and `mail-messages` return.
 *
 * Hand-written mirrors of `MailAccountView` / `MailMessageView` in
 * `apps/api/src/mail-accounts/`, the same way `(shell)/inbox/types.ts` mirrors
 * the ingestion DTOs. The API is a separate deployable and the web app does not
 * import from it; a shape that drifts is caught by the first screen that reads a
 * field the server stopped sending, which is what the null-tolerant types below
 * are for.
 */

/** Only `IMAP` can actually be connected today — see `MailProviderFactory`. */
export type MailProviderKind = 'IMAP' | 'GMAIL_OAUTH' | 'OUTLOOK_OAUTH';

/**
 * `AUTH_FAILED` is the worker's word, not a person's: the API refuses to let a
 * client set it, and the only way out of it is a password that verifies.
 */
export type MailAccountStatus = 'ACTIVE' | 'AUTH_FAILED' | 'DISABLED';

/**
 * Four, not the three the reading screen was first sketched with.
 *
 * `ARCHIVE` is real and carries traffic: the IMAP provider maps Gmail's `\All`
 * special-use flag onto it, so for a Gmail mailbox that folder holds nearly
 * everything. A screen with no আর্কাইভ tab would show a Gmail user a fraction of
 * their own synced mail and give them no way to reach the rest.
 */
export type MailFolder = 'INBOX' | 'SENT' | 'DRAFTS' | 'ARCHIVE';

export interface MailAccountView {
  id: string;
  provider: MailProviderKind;
  email: string;
  imapHost: string | null;
  imapPort: number | null;
  status: MailAccountStatus;
  /** Why the last sweep failed, already in Bengali, written by the worker. */
  lastError: string | null;
  /** Null means this mailbox has never been read, not "read and found nothing". */
  lastSyncAt: string | null;
  /** `YYYY-MM-DD`. Mail older than this is never fetched, so it explains an empty list. */
  syncSince: string | null;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface MailMessageView {
  id: string;
  mailAccountId: string;
  folder: MailFolder;
  externalId: string;
  fromAddress: string | null;
  toAddress: string | null;
  subject: string | null;
  snippet: string | null;
  receivedAt: string;
  isRead: boolean;
  createdAt: string;
}

/**
 * One message, with its text.
 *
 * `body` is **plain text** — the API converts HTML to text on the way in so that
 * no markup is ever stored. It must reach the screen as a text node. See the
 * comment on `MessageBody` in `parts.tsx`, which is the only place this field is
 * rendered.
 */
export interface MailMessageDetailView extends MailMessageView {
  body: string | null;
}

export interface MailMessagePage {
  items: MailMessageView[];
  nextCursor: string | null;
}
