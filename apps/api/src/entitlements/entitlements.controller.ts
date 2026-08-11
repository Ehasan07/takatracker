import { Controller, Get, UseGuards } from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { EntitlementsService } from './entitlements.service';
import { FeatureCatalogueService } from './feature-catalogue.service';

/**
 * The guard is on the methods, not the class.
 *
 * `plans` and `features` describe what is *for sale*; `snapshot` describes what
 * one workspace has used. Only the last of those needs a session, and putting a
 * class-level guard over all three meant the pricing page — the one screen a
 * visitor sees before they have an account — could not read the prices. The
 * comparison was documented as public and was not.
 */
@Controller('entitlements')
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
  @UseGuards(JwtAuthGuard)
  snapshot(@CurrentUser() user: AuthUser) {
    return this.entitlements.snapshot(user.workspaceId, user.timezone);
  }

  /**
   * The public plan comparison — no session, because the people who most need
   * to read it do not have one yet.
   *
   * Read from the `Plan` and `Feature` tables, which is where the enforcement
   * reads from too — so a package assembled at runtime shows up here, and a
   * price the pricing page quotes is one the API will actually hold anybody to.
   *
   * Nothing here is tenant data: `isPublic` plans, their prices, and the labels
   * of the features they grant. It is the same list a printed price sheet would
   * carry.
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
   *
   * Public for the same reason as `plans`: the pricing table names the features
   * a package grants, and it cannot name them before you sign in.
   */
  @Get('features')
  features() {
    return this.catalogue.all();
  }
}
