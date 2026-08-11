import { Module } from '@nestjs/common';
import { FxController } from './fx.controller';
import { FxService } from './fx.service';

/**
 * Exchange-rate suggestions.
 *
 * `FxService` holds the cache in memory, so it must stay a singleton — which it
 * is, as an ordinary Nest provider. Exported because the transaction module
 * will want the same cached table when it starts sanity-checking a declared
 * rate against the published one.
 */
@Module({
  controllers: [FxController],
  providers: [FxService],
  exports: [FxService],
})
export class FxModule {}
