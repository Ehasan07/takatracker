import { Injectable, Logger } from '@nestjs/common';
import type { MailFolder, MailProvider as MailProviderKind } from '@prisma/client';
import { ImapFlow, type FetchMessageObject, type ListResponse } from 'imapflow';
import { simpleParser } from 'mailparser';
import { htmlToPlainText, plainTextSnippet } from './mail-body';
import {
  MailAuthError,
  MailTransientError,
  type FetchedMessage,
  type MailConnectionConfig,
  type MailProvider,
  type MailSession,
} from './mail-provider';

/**
 * IMAP over TLS, on `imapflow`.
 *
 * ## Who this is for
 *
 * cPanel, Dovecot, Zoho, Fastmail, and the small Bangladeshi hosts a lot of
 * businesses here actually use. For those accounts this is the only mechanism
 * that will ever exist, and it works well.
 *
 * It is **not** the path to Microsoft. Microsoft finished disabling basic
 * authentication for IMAP on Exchange Online in 2022–23 and removed it for
 * personal Outlook accounts in 2024, so an `@outlook.com`, `@hotmail.com`,
 * `@live.com` or Microsoft 365 address can only ever fail here — after a full
 * connect-and-authenticate round trip that ends in "authentication failed",
 * which would send the user off resetting a password that was never the
 * problem. `MailAccountsService` refuses those addresses at connect time
 * instead; see `isMicrosoftMailbox` and `MICROSOFT_REFUSAL` there. This file is
 * the reason that guard exists.
 *
 * Google still allows IMAP with an app password, but only with 2-Step
 * Verification on, and a Workspace admin can switch app passwords off for the
 * whole tenant. Treat it as working today and unreliable later — `GMAIL_OAUTH`
 * is the one that lasts.
 *
 * ## Bounding a mailbox we do not control
 *
 * A mail server is a third party, and a hostile or simply broken one can hold a
 * socket open forever, announce a 200 MB message, advertise ten thousand
 * folders, or send a line that never terminates. Every one of those is bounded
 * here rather than trusted:
 *
 *  - **Time** — `connectionTimeout` covers DNS, TCP and TLS as one budget;
 *    `greetingTimeout` covers a server that accepts a connection and then says
 *    nothing; `socketTimeout` kills a stalled command mid-flight. Tight for
 *    `verify()`, which a person is waiting on, looser for the worker.
 *  - **Bytes** — `maxLineLength`, `maxLiteralSize` and `maxResponseSize` cap
 *    what one response may allocate, and the message body is fetched with an
 *    explicit `maxLength` so a 200 MB message costs us 256 KB and no more.
 *  - **Count** — the folder scan stops after `MAX_LIST_ENTRIES`, and a search
 *    result is sliced to the newest `limit` UIDs before a single message is
 *    fetched.
 *  - **The sweep** — one account cannot stall the other twenty-four:
 *    `MailSyncService` runs each account under its own wall-clock budget, and
 *    every timeout here is well inside it.
 *
 * ## Two things about correctness
 *
 * **Mailboxes are opened read-only.** `mailboxOpen(path, { readOnly: true })`
 * issues `EXAMINE`, not `SELECT`. Reading somebody's mail must not mark it read,
 * and a `SELECT` on a mailbox with `\Deleted` messages can trigger an implicit
 * expunge on some servers. We are a reader; nothing here may change what is in
 * the user's mailbox.
 *
 * **`externalId` is `<uidValidity>:<uid>`.** A UID is unique within a mailbox
 * but only for as long as `UIDVALIDITY` holds; when a server renumbers, the old
 * UIDs mean nothing. Prefixing with `UIDVALIDITY` means a renumber produces new
 * ids and the folder is re-read — the correct response to the server telling us
 * our ids are void. `Message-ID` was the alternative and is worse: it is
 * attacker-controlled and duplicated often enough (a message filed twice, a
 * broken sender) that two real messages would collide onto one row and one of
 * them would be lost. A duplicate row is visible and annoying; a lost message is
 * neither.
 */

// --- bounds ------------------------------------------------------------------

/**
 * Timeouts for `verify()`. A person is watching a spinner, and
 * `MailAccountsService` races the whole call against `VERIFY_TIMEOUT_MS`
 * (10 s) — everything here has to fit inside that with room to report a real
 * error rather than being cut off by the outer race.
 */
const VERIFY_TIMEOUTS = {
  connectionTimeout: 6_000,
  greetingTimeout: 4_000,
  socketTimeout: 8_000,
} as const;

