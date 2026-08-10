import type { MailFolder, MailProvider as MailProviderKind } from '@prisma/client';

/**
 * What a mailbox backend has to be able to do, and nothing more.
 *
 * The Prisma enum is imported as `MailProviderKind` so the name `MailProvider`
 * is free for the interface below — the enum value and the thing that implements
 * it are different concepts and reading `provider: MailProvider` on both would
 * be a running confusion.
 *
 * ## The shape, and why it is a session rather than three loose calls
 *
 * `verify(config)` stands alone: it opens a connection, authenticates, closes,
 * and answers one question — will these credentials work? It is the only method
 * an HTTP request is ever allowed to call.
 *
 * `listFolders()` and `fetchSince(folder, since, limit)` take no config because
 * they are methods on an already-authenticated session. That is not an
 * abstraction for its own sake; it is what IMAP actually is. A connection is
 * expensive to establish (TCP, TLS, LOGIN), servers cap how many a client may
 * hold, and reading three folders means three `SELECT`s down one connection, not
 * three logins. A `fetchSince(config, …)` that reconnected per call would get an
 * account rate-limited by its own provider within a day.
 *
 * So: `open(config)` hands back a `MailSession`, the session is used, and the
 * session is closed in a `finally`. Callers never hold one across an await they
 * do not control.
 *
 * ## What is deliberately not here
 *
 * No "sync this account" method, no database types, no workspace id. A provider
 * knows how to talk to a mail server and nothing about tenants, entitlements or
 * rows — `mail-sync.service.ts` owns all of that. The point of the seam is that
 * adding Gmail OAuth is a new file implementing this interface and one line in
 * the factory, with no reachable path from it to another tenant's data.
 */
export interface MailProvider {
  readonly kind: MailProviderKind;

  /**
   * Null when this deployment can actually use the provider; otherwise the
   * Bengali sentence explaining why not.
   *
   * A field rather than a `switch` somewhere else, because a capability table
   * kept apart from the capability is a table that eventually lies — it says
   * "implemented" for a class whose methods still throw, and the lie surfaces as
   * a 500 on somebody's connect form. Here, filling in a provider and marking it
   * available are the same edit.
   */
  readonly unavailableReason: string | null;

  /**
   * Can these credentials open this mailbox?
   *
   * Resolves on success and throws one of the errors below on failure — there is
   * no boolean return, because "it failed" is never enough for the user and the
   * distinction between *wrong password* and *server unreachable* decides
   * whether we mark the account `AUTH_FAILED` or retry it later.
   *
   * The one provider call permitted inside an HTTP request, and only because a
   * mailbox that cannot be reached must fail at connect time rather than
   * silently at the next sweep. Implementations must therefore bound themselves
   * with `VERIFY_TIMEOUT_MS`; a screen may not wait on a hung IMAP handshake.
   */
  verify(config: MailConnectionConfig): Promise<void>;

  /**
   * Authenticate and hand back a live session.
   *
   * Only the sync worker calls this. Whatever it returns must be closed, and
   * `close()` must be safe to call twice and must not throw.
   */
  open(config: MailConnectionConfig): Promise<MailSession>;
}

/** An authenticated connection to one mailbox. Always closed by its caller. */
export interface MailSession {
  /**
   * The folders this mailbox exposes, mapped onto the four the schema knows.
   *
   * The mapping is lossy on purpose and every real provider is different:
   * Gmail's `[Gmail]/Sent Mail`, Outlook's `Sent Items` and Dovecot's `Sent` are
   * all `SENT`, and a user's own `Receipts 2024` folder maps to nothing and is
   * simply not listed. `MailFolder` has four values; a mailbox with ninety
   * folders still reports at most four.
   */
  listFolders(): Promise<MailFolder[]>;

  /**
   * Messages in `folder` received at or after `since`, newest first, at most
   * `limit` of them.
   *
   * `since` is never null in practice — the worker always resolves one from
   * `syncSince` or `lastSyncAt` — but the signature allows it for a provider
   * that genuinely can fetch everything.
   *
   * **Day granularity is the caller's problem to absorb, not the provider's to
   * fake.** IMAP `SEARCH SINCE` takes a date, not a timestamp, and compares
   * against the server's internal date in its own timezone. An implementation
   * must therefore floor `since` to the start of its UTC day for the server-side
   * search and then discard, in memory, anything that comes back older than the
   * real `since`. Pretending to second precision would silently drop messages
   * that arrived earlier the same day.
   *
   * `limit` is a hard ceiling on what is returned, applied after that filter.
   */
  fetchSince(folder: MailFolder, since: Date | null, limit: number): Promise<FetchedMessage[]>;

  /** Idempotent, and never throws. A failed logout must not fail a sync. */
  close(): Promise<void>;
}

/**
 * Everything needed to reach one mailbox.
 *
 * Assembled by the service from the row plus the decrypted secret, and never
 * logged. A `MailConnectionConfig` in a log line is a password in a log line.
 */
export interface MailConnectionConfig {
  kind: MailProviderKind;
  /** The address, lowercased. Also the default IMAP username. */
  email: string;
  host: string | null;
  port: number | null;
  secret: MailSecret;
}

