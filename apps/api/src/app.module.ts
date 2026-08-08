import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AccountsModule } from './accounts/accounts.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { CategoriesModule } from './categories/categories.module';
import { ImportModule } from './import/import.module';
import { IngestionModule } from './ingestion/ingestion.module';
import { InsuranceModule } from './insurance/insurance.module';
import { LoansModule } from './loans/loans.module';
import { SavingsModule } from './savings/savings.module';
import { EntitlementsModule } from './entitlements/entitlements.module';
import { HealthController } from './health.controller';
import { NotificationsModule } from './notifications/notifications.module';
import { PrismaModule } from './prisma/prisma.module';
import { ReportsModule } from './reports/reports.module';
import { TransactionsModule } from './transactions/transactions.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../../.env', '.env'] }),
    /* One shared limit per IP. The e2e suite drives every request from
     * 127.0.0.1, so it raises the ceiling rather than tripping over itself. */
    ThrottlerModule.forRoot([
      {
        name: 'default',
        ttl: 60_000,
        limit: Number(
          process.env.THROTTLE_LIMIT ?? (process.env.NODE_ENV === 'test' ? 100_000 : 120),
        ),
      },
    ]),
    PrismaModule,
    AuditModule,
    EntitlementsModule,
    AuthModule,
    AccountsModule,
    CategoriesModule,
    SavingsModule,
    InsuranceModule,
    LoansModule,
    ImportModule,
    IngestionModule,
    TransactionsModule,
    ReportsModule,
    NotificationsModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
