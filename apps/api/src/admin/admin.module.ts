import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
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
 * `PrismaModule`, `AuditModule` and `EntitlementsModule` are already global.
 *
 * TODO(main): register this in `app.module.ts` (`AdminModule` in `imports`).
 * Nothing else needs to change — the guard is bound with `@UseGuards` on the
 * controller, not as an `APP_GUARD`, precisely so mounting this module cannot
 * alter the behaviour of any other route.
 */
@Module({
  imports: [AuthModule],
  controllers: [AdminController],
  providers: [AdminService, AdminImpersonationService, SuperAdminGuard],
})
export class AdminModule {}
