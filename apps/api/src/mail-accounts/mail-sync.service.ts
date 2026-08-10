import { Injectable, Logger } from '@nestjs/common';
import type { MailAccountStatus, MailFolder } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { MAIL_SYNC_FAILED } from './mail-audit';
import { connectionConfigFor, openMailSecret } from './mail-credentials';
import {
  isMailProviderError,
  MailAuthError,
  MailProviderUnavailableError,
  withTimeout,
  type FetchedMessage,
  type MailSession,
} from './mail-provider';
import { MailProviderFactory } from './mail-provider.factory';

/**
 * Reading mailboxes. **Nothing in this file is reachable from an HTTP request.**
 *
 * That separation is the whole reason the module is shaped this way. IMAP is a
 * TLS handshake, a login, a `SEARCH` and a `FETCH` against somebody else's
 * rate-limited server; the fast case is a second and the bad case is a socket
 * that never answers. A screen that waits on it hangs, and a request thread
 * parked on it is a request thread that is not serving anyone. So the endpoints
 * read rows, this service fills them in, and `mail-sync.scheduler.ts` decides
 * when.
 *
 * Three limits keep one sweep from becoming an incident:
 *
 *  - **Per run, across all tenants** — `MAX_ACCOUNTS_PER_RUN`, oldest sync
 *    first. A thousand connected mailboxes do not all get read at 09:00.
 *  - **Per account** — `MAX_MESSAGES_PER_RUN`, and `MAX_MESSAGES_PER_FOLDER`
 *    inside that. A mailbox with a large backlog catches up over several sweeps
 *    instead of pulling everything into one transaction.
 *  - **Per account, backwards** — `syncSince`, always. Connecting a decade-old
 *    mailbox reads from the window the user chose, not from 2014.
 *
 * And one rule about the data: `workspaceId` on every row written here comes
 * from the `MailAccount` being synced and from nowhere else. There is no caller
 * to take it from — that is a property of running outside a request, not an
 * accident of this code.
 */

/**
 * How far back a mailbox with no `syncSince` is read on its first sweep.
 *
 * Thirty days is a real month of statements and receipts, which is what makes
 * the feature useful the moment it is connected, and it is a bounded amount of
 * somebody else's data to hold. The alternative default — everything — means a
 * first sync that runs for hours and a database full of mail nobody asked us to
 * keep. Exported because the connect endpoint stamps it onto new accounts, so
 * the window is visible in the API response rather than implied by the worker.
 */
export const DEFAULT_SYNC_WINDOW_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Re-read this far behind `lastSyncAt` on every incremental sweep.
 *
 * Free, and it closes a real gap: a message that arrives while a sync is running
 * would otherwise fall between the fetch and the new `lastSyncAt` and never be
 * seen again. It is free because the write is an upsert on
 * `(mailAccountId, folder, externalId)` — re-reading the same message updates a
 * row rather than duplicating it. Ten minutes also absorbs the clock skew
 * between us and a mail server, which is routinely a minute or two and
 * occasionally much worse.
 */
const SYNC_OVERLAP_MS = 10 * 60 * 1000;

const MAX_ACCOUNTS_PER_RUN = 25;
const MAX_MESSAGES_PER_RUN = 200;
const MAX_MESSAGES_PER_FOLDER = 100;

/**
 * Wall clock for one mailbox, connection through last write.
 *
 * Ninety seconds is generous for 200 messages over a healthy link and short
 * enough that all twenty-five accounts fit inside the fifteen-minute sweep
 * interval even in the pathological case where every one of them times out
 * (25 × 90 s = 37 min — which does *not* fit, and that is why the sweep's
 * non-overlap guard exists: the next tick is skipped rather than piling on).
 */
const ACCOUNT_SYNC_BUDGET_MS = 90_000;

/* Storage caps. A marketing email is routinely a megabyte of HTML and this
 * column is not an archive — it is what a person reads on a phone. Truncation is
 * silent by design: a visible "[truncated]" marker in the body would end up
 * quoted into a reply. */
