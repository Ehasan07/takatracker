import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AccountsModule } from './accounts/accounts.module';
import { AuthModule } from './auth/auth.module';
import { CategoriesModule } from './categories/categories.module';
import { EntitlementsModule } from './entitlements/entitlements.module';
import { HealthController } from './health.controller';
import { NotificationsModule } from './notifications/notifications.module';
import { PrismaModule } from './prisma/prisma.module';
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
    EntitlementsModule,
    AuthModule,
    AccountsModule,
    CategoriesModule,
    TransactionsModule,
    NotificationsModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
