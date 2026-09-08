import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { jwtAccessSecret } from '../common/env';
import { MailModule } from '../mail/mail.module';
import { AccountDeletionScheduler } from './account-deletion.scheduler';
import { AccountDeletionService } from './account-deletion.service';
import { AccountService } from './account.service';
import { BreachedPasswordService } from './breached-password.service';
import { SmsSender } from '../notifications/sms.sender';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { EmailTokenService } from './email-token.service';
import { JwtStrategy } from './jwt.strategy';
import { SessionsService } from './sessions.service';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    /* `registerAsync`, not `register`, and that is not cosmetic. `register` is
     * called while this file is still being imported — before AppModule's
     * decorator runs `ConfigModule.forRoot`, so before a local `.env` has
     * reached `process.env`. It therefore read `undefined` and fell through to
     * `?? 'change-me-access'`, while JwtStrategy read the real value later:
     * two different keys, matching only because the placeholder happened to
     * equal what `.env` contained. The factory runs at DI time, after the
     * config is loaded, and the resolver memoises one value for everybody. */
    JwtModule.registerAsync({
      useFactory: () => ({
        secret: jwtAccessSecret(),
        signOptions: { expiresIn: process.env.JWT_ACCESS_TTL ?? '15m' },
      }),
    }),
    // Verification and reset links have to reach a mailbox. MailModule is
    // @Global, so importing it here also makes MailService available anywhere
    // else that later needs to send something.
    MailModule,
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtStrategy,
    EmailTokenService,
    AccountService,
    AccountDeletionService,
    AccountDeletionScheduler,
    SessionsService,
    BreachedPasswordService,
    SmsSender,
  ],
  exports: [AuthService, AccountService, AccountDeletionService, SessionsService],
})
export class AuthModule {}
