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
import { createAccountSchema, reconcileSchema, updateAccountSchema } from '@hishab/shared';
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
    return this.accounts.create(user.workspaceId, body, user.timezone);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(zodPipe(updateAccountSchema)) body: ReturnType<typeof updateAccountSchema.parse>,
  ) {
    return this.accounts.update(user.workspaceId, id, body);
  }

  @Delete(':id')
  archive(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.accounts.archive(user.workspaceId, id);
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
}
