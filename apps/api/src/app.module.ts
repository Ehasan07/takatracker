import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RequestContextMiddleware } from './common/request-context.middleware';
import { AccountsModule } from './accounts/accounts.module';
import { AdminModule } from './admin/admin.module';
import { AttachmentsModule } from './attachments/attachments.module';
import { AuditModule } from './audit/audit.module';
import { BusinessModule } from './business/business.module';
import { AuthModule } from './auth/auth.module';
import { CategoriesModule } from './categories/categories.module';
import { ImportModule } from './import/import.module';
import { MigrationModule } from './migration/migration.module';
import { RenewalsModule } from './renewals/renewals.module';
import { IngestionModule } from './ingestion/ingestion.module';
import { InsuranceModule } from './insurance/insurance.module';
import { LoansModule } from './loans/loans.module';
import { SplitModule } from './split/split.module';
import { MailAccountsModule } from './mail-accounts/mail-accounts.module';
import { SavingsModule } from './savings/savings.module';
import { EntitlementsModule } from './entitlements/entitlements.module';
import { FeedbackModule } from './feedback/feedback.module';
import { HealthController } from './health.controller';
import { NotificationsModule } from './notifications/notifications.module';
import { FxModule } from './fx/fx.module';
import { PeopleModule } from './people/people.module';
import { TranslationsModule } from './translations/translations.module';
import { StatementsModule } from './statements/statements.module';
import { WorkspaceModule } from './workspace/workspace.module';
import { PrismaModule } from './prisma/prisma.module';
import { AdsModule } from './ads/ads.module';
import { ReportsModule } from './reports/reports.module';
import { TagsModule } from './tags/tags.module';
import { TaxModule } from './tax/tax.module';
import { ThrottleModule } from './throttle/throttle.module';
import { TransactionsModule } from './transactions/transactions.module';

@Module({
  imports: [
    BusinessModule,
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../../.env', '.env'] }),
    /* Limits and the global guard, unchanged in size and now bucketed by
     * workspace rather than by address — see throttle/throttle.module.ts. */
    ThrottleModule,
    PrismaModule,
    AuditModule,
    EntitlementsModule,
    AuthModule,
    AccountsModule,
    CategoriesModule,
    TagsModule,
    SavingsModule,
    InsuranceModule,
    LoansModule,
    SplitModule,
    PeopleModule,
    FxModule,
    TranslationsModule,
    StatementsModule,
    WorkspaceModule,
    MailAccountsModule,
    ImportModule,
    MigrationModule,
    RenewalsModule,
    AttachmentsModule,
    AdminModule,
    IngestionModule,
    TransactionsModule,
    ReportsModule,
    AdsModule,
    TaxModule,
    NotificationsModule,
    FeedbackModule,
  ],
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  /* Every route, including the unauthenticated ones. A context that exists only
   * on some paths is one `AuditService.record` has to test for, and the branch
   * that says "no context here" is indistinguishable from "no operator here". */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
