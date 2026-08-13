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

  /** A ledger date or a 400 — never a guess. */
  private date(name: string, value?: string): string | undefined {
    if (value === undefined) return undefined;
    if (!ISO_DATE.test(value)) throw new BadRequestException(`${name} must be YYYY-MM-DD`);
    return value;
  }

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

  /**
   * `GET /v1/reports/by-tag` — the same period as `by-category`, cut by *who
   * for* rather than *what on*.
   *
   * `kind` is narrowed the way `by-category` narrows it — anything that is not
   * `INCOME` is an expense report — so the two endpoints answer a malformed
   * parameter identically rather than one refusing and the other defaulting.
   *
   * The response deliberately does **not** balance: `rows` sum to more than
   * `totalMinor` whenever a transaction carries more than one tag, and the
   * difference is reported as `overlapMinor`. See `ReportsService.byTag`.
   */
  @Get('by-tag')
  byTag(
    @CurrentUser() user: AuthUser,
    @Query('kind') kind?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.reports.byTag(
      user,
      kind === 'INCOME' ? 'INCOME' : 'EXPENSE',
      this.period(user, from, to),
    );
  }

  @Get('trend')
  trend(@CurrentUser() user: AuthUser, @Query('months') months?: string) {
    const count = Math.min(36, Math.max(1, Number(months) || 12));
    return this.reports.trend(user, count);
  }

  /**
   * `GET /v1/reports/balance-sheet` — the position at the end of a day.
   *
   * `asOf=YYYY-MM-DD` is that day, in the workspace's timezone. With no
   * arguments the answer is today's, unchanged down to the shape of the object,
   * so every caller that exists keeps working untouched.
   *
   * `compareTo=YYYY-MM-DD` adds an earlier day's totals and the movement since,
   * under `comparison`. It is one request rather than two because the two dates
   * answer **one** sentence on screen — "নিট সম্পদ গত মাসের চেয়ে ৳১২,০০০ বেশি"
   * is false if half of it is stale — and because the second date costs one
   * aggregate: the account list is fetched once and shared, and the difference
   * is computed by `compareBalanceSheets` in @hishab/core, so no client has to
   * reimplement poisha arithmetic to subtract two numbers. A client that would
   * rather have them separately still can: two calls with different `asOf`.
   *
   * `from`/`to` are deliberately not accepted. A balance sheet has one date, and
   * a range handed to a photograph would produce a number that looks like last
   * March's and is today's.
   */
  @Get('balance-sheet')
  balanceSheet(
    @CurrentUser() user: AuthUser,
    @Query('asOf') asOf?: string,
    @Query('compareTo') compareTo?: string,
  ) {
    return this.reports.balanceSheet(user, {
      asOf: this.date('asOf', asOf),
      compareTo: this.date('compareTo', compareTo),
    });
  }

  /**
   * `GET /v1/reports/by-quantity` — how much of each thing, not how much it cost.
   *
   * The question money cannot answer: a price rise and a habit change look
   * identical in taka and completely different in litres.
   */
  @Get('by-quantity')
  byQuantity(
    @CurrentUser() user: AuthUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.reports.byQuantity(user, this.period(user, from, to));
  }

  /**
   * `GET /v1/reports/income-statement` — what came in, what went out, what was
   * left, for any window, with an optional comparative column.
   *
   * `compareFrom`/`compareTo` are a second window rather than a "previous
   * period" flag: a reader comparing this quarter with the same quarter last
   * year and a reader comparing it with last quarter both have a real question,
   * and the server should not be guessing which.
   */
  @Get('income-statement')
  incomeStatement(
    @CurrentUser() user: AuthUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('compareFrom') compareFrom?: string,
    @Query('compareTo') compareTo?: string,
  ) {
    const comparison =
      compareFrom && compareTo ? this.period(user, compareFrom, compareTo) : undefined;
    return this.reports.incomeStatement(user, this.period(user, from, to), comparison);
  }

  /**
   * `GET /v1/reports/net-worth-changes` — the reconciliation that makes the
   * other three statements checkable against one another.
   */
  @Get('net-worth-changes')
  changesInNetWorth(
    @CurrentUser() user: AuthUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.reports.changesInNetWorth(user, this.period(user, from, to));
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