/**
 * Timeouts for the worker. Nobody is waiting, so a slow server on a bad link
 * gets more room — but `socketTimeout` is inactivity, not total duration, and
 * the per-account budget in `MailSyncService` is the real ceiling.
 */
const SYNC_TIMEOUTS = {
  connectionTimeout: 15_000,
  greetingTimeout: 10_000,
  socketTimeout: 45_000,
} as const;

/**
 * Memory bounds handed to `imapflow`, well under its 1–2 GB defaults.
 *
 * The defaults exist to avoid breaking exotic-but-legitimate servers. We are not
 * a general-purpose mail client: we fetch envelopes and a capped prefix of the
 * source, so nothing legitimate comes close to these, and anything that does is
 * a server we should be hanging up on.
 */
const MAX_LINE_BYTES = 256 * 1024;
const MAX_LITERAL_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * How much of one message we download.
 *
 * 256 KB of a message is the first few body parts, and in a `multipart/
 * alternative` the plain-text alternative comes first — RFC 2046 orders parts
 * least-rich first, and every real mailer follows it. So the text we want is at
 * the front and the megabytes of HTML, images and attachments we do not want are
 * behind it. `simpleParser` is a streaming parser and handles a source cut off
 * mid-part without complaint.
 *
 * The headers are taken from the IMAP `ENVELOPE` rather than from this
 * truncated source, so a subject line is never a casualty of the cut.
 */
const MAX_SOURCE_BYTES = 256 * 1024;

/** Stop scanning a `LIST` response after this many entries. */
const MAX_LIST_ENTRIES = 500;

/** Hard ceiling on UIDs considered in one folder, before `limit` is applied. */
const MAX_UIDS_CONSIDERED = 2_000;

/** Longest body we hand back. `MailSyncService` clamps again on write. */
const MAX_BODY_CHARS = 64_000;

/** Longest `toAddress` we assemble before giving up on listing more recipients. */
const MAX_RECIPIENTS = 5;

// --- folder mapping ------------------------------------------------------------

/**
 * IMAP special-use flags (RFC 6154) to our four folders.
 *
 * `\All` maps to `ARCHIVE` for Gmail's sake: Gmail has no real Archive folder,
 * it has "All Mail", and that is the closest honest equivalent. `\Junk`,
 * `\Trash` and `\Flagged` map to nothing and are skipped — a spam folder is not
 * something this product should be storing.
 */
const SPECIAL_USE_FOLDERS: ReadonlyMap<string, MailFolder> = new Map([
  ['\\Inbox', 'INBOX'],
  ['\\Sent', 'SENT'],
  ['\\Drafts', 'DRAFTS'],
  ['\\Archive', 'ARCHIVE'],
  ['\\All', 'ARCHIVE'],
]);

/**
 * Fallback for servers with no SPECIAL-USE extension, matched on the folder's
 * own name, case-insensitively.
 *
 * English only, and deliberately so. A localised match is a guess — "Enviados"
 * is Sent in Spanish and also a perfectly good name for a user's own folder —
 * and mapping a personal folder onto `SENT` would file somebody's mail under a
 * label that means something else. An unrecognised folder is simply not synced,
 * which is a small loss and an honest one.
 */
const NAME_FOLDERS: ReadonlyMap<string, MailFolder> = new Map([
  ['inbox', 'INBOX'],
  ['sent', 'SENT'],
  ['sent items', 'SENT'],
  ['sent mail', 'SENT'],
  ['drafts', 'DRAFTS'],
  ['draft', 'DRAFTS'],
  ['archive', 'ARCHIVE'],
  ['all mail', 'ARCHIVE'],
]);

@Injectable()
export class ImapMailProvider implements MailProvider {
  private readonly logger = new Logger(ImapMailProvider.name);

  readonly kind: MailProviderKind = 'IMAP';

  /** Implemented. Both OAuth providers still carry a reason; this one does not. */
  readonly unavailableReason: string | null = null;

  /**
   * Connect, authenticate, hang up.
   *
   * `verifyOnly` tells `imapflow` to log out the moment authentication succeeds,
   * so this is the smallest possible round trip: no mailbox is opened and not a
   * byte of anyone's mail is fetched to answer "does this password work?".
   */
  async verify(config: MailConnectionConfig): Promise<void> {
    const client = this.clientFor(config, VERIFY_TIMEOUTS, { verifyOnly: true });

    try {
      await client.connect();
    } catch (err) {
      throw classify(err, config);
    } finally {
      // `verifyOnly` has usually closed it already; both calls are safe twice.
      await quietly(client);
    }
  }

