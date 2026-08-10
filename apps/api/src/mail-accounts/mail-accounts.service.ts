import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { fromLocalDateString, toLocalDateString } from '@hishab/shared';
import { Prisma } from '@prisma/client';
import type { MailAccountStatus, MailProvider as MailProviderKind } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../transactions/transactions.service';
import type { ConnectMailAccountInput, UpdateMailAccountInput } from './mail-accounts.controller';
import { MAIL_ACCOUNT_CONNECTED, MAIL_ACCOUNT_DISCONNECTED } from './mail-audit';
import { mailEncryptionAvailable, MAIL_KEY_ENV } from './mail-crypto';
import { REDACTED_SECRET, sealMailSecret } from './mail-credentials';
import {
  isMailProviderError,
  MailAuthError,
  MailProviderUnavailableError,
  VERIFY_TIMEOUT_MS,
  withTimeout,
  type MailConnectionConfig,
  type MailSecret,
} from './mail-provider';
import { MailProviderFactory } from './mail-provider.factory';
import { DEFAULT_SYNC_WINDOW_DAYS } from './mail-sync.service';
import { MailSyncScheduler } from './mail-sync.scheduler';

/**
 * Connecting, listing and disconnecting mailboxes.
 *
 * A sibling of `ingestion/ingestion.service.ts`, and the family resemblance is
 * intentional: both take somebody else's messages in, both refuse to let one
 * tenant see another's, and both keep the slow, untrusted part away from the
 * request path. Where ingestion waits for a forwarder to post, this one has to
 * go and fetch — which is the whole reason there is a worker.
 *
 * Three things this file is responsible for getting right.
 *
 *  1. **Every query is scoped by `ctx.workspaceId`.** Not by an id in the path,
 *     not by anything in a body. `:id` is only ever an extra `AND` on top of a
 *     `workspaceId` that came from the JWT, so another tenant's mailbox is not
 *     forbidden, it is *absent* — which is also what stops the 404/403 split
 *     from confirming that a given id exists.
 *  2. **The cipher and the IV never leave.** Reads use an explicit `select` and
 *     never `include` or a bare `findFirst`. That is the difference between "we
 *     remembered to strip it" and "it cannot be returned": a column added to
 *     `MailAccount` next year is absent from these responses by default rather
 *     than present by default.
 *  3. **`verify()` is the only outbound call, and it is bounded.** A mailbox
 *     that cannot be reached fails at connect time, where somebody is looking at
 *     the screen and can fix the typo — not silently at 03:00 as an
 *     `AUTH_FAILED` nobody notices for a week.
 */

const NOT_FOUND = 'মেইলবক্স পাওয়া যায়নি';

/**
 * Microsoft-hosted mail, which IMAP cannot serve and never will again.
 *
 * Microsoft finished disabling basic authentication for IMAP on Exchange Online
 * in 2022–23 and removed it for personal Outlook accounts in 2024. There is no
 * setting, no admin override, and no app-password equivalent. `verify()` against
 * one of these can only ever end in "authentication failed" — after a full
 * connect, TLS handshake and login round trip — and that message would send
 * somebody off resetting a password that was never the problem, possibly several
 * times.
 *
 * So it is refused up front, in under a millisecond, with a sentence that says
 * whose change this was.
 *
 * Matched two ways, because neither alone is enough. The consumer domains catch
 * personal accounts. The **host** list catches Microsoft 365 tenants on their
 * own domain — `hello@somecompany.com.bd` is invisible in the address but the
 * user still has to type `outlook.office365.com` to reach it, and that is the
 * tell.
 */
const MICROSOFT_DOMAINS: readonly string[] = [
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'passport.com',
  'windowslive.com',
];

const MICROSOFT_HOSTS: readonly string[] = [
  'outlook.office365.com',
  'outlook.office.com',
  'imap-mail.outlook.com',
  'imap.outlook.com',
  'outlook.com',
];

const MICROSOFT_REFUSAL =
  'Microsoft (Outlook / Hotmail / Live / Microsoft 365) পাসওয়ার্ড দিয়ে IMAP সংযোগ বন্ধ করে দিয়েছে — এটি আপনার পাসওয়ার্ডের সমস্যা নয়। এই মেইলবক্স এখন যুক্ত করা যাবে না।';

/**
 * True when this address or host is Microsoft-hosted.
 *
 * Suffix matching on a dot boundary, not `includes`: `includes('live.com')`
 * would also refuse `mail.notlive.company.bd`, and refusing a mailbox that would
 * have worked is the one failure mode this guard must not have.
 */
