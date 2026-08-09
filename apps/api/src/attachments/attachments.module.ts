import { Module } from '@nestjs/common';
import { AttachmentStorage } from './attachment-storage';
import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';

/**
 * Receipts and documents.
 *
 * No imports: Prisma and audit are both global modules, and the storage layer
 * is local to this feature. `AttachmentsService` is exported because the
 * modules that hold `attachmentIds` arrays — transactions, loans, savings,
 * insurance — will eventually want to resolve them to metadata without going
 * back out through HTTP.
 *
 * `AttachmentStorage` is a provider rather than a bare module of functions so
 * that the root directory is resolved once, at construction, and so a test can
 * swap the whole disk layer out.
 */
@Module({
  controllers: [AttachmentsController],
  providers: [AttachmentsService, AttachmentStorage],
  exports: [AttachmentsService],
})
export class AttachmentsModule {}
