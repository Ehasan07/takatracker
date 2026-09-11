import { Controller, Get, Res, StreamableFile, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { NoImpersonationGuard } from '../auth/no-impersonation.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { AuditService, type AuditAction } from '../audit/audit.service';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { LoansService, type PartyDueReport } from '../loans/loans.service';
import { PrismaService } from '../prisma/prisma.service';
import { partyDuesWorkbook } from './party-due.xlsx';

const PARTY_DUES_DOWNLOADED: AuditAction = 'report.party_dues_downloaded';

/** The feature a super admin grants per workspace. Off on every package. */
const FEATURE_KEY = 'party.due.report';

/**
 * `Content-Disposition` with both an ASCII fallback and the RFC 5987 form.
 *
 * A third copy of the four lines in `import/export.controller.ts` and
 * `statements`, and deliberately so: one feature folder reaching into another's
 * internals for a string formatter is a coupling that outlasts the saving.
 */
function attachment(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * Who owes what, across the whole workspace.
 *
 * Two locks, and both have to open. `party.due.report` is a flag no package
 * sells, so a super admin decides which workspaces have the screen at all; and
 * `@Roles` keeps it to the owner and the admins of that workspace, because the
 * file names every customer and supplier a shop has together with what each of
 * them still owes — which is the shop's own list to hand out, not a shop
 * assistant's.
 *
 * What the role gate does **not** do is hide the figures. A member can still
 * open one counterparty's ledger and read the same balance there, exactly as
 * they could yesterday; every other route in this API is workspace-scoped and
 * nothing more. The restriction is on walking out with the whole list in one
 * file, and that is the thing that was asked for.
 */
@Controller('reports')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('OWNER', 'ADMIN')
export class PartyDueController {
  constructor(
    private readonly loans: LoansService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
  ) {}

  /** `GET /v1/reports/party-dues` — the screen, and what the print view draws. */
  @Get('party-dues')
  async partyDues(@CurrentUser() user: AuthUser): Promise<PartyDueReport> {
    await this.entitlements.assertEnabled(user.workspaceId, FEATURE_KEY);
    return this.loans.partyDues(user);
  }

  /**
   * `GET /v1/reports/party-dues.xlsx` — the same figures as a workbook.
   *
   * `NoImpersonationGuard` on this one and not on the JSON above, the way the
   * CSV export already splits: an operator in a support session can read any
   * figure on any screen, which is what the session is for. What they cannot do
   * is walk out with the file, because a spreadsheet of somebody's whole
   * counterparty list is the one artefact that outlives the session.
   */
  @Get('party-dues.xlsx')
  @UseGuards(NoImpersonationGuard)
  async partyDuesXlsx(
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    await this.entitlements.assertEnabled(user.workspaceId, FEATURE_KEY);

    const [report, workspace] = await Promise.all([
      this.loans.partyDues(user),
      this.prisma.workspace.findUnique({
        where: { id: user.workspaceId },
        select: { name: true },
      }),
    ]);

    const body = await partyDuesWorkbook(report, {
      workspaceName: workspace?.name ?? '',
      locale: user.locale,
    });
    const filename = `party-dues-${report.asOf}.xlsx`;

    /* Awaited, not fired and forgotten. This download names people who never
     * agreed to be in a spreadsheet; a row that may or may not have been
     * written is not a record of who took it. */
    await this.audit.record({
      workspaceId: user.workspaceId,
      actorUserId: user.id,
      action: PARTY_DUES_DOWNLOADED,
      entity: 'Workspace',
      entityId: user.workspaceId,
      after: {
        customers: report.customers.length,
        suppliers: report.suppliers.length,
        receivableMinor: report.customerTotals.outstandingMinor,
        payableMinor: report.supplierTotals.outstandingMinor,
        asOf: report.asOf,
      },
    });

    res.setHeader('Content-Type', XLSX_MIME);
    res.setHeader('Content-Disposition', attachment(filename));
    res.setHeader('Content-Length', String(body.byteLength));

    /* `StreamableFile`, not a bare `Buffer`. Nest's serialiser turns a returned
       Buffer into `{"type":"Buffer","data":[...]}` — a JSON array of byte
       values, sent under a spreadsheet's content type, which every program
       opens as a corrupt file. */
    return new StreamableFile(body);
  }
}