function isMicrosoftMailbox(email: string, host: string | null): boolean {
  const domain = email.split('@').pop()?.trim().toLowerCase() ?? '';
  const matches = (value: string, needles: readonly string[]): boolean =>
    needles.some((needle) => value === needle || value.endsWith(`.${needle}`));

  if (domain && matches(domain, MICROSOFT_DOMAINS)) return true;

  const hostname = host?.trim().toLowerCase().replace(/\.$/, '') ?? '';
  return hostname !== '' && matches(hostname, MICROSOFT_HOSTS);
}

/**
 * The shape every read returns.
 *
 * `secretCipher` and `secretIv` are not in it, and this is the only place a
 * `MailAccount` is selected, so they cannot be in any response.
 */
const accountSelect = {
  id: true,
  provider: true,
  email: true,
  imapHost: true,
  imapPort: true,
  status: true,
  lastError: true,
  lastSyncAt: true,
  syncSince: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { messages: true } },
} satisfies Prisma.MailAccountSelect;

type AccountRow = Prisma.MailAccountGetPayload<{ select: typeof accountSelect }>;

export interface MailAccountView {
  id: string;
  provider: MailProviderKind;
  email: string;
  imapHost: string | null;
  imapPort: number | null;
  status: MailAccountStatus;
  /**
   * Why the last sync failed, in Bengali, or null.
   *
   * On screen next to the status, always — `AUTH_FAILED` with no explanation is
   * a dead mailbox the user cannot fix. This is written by the worker and is the
   * only channel it has to reach a person.
   */
  lastError: string | null;
  lastSyncAt: string | null;
  /** `YYYY-MM-DD` in the workspace's timezone. Mail older than this is never read. */
  syncSince: string | null;
  /** How many messages have been stored from this mailbox so far. */
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class MailAccountsService {
  private readonly logger = new Logger(MailAccountsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly providers: MailProviderFactory,
    private readonly scheduler: MailSyncScheduler,
    private readonly audit: AuditService,
  ) {}

  // --- reads -------------------------------------------------------------------

  async list(ctx: TenantContext): Promise<{ items: MailAccountView[] }> {
    const rows = await this.prisma.mailAccount.findMany({
      where: { workspaceId: ctx.workspaceId, deletedAt: null },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: accountSelect,
    });
    return { items: rows.map((row) => MailAccountsService.present(row, ctx.timezone)) };
  }

  async findOne(ctx: TenantContext, id: string): Promise<MailAccountView> {
    const row = await this.requireAccount(ctx.workspaceId, id);
    return MailAccountsService.present(row, ctx.timezone);
  }

  // --- connecting ----------------------------------------------------------------

  /**
   * Add a mailbox.
   *
   * The order of the checks is the design. Cheap and local first, then the plan,
   * then the network, then the write:
   *
   *  1. Can this deployment speak the protocol at all? A 503 here costs nothing
   *     and does not blame the user's password for a missing dependency.
   *  2. Is there a key to encrypt with? Storing a credential we cannot seal is
   *     never acceptable, and finding that out *after* asking a mail server for
   *     it would mean the password had already left the building.
   *  3. Does the plan allow another mailbox? Before the network call, so a
   *     tenant at their limit is not made to wait on an IMAP handshake to be
   *     told no.
   *  4. Do the credentials work? The one outbound call, bounded.
   *  5. Seal and write.
   */
  async connect(ctx: TenantContext, input: ConnectMailAccountInput): Promise<MailAccountView> {
    const unavailable = this.providers.unavailableReason(input.provider);
    if (unavailable) throw new ServiceUnavailableException(unavailable);

    if (!mailEncryptionAvailable()) {
      /* The operator's problem, not the user's, so the log line names the
       * variable and the response does not. Telling a browser which environment
       * variable is unset on the server is free reconnaissance. */
      this.logger.error(
        `Refusing to connect a mailbox: ${MAIL_KEY_ENV} is missing or is a published placeholder, ` +
          'so the credential cannot be encrypted at rest.',
      );
      throw new ServiceUnavailableException(
        'সার্ভারে ইমেইল সংযোগের নিরাপত্তা কনফিগার করা নেই। সহায়তার জন্য যোগাযোগ করুন।',
      );
    }

    const email = input.email.trim().toLowerCase();

    /* Before anything slow. A Microsoft mailbox cannot authenticate over IMAP at
     * all, so the alternative to this line is a ten-second timeout followed by
     * "wrong password" — see `MICROSOFT_REFUSAL`. 422 rather than 401: nothing
     * is wrong with what they typed, this route simply does not exist for them. */
    if (input.provider === 'IMAP' && isMicrosoftMailbox(email, input.imapHost ?? null)) {
      throw new UnprocessableEntityException(MICROSOFT_REFUSAL);
    }

    /* A previously disconnected mailbox still occupies the `(workspaceId, email)`
     * unique key — the schema's soft delete has no partial index behind it — so
     * reconnecting one has to be an update, not an insert. It is also the
     * behaviour a user expects: "add it back" should work. */
    const existing = await this.prisma.mailAccount.findUnique({
      where: { workspaceId_email: { workspaceId: ctx.workspaceId, email } },
      select: { id: true, deletedAt: true },
    });
    if (existing && !existing.deletedAt) {
      throw new ConflictException('এই ইমেইলটি ইতিমধ্যে যুক্ত করা আছে');
    }

    /* Both checks, in this order. `assertWithinLimit` alone would tell a free
     * workspace "0/0 সীমা শেষ", which reads as a bug; `assertEnabled` says
     * plainly that the feature is not on their plan. A revived mailbox counts
     * too — `EntitlementsService.usage()` counts rows with `deletedAt: null`,
     * and undeleting one is exactly as much a new connection as inserting one. */
    await this.entitlements.assertEnabled(ctx.workspaceId, 'email.connections.max');
    await this.entitlements.assertWithinLimit(
      ctx.workspaceId,
      'email.connections.max',
      ctx.timezone,
    );

    const secret = MailAccountsService.secretFrom(input, email);
    const config: MailConnectionConfig = {
      kind: input.provider,
      email,
      host: input.imapHost?.trim() ?? null,
      port: input.imapPort,
      secret,
    };

    await this.verifyOrThrow(config);

    const sealed = sealMailSecret(ctx.workspaceId, email, secret);
    const syncSince = this.resolveSyncSince(input.syncSince, ctx.timezone);

    const data = {
      provider: input.provider,
      imapHost: config.host,
      imapPort: config.port,
      status: 'ACTIVE' as const,
      lastError: null,
      /* Reset, not preserved, when a mailbox is revived. The messages from the
       * previous connection were deleted with it, so a `lastSyncAt` left over
       * from then would make the first sweep believe it had already read a
       * window it no longer has. */
      lastSyncAt: null,
      syncSince,
      deletedAt: null,
      ...sealed,
    };

    let row: AccountRow;
    try {
      row = existing
        ? await this.prisma.mailAccount.update({
            where: { id: existing.id, workspaceId: ctx.workspaceId },
            data,
            select: accountSelect,
          })
        : await this.prisma.mailAccount.create({
            data: { workspaceId: ctx.workspaceId, email, ...data },
            select: accountSelect,
          });
    } catch (err) {
      // Two tabs connecting the same address at once; the loser reports the clash.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        (err.code === 'P2002' || err.code === 'P2025')
      ) {
        throw new ConflictException('এই ইমেইলটি ইতিমধ্যে যুক্ত করা আছে');
      }
      throw err;
    }

    /* No host, no username, and above all no password. The audit log is retained
     * far longer than these rows and is readable by every admin in the
     * workspace; what belongs in it is *that* a mailbox was connected, by whom,
     * and when. */
    this.audit.emit({
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.id,
      action: MAIL_ACCOUNT_CONNECTED,
      entity: 'MailAccount',
      entityId: row.id,
      after: {
        provider: row.provider,
        email: row.email,
        syncSince: row.syncSince ? toLocalDateString(row.syncSince, ctx.timezone) : null,
        reconnected: Boolean(existing),
      },
    });

    // Do not wait for it. The first sweep happens on the worker's own tick.
    this.scheduler.enqueue(row.id);

    return MailAccountsService.present(row, ctx.timezone);
  }

