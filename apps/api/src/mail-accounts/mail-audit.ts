import type { AuditAction } from '../audit/audit.service';

/**
 * The audit strings this module writes.
 *
 * Connecting a mailbox hands the server a password that opens somebody's email;
 * disconnecting one destroys it. Both are events a customer will later ask about
 * — "when did this start reading my mail, and who turned it on?" — and neither
 * is answerable from the `MailAccount` row alone, because the row is gone or
 * mutated by then. A sync that fails on authentication is the third: it is the
 * only record that a credential stopped working at a particular moment, which is
 * what somebody investigating a compromised mailbox needs.
 *
 * Annotated, never `as AuditAction` — see `tags/tag-audit.ts` for why a cast
 * here would let a typo through to a row nothing ever reads back.
 */
export const MAIL_ACCOUNT_CONNECTED: AuditAction = 'mail.account_connected';
export const MAIL_ACCOUNT_DISCONNECTED: AuditAction = 'mail.account_disconnected';
export const MAIL_SYNC_FAILED: AuditAction = 'mail.sync_failed';
