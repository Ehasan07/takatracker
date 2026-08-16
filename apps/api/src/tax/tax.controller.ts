import { Body, Controller, Get, HttpCode, Post, Put, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { zodPipe } from '../common/zod.pipe';
import { TaxService } from './tax.service';

/**
 * The income tax worksheet, and the one endpoint that produces a figure.
 *
 * ## Why the estimate is a POST
 *
 * It changes nothing, so REST would make it a GET. It is a POST anyway, and
 * deliberately: a GET is something a router prefetches, a service worker warms
 * and a browser retries. A tax figure must appear because a person pressed a
 * button and for no other reason — docs/RENEWALS-AND-TAX.md §3.8, "calling it an
 * estimate in the same breath as showing it, every time". A method that cannot
 * be prefetched is the cheapest way to make that true at the protocol level
 * rather than only in the UI.
 *
 * `GET /tax/worksheet` is the half that is safe to fetch: every input, fully
 * traced, and never a tax figure.
 */

/** `2025-26`, as `fiscalYearOf` in @hishab/core names it. */
const fiscalYear = z.string().regex(/^\d{4}-\d{2}$/, 'Expected a fiscal year like 2025-26');

const worksheetQuerySchema = z.object({
  /** Absent means the year the workspace is currently in, in its own timezone. */
  fiscalYear: fiscalYear.optional(),
});
export type WorksheetQuery = z.infer<typeof worksheetQuerySchema>;

const estimateSchema = z.object({
  fiscalYear: fiscalYear.optional(),
});
export type EstimateInput = z.infer<typeof estimateSchema>;

/**
 * The taxpayer, not their money.
 *
 * `category` and `area` are free text validated against the *year's* regime at
 * computation time, never against a list here: which categories exist is a fact
 * about the Finance Act. A bounded length is the only thing worth asserting.
 */
const profileSchema = z.object({
  country: z.string().length(2).toUpperCase().optional(),
  category: z.string().min(1).max(64).optional(),
  area: z.string().min(1).max(64).optional(),
  isRequiredToFile: z.boolean().optional(),
  /* Short on purpose. A TIN is a national identifier and this product has no
     use for the whole of one — the last digits are enough for somebody to
     recognise their own return. */
  tinMasked: z.string().max(24).nullish(),
});
export type UpdateTaxProfileInput = z.infer<typeof profileSchema>;

@Controller('tax')
@UseGuards(JwtAuthGuard)
export class TaxController {
  constructor(private readonly tax: TaxService) {}

  @Get('worksheet')
  worksheet(
    @CurrentUser() user: AuthUser,
    @Query(zodPipe(worksheetQuerySchema)) query: WorksheetQuery,
  ) {
    return this.tax.worksheet(user, query.fiscalYear);
  }

  @Get('profile')
  profile(@CurrentUser() user: AuthUser) {
    return this.tax.profile(user.workspaceId);
  }

  @Put('profile')
  saveProfile(
    @CurrentUser() user: AuthUser,
    @Body(zodPipe(profileSchema)) body: UpdateTaxProfileInput,
  ) {
    return this.tax.saveProfile(user.workspaceId, body);
  }

  /**
   * 200 rather than 201: nothing was created. The POST is about deliberateness,
   * not about a resource.
   */
  @Post('estimate')
  @HttpCode(200)
  estimate(@CurrentUser() user: AuthUser, @Body(zodPipe(estimateSchema)) body: EstimateInput) {
    return this.tax.estimate(user, body.fiscalYear);
  }
}
