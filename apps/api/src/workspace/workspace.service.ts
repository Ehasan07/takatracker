import { Injectable } from '@nestjs/common';
import { normaliseUnitList } from '@hishab/shared';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The workspace's own preferences — the settings that describe the books rather
 * than the person reading them.
 *
 * ## Why a module of its own
 *
 * These values were set once at signup and had no write path at all: currency,
 * timezone and locale were chosen on the signup form and then frozen, because
 * nothing in the API could change a `Workspace` row's settings. This is that
 * missing route. It starts with one field and is shaped for the rest —
 * `locale` in particular, which the whole i18n layer already reads and which
 * nothing can currently set.
 *
 * ## Why not on /auth/me
 *
 * `/auth/me` answers "who is signed in", and it already returns these values as
 * part of that answer. A `PATCH` there would mean the endpoint for reading an
 * identity also writes the books' configuration, which is how a route ends up
 * with an authorisation rule nobody can state in one sentence. Reads stay where
 * they are; writes land here, where the rule is "an owner or admin of this
 * workspace, and nobody else".
 */

export interface WorkspaceSettingsPatch {
  /** Replaces the list. An empty array is a legitimate "remove them all". */
  quantityUnits?: string[];
}

export interface WorkspaceSettingsView {
  quantityUnits: string[];
}

@Injectable()
export class WorkspaceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async settings(workspaceId: string): Promise<WorkspaceSettingsView> {
    const workspace = await this.prisma.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
      select: { quantityUnits: true },
    });
    return { quantityUnits: workspace.quantityUnits };
  }

  async update(
    workspaceId: string,
    userId: string,
    patch: WorkspaceSettingsPatch,
  ): Promise<WorkspaceSettingsView> {
    const before = await this.prisma.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
      select: { quantityUnits: true },
    });

    /* Cleaned here and not only in the client: the cap, the de-duplication and
     * the "not one of the shipped eight" rule are the same three the dropdown
     * relies on, and a list that reached the column unfiltered would show a
     * workspace two কেজি rows with only one of them removable. */
    const quantityUnits =
      patch.quantityUnits === undefined ? undefined : normaliseUnitList(patch.quantityUnits);

    if (quantityUnits === undefined) return { quantityUnits: before.quantityUnits };

    const updated = await this.prisma.workspace.update({
      where: { id: workspaceId },
      data: { quantityUnits },
      select: { quantityUnits: true },
    });

    /* Emitted, not awaited. A settings change is worth a line in the log —
     * "why does the dropdown say গজ now" has an answer — but it is not worth
     * making the save wait on a second write. `record` never rejects. */
    void this.audit.record({
      workspaceId,
      actorUserId: userId,
      action: 'workspace.settings_updated',
      entity: 'Workspace',
      entityId: workspaceId,
      before: { quantityUnits: before.quantityUnits },
      after: { quantityUnits: updated.quantityUnits },
    });

    return { quantityUnits: updated.quantityUnits };
  }
}
