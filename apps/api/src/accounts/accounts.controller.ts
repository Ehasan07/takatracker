import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import {
  createAccountSchema,
  isoDate,
  reconcileSchema,
  revalueSchema,
  updateAccountSchema,
} from '@hishab/shared';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { zodPipe } from '../common/zod.pipe';
import { TransactionsService } from '../transactions/transactions.service';
import { AccountStatementService } from './account-statement.service';
import { AccountsService } from './accounts.service';

/**
 * The statement window.
 *
 * Both absent means the whole life of the account, which is what somebody who
 * has just opened the screen wants. A cleared date field arrives as `?from=`
 * rather than as an absent key, so the empty string has to mean "no bound" —
 * otherwise clearing a filter is a 400 the reader cannot explain.
 */
const accountStatementQuerySchema = z.object({
  from: z.preprocess((v) => (v === '' || v === null ? undefined : v), isoDate.optional()),
  to: z.preprocess((v) => (v === '' || v === null ? undefined : v), isoDate.optional()),
});

@Controller('accounts')
@UseGuards(JwtAuthGuard)
export class AccountsController {
  constructor(
    private readonly accounts: AccountsService,
    private readonly transactions: TransactionsService,
    private readonly statements: AccountStatementService,
  ) {}

  /* The timezone is threaded through because `openingBalanceDate` is a local
     day, not an instant: the transaction is stored as a UTC moment and has to
     be read back in the workspace's own calendar, or a Dhaka user's 1 June
     opening balance comes back as 31 May. */
  @Get()
  list(@CurrentUser() user: AuthUser, @Query('includeArchived') includeArchived?: string) {
    return this.accounts.list(user.workspaceId, includeArchived === 'true', user.timezone);
  }

  @Get(':id')
  findOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.accounts.findOne(user.workspaceId, id, user.timezone);
  }

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body(zodPipe(createAccountSchema)) body: ReturnType<typeof createAccountSchema.parse>,
  ) {
    return this.accounts.create(user.workspaceId, body, user.timezone, user.id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(zodPipe(updateAccountSchema)) body: ReturnType<typeof updateAccountSchema.parse>,
  ) {
    return this.accounts.update(user.workspaceId, id, body, user.id, user.timezone);
  }

  @Delete(':id')
  archive(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.accounts.archive(user.workspaceId, id, user.id);
  }

  /** Enter the real balance; the server books the difference as an ADJUSTMENT. */
  @Post(':id/reconcile')
  reconcile(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(zodPipe(reconcileSchema)) body: ReturnType<typeof reconcileSchema.parse>,
  ) {
    return this.transactions.reconcile(user, id, body);
  }

  /**
   * Mark an asset to what it is worth now.
   *
   * Separate from `reconcile` on purpose: reconciling says the ledger was wrong
   * about money that already existed, revaluing says the world moved. Only
   * `ASSET` and `LIABILITY` accounts accept it — cash does not appreciate, and
   * offering it on a wallet would let a bookkeeping error be filed as a gain.
   */
  @Post(':id/revalue')
  revalue(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(zodPipe(revalueSchema)) body: ReturnType<typeof revalueSchema.parse>,
  ) {
    return this.transactions.revalue(user, id, body);
  }

  /**
   * The account's own statement: opening balance, every entry, closing balance.
   *
   * A `GET` with the window in the query string, so the page a reader is
   * looking at is a URL they can bookmark, reload and send to themselves.
   */
  @Get(':id/statement')
  statement(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query(zodPipe(accountStatementQuerySchema))
    query: ReturnType<typeof accountStatementQuerySchema.parse>,
  ) {
    return this.statements.statement(user, id, query, user.locale);
  }

  @Get(':id/revaluations')
  revaluations(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.transactions.revaluations(user, id);
  }
}
