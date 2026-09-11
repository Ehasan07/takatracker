import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AccountsModule } from '../accounts/accounts.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AdminAdsService } from './admin-ads.service';
import { AdminAnalyticsService } from './admin-analytics.service';
import { AdminBroadcastService } from './admin-broadcast.service';
import { AdminCatalogueService } from './admin-catalogue.service';
import { AdminFinanceService } from './admin-finance.service';
import { AdminImpersonationService } from './admin-impersonation.service';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { SuperAdminGuard } from './super-admin.guard';

/**
 * Platform operations.
 *
 * Deliberately **not** `@Global`, unlike AuditModule and EntitlementsModule.
 * Nothing outside this directory should be able to inject `AdminService`: the
 * moment an ordinary feature module can reach a cross-tenant query, the tenant
 * boundary stops being a property of the repository layer and becomes a
 * property of whoever remembered not to call the wrong service. Nothing is
 * exported for the same reason.
 *
 * `AuthModule` is imported for one thing only — `AuthService.reissueAccessToken`,
 * the existing minter that impersonation borrows instead of reimplementing.
 * `PrismaModule`, `AuditModule` and `EntitlementsModule` are already global,
 * which is how `AdminService` reaches `FeatureCatalogueService`.
 *
 * The guard is bound with `@UseGuards` on the controller rather than as an
 * `APP_GUARD`, so mounting this module in `app.module.ts` cannot alter the
 * behaviour of any other route.
 */
@Module({
  /* `AccountsModule` for one thing: `AccountsService.balances`, so an operator
   * and a customer read the same number rather than two implementations of it. */
  imports: [AuthModule, AccountsModule, NotificationsModule],
  controllers: [AdminController],
  providers: [
    AdminService,
    AdminCatalogueService,
    AdminImpersonationService,
    AdminFinanceService,
    AdminAnalyticsService,
    AdminBroadcastService,
    AdminAdsService,
    SuperAdminGuard,
  ],
})
export class AdminModule {}
