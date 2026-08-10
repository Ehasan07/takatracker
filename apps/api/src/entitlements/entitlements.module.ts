import { Global, Module } from '@nestjs/common';
import { EntitlementsController } from './entitlements.controller';
import { EntitlementsService } from './entitlements.service';
import { FeatureCatalogueService } from './feature-catalogue.service';
import { UsageMeterService } from './usage-meter.service';

/**
 * Global, because almost every feature module eventually needs to ask whether
 * the workspace is allowed to do something — and, now, to record that it did.
 *
 * `UsageMeterService` is exported alongside the entitlements service because
 * the increment has to happen where the work happens: only the ingestion
 * pipeline knows a message was accepted, and only it can say so atomically with
 * the row it wrote.
 */
@Global()
@Module({
  controllers: [EntitlementsController],
  providers: [EntitlementsService, FeatureCatalogueService, UsageMeterService],
  exports: [EntitlementsService, FeatureCatalogueService, UsageMeterService],
})
export class EntitlementsModule {}
