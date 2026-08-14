import { Module } from '@nestjs/common';
import { MigrationController } from './migration.controller';
import { MigrationService } from './migration.service';
import { WalletClient } from './wallet.client';

@Module({
  controllers: [MigrationController],
  providers: [MigrationService, WalletClient],
  exports: [MigrationService],
})
export class MigrationModule {}