/**
 * The part of a connection that is encrypted at rest.
 *
 * A discriminated union so the OAuth variants can be added without every
 * consumer growing an optional `password`. Whatever is here is JSON-encoded and
 * sealed by `mail-crypto.ts`; the host and port are *not* here because they are
 * not secret and the UI needs to show them.
 */
export type MailSecret = ImapSecret | OAuthSecret;

export interface ImapSecret {
  kind: 'IMAP';
  /** Usually the address itself, but some hosts want a bare username. */
  username: string;
  /** An app password on Gmail; the account password on a self-hosted server. */
  password: string;
}

export interface OAuthSecret {
  kind: 'GMAIL_OAUTH' | 'OUTLOOK_OAUTH';
  /** Long-lived. Access tokens are minted from it per session and never stored. */
  refreshToken: string;
}

/** One message as a provider hands it over, before anything is written down. */
export interface FetchedMessage {
  /**
   * The provider's own stable identifier for this message in this folder.
   *
   * Uniqueness is `(mailAccountId, folder, externalId)`, so this only has to be
   * stable within a folder — which matters, because an IMAP UID is scoped to a
   * mailbox and changes if the server's `UIDVALIDITY` changes. A provider that
   * has `Message-ID` should prefer it; a UID is acceptable and a re-sync after a
   * `UIDVALIDITY` bump then re-inserts rather than updates. Duplicated rows are
   * a visible annoyance; a fabricated "unique" id that collides across two real
   * messages loses mail, which is not.
   */
  externalId: string;
  fromAddress: string | null;
  toAddress: string | null;
  subject: string | null;
  /** First few hundred characters of the text part, for the list view. */
  snippet: string | null;
  /** Plain text where available. Never the raw MIME source. */
  body: string | null;
  receivedAt: Date;
  isRead: boolean;
}

// --- failures ----------------------------------------------------------------

/**
 * The credentials were rejected.
 *
 * The one failure that must never be retried on a timer: an account that keeps
 * presenting a wrong password gets locked out by its provider, and on Gmail that
 * takes the *user's* whole account down, not just our connection. The worker
 * answers this by setting `status: AUTH_FAILED` and stopping until a person
 * intervenes.
 */
export class MailAuthError extends Error {
  constructor(
    message: string,
    /** Shown to the user, in Bengali. Stored in `MailAccount.lastError`. */
    readonly userMessage: string,
  ) {
    super(message);
    this.name = 'MailAuthError';
  }
}

/**
 * The mailbox could not be reached this time — DNS, TLS, a timeout, a 4xx rate
 * limit, a server restarting. Worth trying again on the next sweep, so the
 * account keeps its `ACTIVE` status and its `lastSyncAt` is left alone.
 */
export class MailTransientError extends Error {
  constructor(
    message: string,
    readonly userMessage: string,
  ) {
    super(message);
    this.name = 'MailTransientError';
  }
}

/**
 * This deployment cannot talk to this kind of mailbox at all.
 *
 * Not a credential problem and not a network problem: the code to do it is not
 * present. Both OAuth providers raise it always, and the IMAP provider raises it
 * until an IMAP client library is a dependency — see `imap.provider.ts`. Kept
 * distinct from the other two so the connect endpoint can answer 503 rather than
 * blaming the user's password, and so the worker does not mark a perfectly good
 * account `AUTH_FAILED` over a missing library.
 */
export class MailProviderUnavailableError extends Error {
  constructor(
    message: string,
    readonly userMessage: string,
  ) {
    super(message);
    this.name = 'MailProviderUnavailableError';
  }
}

/**
 * How long a `verify()` may hold an HTTP request open.
 *
 * Ten seconds is long for a screen and short for IMAP over a bad link. It is a
 * ceiling on the worst case, not a target: a healthy handshake is well under a
 * second, and the alternative — no bound at all — is a request thread parked on
 * a socket that a hostile or broken server never answers.
 */
export const VERIFY_TIMEOUT_MS = 10_000;

/**
 * Reject after `ms`, whatever the promise is doing.
 *
 * The underlying work is not cancelled — a promise cannot be — so a hung socket
 * stays hung until its own stack gives up. What this bounds is how long the
 * *caller* waits, and there are two callers who need that for different reasons:
 * `MailAccountsService.connect` is holding an HTTP request open, and
 * `MailSyncService.syncAccount` is holding up twenty-four other mailboxes. The
 * providers set their own socket-level timeouts as well; this is the outer
 * guarantee that does not depend on a provider remembering to.
 *
 * The timer is `unref`'d so a pending call cannot hold the process open at
 * shutdown.
 */
export function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new MailTransientError(`${label} timed out after ${ms}ms`, MAIL_TIMEOUT_MESSAGE));
    }, ms);
    timer.unref();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/** Shown when we gave up waiting. Deliberately not "wrong password". */
export const MAIL_TIMEOUT_MESSAGE = 'মেইল সার্ভার সময়মতো সাড়া দেয়নি। পরে আবার চেষ্টা করা হবে।';

/** Whether a thrown value is one of ours, for the `catch` blocks that sort them. */
export function isMailProviderError(
  err: unknown,
): err is MailAuthError | MailTransientError | MailProviderUnavailableError {
  return (
    err instanceof MailAuthError ||
    err instanceof MailTransientError ||
    err instanceof MailProviderUnavailableError
  );
}

export type { MailProviderKind };
