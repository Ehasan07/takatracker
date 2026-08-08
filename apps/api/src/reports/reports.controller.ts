import { BadRequestException, Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { startOfMonth, startOfNextMonth, toLocalDateString } from '@hishab/shared';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ReportsService, type PeriodQuery } from './reports.service';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

@Controller('reports')
@UseGuards(JwtAuthGuard)
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  /** Defaults to the current month, so every report works with no arguments. */
  private period(user: AuthUser, from?: string, to?: string): PeriodQuery {
    if (from && !ISO_DATE.test(from)) throw new BadRequestException('from must be YYYY-MM-DD');
    if (to && !ISO_DATE.test(to)) throw new BadRequestException('to must be YYYY-MM-DD');

    const now = new Date();
    const defaultFrom = toLocalDateString(startOfMonth(now, user.timezone), user.timezone);
    const defaultTo = toLocalDateString(
      new Date(startOfNextMonth(now, user.timezone).getTime() - 86_400_000),
      user.timezone,
    );
    return { from: from ?? defaultFrom, to: to ?? defaultTo };
  }

  @Get('by-category')
  byCategory(
    @CurrentUser() user: AuthUser,
    @Query('kind') kind: 'INCOME' | 'EXPENSE' = 'EXPENSE',
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('top') top?: string,
    @Query('flat') flat?: string,
  ) {
    const period = this.period(user, from, to);
    if (top) return this.reports.byCategoryTop(user, kind, period, Number(top));
    // Parents by default; `flat=1` returns every category on its own line.
    return flat === '1'
      ? this.reports.byCategory(user, kind, period)
      : this.reports.byParentCategory(user, kind, period);
  }

  @Get('trend')
  trend(@CurrentUser() user: AuthUser, @Query('months') months?: string) {
    const count = Math.min(36, Math.max(1, Number(months) || 12));
    return this.reports.trend(user, count);
  }

  @Get('balance-sheet')
  balanceSheet(@CurrentUser() user: AuthUser) {
    return this.reports.balanceSheet(user);
  }

  @Get('cash-flow')
  cashFlow(@CurrentUser() user: AuthUser, @Query('from') from?: string, @Query('to') to?: string) {
    return this.reports.cashFlow(user, this.period(user, from, to));
  }

  @Get('category/:id')
  drilldown(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.reports.categoryDrilldown(user, id, this.period(user, from, to));
  }
}
