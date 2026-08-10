import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { MailSyncService } from './mail-sync.service';

/**
 * When mailboxes get read.
 *
 * A plain interval, matching `notifications/reminder.scheduler.ts` — same shape,
 * same off switch, same non-overlap guard — because the job has the same
 * property that makes that choice safe: it is idempotent. Every message is an
 * upsert on `(mailAccountId, folder, externalId)`, so a restart mid-sweep, two
 * sweeps overlapping, or a second instance of the API cannot produce a duplicate
 * row. BullMQ and a separate worker process would buy scheduling guarantees this
 * job does not need and a Redis dependency the deployment does not have.
 *
 * **Disabled under test.** `NODE_ENV === 'test' || DISABLE_MAIL_SYNC === 'true'`
 * and nothing is scheduled — no interval, no timeout, no socket. The e2e suite
 * boots the whole `AppModule`, and a worker that woke up mid-run would open TLS
 * connections to real mail servers from a test process. `requestSync` still
 * accepts and queues under test; the queue simply never drains, which is exactly
 * what a test asserting "the endpoint enqueues rather than blocking" wants to
 * see.
 */

/**
 * Fifteen minutes.
 *
 * Mail is minutes-late here and that is the deal being struck. Polling faster
 * multiplies logins against providers that count them — Gmail throttles on
 * connection rate, not just bandwidth — and IMAP `IDLE`, the only way to do
 * better, means holding a socket open per mailbox for the life of the process.
 * That is not something an HTTP API should do per tenant.
 */
const SWEEP_INTERVAL_MS = Number(process.env.MAIL_SYNC_INTERVAL_MS ?? 15 * 60 * 1000);

/** Let the app finish booting, and let a rolling deploy settle, before the first sweep. */
const FIRST_SWEEP_DELAY_MS = 60_000;

/**
 * How long a manual `POST /:id/sync` waits before the queue is drained.
 *
 * Not zero. A user tapping "sync now" three times should cause one sweep, and a
 * short delay collapses the taps into a single drain. It is also what keeps the
 * work off the request's own tick: the HTTP response has long since been written
 * by the time this fires.
 */
const MANUAL_SYNC_DELAY_MS = 2_000;

/** A stuck queue must not grow without bound. Far above any real tenant's mailbox count. */
const MAX_QUEUED = 500;

@Injectable()
export class MailSyncScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MailSyncScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private manualTimer: NodeJS.Timeout | null = null;
  private running = false;
  private enabled = false;

  /**
   * Accounts a user has explicitly asked for, ahead of the rotation.
   *
   * In-process and deliberately so. It is a *hint*, not a work log: the truth
   * about what needs syncing is in the `MailAccount` rows, and the sweep would
   * reach every one of them within an interval anyway. Losing this Set to a
   * restart costs somebody a few minutes, which is the right price for not
   * introducing a queue server. A Set, so three taps are one entry.
   */
  private readonly queued = new Set<string>();

  constructor(private readonly sync: MailSyncService) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test' || process.env.DISABLE_MAIL_SYNC === 'true') {
      return;
    }
    this.enabled = true;
    this.timer = setInterval(() => void this.tick(), SWEEP_INTERVAL_MS);
    setTimeout(() => void this.tick(), FIRST_SWEEP_DELAY_MS).unref();
    this.logger.log(`Mailbox sync sweep scheduled every ${Math.floor(SWEEP_INTERVAL_MS / 1000)}s`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.manualTimer) clearTimeout(this.manualTimer);
  }

  /**
   * Put an account at the front of the next sweep. Returns immediately.
   *
   * Called from the request path by `POST /mail-accounts/:id/sync`, which is why
   * it returns `void` and not a promise: an endpoint that could `await` this
   * would eventually be made to, and then a screen would be waiting on IMAP
   * again. The caller has already checked that the account belongs to the
   * caller's workspace — this method is given an id and trusts it, so it must
   * never be reachable from anywhere that has not.
   */
  enqueue(accountId: string): void {
    if (this.queued.size >= MAX_QUEUED) {
      this.logger.warn('Mail sync queue is full; the sweep will pick this account up in rotation');
      return;
    }
    this.queued.add(accountId);

    if (!this.enabled || this.running || this.manualTimer) return;
    this.manualTimer = setTimeout(() => {
      this.manualTimer = null;
      void this.tick();
    }, MANUAL_SYNC_DELAY_MS);
    this.manualTimer.unref();
  }

  /** Roughly when a queued account will be read, for the 202 body. */
  nextSweepInSeconds(): number {
    if (!this.enabled) return 0;
    return Math.ceil((this.queued.size > 0 ? MANUAL_SYNC_DELAY_MS : SWEEP_INTERVAL_MS) / 1000);
  }

  private async tick(): Promise<void> {
    if (this.running) return; // a slow sweep must not overlap itself
    this.running = true;

    try {
      /* Drained before the query, so an account queued *during* this sweep is
       * kept for the next one rather than silently dropped. */
      const requested = [...this.queued];
      this.queued.clear();

      const due = await this.sync.dueAccountIds();
      const ids = [...new Set([...requested, ...due])];

      let stored = 0;
      let drafted = 0;
      let failed = 0;

      for (const id of ids) {
        /* Sequential, not `Promise.all`. Twenty-five concurrent TLS handshakes
         * out of an API process is a burst that looks like an attack to some
         * providers, and the work is not urgent enough to be worth it. */
        const result = await this.sync.syncAccount(id);
        stored += result.stored;
        drafted += result.drafted;
        if (result.outcome !== 'ok' && result.outcome !== 'skipped') failed += 1;
      }

      if (stored > 0 || failed > 0) {
        /* `drafted` is in the line because it is the number somebody will
         * question first — "why is my inbox empty / full?" — and the ratio of
         * it to `stored` is the only operational read on whether the
         * eligibility rule in `mail-ingest.ts` is set anywhere near right. */
        this.logger.log(
          `Mail sync: ${stored} message(s) stored across ${ids.length} mailbox(es), ` +
            `${drafted} draft(s) for review, ${failed} failed`,
        );
      }
    } catch (err) {
      /* `syncAccount` swallows its own failures, so reaching here means the
       * *sweep* broke — the database is unreachable, most likely. Nothing to
       * record against an account; the next interval tries again. */
      this.logger.error(`Mail sync sweep failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
