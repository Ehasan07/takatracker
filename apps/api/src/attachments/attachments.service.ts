import { createHash } from 'node:crypto';
import type { ReadStream } from 'node:fs';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { toBengaliDigits } from '@hishab/shared';
import { AuditService } from '../audit/audit.service';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../transactions/transactions.service';
import { AttachmentStorage, UnsafeStoragePathError } from './attachment-storage';
import { ATTACHMENT_MIME_TYPES, defaultFilenameFor, sniffMimeType } from './file-type';

/**
 * Receipts and documents: the bytes behind `Transaction.attachmentIds` and the
 * same array on `Loan`, `LoanPayment`, `SavingsPlan` and `InsurancePolicy`.
 *
 * This is the most sensitive endpoint in the API. Everything else serves
 * numbers about somebody's money; this serves photographs of their bank
 * statements, their national ID and their insurance papers. Three rules follow
 * from that and none of them are negotiable:
 *
 *  1. **Every read is workspace-scoped.** An id from another workspace is a
 *     404, resolved by the same `requireRow` on all three read paths, so there
 *     is no route that reaches a row without going through the tenant filter.
 *  2. **The path comes from the hash.** See `attachment-storage.ts` — nothing a
 *     user typed ever becomes part of a path.
 *  3. **The type is sniffed, not believed.** See `file-type.ts` — the declared
 *     `Content-Type` is discarded, and the sniffed type is what is stored and
 *     what is served back.
 *
 * **Deduplication is on the bytes, never on the row.** One upload always makes
 * one `Attachment` row; the file underneath it is shared when the hash already
 * exists. Reusing the row instead would be smaller and wrong: the rows are
 * referenced by id from `attachmentIds` arrays all over the schema, so a row
 * shared between two transactions would mean deleting the receipt from January
 * silently blanks it on February, and it would hand a second uploader the first
 * one's filename. Worse, a row carries a `workspaceId` — reusing one across
 * workspaces would be a tenant breach, and refusing to do so while reusing
 * within one would make the behaviour depend on who happened to upload first.
 * So: one row per upload, one file per distinct hash. That is exactly why
 * deleting must count the other rows on the same hash before unlinking.
 */

const UPLOADED_ACTION = 'attachment.uploaded';
const DELETED_ACTION = 'attachment.deleted';

/**
 * Five mebibytes.
 *
 * A phone photograph of a receipt is one to three; a scanned multi-page PDF
 * rarely more. The cap is not really about disk — it is about how much a single
 * unauthenticated-looking request can make the process hold in memory at once,
 * which is why the controller refuses past it while the body is still arriving
 * rather than after it has been buffered.
 */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

const bn = (value: number): string => toBengaliDigits(value.toLocaleString('en-US'));

export const TOO_LARGE_MESSAGE = `ফাইলটি খুব বড় — সর্বোচ্চ ${bn(
  MAX_ATTACHMENT_BYTES / (1024 * 1024),
)} মেগাবাইট পর্যন্ত ছবি বা পিডিএফ দেওয়া যায়`;

export const UNSUPPORTED_TYPE_MESSAGE =
  'শুধু ছবি (JPEG, PNG, WebP, HEIC) অথবা পিডিএফ ফাইল দেওয়া যায়';

const EMPTY_FILE_MESSAGE = 'ফাইলটি খালি — আবার চেষ্টা করুন';

const NOT_FOUND_MESSAGE = 'ফাইল পাওয়া যায়নি';

/** Shown when the row is fine but the bytes under it are not. */
const UNREADABLE_MESSAGE = 'ফাইলটি পড়া যাচ্ছে না — সম্ভবত নষ্ট হয়ে গেছে';

const SERVEABLE_TYPES = new Set<string>(ATTACHMENT_MIME_TYPES);

/** No browser renders this. The answer for a type we cannot vouch for. */
const INERT_TYPE = 'application/octet-stream';

export interface AttachmentView {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** Hex SHA-256 of the bytes. Lets a client skip re-uploading what it has. */
  sha256: string;
  createdByUserId: string | null;
  createdAt: string;
}

export interface UploadedAttachmentView extends AttachmentView {
  /**
   * An earlier, still-live attachment **in this workspace** holding the same
   * bytes, so the UI can say "you have already attached this receipt". Scoped
   * to the caller's own workspace on purpose: answering it globally would turn
   * the upload endpoint into an oracle for whether a given file exists on the
   * server at all, across tenants.
   */
  duplicateOfId: string | null;
}

export interface AttachmentDownload {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  stream: ReadStream;
}

/** Matches `EntitlementsService`, which reports the usage this is checked against. */
const BYTES_PER_MB = 1_048_576;

export interface UploadAttachmentInput {
  /** Already stripped of anything path-like by the controller. May be empty. */
  filename: string;
  bytes: Buffer;
}