  // --- changing ------------------------------------------------------------------

  /**
   * Enable, disable, move the sync window, or re-enter a password.
   *
   * The one rule worth stating: **an `AUTH_FAILED` mailbox cannot be switched
   * back on without a credential.** Letting `status: 'ACTIVE'` alone clear the
   * failure would put the same rejected password straight back into the sweep,
   * which then presents it to the provider every fifteen minutes until the
   * user's whole account is locked. That is the exact failure `AUTH_FAILED`
   * exists to prevent, so the only way out of it is a credential that verifies.
   */
  async update(
    ctx: TenantContext,
    id: string,
    input: UpdateMailAccountInput,
  ): Promise<MailAccountView> {
    const account = await this.requireAccountForUpdate(ctx.workspaceId, id);

    const credentialsGiven =
      input.password !== undefined ||
      input.username !== undefined ||
      input.imapHost !== undefined ||
      input.imapPort !== undefined;

    if (account.status === 'AUTH_FAILED' && input.status === 'ACTIVE' && !credentialsGiven) {
      throw new BadRequestException(
        'পাসওয়ার্ড ভুল বলে সংযোগ বন্ধ আছে। আবার চালু করতে নতুন পাসওয়ার্ড দিন।',
      );
    }

    const data: Prisma.MailAccountUpdateInput = {};

    if (credentialsGiven) {
      if (!mailEncryptionAvailable()) {
        throw new ServiceUnavailableException(
          'সার্ভারে ইমেইল সংযোগের নিরাপত্তা কনফিগার করা নেই। সহায়তার জন্য যোগাযোগ করুন।',
        );
      }
      /* A password change is a re-verification, for the same reason connecting
       * is one: the alternative is storing something that does not work and
       * finding out on the next sweep. Only IMAP has a credential a user can
       * retype — an OAuth mailbox is repaired by re-running consent, which this
       * module does not have. */
      if (account.provider !== 'IMAP') {
        throw new BadRequestException('এই ধরনের মেইলবক্সের পাসওয়ার্ড এখানে বদলানো যায় না');
      }
      if (input.password === undefined) {
        throw new BadRequestException('পাসওয়ার্ড দিন');
      }

      const host = input.imapHost?.trim() ?? account.imapHost;
      if (!host) throw new BadRequestException('IMAP সার্ভারের ঠিকানা দিন');

      /* The same guard connect applies. A mailbox can be repointed at a
       * Microsoft host here, and it would fail exactly as hopelessly. */
      if (isMicrosoftMailbox(account.email, host)) {
        throw new UnprocessableEntityException(MICROSOFT_REFUSAL);
      }

      const secret: MailSecret = {
        kind: 'IMAP',
        username: input.username?.trim() || account.email,
        password: input.password,
      };
      const port = input.imapPort ?? account.imapPort;
      await this.verifyOrThrow({
        kind: 'IMAP',
        email: account.email,
        host,
        port,
        secret,
      });

      Object.assign(data, sealMailSecret(ctx.workspaceId, account.email, secret), {
        imapHost: host,
        imapPort: port,
        /* A verified credential clears the failure and switches the mailbox back
         * on, unless the caller asked for it to stay off in the same request. */
        status: input.status ?? 'ACTIVE',
        lastError: null,
      });
    } else if (input.status !== undefined) {
      data.status = input.status;
      /* Turning a mailbox off is not a failure, so the stale reason goes with
       * it — leaving "পাসওয়ার্ড ভুল" next to a DISABLED badge would be
       * describing something that is no longer true. */
      if (input.status === 'DISABLED') data.lastError = null;
    }

    if (input.syncSince !== undefined) {
      /* Moving the window forward does not delete anything already stored — the
       * user narrowed what we fetch next, not what they have. Moving it back
       * does not retroactively fetch either; the next incremental sweep still
       * starts from `lastSyncAt`, and a full re-read would mean clearing that,
       * which is not something a date field should silently do. */
      data.syncSince =
        input.syncSince === null ? null : fromLocalDateString(input.syncSince, ctx.timezone);
    }

    const row = await this.prisma.mailAccount.update({
      // Scoped, not just by id: a stray id from another tenant updates nothing.
      where: { id: account.id, workspaceId: ctx.workspaceId, deletedAt: null },
      data,
      select: accountSelect,
    });

    if (row.status === 'ACTIVE' && account.status !== 'ACTIVE') this.scheduler.enqueue(row.id);

    return MailAccountsService.present(row, ctx.timezone);
  }

