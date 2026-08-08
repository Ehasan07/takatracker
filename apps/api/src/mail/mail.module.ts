import { Global, Module } from '@nestjs/common';
import { MailService } from './mail.service';

/**
 * Global because mail is a leaf utility with no dependencies of its own —
 * exactly like PrismaModule. Any feature module that needs to send something
 * can inject `MailService` without a fresh import line.
 */
@Global()
@Module({
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
