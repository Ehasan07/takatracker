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
import { PrismaService } from '../prisma/prisma.service';
import { TransactionsService } from './transactions.service';

@Controller('transactions')
@UseGuards(JwtAuthGuard)
export class TransactionsController {
  constructor(
    private readonly transactions: TransactionsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query(zodPipe(transactionQuerySchema)) query: ReturnType<typeof transactionQuerySchema.parse>,
  ) {
    return this.transactions.list(user.id, query);
  }

  /** Dashboard header: this month's income, expense and net. */
  @Get('summary')
  async summary(@CurrentUser() user: AuthUser, @Query('month') month?: string) {
    const { timezone } = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { timezone: true },
    });
    const anchor = month ? fromLocalDateString(`${month}-01`, timezone) : new Date();
    const from = startOfMonth(anchor, timezone);
    const to = startOfNextMonth(anchor, timezone);
    const [current, expenseByCategory] = await Promise.all([
      this.transactions.summary(user.id, from, to),
      this.transactions.byCategory(user.id, 'EXPENSE', from, to),
    ]);
    return { from: from.toISOString(), to: to.toISOString(), ...current, expenseByCategory };
  }

  @Get(':id')
  findOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.transactions.findOne(user.id, id);
  }

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body(zodPipe(simpleTransactionSchema)) body: ReturnType<typeof simpleTransactionSchema.parse>,
  ) {
    return this.transactions.create(user.id, body);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(zodPipe(simpleTransactionSchema)) body: ReturnType<typeof simpleTransactionSchema.parse>,
  ) {
    return this.transactions.update(user.id, id, body);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.transactions.remove(user.id, id);
  }
}
