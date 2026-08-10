import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AccountsModule } from './accounts/accounts.module';
import { AdminModule } from './admin/admin.module';
import { AttachmentsModule } from './attachments/attachments.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { CategoriesModule } from './categories/categories.module';
import { ImportModule } from './import/import.module';
import { IngestionModule } from './ingestion/ingestion.module';
import { InsuranceModule } from './insurance/insurance.module';
import { LoansModule } from './loans/loans.module';
import { MailAccountsModule } from './mail-accounts/mail-accounts.module';
import { SavingsModule } from './savings/savings.module';
import { EntitlementsModule } from './entitlements/entitlements.module';
import { HealthController } from './health.controller';
import { NotificationsModule } from './notifications/notifications.module';
import { PeopleModule } from './people/people.module';
import { PrismaModule } from './prisma/prisma.module';
import { ReportsModule } from './reports/reports.module';
import { TagsModule } from './tags/tags.module';
import { ThrottleModule } from './throttle/throttle.module';
import { TransactionsModule } from './transactions/transactions.module';

@Module({
  imports: [
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
    PeopleModule,
    MailAccountsModule,
    ImportModule,
    AttachmentsModule,
    AdminModule,
    IngestionModule,
    TransactionsModule,
    ReportsModule,
    NotificationsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
