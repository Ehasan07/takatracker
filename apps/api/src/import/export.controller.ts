import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { cuid, isoDate } from '@hishab/shared';
import type { Response } from 'express';
import { z } from 'zod';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { NoImpersonationGuard } from '../auth/no-impersonation.guard';
import { zodPipe } from '../common/zod.pipe';
import { ExportService } from './export.service';

/**
 * Downloads. Both routes emit `export.downloaded`.
 *
 * `@Res({ passthrough: true })` rather than a raw response: the headers have to
 * be set by hand (a download is nothing without its Content-Disposition) but
 * Nest still owns sending the body and handling anything thrown, so a failed
 * export is an ordinary JSON error and not a half-written file.
 */

/** A cleared filter arrives as `?accountId=`, an empty string, not an absent key. */
const optionalQuery = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (value === '' || value === null ? undefined : value), schema.optional());

const exportQuerySchema = z.object({
  from: optionalQuery(isoDate),
  to: optionalQuery(isoDate),
  accountId: optionalQuery(cuid),
});
export type ExportTransactionsQuery = z.infer<typeof exportQuerySchema>;

/**
 * `Content-Disposition` with both an ASCII fallback and the UTF-8 form.
 *
 * Our filenames are ASCII today, but a header carrying a raw Bengali byte is
 * how a download silently arrives named "download" — RFC 5987 is the form every
 * browser has understood for a decade.
 */
function attachment(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/* An operator can read any figure on any screen during a support session. What
 * they cannot do is walk out with the file — a CSV of somebody's whole ledger
 * is the one artefact that outlives the session and leaves the building. */
@Controller('export')
@UseGuards(JwtAuthGuard, NoImpersonationGuard)
export class ExportController {
  constructor(private readonly exports: ExportService) {}

  /** CSV of the workspace's transactions, with a UTF-8 BOM so Excel keeps Bengali. */
  @Get('transactions')
  async transactions(
    @CurrentUser() user: AuthUser,
    @Query(zodPipe(exportQuerySchema)) query: ExportTransactionsQuery,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const file = await this.exports.transactionsCsv(user, query);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', attachment(file.filename));
    // Lets a browser download show progress instead of an unknown-length spinner.
    res.setHeader('Content-Length', String(Buffer.byteLength(file.body, 'utf8')));
    return file.body;
  }

  /** Every table the workspace owns. Spec §9: take your data and leave. */
  @Get('full')
  async full(
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Record<string, unknown>> {
    const file = await this.exports.full(user);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', attachment(file.filename));
    return file.body;
  }
}
