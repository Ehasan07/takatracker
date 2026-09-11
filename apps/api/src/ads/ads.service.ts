import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * What a document prints at the bottom. Deliberately four fields and no ids a
 * client could use to ask for anything else.
 */
export interface FooterAd {
  headline: string;
  body: string | null;
  contactLine: string | null;
  /** Live on a screen, ignored on paper — a URL nobody can click is noise. */
  linkUrl: string | null;
}

/**
 * The sponsored strip at the foot of a workspace's documents.
 *
 * A super admin sells it and assigns it; a workspace cannot create, edit or
 * remove one, and nothing here takes a campaign id from a caller. The only
 * question this service answers is "what runs on this workspace, right now",
 * which is the only question a document needs to ask.
 *
 * **Printed documents only.** The spreadsheet export deliberately has no
 * footer: a CSV or an XLSX is a file somebody sorts, filters and pastes into
 * their own workbook, and an advert in row 412 is a row that breaks their
 * formulas. Paper and PDF have a margin that belongs to the page rather than
 * to the data, and that is the thing being sold.
 */
@Injectable()
export class AdsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The advert running on this workspace today, or null.
   *
   * One, not a list. A document has one footer, and letting two sponsors share
   * it would make each of them worth less than the one that was sold. Newest
   * placement wins, so switching sponsor is a placement rather than an
   * unpicking of the old one.
   */
  async footerFor(workspaceId: string, now: Date = new Date()): Promise<FooterAd | null> {
    const placement = await this.prisma.adPlacement.findFirst({
      where: {
        workspaceId,
        campaign: { isActive: true },
        AND: [
          { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
          { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
        ],
      },
      orderBy: { createdAt: 'desc' },
      select: {
        campaign: {
          select: { headline: true, body: true, contactLine: true, linkUrl: true },
        },
      },
    });

    return placement?.campaign ?? null;
  }
}
