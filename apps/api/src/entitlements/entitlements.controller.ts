import { Controller, Get, UseGuards } from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { EntitlementsService } from './entitlements.service';
import { FeatureCatalogueService } from './feature-catalogue.service';

@Controller('entitlements')
@UseGuards(JwtAuthGuard)
export class EntitlementsController {
  constructor(
    private readonly entitlements: EntitlementsService,
    private readonly catalogue: FeatureCatalogueService,
  ) {}

  /**
   * Limits, current usage and headroom in one call, so the UI can grey out an
   * action before the user hits a 402 rather than after.
   */
  @Get()
  snapshot(@CurrentUser() user: AuthUser) {
    return this.entitlements.snapshot(user.workspaceId, user.timezone);
  }

  /**
   * The public plan comparison.
   *
   * Read from the `Plan` and `Feature` tables, which is where the enforcement
   * reads from too — so a package assembled at runtime shows up here, and a
   * price the pricing page quotes is one the API will actually hold anybody to.
   */
  @Get('plans')
  plans() {
    return this.entitlements.publicPlans();
  }

  /**
   * The catalogue itself: every feature, retired ones included, with the label
   * and unit a client needs to render a limit it has never heard of. Without
   * this, a feature created after the web build shipped would arrive in the
   * snapshot as a bare key with a number next to it.
   */
  @Get('features')
  features() {
    return this.catalogue.all();
  }
}