  async open(config: MailConnectionConfig): Promise<MailSession> {
    const client = this.clientFor(config, SYNC_TIMEOUTS, {});

    try {
      await client.connect();
    } catch (err) {
      await quietly(client);
      throw classify(err, config);
    }

    return new ImapSession(client, config, this.logger);
  }

  /**
   * `secure` follows the port, which is the convention every mail client uses:
   * 993 is implicit TLS, anything else starts in cleartext. It is not a downgrade
   * — with `secure: false` `imapflow` still performs STARTTLS whenever the server
   * advertises it, so a 143 connection to a properly configured host is
   * encrypted too. What it does mean is that a host offering *neither* is
   * allowed, which is the right call for the self-hosted and LAN mail servers
   * this provider exists to serve; refusing them would remove the only option
   * some users have.
   */
  private clientFor(
    config: MailConnectionConfig,
    timeouts: typeof VERIFY_TIMEOUTS | typeof SYNC_TIMEOUTS,
    extra: { verifyOnly?: boolean },
  ): ImapFlow {
    if (config.secret.kind !== 'IMAP') {
      // Unreachable via the factory; a wrong secret on an IMAP row is corruption.
      throw new MailTransientError(
        `Expected an IMAP secret, got ${config.secret.kind}`,
        'মেইলবক্সের সংযোগ তথ্য ঠিক নেই। আবার যুক্ত করুন।',
      );
    }
    const host = config.host?.trim();
    if (!host) {
      throw new MailTransientError(
        'No IMAP host configured',
        'IMAP সার্ভারের ঠিকানা দেওয়া হয়নি।',
      );
    }
    const port = config.port ?? 993;

    return new ImapFlow({
      host,
      port,
      secure: port === 993,
      auth: { user: config.secret.username || config.email, pass: config.secret.password },
      ...timeouts,
      ...extra,
      maxLineLength: MAX_LINE_BYTES,
      maxLiteralSize: MAX_LITERAL_BYTES,
      maxResponseSize: MAX_RESPONSE_BYTES,
      /* Nothing from a mail server goes to our logs. `imapflow`'s logger prints
       * protocol traffic, and IMAP protocol traffic contains the LOGIN command —
       * that is the user's password in a log file, forever. */
      logger: false,
      /* We poll on a schedule and close. An IDLE started automatically on
       * connect would hold the socket open and keep the sweep from finishing. */
      disableAutoIdle: true,
      clientInfo: { name: 'Hishab', vendor: 'Hishab' },
    });
  }
}

/**
 * One authenticated connection.
 *
 * Holds the folder map that `listFolders` builds, because `fetchSince` takes a
 * `MailFolder` and the server wants a path — and those are different things on
 * every server (`[Gmail]/Sent Mail`, `INBOX.Sent`, `Sent Items`).
 */
class ImapSession implements MailSession {
  private folderPaths: Map<MailFolder, string> | null = null;
  private closed = false;

  constructor(
    private readonly client: ImapFlow,
    private readonly config: MailConnectionConfig,
    private readonly logger: Logger,
  ) {}

  async listFolders(): Promise<MailFolder[]> {
    const paths = await this.resolveFolders();
    return [...paths.keys()];
  }

