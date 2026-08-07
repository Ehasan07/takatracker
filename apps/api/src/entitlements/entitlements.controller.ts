import { Controller, Get, UseGuards } from '@nestjs/common';
import { DEFAULT_PLANS, FEATURES } from '@hishab/core';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { EntitlementsService } from './entitlements.service';

@Controller('entitlements')
@UseGuards(JwtAuthGuard)
export class EntitlementsController {
  constructor(private readonly entitlements: EntitlementsService) {}

  /**
   * Limits, current usage and headroom in one call, so the UI can grey out an
   * action before the user hits a 402 rather than after.
   */
  @Get()
  snapshot(@CurrentUser() user: AuthUser) {
    return this.entitlements.snapshot(user.workspaceId, user.timezone);
  }

  /** The public plan comparison. Read from the same definition the API enforces. */
  @Get('plans')
  plans() {
    return DEFAULT_PLANS.filter((p) => p.isPublic)
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((p) => ({
        code: p.code,
        name: p.name,
        priceMinor: p.priceMinor,
        interval: p.interval,
        features: Object.entries(p.features).map(([key, limitValue]) => ({
          key,
          label: FEATURES[key as keyof typeof FEATURES]?.label ?? key,
          limitValue,
        })),
      }));
  }
}
