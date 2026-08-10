import type { MailProvider as MailProviderKind } from '@prisma/client';
import { decryptSecret, encryptSecret, mailSecretAad, type SealedSecret } from './mail-crypto';
import type { ImapSecret, MailConnectionConfig, MailSecret, OAuthSecret } from './mail-provider';

/**
 * The domain layer over `mail-crypto.ts`: a typed `MailSecret` in, two opaque
 * columns out, and back again.
 *
 * Separate from both the crypto and the services on purpose. `mail-crypto.ts`
 * knows about bytes and knows nothing about mailboxes; the services know about
 * mailboxes and must never be the place someone reaches for `createCipheriv`.
 * Two files need this — `mail-accounts.service.ts` when a credential is stored
 * and `mail-sync.service.ts` when one is used — and neither should own it.
 *
 * The one rule that matters here: **a `MailSecret` never leaves this process and
 * never enters a log line, a view or an audit `after` block.** Everything below
 * either produces one from the database or consumes one into a provider call.
 */

/** The columns a sealed credential occupies. Matches `MailAccount`'s two fields. */
export interface StoredSecretColumns {
  secretCipher: string;
  secretIv: string;
}

/** Enough of a `MailAccount` row to rebuild a connection. Deliberately not the whole row. */
export interface MailAccountCredentialRow extends StoredSecretColumns {
  workspaceId: string;
  provider: MailProviderKind;
  email: string;
  imapHost: string | null;
  imapPort: number | null;
}

/**
 * Seal a credential for one workspace's mailbox.
 *
 * `workspaceId` and `email` are the additional authenticated data, not just
 * arguments — see `mail-crypto.ts`. They bind the ciphertext to this tenant, so
 * a row copied into another workspace fails its tag check instead of quietly
 * working. Pass the same pair to `openMailSecret` or nothing opens.
 */
export function sealMailSecret(
  workspaceId: string,
  email: string,
  secret: MailSecret,
): StoredSecretColumns {
  const sealed: SealedSecret = encryptSecret(
    JSON.stringify(secret),
    mailSecretAad(workspaceId, email),
  );
  return { secretCipher: sealed.cipher, secretIv: sealed.iv };
}

/**
 * Open a stored credential, or throw `MailCryptoError`.
 *
 * The JSON is re-checked rather than trusted: a decrypted blob is authentic, but
 * "authentic" only means it is the one we wrote, and a row written by an older
 * shape of this code would otherwise flow into a provider as a half-empty
 * object. A mismatch between the row's `provider` column and the secret's own
 * `kind` is treated as corruption for the same reason — those two disagreeing
 * means something rewrote one of them.
 */
export function openMailSecret(row: MailAccountCredentialRow): MailSecret {
  const plain = decryptSecret(
    { cipher: row.secretCipher, iv: row.secretIv },
    mailSecretAad(row.workspaceId, row.email),
  );

  const parsed: unknown = JSON.parse(plain);
  if (!isMailSecret(parsed) || parsed.kind !== row.provider) {
    throw new Error('Stored mailbox credential does not match the account it is on');
  }
  return parsed;
}

function isMailSecret(value: unknown): value is MailSecret {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ImapSecret> & Partial<OAuthSecret>;
  if (candidate.kind === 'IMAP') {
    return typeof candidate.username === 'string' && typeof candidate.password === 'string';
  }
  if (candidate.kind === 'GMAIL_OAUTH' || candidate.kind === 'OUTLOOK_OAUTH') {
    return typeof candidate.refreshToken === 'string';
  }
  return false;
}

/** The row plus its opened secret, in the shape a provider takes. */
export function connectionConfigFor(
  row: MailAccountCredentialRow,
  secret: MailSecret,
): MailConnectionConfig {
  return {
    kind: row.provider,
    email: row.email,
    host: row.imapHost,
    port: row.imapPort,
    secret,
  };
}

/**
 * What replaces a credential when a mailbox is disconnected.
 *
 * Not null — both columns are `NOT NULL` and this change does not own the
 * schema — and not the old ciphertext either. A soft-deleted account is not
 * coming back: there is no restore endpoint, and keeping a decryptable password
 * for a mailbox the user has told us to forget is the opposite of what they
 * asked for. `openMailSecret` on one of these throws, which is the correct
 * outcome for a row nothing should be reading anyway.
 */
export const REDACTED_SECRET: StoredSecretColumns = { secretCipher: '', secretIv: '' };