  // --- disconnecting -------------------------------------------------------------

  /**
   * Disconnect a mailbox.
   *
   * Three things happen, and the second and third are the ones worth being
   * explicit about, because "soft delete" usually implies neither:
   *
   *  1. **The account row is soft-deleted.** `deletedAt` is stamped and the
   *     status goes to `DISABLED`. Every read in this module filters
   *     `deletedAt: null`, and `dueAccountIds` selects only `ACTIVE`, so the
   *     worker stops touching it immediately. The row survives so the unique
   *     `(workspaceId, email)` key still resolves and `connect` can revive it.
   *  2. **The stored credential is destroyed, not just hidden.** Both columns
   *     are overwritten with the empty string (`REDACTED_SECRET`). There is no
   *     restore endpoint and no undo, so keeping a decryptable password for a
   *     mailbox somebody has told us to forget would be the opposite of what
   *     they asked. Reconnecting means typing the password again, which is the
   *     honest cost of that.
   *  3. **The synced messages are deleted outright.** Not soft-deleted —
   *     `MailMessage` has no `deletedAt` column and this change does not own the
   *     schema, so the only choices were "delete them" and "leave a tenant's
   *     private mail in the database indefinitely, invisible, with no way to
   *     remove it". Somebody disconnecting a mailbox means "stop holding my
   *     mail". The count comes back in the response and goes into the audit row
   *     so the deletion is not silent.
   *
   * All of it in one transaction: a half-disconnected mailbox — credential gone,
   * messages still listed — is a worse state than either end.
   */
  async remove(
    ctx: TenantContext,
    id: string,
  ): Promise<{ id: string; deleted: true; messagesRemoved: number }> {
    const account = await this.requireAccount(ctx.workspaceId, id);

    const messagesRemoved = await this.prisma.$transaction(async (tx) => {
      /* Scoped by workspace as well as by account. The account id was already
       * proven to belong to this tenant, and the second predicate costs an index
       * lookup — on a `deleteMany` over somebody's mail that is a trade worth
       * making every time. */
      const { count } = await tx.mailMessage.deleteMany({
        where: { workspaceId: ctx.workspaceId, mailAccountId: account.id },
      });

      await tx.mailAccount.update({
        where: { id: account.id, workspaceId: ctx.workspaceId, deletedAt: null },
        data: {
          deletedAt: new Date(),
          status: 'DISABLED',
          lastError: null,
          ...REDACTED_SECRET,
        },
      });

      return count;
    });

    this.audit.emit({
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.id,
      action: MAIL_ACCOUNT_DISCONNECTED,
      entity: 'MailAccount',
      entityId: account.id,
      before: { provider: account.provider, email: account.email, status: account.status },
      after: { messagesRemoved, credentialDestroyed: true },
    });

    return { id: account.id, deleted: true, messagesRemoved };
  }

