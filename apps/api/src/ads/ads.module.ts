import { Module } from '@nestjs/common';
import { AdsController } from './ads.controller';
import { AdsService } from './ads.service';

/**
 * Exported because the documents that carry a footer are built elsewhere: the
 * public statement a shop shares with a customer renders server-side and has no
 * session to call `/ads/footer` with.
 */
@Module({
  controllers: [AdsController],
  providers: [AdsService],
  exports: [AdsService],
})
export class AdsModule {}
