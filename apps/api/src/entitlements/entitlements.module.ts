import { Global, Module } from '@nestjs/common';
import { EntitlementsController } from './entitlements.controller';
import { EntitlementsService } from './entitlements.service';

/**
 * Global, because almost every feature module eventually needs to ask whether
 * the workspace is allowed to do something.
 */
@Global()
@Module({
  controllers: [EntitlementsController],
  providers: [EntitlementsService],
  exports: [EntitlementsService],
})
export class EntitlementsModule {}