  // --- syncing -------------------------------------------------------------------

  /**
   * Ask for a sync. Returns immediately; it never touches a mail server.
   *
   * The refusals matter as much as the enqueue. A `DISABLED` mailbox is off
   * because somebody switched it off, and an `AUTH_FAILED` one has a password
   * the provider has already rejected — queueing either would be the endpoint
   * quietly doing nothing, and the user would keep tapping.
   */
  async requestSync(
    ctx: TenantContext,
    id: string,
  ): Promise<{ accountId: string; queued: true; estimatedSeconds: number }> {
    const account = await this.requireAccount(ctx.workspaceId, id);

    if (account.status === 'AUTH_FAILED') {
      throw new BadRequestException(
        'পাসওয়ার্ড ভুল বলে সংযোগ বন্ধ আছে। নতুন পাসওয়ার্ড দিয়ে আবার চালু করুন।',
      );
    }
    if (account.status !== 'ACTIVE') {
      throw new BadRequestException('মেইলবক্সটি বন্ধ আছে। আগে চালু করুন।');
    }

    this.scheduler.enqueue(account.id);

    return {
      accountId: account.id,
      queued: true,
      estimatedSeconds: this.scheduler.nextSweepInSeconds(),
    };
  }

  // --- guards --------------------------------------------------------------------

  /**
   * A mailbox belonging to this workspace, or a 404.
   *
   * Another tenant's id gets the same "not found" as an invented one. A 403
   * would be a confirmation that the id exists, which is a fact about somebody
   * else's account and not one to hand out.
   */
  private async requireAccount(workspaceId: string, id: string): Promise<AccountRow> {
    const row = await this.prisma.mailAccount.findFirst({
      where: { id, workspaceId, deletedAt: null },
      select: accountSelect,
    });
    if (!row) throw new NotFoundException(NOT_FOUND);
    return row;
  }