@Injectable()
export class AttachmentsService {
  private readonly logger = new Logger(AttachmentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: AttachmentStorage,
    private readonly entitlements: EntitlementsService,
  ) {}

  // --- writes ------------------------------------------------------------------

  async upload(ctx: TenantContext, input: UploadAttachmentInput): Promise<UploadedAttachmentView> {
    const { bytes } = input;

    if (bytes.length === 0) throw new BadRequestException(EMPTY_FILE_MESSAGE);
    /* The plan's storage ceiling, enforced here because here is the only place
     * bytes reach the disk.
     *
     * It was measured and reported and never *checked*: `attachments.storage.mb`
     * had a usage number, a column on every plan and a row on the admin screen,
     * and a workspace whose plan set it to zero could still upload all day. A
     * package that says "no attachments" has to mean it, and a paid tier that
     * sells 500 MB is not selling anything if the free one has no ceiling
     * either.
     *
     * Rounded **up**, so a 200 KB receipt costs 1 MB against the allowance
     * rather than nothing: rounding down would let a plan with a 5 MB ceiling
     * take an unbounded number of small files, which is the same hole with a
     * longer fuse. A zero ceiling therefore refuses the first byte. */
    await this.entitlements.assertWithinLimit(
      ctx.workspaceId,
      'attachments.storage.mb',
      ctx.timezone,
      Math.ceil(bytes.length / BYTES_PER_MB),
    );
    /* The controller already refused anything larger while it was arriving.
     * Repeated here because the service must not depend on its caller having
     * done so — this is the only place that decides what lands on disk. */
    if (bytes.length > MAX_ATTACHMENT_BYTES) throw new BadRequestException(TOO_LARGE_MESSAGE);

    const mimeType = sniffMimeType(bytes);
    if (!mimeType) throw new UnsupportedMediaTypeException(UNSUPPORTED_TYPE_MESSAGE);

    const filename = input.filename || defaultFilenameFor(mimeType);
    const sha256 = createHash('sha256').update(bytes).digest('hex');

    /* Looked up before the write so the answer describes the state the user was
     * in when they pressed upload, not the one this very upload created. */
    const duplicate = await this.prisma.attachment.findFirst({
      where: { workspaceId: ctx.workspaceId, sha256, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });

    /* File first, row second. A row pointing at bytes that are not there yet is
     * a broken download; bytes with no row yet are invisible and will be
     * adopted by the next upload of the same receipt. */
    const stored = await this.storage.write(sha256, bytes);

    const row = await this.prisma.attachment.create({
      data: {
        workspaceId: ctx.workspaceId,
        createdByUserId: ctx.id,
        filename,
        mimeType,
        sizeBytes: bytes.length,
        sha256,
        storagePath: stored.storagePath,
      },
    });

    this.audit.emit({
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.id,
      action: UPLOADED_ACTION,
      entity: 'Attachment',
      entityId: row.id,
      after: {
        filename,
        // The sniffed type. What the client declared is not recorded because it
        // was never believed and never used.
        mimeType,
        sizeBytes: bytes.length,
        sha256,
        storagePath: stored.storagePath,
        /* False means these bytes were already on disk under this hash, so the
         * upload cost nothing but a row. Kept for anyone reconciling the
         * directory against the table. */
        fileWritten: stored.written,
      },
    });

    return { ...AttachmentsService.present(row), duplicateOfId: duplicate?.id ?? null };
  }

  /**
   * Soft-delete the row, and unlink the file only when nothing else points at
   * it.
   *
   * The count deliberately ignores `workspaceId`, which is the one place in
   * this file that does. The file on disk is addressed by hash alone, so two
   * workspaces that happen to hold the same bytes — a standard bank statement
   * template, the same forwarded receipt — share it. Counting only within the
   * caller's workspace would delete a file another tenant is still using and
   * leave them with a 404 on their own document.
   *
   * The row is soft-deleted first so that the count is taken with this
   * attachment already out of the way, and so an upload landing at the same
   * moment is either counted (its row exists, we leave the file alone) or lands
   * a fraction later and rewrites the file it needs. A very narrow window
   * remains where an upload can reuse a file that is about to be unlinked;
   * `download` treats a missing file as a 404 and logs it loudly rather than
   * throwing a 500, which is the honest behaviour until there is a job runner
   * to do this sweeping out of band.
   */
  async remove(ctx: TenantContext, id: string): Promise<{ id: string }> {
    const row = await this.requireRow(ctx.workspaceId, id);

    await this.prisma.attachment.update({
      where: { id: row.id },
      data: { deletedAt: new Date() },
    });

    const stillReferenced = await this.prisma.attachment.count({
      where: { sha256: row.sha256, deletedAt: null },
    });

    let fileRemoved = false;
    if (stillReferenced === 0) {
      try {
        fileRemoved = await this.storage.remove(row.storagePath);
      } catch (err) {
        /* The row is already gone from the user's point of view and that is the
         * part they asked for. An orphaned file is a disk problem for an
         * operator, not a failed request for them. */
        this.logger.error(
          `Soft-deleted attachment ${row.id} but could not unlink ${row.storagePath}: ` +
            `${(err as Error).message}`,
        );
      }
    }

    this.audit.emit({
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.id,
      action: DELETED_ACTION,
      entity: 'Attachment',
      entityId: row.id,
      before: {
        filename: row.filename,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes,
        sha256: row.sha256,
        storagePath: row.storagePath,
      },
      after: {
        deleted: true,
        /* Whether the bytes went with it. `false` here with no error in the log
         * means another row still holds the same hash, which is the shared-file
         * case working as intended. */
        fileRemoved,
        remainingRowsOnHash: stillReferenced,
      },
    });

    return { id: row.id };
  }

  // --- reads -------------------------------------------------------------------

  async meta(ctx: TenantContext, id: string): Promise<AttachmentView> {
    return AttachmentsService.present(await this.requireRow(ctx.workspaceId, id));
  }

  /**
   * The row and an open stream over its bytes.
   *
   * The size is re-read from disk rather than taken from the row, for two
   * reasons: it is the `Content-Length` a download needs to show progress, and
   * a disagreement between the two means the file is not what the row says it
   * is. That is refused rather than served — the whole point of storing the
   * hash is to notice.
   */
  async download(ctx: TenantContext, id: string): Promise<AttachmentDownload> {
    const row = await this.requireRow(ctx.workspaceId, id);

    let sizeOnDisk: number | null;
    try {
      sizeOnDisk = await this.storage.size(row.storagePath);
    } catch (err) {
      if (err instanceof UnsafeStoragePathError) {
        /* A stored path that fails the containment check cannot have been
         * written by this service. Something has edited the table, which is
         * worth waking somebody up for. */
        this.logger.error(`Attachment ${row.id} has a storagePath outside the root — refusing.`);
        throw new NotFoundException(NOT_FOUND_MESSAGE);
      }
      throw err;
    }

    if (sizeOnDisk === null) {
      this.logger.error(
        `Attachment ${row.id} points at ${row.storagePath}, which is not on disk. The row and ` +
          'the attachment directory have diverged — check ATTACHMENTS_DIR and any restore.',
      );
      throw new NotFoundException(NOT_FOUND_MESSAGE);
    }
    if (sizeOnDisk !== row.sizeBytes) {
      this.logger.error(
        `Attachment ${row.id} is ${sizeOnDisk} bytes on disk but the row says ${row.sizeBytes}. ` +
          'Refusing to serve it.',
      );
      throw new BadRequestException(UNREADABLE_MESSAGE);
    }

    return {
      filename: row.filename,
      /* The type sniffed at upload, read back off the row. A stored value that
       * is somehow not on the allowlist — an older row, a hand-edited one — is
       * downgraded rather than trusted, because the response type is what tells
       * the browser whether it is safe to render this. */
      mimeType: AttachmentsService.serveableType(row.mimeType),
      sizeBytes: sizeOnDisk,
      stream: this.storage.openReadStream(row.storagePath),
    };
  }

  // --- guards ------------------------------------------------------------------

  /**
   * The single door every read and the delete go through.
   *
   * `workspaceId` is in the `where`, not checked afterwards, so there is no
   * ordering to get wrong: an id belonging to another workspace does not come
   * back at all, and the caller cannot tell it apart from an id that never
   * existed. That is the intended answer — "wrong workspace" and "no such file"
   * must look identical, or the endpoint enumerates other tenants' rows.
   */
  private async requireRow(workspaceId: string, id: string) {
    const row = await this.prisma.attachment.findFirst({
      where: { id, workspaceId, deletedAt: null },
    });
    if (!row) throw new NotFoundException(NOT_FOUND_MESSAGE);
    return row;
  }

  // --- presentation --------------------------------------------------------------

  /**
   * Checked against the same allowlist the sniffer uses, on the way out as well
   * as on the way in. Every row this service writes already holds a sniffed
   * type, so the fallback should be unreachable — but "unreachable" is a claim
   * about code that no longer holds the moment a row is restored from a backup
   * or written by a migration, and the wrong value here is the browser's
   * instruction to render.
   */
  private static serveableType(stored: string): string {
    return SERVEABLE_TYPES.has(stored) ? stored : INERT_TYPE;
  }

  private static present(row: {
    id: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    createdByUserId: string | null;
    createdAt: Date;
  }): AttachmentView {
    return {
      id: row.id,
      filename: row.filename,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      sha256: row.sha256,
      createdByUserId: row.createdByUserId,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
