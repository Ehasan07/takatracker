import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { cuid, isoDate } from '@hishab/shared';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { zodPipe } from '../common/zod.pipe';
import { BusinessService } from './business.service';

/** The venture's name. It becomes the tag every business row carries. */
const setupSchema = z.object({
  name: z.string().trim().min(1).max(60),
});

/**
 * A stock count.
 *
 * `countedMinor` is allowed to be zero — a shop that sold out has ৳0 on the
 * shelf and that is a real answer, not a missing one. Everything else about
 * the entry is derived: the amount is what the books held less what was
 * counted, and the category is `বিক্রীত পণ্যের ব্যয়` unless one is named.
 */
const stockCountSchema = z.object({
  accountId: cuid,
  date: isoDate,
  countedMinor: z.number().int().min(0),
  tagId: cuid.optional(),
  categoryId: cuid.optional(),
});

@Controller('business')
@UseGuards(JwtAuthGuard)
export class BusinessController {
  constructor(private readonly business: BusinessService) {}

  /**
   * `POST /v1/business/setup` — the tag and the eighteen categories, in one
   * press.
   *
   * Safe to call twice: everything is matched by name first, so a second press
   * reports what already existed rather than creating a duplicate set the owner
   * then has to merge.
   */
  @Post('setup')
  setup(
    @CurrentUser() user: AuthUser,
    @Body(zodPipe(setupSchema)) body: ReturnType<typeof setupSchema.parse>,
  ) {
    return this.business.setup(user, body);
  }

  /**
   * `GET /v1/business/stock-count?accountId=&date=` — what the books say is on
   * the shelf, before anybody counts it.
   *
   * Read first and written second, deliberately. The owner should see the
   * figure they are about to contradict: a count that differs from the ledger
   * by ৳2 and one that differs by ৳2,00,000 are different events, and only one
   * of them is a month's trading.
   */
  @Get('stock-count')
  preview(
    @CurrentUser() user: AuthUser,
    @Query('accountId') accountId: string,
    @Query('date') date: string,
  ) {
    const query = z.object({ accountId: cuid, date: isoDate }).parse({ accountId, date });
    return this.business.stockPreview(user, query);
  }

  /**
   * `POST /v1/business/stock-count` — the month-end entry.
   *
   * What was bought and is no longer on the shelf was sold, so it stops being
   * an asset and becomes the cost of what was sold. One number in, one entry
   * out, and the month's profit is true.
   */
  @Post('stock-count')
  stockCount(
    @CurrentUser() user: AuthUser,
    @Body(zodPipe(stockCountSchema)) body: ReturnType<typeof stockCountSchema.parse>,
  ) {
    return this.business.stockCount(user, body);
  }
}
