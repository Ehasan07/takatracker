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
import {
  createAccountSchema,
  reconcileSchema,
  revalueSchema,
  updateAccountSchema,
} from '@hishab/shared';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { zodPipe } from '../common/zod.pipe';
import { TransactionsService } from '../transactions/transactions.service';
import { AccountsService } from './accounts.service';

@Controller('accounts')
@UseGuards(JwtAuthGuard)
export class AccountsController {
  constructor(
    private readonly accounts: AccountsService,
    private readonly transactions: TransactionsService,
  ) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query('includeArchived') includeArchived?: string) {
    return this.accounts.list(user.workspaceId, includeArchived === 'true');
  }

  @Get(':id')
  findOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.accounts.findOne(user.workspaceId, id);
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

  @Get(':id/revaluations')
  revaluations(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.transactions.revaluations(user, id);
  }
}
