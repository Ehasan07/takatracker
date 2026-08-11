import { BadRequestException, Injectable } from '@nestjs/common';
import { LOCALES, type Locale } from '@hishab/shared';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../transactions/transactions.service';

/**
 * A workspace's corrections to the interface's wording.
 *
 * The shipped strings are a starting point, not an authority. They were written
 * without knowing what a given household calls things, and the English half was
 * written by people whose first language it is not — so anywhere a word is
 * wrong, awkward, or simply not what this family says, the workspace can
 * replace it and their app will agree.
 *
 * ## Why this is a table and not a config file
 *
 * The alternative is a support request and a deployment for every wording
 * complaint, which means the wording never gets fixed. A row is the only shape
 * that lets the person who noticed the problem be the person who solves it.
 *
 * ## Why it stays small
 *
 * Sparse: only what somebody has actually changed. A workspace with no
 * corrections has no rows and the client fetches an empty object, so the
 * feature costs nothing to the overwhelming majority who never touch it. There
 * is no row per key, ever — the catalogue lives in the build.
 */

/** A single correction may not be longer than the longest string we ship. */
const MAX_VALUE = 500;
const MAX_KEY = 120;

/**
 * How many corrections one workspace may hold.
 *
 * A ceiling at all because this is a user-writable key–value store attached to
 * a tenant, and one with no bound is one somebody eventually treats as
 * storage. Generous enough that correcting every string on every screen stays
 * comfortably inside it.
 */
const MAX_OVERRIDES = 2_000;

@Injectable()
export class TranslationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Every correction this workspace has made, as a flat map.
   *
   * One request at app boot, and usually `{}`. Returned as an object rather
   * than a list because the client's only use for it is a lookup by key.
   */
  async forWorkspace(workspaceId: string, locale: Locale): Promise<Record<string, string>> {
    const rows = await this.prisma.workspaceTranslation.findMany({
      where: { workspaceId, locale },
      select: { key: true, value: true },
    });
    const out: Record<string, string> = {};
    for (const row of rows) out[row.key] = row.value;
    return out;
  }

  /**
   * Set one correction, or clear it.
   *
   * An empty value deletes the row rather than storing a blank: "put it back to
   * what it said" is the common second act of editing a string, and a stored
   * empty string would render the interface with a hole in it.
   */
  async set(
    ctx: TenantContext,
    locale: string,
    key: string,
    value: string | null,
  ): Promise<{ key: string; value: string | null }> {
    const lang = this.assertLocale(locale);
    const trimmedKey = key.trim();
    if (!trimmedKey || trimmedKey.length > MAX_KEY) {
      throw new BadRequestException('স্ট্রিংয়ের কী ঠিক নেই');
    }

    const trimmed = value?.trim() ?? '';
    if (trimmed.length > MAX_VALUE) {
      throw new BadRequestException(`সর্বোচ্চ ${MAX_VALUE} অক্ষর`);
    }

    if (trimmed === '') {
      await this.prisma.workspaceTranslation.deleteMany({
        where: { workspaceId: ctx.workspaceId, locale: lang, key: trimmedKey },
      });
      this.audit.emit({
        workspaceId: ctx.workspaceId,
        actorUserId: ctx.id,
        action: 'translation.reset',
        entity: 'WorkspaceTranslation',
        entityId: trimmedKey,
        before: { locale: lang, key: trimmedKey },
      });
      return { key: trimmedKey, value: null };
    }

    /* Counted before the write, and only when the key is new — an edit to an
     * existing correction can never push the count up, so making every save
     * pay for a count would be a query for nothing. */
    const existing = await this.prisma.workspaceTranslation.findUnique({
      where: {
        workspaceId_locale_key: { workspaceId: ctx.workspaceId, locale: lang, key: trimmedKey },
      },
      select: { id: true, value: true },
    });
    if (!existing) {
      const count = await this.prisma.workspaceTranslation.count({
        where: { workspaceId: ctx.workspaceId },
      });
      if (count >= MAX_OVERRIDES) {
        throw new BadRequestException('অনেক বেশি পরিবর্তন — কিছু আগে মুছে ফেলুন');
      }
    }

    await this.prisma.workspaceTranslation.upsert({
      where: {
        workspaceId_locale_key: { workspaceId: ctx.workspaceId, locale: lang, key: trimmedKey },
      },
      create: {
        workspaceId: ctx.workspaceId,
        locale: lang,
        key: trimmedKey,
        value: trimmed,
        updatedByUserId: ctx.id,
      },
      update: { value: trimmed, updatedByUserId: ctx.id },
    });

    this.audit.emit({
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.id,
      action: 'translation.changed',
      entity: 'WorkspaceTranslation',
      entityId: trimmedKey,
      before: existing ? { value: existing.value } : undefined,
      after: { locale: lang, key: trimmedKey, value: trimmed },
    });

    return { key: trimmedKey, value: trimmed };
  }

  private assertLocale(locale: string): Locale {
    const found = LOCALES.find((l) => l === locale);
    if (!found) throw new BadRequestException('এই ভাষাটি সমর্থিত নয়');
    return found;
  }
}
