import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { cuid, isoDate } from '@hishab/shared';
import { z } from 'zod';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { zodPipe } from '../common/zod.pipe';
import { MailAccountsService } from './mail-accounts.service';
import { MailMessagesService } from './mail-messages.service';

/* Mirrors of the Prisma enums, kept local until mail earns a place in
 * @hishab/shared — the same holding pattern loans, savings and ingestion use,
 * so there is one obvious file to move them out of. */
const MAIL_PROVIDERS = ['IMAP', 'GMAIL_OAUTH', 'OUTLOOK_OAUTH'] as const;
const MAIL_FOLDERS = ['INBOX', 'SENT', 'DRAFTS', 'ARCHIVE'] as const;

/**
 * The two statuses a *person* may set.
 *
 * `AUTH_FAILED` is missing on purpose: it is the worker's word for "your
 * credentials stopped working", and letting a client assert it would let the UI
 * invent a failure that never happened. Coming back from it is
 * `status: 'ACTIVE'` plus a working password, which is the only thing that
 * actually fixes it — see `MailAccountsService.update`.
 */
const SETTABLE_STATUSES = ['ACTIVE', 'DISABLED'] as const;

/** 993 is IMAP-over-TLS and is what all but a handful of hosts use. */
const DEFAULT_IMAP_PORT = 993;

/**
 * A cleared filter arrives as `?folder=` — an empty string, not an absent key.
 * Treating that as "no filter" is the difference between a working "সব" chip
 * and a 400 the user cannot explain.
 */
const optionalQuery = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (value === '' || value === null ? undefined : value), schema.optional());

/**
 * A mailbox password. Bounded, and **never** trimmed, lowercased or otherwise
 * normalised — a password is bytes, and a leading space somebody's host insists
 * on is theirs to keep. 1 KB is far past any real app password and stops a
 * multi-megabyte body being encrypted into a row.
 */
const password = z.string().min(1).max(1024);

/**
 * Connect a mailbox.
 *
 * The credentials are verified against the real server before anything is
 * stored, so a typo fails here rather than as a silent `AUTH_FAILED` an hour
 * later. That is the one and only network call this API makes to a mail host
 * inside an HTTP request, and it is bounded by `VERIFY_TIMEOUT_MS`.
 */
const connectSchema = z
  .object({
    provider: z.enum(MAIL_PROVIDERS).default('IMAP'),
    /* Lowercased before it is stored: it is half of the `(workspaceId, email)`
     * unique key and half of the encryption AAD, and `Ali@x.com` and `ali@x.com`
     * must not become two mailboxes or two different AADs. */
    email: z.string().email('সঠিক ইমেইল ঠিকানা দিন').max(320),
    imapHost: z.string().min(1).max(255).optional(),
    imapPort: z.coerce.number().int().min(1).max(65_535).default(DEFAULT_IMAP_PORT),
    /** Defaults to the address. Some hosts want a bare username instead. */
    username: z.string().min(1).max(320).optional(),
    password: password.optional(),
    /**
     * Only mail received on or after this date is ever read. Absent means the
     * server picks a recent default — see `DEFAULT_SYNC_WINDOW_DAYS`. Left out
     * of the sync window entirely, a first sweep against a ten-year-old mailbox
     * would try to pull ten years of mail.
     */
    syncSince: isoDate.optional(),
  })
  .refine((v) => v.provider !== 'IMAP' || Boolean(v.imapHost?.trim()), {
    message: 'IMAP সার্ভারের ঠিকানা দিন',
    path: ['imapHost'],
  })
  .refine((v) => v.provider !== 'IMAP' || Boolean(v.password), {
    message: 'পাসওয়ার্ড দিন',
    path: ['password'],
  });
export type ConnectMailAccountInput = z.infer<typeof connectSchema>;

/**
 * Enable, disable, change the sync window — and re-enter a password.
 *
 * The last one is a small, deliberate extension beyond the first three. Without
 * it there is no way out of `AUTH_FAILED` except deleting the mailbox and
 * connecting it again, which also throws away every message already synced. A
 * mailbox whose password changed is the ordinary case, not the exotic one.
 *
 * Supplying any credential field re-verifies against the server before storing,
 * exactly as connecting does.
 */
const updateSchema = z
  .object({
    status: z.enum(SETTABLE_STATUSES).optional(),
    /** Explicit null clears the window, meaning "whatever the provider gives us". */
    syncSince: isoDate.nullable().optional(),
    imapHost: z.string().min(1).max(255).optional(),
    imapPort: z.coerce.number().int().min(1).max(65_535).optional(),
    username: z.string().min(1).max(320).optional(),
    password: password.optional(),
  })
  .refine((v) => Object.values(v).some((value) => value !== undefined), {
    message: 'কী পরিবর্তন করতে চান সেটি দিন',
  });
export type UpdateMailAccountInput = z.infer<typeof updateSchema>;

const listMessagesQuerySchema = z.object({
  folder: optionalQuery(z.enum(MAIL_FOLDERS)),
  /** One of the caller's own mailboxes. A foreign id matches nothing, it does not 403. */
  accountId: optionalQuery(cuid),
  /** Case-insensitive substring over subject, sender, recipient and snippet. */
  q: optionalQuery(z.string().max(200)),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: optionalQuery(z.string().min(1)),
});
export type ListMailMessagesQuery = z.infer<typeof listMessagesQuerySchema>;

/**
 * Mailboxes.
 *
 * Every route is behind `JwtAuthGuard` and every query underneath is scoped to
 * `user.workspaceId`. No handler here takes a workspace from a parameter, a
 * body or a header — this feature reads people's private mail, and the id of
 * whose mail to read is never something a caller gets to state.
 */
@Controller('mail-accounts')
@UseGuards(JwtAuthGuard)
export class MailAccountsController {
  constructor(private readonly accounts: MailAccountsService) {}

  /** The tenant's mailboxes. Never the cipher, the IV, or anything derived from them. */
  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.accounts.list(user);
  }

  @Post()
  connect(
    @CurrentUser() user: AuthUser,
    @Body(zodPipe(connectSchema)) body: ConnectMailAccountInput,
  ) {
    return this.accounts.connect(user, body);
  }

  @Get(':id')
  findOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.accounts.findOne(user, id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(zodPipe(updateSchema)) body: UpdateMailAccountInput,
  ) {
    return this.accounts.update(user, id, body);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.accounts.remove(user, id);
  }

  /**
   * Ask for a sync now.
   *
   * **202, and it does not wait.** Reading a mailbox is a TLS handshake, a
   * login, a search and a fetch against somebody else's rate-limited server; a
   * screen that blocks on that is a screen that hangs. The account is put on the
   * worker's queue and the response says when the sweep will pick it up. The
   * client learns the outcome from `lastSyncAt` and `lastError` on the next
   * `GET /mail-accounts`.
   */
  @Post(':id/sync')
  @HttpCode(202)
  requestSync(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.accounts.requestSync(user, id);
  }
}

/**
 * Mail the worker has already stored. Nothing in this controller touches a mail
 * server; every response comes from the database.
 */
@Controller('mail-messages')
@UseGuards(JwtAuthGuard)
export class MailMessagesController {
  constructor(private readonly messages: MailMessagesService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query(zodPipe(listMessagesQuerySchema)) query: ListMailMessagesQuery,
  ) {
    return this.messages.list(user, query);
  }

  @Get(':id')
  findOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.messages.findOne(user, id);
  }
}
