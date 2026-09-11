import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditService, type AuditAction } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { fileAgainst, type AdminActor } from './admin-audit';

const AD_CREATED: AuditAction = 'admin.ad_created';
const AD_UPDATED: AuditAction = 'admin.ad_updated';
const AD_DELETED: AuditAction = 'admin.ad_deleted';
const AD_PLACED: AuditAction = 'admin.ad_placed';
const AD_WITHDRAWN: AuditAction = 'admin.ad_withdrawn';

export interface AdCampaignInput {
  name: string;
  headline: string;
  body?: string | null;
  contactLine?: string | null;
  linkUrl?: string | null;
  isActive?: boolean;
}

export interface PlaceAdInput {
  workspaceId: string;
  startsAt?: string | null;
  endsAt?: string | null;
  note?: string | null;
}

/**
 * The operator's side of sponsored footers.
 *
 * Writes are filed against the **tenant**, not the operator, by the rule in
 * `admin-audit.ts`: putting an advert on somebody's customer statements is a
 * thing done *to* that workspace, its effect is visible to them on every
 * document they print, and their own audit screen is where they are entitled to
 * read who decided it. Editing the wording of a campaign touches no single
 * tenant, so that one is filed against the operator.
 */
@Injectable()
export class AdminAdsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Every campaign, with where each one is running. */
  async list() {
    const campaigns = await this.prisma.adCampaign.findMany({
      orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
      include: {
        placements: {
          orderBy: { createdAt: 'desc' },
          include: { workspace: { select: { id: true, name: true, status: true } } },
        },
      },
    });

    return {
      campaigns: campaigns.map((campaign) => ({
        id: campaign.id,
        name: campaign.name,
        headline: campaign.headline,
        body: campaign.body,
        contactLine: campaign.contactLine,
        linkUrl: campaign.linkUrl,
        isActive: campaign.isActive,
        createdAt: campaign.createdAt.toISOString(),
        placements: campaign.placements.map((placement) => ({
          id: placement.id,
          workspaceId: placement.workspaceId,
          workspaceName: placement.workspace.name,
          workspaceStatus: placement.workspace.status,
          startsAt: placement.startsAt?.toISOString() ?? null,
          endsAt: placement.endsAt?.toISOString() ?? null,
          note: placement.note,
          createdAt: placement.createdAt.toISOString(),
        })),
      })),
    };
  }

  async create(actor: AdminActor, input: AdCampaignInput) {
    const campaign = await this.prisma.adCampaign.create({
      data: {
        name: input.name,
        headline: input.headline,
        body: input.body ?? null,
        contactLine: input.contactLine ?? null,
        linkUrl: input.linkUrl ?? null,
        isActive: input.isActive ?? true,
        createdByUserId: actor.id,
      },
    });

    await this.audit.record({
      ...fileAgainst(actor),
      action: AD_CREATED,
      entity: 'AdCampaign',
      entityId: campaign.id,
      after: { name: campaign.name, headline: campaign.headline, operator: actor.email },
    });

    return campaign;
  }

  async update(actor: AdminActor, id: string, input: Partial<AdCampaignInput>) {
    const existing = await this.prisma.adCampaign.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('বিজ্ঞাপনটি পাওয়া যায়নি');

    const campaign = await this.prisma.adCampaign.update({
      where: { id },
      data: {
        name: input.name ?? undefined,
        headline: input.headline ?? undefined,
        /* `??` would not let a sponsor clear a line they no longer want
         * printed: sending `null` has to mean "take it off the page", and only
         * an absent key means "leave it alone". */
        body: input.body === undefined ? undefined : input.body,
        contactLine: input.contactLine === undefined ? undefined : input.contactLine,
        linkUrl: input.linkUrl === undefined ? undefined : input.linkUrl,
        isActive: input.isActive ?? undefined,
      },
    });

    await this.audit.record({
      ...fileAgainst(actor),
      action: AD_UPDATED,
      entity: 'AdCampaign',
      entityId: campaign.id,
      before: {
        name: existing.name,
        headline: existing.headline,
        body: existing.body,
        contactLine: existing.contactLine,
        isActive: existing.isActive,
      },
      after: {
        name: campaign.name,
        headline: campaign.headline,
        body: campaign.body,
        contactLine: campaign.contactLine,
        isActive: campaign.isActive,
        operator: actor.email,
      },
    });

    return campaign;
  }

  /**
   * Delete the campaign and every placement with it.
   *
   * The cascade is the point: an advert somebody wants gone has to leave every
   * document it was on, and a "deleted" campaign still printing at the bottom
   * of a shop's statements because one placement row survived is the failure
   * this route exists to prevent. Switching `isActive` off does the same thing
   * reversibly, and is what the screen offers first.
   */
  async remove(actor: AdminActor, id: string) {
    const existing = await this.prisma.adCampaign.findUnique({
      where: { id },
      include: { placements: { select: { workspaceId: true } } },
    });
    if (!existing) throw new NotFoundException('বিজ্ঞাপনটি পাওয়া যায়নি');

    await this.prisma.adCampaign.delete({ where: { id } });

    await this.audit.record({
      ...fileAgainst(actor),
      action: AD_DELETED,
      entity: 'AdCampaign',
      entityId: id,
      before: {
        name: existing.name,
        headline: existing.headline,
        placements: existing.placements.length,
      },
      after: { operator: actor.email },
    });

    return { id, deleted: true, placementsRemoved: existing.placements.length };
  }

  /**
   * Run a campaign on one workspace, or move its window.
   *
   * Idempotent by `@@unique([campaignId, workspaceId])`: pressing the button
   * twice leaves one placement, and sending new dates edits the one that is
   * there rather than raising a conflict the operator has to resolve by hand.
   */
  async place(actor: AdminActor, campaignId: string, input: PlaceAdInput) {
    const campaign = await this.prisma.adCampaign.findUnique({ where: { id: campaignId } });
    if (!campaign) throw new NotFoundException('বিজ্ঞাপনটি পাওয়া যায়নি');

    const workspace = await this.prisma.workspace.findUnique({
      where: { id: input.workspaceId },
      select: { id: true, name: true },
    });
    if (!workspace) throw new NotFoundException('ওয়ার্কস্পেসটি পাওয়া যায়নি');

    const startsAt = input.startsAt ? new Date(input.startsAt) : null;
    const endsAt = input.endsAt ? new Date(input.endsAt) : null;

    const placement = await this.prisma.adPlacement.upsert({
      where: { campaignId_workspaceId: { campaignId, workspaceId: workspace.id } },
      create: {
        campaignId,
        workspaceId: workspace.id,
        startsAt,
        endsAt,
        note: input.note ?? null,
        grantedByUserId: actor.id,
      },
      update: {
        startsAt,
        endsAt,
        note: input.note ?? null,
        grantedByUserId: actor.id,
      },
    });

    await this.audit.record({
      ...fileAgainst(actor, workspace.id),
      action: AD_PLACED,
      entity: 'AdPlacement',
      entityId: placement.id,
      after: {
        campaign: campaign.name,
        headline: campaign.headline,
        startsAt: placement.startsAt?.toISOString() ?? null,
        endsAt: placement.endsAt?.toISOString() ?? null,
        note: placement.note,
        operator: actor.email,
      },
    });

    return placement;
  }

  async withdraw(actor: AdminActor, campaignId: string, workspaceId: string) {
    const placement = await this.prisma.adPlacement.findUnique({
      where: { campaignId_workspaceId: { campaignId, workspaceId } },
      include: { campaign: { select: { name: true } } },
    });
    if (!placement) throw new NotFoundException('এই ওয়ার্কস্পেসে বিজ্ঞাপনটি চলছে না');

    await this.prisma.adPlacement.delete({ where: { id: placement.id } });

    await this.audit.record({
      ...fileAgainst(actor, workspaceId),
      action: AD_WITHDRAWN,
      entity: 'AdPlacement',
      entityId: placement.id,
      before: {
        campaign: placement.campaign.name,
        startsAt: placement.startsAt?.toISOString() ?? null,
        endsAt: placement.endsAt?.toISOString() ?? null,
      },
      after: { operator: actor.email },
    });

    return { campaignId, workspaceId, withdrawn: true };
  }
}