const MAX_SUBJECT_CHARS = 500;
const MAX_SNIPPET_CHARS = 280;
const MAX_BODY_CHARS = 64_000;
const MAX_ADDRESS_CHARS = 320;
/** `MailAccount.lastError` is read by a human on a settings screen, not parsed. */
const MAX_ERROR_CHARS = 500;

/** What one account's sweep did, for the scheduler's log line. */
export interface AccountSyncResult {
  accountId: string;
  stored: number;
  folders: number;
  outcome: 'ok' | 'auth_failed' | 'unavailable' | 'transient' | 'skipped';
}

@Injectable()
export class MailSyncService {
  private readonly logger = new Logger(MailSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: MailProviderFactory,
    private readonly audit: AuditService,
  ) {}

  /**
   * The ids the next sweep should read, oldest first.
   *
   * `status: 'ACTIVE'` is what makes `AUTH_FAILED` mean something: an account
   * whose password was rejected is simply not in this list, so it is never
   * retried on a timer and never contributes to the provider's lockout counter.
   * It comes back when a person supplies a working password, and not before.
   */
  async dueAccountIds(limit = MAX_ACCOUNTS_PER_RUN): Promise<string[]> {
    const rows = await this.prisma.mailAccount.findMany({
      where: { deletedAt: null, status: 'ACTIVE' },
      // Nulls first: a mailbox that has never synced is the one somebody is
      // watching a spinner for.
      orderBy: [{ lastSyncAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
      take: limit,
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  /**
   * Read one mailbox.
   *
   * Never throws. Every failure is classified, written to the account so the
   * user can see it, and returned as an outcome — a sweep must not abandon
   * twenty healthy mailboxes because the twenty-first has a wrong password.
   */
  async syncAccount(accountId: string): Promise<AccountSyncResult> {
    const account = await this.prisma.mailAccount.findFirst({
      where: { id: accountId, deletedAt: null, status: 'ACTIVE' },
      select: {
        id: true,
        workspaceId: true,
        provider: true,
        email: true,
        imapHost: true,
        imapPort: true,
        secretCipher: true,
        secretIv: true,
        lastSyncAt: true,
        syncSince: true,
        lastError: true,
      },
    });

    /* Deleted, disabled or already failed between being queued and being
     * reached. Not an error: the queue is advisory and the row is the truth. */
    if (!account) return { accountId, stored: 0, folders: 0, outcome: 'skipped' };

    const startedAt = new Date();
    const since = MailSyncService.resolveSince(account.syncSince, account.lastSyncAt, startedAt);

    /* A holder rather than a bare `let`. The session is opened inside the async
     * closure below and closed in the `finally` outside it, and TypeScript's
     * control-flow analysis does not track assignments made inside a callback —
     * a plain variable narrows to `never` by the time `finally` reads it. */
    const open: { session: MailSession | null } = { session: null };

    try {
      const secret = openMailSecret(account);
      const provider = this.providers.for(account.provider);

      /* **The guarantee that one mailbox cannot stall the sweep.**
       *
       * Accounts are synced one after another, so without this a single server
       * that accepts a connection and then answers slowly — never slowly enough
       * to trip a socket-inactivity timeout, just slowly — holds up the other
       * twenty-four indefinitely. The provider sets its own connection, greeting
       * and socket timeouts, and those are the right tool for a dead link; this
       * is the wall clock for the whole conversation, which no per-command
       * timeout can bound.
       *
       * A budget hit is a `MailTransientError`, so `lastSyncAt` is left where it
       * was and the next sweep resumes the same window. A mailbox with a genuine
       * backlog therefore drains a slice at a time across several sweeps instead
       * of failing forever, and the per-run message caps mean it was going to
       * take several sweeps regardless. */
      const deadline = withTimeout(
        (async () => {
          const session = await provider.open(connectionConfigFor(account, secret));
          open.session = session;

          const folders = await session.listFolders();
          let stored = 0;

          for (const folder of folders) {
            if (stored >= MAX_MESSAGES_PER_RUN) break;
            const room = Math.min(MAX_MESSAGES_PER_FOLDER, MAX_MESSAGES_PER_RUN - stored);
            const messages = await session.fetchSince(folder, since, room);
            stored += await this.store(account.id, account.workspaceId, folder, messages);
          }

          return { stored, folders: folders.length };
        })(),
        ACCOUNT_SYNC_BUDGET_MS,
        `Sync of mailbox ${account.id}`,
      );

      const { stored, folders } = await deadline;

      /* Stamped with the moment the run *started*, not the moment it finished.
       * A sweep that took four minutes would otherwise skip anything that
       * arrived while it was running. `SYNC_OVERLAP_MS` covers the same ground
       * from the other side; between them the window can only ever be too wide,
       * and too wide costs an upsert that changes nothing. */
      await this.prisma.mailAccount.update({
        where: { id: account.id },
        data: { lastSyncAt: startedAt, lastError: null },
      });

      return { accountId, stored, folders, outcome: 'ok' };
    } catch (err) {
      return await this.recordFailure(account, err);
    } finally {
      /* Always, and it must not throw — a mail server that refuses LOGOUT has
       * still given us the messages, and losing them to a failed close would be
       * absurd. This also runs when the budget above expired, which is the point:
       * the work carries on inside its own promise, but the socket does not stay
       * open waiting for it. */
      if (open.session) {
        try {
          await open.session.close();
        } catch {
          /* deliberately ignored */
        }
      }
    }
  }

  /**
   * The earliest message this run may read.
   *
   * `syncSince` is a floor and outranks everything: it is the user's explicit
   * statement about how much of their mail we are allowed to hold, so an
   * incremental window is never widened past it, not even on a first sync.
   *
   * Above that floor the window is `lastSyncAt - SYNC_OVERLAP_MS`. With no
   * `lastSyncAt` and no `syncSince` — an account created before the connect
   * endpoint started stamping a default — it falls back to
   * `DEFAULT_SYNC_WINDOW_DAYS`, which is the same answer connect would have
   * given.
   */
  private static resolveSince(
    syncSince: Date | null,
    lastSyncAt: Date | null,
    now: Date,
  ): Date | null {
    const incremental = lastSyncAt
      ? new Date(lastSyncAt.getTime() - SYNC_OVERLAP_MS)
      : new Date(now.getTime() - DEFAULT_SYNC_WINDOW_DAYS * DAY_MS);

    if (!syncSince) return incremental;
    return incremental.getTime() > syncSince.getTime() ? incremental : syncSince;
  }

  /**
   * Write what the provider handed over.
   *
   * An upsert per message on `(mailAccountId, folder, externalId)`, which is what
   * makes a re-sync idempotent: the overlap window above re-reads messages on
   * purpose, and every one of them updates a row instead of creating a second
   * copy. `workspaceId` is passed in from the account row — a message row that
   * disagreed with its account about which tenant it belongs to would be exactly
   * the cross-tenant leak this feature must not have, so it is never taken from
   * the provider's payload.
   *
   * One bad message does not lose the batch. A provider that returns an empty
   * `externalId`, or a row that races another sweep, is skipped and logged.
   */
  private async store(
    mailAccountId: string,
    workspaceId: string,
    folder: MailFolder,
    messages: readonly FetchedMessage[],
  ): Promise<number> {
    let stored = 0;

    for (const message of messages) {
      const externalId = message.externalId?.trim();
      if (!externalId) continue;

      const fields = {
        fromAddress: clamp(message.fromAddress, MAX_ADDRESS_CHARS),
        toAddress: clamp(message.toAddress, MAX_ADDRESS_CHARS),
        subject: clamp(message.subject, MAX_SUBJECT_CHARS),
        snippet: clamp(message.snippet, MAX_SNIPPET_CHARS),
        body: clamp(message.body, MAX_BODY_CHARS),
        receivedAt: message.receivedAt,
        isRead: message.isRead,
      };

      try {
        await this.prisma.mailMessage.upsert({
          where: { mailAccountId_folder_externalId: { mailAccountId, folder, externalId } },
          create: { workspaceId, mailAccountId, folder, externalId, ...fields },
          update: fields,
        });
        stored += 1;
      } catch (err) {
        this.logger.warn(
          `Mail message ${folder}/${externalId} on account ${mailAccountId} was not stored: ` +
            `${(err as Error).message}`,
        );
      }
    }

    return stored;
  }

  /**
   * Turn a thrown thing into a status, a sentence the user can act on, and — if
   * it is news — an audit row.
   *
   * The three outcomes are genuinely different and conflating them is how this
   * feature would hurt somebody:
   *
   *  - **`MailAuthError` → `AUTH_FAILED`, and we stop.** A wrong password
   *    retried every fifteen minutes is a wrong password presented ninety-six
   *    times a day, and Gmail answers that by locking the *user's* account, not
   *    just our connection. `dueAccountIds` only selects `ACTIVE`, so setting
   *    this status is what stops the retry loop. The user sees the reason on the
   *    settings screen and fixes it with `PATCH`.
   *  - **`MailProviderUnavailableError` → status untouched.** The credentials
   *    are fine; this deployment cannot speak the protocol. Marking the mailbox
   *    `AUTH_FAILED` would tell the user their password is wrong when the
   *    missing piece is on our side, and it would make them retype a password
   *    that was never the problem.
   *  - **anything else → transient, status untouched, `lastSyncAt` untouched.**
   *    The next sweep re-covers exactly the same window, because the window is
   *    derived from a `lastSyncAt` we did not move.
   *
   * The audit row is written only when the failure is *new* — a first failure,
   * or a different message than last time. A mailbox behind a flaky link would
   * otherwise file ninety-six identical rows a day into a log whose whole value
   * is that somebody can read it.
   */
  private async recordFailure(
    account: { id: string; workspaceId: string; email: string; lastError: string | null },
    err: unknown,
  ): Promise<AccountSyncResult> {
    const known = isMailProviderError(err);
    const outcome: AccountSyncResult['outcome'] =
      err instanceof MailAuthError
        ? 'auth_failed'
        : err instanceof MailProviderUnavailableError
          ? 'unavailable'
          : 'transient';

    /* A decryption failure is not a provider error and lands here as
     * "transient", which is wrong in spirit — the key is gone or the row was
     * tampered with and no number of retries fixes it. It is still the safer
     * classification: the alternative is disabling a mailbox over what might be
     * a mis-set environment variable on one box in a rolling deploy. The log
     * line below is what makes it visible. */
    const userMessage = known
      ? err.userMessage
      : 'মেইলবক্স পড়া যায়নি। কিছুক্ষণ পর আবার চেষ্টা করা হবে।';
    const detail = err instanceof Error ? err.message : String(err);

    const status: MailAccountStatus | undefined =
      outcome === 'auth_failed' ? 'AUTH_FAILED' : undefined;

    await this.prisma.mailAccount.update({
      where: { id: account.id },
      data: {
        lastError: clamp(userMessage, MAX_ERROR_CHARS),
        ...(status ? { status } : {}),
      },
    });

    this.logger.warn(`Mail sync failed for account ${account.id} (${outcome}): ${detail}`);

    if (account.lastError !== userMessage) {
      this.audit.emit({
        workspaceId: account.workspaceId,
        actorType: 'SYSTEM',
        action: MAIL_SYNC_FAILED,
        entity: 'MailAccount',
        entityId: account.id,
        after: {
          email: account.email,
          outcome,
          /* The user-facing sentence, not `detail`. A provider's raw error can
           * echo the username or the server's banner back at us, and the audit
           * log is retained far longer than a log file. */
          reason: userMessage,
          statusChangedTo: status ?? null,
        },
      });
    }

    return { accountId: account.id, stored: 0, folders: 0, outcome };
  }
}

/** Trim to a column's budget. Null and empty both become null — an empty subject is no subject. */
function clamp(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}