  /**
   * The columns `update` needs to merge a partial credential — a new password
   * with the existing host, say.
   *
   * **Still no `secretCipher` and no `secretIv`.** Re-verifying always uses a
   * credential the caller just typed, so there is never a reason to open the
   * stored one on a request path. `mail-sync.service.ts` is the only code in
   * this module that decrypts anything, and it does not run inside a request.
   */
  private async requireAccountForUpdate(
    workspaceId: string,
    id: string,
  ): Promise<{
    id: string;
    provider: MailProviderKind;
    email: string;
    imapHost: string | null;
    imapPort: number | null;
    status: MailAccountStatus;
  }> {
    const row = await this.prisma.mailAccount.findFirst({
      where: { id, workspaceId, deletedAt: null },
      select: {
        id: true,
        provider: true,
        email: true,
        imapHost: true,
        imapPort: true,
        status: true,
      },
    });
    if (!row) throw new NotFoundException(NOT_FOUND);
    return row;
  }

  // --- provider plumbing ----------------------------------------------------------

  private static secretFrom(input: ConnectMailAccountInput, email: string): MailSecret {
    if (input.provider === 'IMAP') {
      /* Zod already refused an IMAP connect with no password; the `?? ''` is for
       * the type, and an empty password would fail `verify()` anyway. */
      return {
        kind: 'IMAP',
        username: input.username?.trim() || email,
        password: input.password ?? '',
      };
    }
    /* Unreachable: both OAuth providers report an `unavailableReason`, so
     * `connect` has already answered 503. It exists so that adding the OAuth
     * flow is a change *here* rather than a missing branch discovered at
     * runtime. */
    return { kind: input.provider, refreshToken: '' };
  }

  /**
   * Check the credentials, and translate whatever comes back into an HTTP answer.
   *
   * The three provider errors map to three genuinely different statuses, and
   * flattening them would mislead somebody staring at a form:
   *
   *  - `MailAuthError` → **401**, "check the address and password".
   *  - `MailProviderUnavailableError` → **503**, our fault, do not retype
   *    anything.
   *  - `MailTransientError` and anything else → **503** with "try again", which
   *    is true and actionable.
   *
   * The timeout is enforced here as well as inside the provider. The interface
   * asks implementations to bound themselves, but this is the one place holding
   * a user's request open, and a future provider that forgets must not be able
   * to park a request thread on a socket forever.
   */
  private async verifyOrThrow(config: MailConnectionConfig): Promise<void> {
    const provider = this.providers.for(config.kind);

    try {
      await withTimeout(provider.verify(config), VERIFY_TIMEOUT_MS, 'Mailbox verification');
    } catch (err) {
      if (err instanceof MailAuthError) {
        throw new UnauthorizedException(err.userMessage);
      }
      if (err instanceof MailProviderUnavailableError) {
        throw new ServiceUnavailableException(err.userMessage);
      }
      if (isMailProviderError(err)) {
        throw new ServiceUnavailableException(err.userMessage);
      }
      /* Never the raw message: a mail server's banner or a stack trace can echo
       * the username back, and the host is the caller's own input reflected
       * through an error page. */
      this.logger.warn(`Mailbox verification failed for ${config.kind}: ${(err as Error).message}`);
      throw new ServiceUnavailableException(
        'মেইলবক্সে সংযোগ করা যায়নি। ঠিকানা ও পাসওয়ার্ড দেখে আবার চেষ্টা করুন।',
      );
    }
  }

  /**
   * When the first sweep should start reading from.
   *
   * Absent means `DEFAULT_SYNC_WINDOW_DAYS` back, never "everything". A mailbox
   * with a decade in it would otherwise spend days being pulled into this
   * database, and nobody connecting an account is asking for that — they are
   * asking to see this month's statements.
   */
  private resolveSyncSince(raw: string | undefined, timezone: string): Date {
    if (raw) return fromLocalDateString(raw, timezone);
    return new Date(Date.now() - DEFAULT_SYNC_WINDOW_DAYS * DAY_MS);
  }

  // --- presentation ---------------------------------------------------------------

  private static present(row: AccountRow, timezone: string): MailAccountView {
    return {
      id: row.id,
      provider: row.provider,
      email: row.email,
      imapHost: row.imapHost,
      imapPort: row.imapPort,
      status: row.status,
      lastError: row.lastError,
      lastSyncAt: row.lastSyncAt ? row.lastSyncAt.toISOString() : null,
      syncSince: row.syncSince ? toLocalDateString(row.syncSince, timezone) : null,
      messageCount: row._count.messages,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
