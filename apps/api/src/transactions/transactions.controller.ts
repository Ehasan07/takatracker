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
  fromLocalDateString,
  simpleTransactionSchema,
  startOfMonth,
  startOfNextMonth,
  transactionQuerySchema,
} from '@hishab/shared';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { zodPipe } from '../common/zod.pipe';
import { AccountsService } from '../accounts/accounts.service';
import { TransactionsService } from './transactions.service';

@Controller('transactions')
@UseGuards(JwtAuthGuard)
export class TransactionsController {
  constructor(
    private readonly transactions: TransactionsService,
    private readonly accounts: AccountsService,
  ) {}

  /**
   * `GET /v1/transactions` — the main screen, and the ledger search.
   *
   * Response shape is unchanged: `{ items, nextCursor }`, newest first. The only
   * thing that moved is what `?q=` means. It is now every token of the query
   * ANDed together, each matched against the description, payee, notes, bank
   * reference, the person the row points at and the category it is filed under.
   *
   * Callers should not expect relevance ordering, and should not expect a Latin
   * query to reach a Bengali row — this is substring matching in Postgres, which
   * cannot transliterate. `buildSearchWhere` in the service states the full list
   * of limits and the fix that would lift them.
   *
   * `?tagId=` narrows to one tag and composes with everything else, so
   * "পারিবারিক, last month, over ৳৫০০" is one request. A tag belonging to
   * another workspace answers 404 rather than an empty page.
   */
  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query(zodPipe(transactionQuerySchema)) query: ReturnType<typeof transactionQuerySchema.parse>,
  ) {
    return this.transactions.list(user, query);
  }

  /**
   * Dashboard header: this month's income, expense and net, plus the two
   * figures that answer "how am I doing".
   *
   * ## Why the position comes from here and not from the account list
   *
   * The dashboard used to add up `GET /accounts` and call the result "মোট
   * ব্যালেন্স". That list is every account a person made, of every type, so a
   * ৳10,00,000 plot of land was counted as spendable balance beside ৳3,600 of
   * cash — and it excludes the hidden control accounts, so money lent out was
   * missing from the same figure. It was wrong in both directions at once.
   *
   * `AccountsService.position` answers it from the same `buildBalanceSheet`
   * the reports screen uses, so the two cannot disagree. It hands back:
   *
   *  - `liquidMinor` — cash, bank and mobile wallet. What can be spent today.
   *  - `netWorthMinor` — every asset, including land and money owed to you,
   *    less every liability. What you are actually worth.
   *
   * Keeping the classification in `packages/core` rather than in the screen is
   * the point: the dashboard and the balance sheet cannot drift into
   * disagreeing about whether a DPS is money.
   */
  @Get('summary')
  async summary(@CurrentUser() user: AuthUser, @Query('month') month?: string) {
    const { timezone } = user;
    const anchor = month ? fromLocalDateString(`${month}-01`, timezone) : new Date();
    const from = startOfMonth(anchor, timezone);
    const to = startOfNextMonth(anchor, timezone);
    const [current, expenseByCategory, position] = await Promise.all([
      this.transactions.summary(user, from, to),
      this.transactions.byCategory(user, 'EXPENSE', from, to),
      this.accounts.position(user.workspaceId),
    ]);
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      ...current,
      expenseByCategory,
      liquidMinor: position.liquidMinor,
      netWorthMinor: position.netWorthMinor,
      assetsMinor: position.assetsMinor,
      liabilitiesMinor: position.liabilitiesMinor,
    };
  }

  @Get(':id')
  findOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.transactions.findOne(user, id);
  }

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body(zodPipe(simpleTransactionSchema)) body: ReturnType<typeof simpleTransactionSchema.parse>,
  ) {
    return this.transactions.create(user, body);
  }

  /**
   * `tagIds` omitted leaves the row's tags exactly as they were; `tagIds: []`
   * clears them. Every other field on this body already behaves that way, and a
   * client editing an amount must not strip labels it never mentioned.
   */
  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(zodPipe(simpleTransactionSchema)) body: ReturnType<typeof simpleTransactionSchema.parse>,
  ) {
    return this.transactions.update(user, id, body);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.transactions.remove(user, id);
  }

  /** Undo a delete within the window the client offers. */
  @Post(':id/restore')
  restore(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.transactions.restore(user, id);
  }
}
