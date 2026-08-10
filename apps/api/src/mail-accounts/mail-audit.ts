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
 * TODO(main): `AUDIT_ACTIONS` in audit/audit.service.ts does not carry these
 * yet, and that file belongs to another change, so each string is asserted here
 * rather than edited in there. Nothing is wrong with the rows that get written —
 * `AuditEvent.action` is a plain `String` column, no enum and no migration.
 * Delete the assertions once these are in the union:
 *
 *   mail.account_connected
 *   mail.account_disconnected
 *   mail.sync_failed
 *
 * This is the same holding pattern `admin/admin-audit.ts` uses, for the same
 * reason and with the same exit.
 */
export const MAIL_ACCOUNT_CONNECTED = 'mail.account_connected' as AuditAction;
export const MAIL_ACCOUNT_DISCONNECTED = 'mail.account_disconnected' as AuditAction;
export const MAIL_SYNC_FAILED = 'mail.sync_failed' as AuditAction;
