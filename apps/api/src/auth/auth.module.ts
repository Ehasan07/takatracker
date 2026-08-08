import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { MailModule } from '../mail/mail.module';
import { AccountService } from './account.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { EmailTokenService } from './email-token.service';
import { JwtStrategy } from './jwt.strategy';
import { SessionsService } from './sessions.service';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.register({
      secret: process.env.JWT_ACCESS_SECRET ?? 'change-me-access',
      signOptions: { expiresIn: process.env.JWT_ACCESS_TTL ?? '15m' },
    }),
    // Verification and reset links have to reach a mailbox. MailModule is
    // @Global, so importing it here also makes MailService available anywhere
    // else that later needs to send something.
    MailModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, EmailTokenService, AccountService, SessionsService],
  exports: [AuthService, AccountService, SessionsService],
})
export class AuthModule {}