  /**
   * The messages in one folder since a date, newest first.
   *
   * The shape of this is dictated by IMAP more than by taste:
   *
   *  1. **`SEARCH SINCE` is day-granular.** The IMAP grammar takes a date, not a
   *     timestamp, and compares it against the server's own `INTERNALDATE` in
   *     the server's timezone. So the search is floored to the start of the UTC
   *     day *before* `since` — deliberately too wide — and the real cutoff is
   *     applied in memory afterwards. Flooring the other way would silently drop
   *     everything that arrived earlier on the same day.
   *  2. **Search first, fetch second.** `SEARCH` returns UIDs and nothing else,
   *     so the expensive `FETCH` only ever runs against the newest `limit` of
   *     them. Fetching first and filtering after would download a year of mail
   *     to keep a hundred messages.
   *  3. **Highest UID is newest.** UIDs are assigned in ascending arrival order
   *     within a mailbox, so the tail of the search result is the recent end.
   */
  async fetchSince(
    folder: MailFolder,
    since: Date | null,
    limit: number,
  ): Promise<FetchedMessage[]> {
    if (limit <= 0) return [];

    const paths = await this.resolveFolders();
    const path = paths.get(folder);
    // The mailbox does not have this folder. Not an error; most do not have all four.
    if (!path) return [];

    let mailbox;
    try {
      // EXAMINE, not SELECT. We never modify the user's mailbox.
      mailbox = await this.client.mailboxOpen(path, { readOnly: true });
    } catch (err) {
      /* A folder that vanished or that we cannot open must not fail the whole
       * account — the other three folders are still worth reading. */
      this.logger.warn(`Skipping folder ${folder}: ${(err as Error).message}`);
      return [];
    }

    try {
      if (mailbox.exists === 0) return [];

      const searchSince = since ? startOfUtcDay(since) : undefined;
      const found = await this.client.search(searchSince ? { since: searchSince } : { all: true }, {
        uid: true,
      });
      // `false` means the server refused the search, not that nothing matched.
      if (!found || !Array.isArray(found) || found.length === 0) return [];

      const considered = found.slice(-MAX_UIDS_CONSIDERED);
      const uids = considered.slice(-limit);
      if (uids.length === 0) return [];

      const cutoff = since ? since.getTime() : null;
      const messages: FetchedMessage[] = [];

      for await (const raw of this.client.fetch(
        uids,
        {
          uid: true,
          flags: true,
          envelope: true,
          internalDate: true,
          size: true,
          // The one unbounded thing a server could send us, explicitly bounded.
          source: { maxLength: MAX_SOURCE_BYTES },
        },
        { uid: true },
      )) {
        const message = await this.toFetchedMessage(raw, mailbox.uidValidity);
        if (!message) continue;
        // The in-memory half of the day-granularity fix.
        if (cutoff !== null && message.receivedAt.getTime() < cutoff) continue;
        messages.push(message);
      }

      messages.sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
      return messages.slice(0, limit);
    } catch (err) {
      throw classify(err, this.config);
    } finally {
      try {
        await this.client.mailboxClose();
      } catch {
        /* Closing a mailbox we have already read is not worth a failure. */
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await quietly(this.client);
  }

  /**
   * Map the server's folders onto our four, once per session.
   *
   * First match wins, and `\Noselect` containers are skipped — on a Dovecot
   * server `INBOX.` is a namespace node, not a mailbox, and opening it fails.
   * The scan stops after `MAX_LIST_ENTRIES` so a server advertising ten thousand
   * folders costs a bounded walk rather than an unbounded one.
   */
  private async resolveFolders(): Promise<Map<MailFolder, string>> {
    if (this.folderPaths) return this.folderPaths;

    let listing: ListResponse[];
    try {
      listing = await this.client.list();
    } catch (err) {
      throw classify(err, this.config);
    }

    const paths = new Map<MailFolder, string>();
    for (const entry of listing.slice(0, MAX_LIST_ENTRIES)) {
      if (entry.flags?.has('\\Noselect')) continue;

      const folder =
        (entry.specialUse ? SPECIAL_USE_FOLDERS.get(entry.specialUse) : undefined) ??
        NAME_FOLDERS.get(entry.path.trim().toLowerCase()) ??
        NAME_FOLDERS.get(entry.name.trim().toLowerCase());

      if (folder && !paths.has(folder)) paths.set(folder, entry.path);
      // Every folder we care about is found; no reason to walk the rest.
      if (paths.size === SPECIAL_USE_FOLDERS.size) break;
    }

    if (listing.length > MAX_LIST_ENTRIES) {
      this.logger.warn(
        `Mailbox ${this.config.email} advertised ${listing.length} folders; scanned the first ${MAX_LIST_ENTRIES}`,
      );
    }

    this.folderPaths = paths;
    return paths;
  }

  /**
   * One IMAP response into one `FetchedMessage`.
   *
   * Headers come from the `ENVELOPE` — already decoded from RFC 2047 by
   * `imapflow`, and unaffected by the source truncation. Only the body comes
   * from parsing the source, and a parse failure costs the body rather than the
   * message: an entry with a subject and a sender and no text is still something
   * a person can recognise in a list, and dropping it entirely would hide mail
   * that exists.
   */
  private async toFetchedMessage(
    raw: FetchMessageObject,
    uidValidity: bigint,
  ): Promise<FetchedMessage | null> {
    if (!raw.uid) return null;

    const envelope = raw.envelope;
    const receivedAt = coerceDate(raw.internalDate) ?? coerceDate(envelope?.date) ?? new Date();

    let body: string | null = null;
    if (raw.source && raw.source.length > 0) {
      try {
        const parsed = await simpleParser(raw.source, {
          // Attachments are not stored and parsing them is pure cost.
          skipImageLinks: true,
          skipHtmlToText: true,
          skipTextToHtml: true,
        });
        body = bodyTextOf(parsed.text, parsed.html);
      } catch (err) {
        this.logger.warn(
          `Could not parse message body (uid ${raw.uid}): ${(err as Error).message}`,
        );
      }
    }

    return {
      externalId: `${uidValidity.toString()}:${raw.uid}`,
      fromAddress: envelope?.from?.[0]?.address?.trim() || null,
      toAddress:
        envelope?.to
          ?.slice(0, MAX_RECIPIENTS)
          .map((entry) => entry.address?.trim())
          .filter((address): address is string => Boolean(address))
          .join(', ') || null,
      subject: envelope?.subject?.trim() || null,
      snippet: body ? plainTextSnippet(body) : null,
      body,
      receivedAt,
      isRead: raw.flags?.has('\\Seen') ?? false,
    };
  }
}

// --- helpers -------------------------------------------------------------------

/**
 * The stored body is **always plain text and never markup**.
 *
 * A text/plain part is used as-is. An HTML-only message — which most bank
 * statements and every marketing mail is — is converted to text by
 * `htmlToPlainText`, not sanitised and stored as HTML. See `mail-body.ts` for
 * why that direction was chosen.
 */
function bodyTextOf(text: string | undefined, html: string | false): string | null {
  const plain = text?.trim();
  if (plain) return plain.slice(0, MAX_BODY_CHARS);
  if (typeof html === 'string' && html.trim() !== '') {
    const converted = htmlToPlainText(html);
    return converted ? converted.slice(0, MAX_BODY_CHARS) : null;
  }
  return null;
}

/** IMAP `SEARCH SINCE` takes a date. Floor deliberately wide; filter precisely later. */
function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** `internalDate` is typed `Date | string`, and a bad server can send an unparseable one. */
function coerceDate(value: Date | string | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Hang up without letting the hang-up itself become the failure. */
async function quietly(client: ImapFlow): Promise<void> {
  try {
    await client.logout();
  } catch {
    try {
      // Not a graceful LOGOUT, but the socket must not be left open.
      client.close();
    } catch {
      /* deliberately ignored */
    }
  }
}

/**
 * Wrong password, or a bad link? Everything downstream turns on this.
 *
 * Get it backwards in one direction and a network blip disables a working
 * mailbox. Get it backwards in the other and we re-present a rejected password
 * every fifteen minutes until the provider locks the user's whole account out —
 * which on Google means their mail, their files and their phone, not just us.
 * So the auth side is matched narrowly and explicitly, and **everything
 * unrecognised is treated as transient**: the cost of a wrong "transient" is one
 * wasted retry, and the cost of a wrong "auth failed" is a user retyping a
 * password that was never broken.
 *
 * ## `instanceof` is not available here
 *
 * `imapflow`'s type declarations export an `AuthenticationFailure` class, but
 * the CommonJS module does **not** export it at runtime —
 * `Object.keys(require('imapflow'))` is `['ImapFlow']` and nothing else. Writing
 * `err instanceof AuthenticationFailure` type-checks cleanly and then throws
 * `Right-hand side of 'instanceof' is not callable` the first time a mailbox
 * rejects a password, in production, on the one path that must not break. The
 * class sets `authenticationFailed = true` as an instance field, so that is what
 * is matched, with the server's own response code as a second signal.
 */
function classify(err: unknown, config: MailConnectionConfig): MailAuthError | MailTransientError {
  const error = err as
    | {
        authenticationFailed?: boolean;
        serverResponseCode?: string;
        code?: string;
        message?: string;
      }
    | undefined;
  const detail = error?.message ?? String(err);
  const code = error?.serverResponseCode ?? error?.code ?? '';

  if (error?.authenticationFailed === true || code === 'AUTHENTICATIONFAILED') {
    return new MailAuthError(
      `IMAP authentication failed for ${config.email}: ${detail}`,
      'ইমেইল ঠিকানা বা পাসওয়ার্ড মেলেনি। Gmail হলে অ্যাপ পাসওয়ার্ড ব্যবহার করুন।',
    );
  }

  /* A mailbox the server will not let us open is an authorisation problem, not a
   * transient one, and retrying cannot fix it. It is rare enough — a disabled
   * IMAP service on an otherwise valid account — that lumping it in with the
   * password case gives the user the more useful prompt of the two. */
  if (code === 'AUTHORIZATIONFAILED' || code === 'NOPERM') {
    return new MailAuthError(
      `IMAP authorisation refused for ${config.email}: ${detail}`,
      'এই অ্যাকাউন্টে IMAP সুবিধা চালু নেই। ইমেইল সরবরাহকারীর সেটিংসে চালু করুন।',
    );
  }

  return new MailTransientError(
    `IMAP connection to ${config.host ?? '?'} failed: ${detail}`,
    'মেইল সার্ভারে সংযোগ করা যায়নি। ঠিকানা ও পোর্ট দেখে আবার চেষ্টা করুন।',
  );
}
