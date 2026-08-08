import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  PayloadTooLargeException,
  Post,
  Query,
  Req,
  UnsupportedMediaTypeException,
  UseGuards,
} from '@nestjs/common';
import { cuid, isoDate, positiveMinorAmount, toBengaliDigits } from '@hishab/shared';
import type { Request } from 'express';
import { z } from 'zod';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { zodPipe } from '../common/zod.pipe';
import { ImportService, MAX_COMMIT_ROWS, MAX_IMPORT_BYTES } from './import.service';

/**
 * The HTTP surface of a spreadsheet import.
 *
 * The upload arrives as a raw text body rather than multipart. A statement is
 * one file of one kind, multipart would buy nothing but a dependency, and the
 * body can then be size-capped as it streams instead of after it has already
 * been buffered.
 */

const ACCEPTED_CONTENT_TYPES = [
  'text/csv',
  'text/plain',
  'text/tab-separated-values',
  'application/csv',
];

const bn = (value: number): string => toBengaliDigits(value.toLocaleString('en-US'));

const TOO_LARGE_MESSAGE = `ফাইলটি খুব বড় — সর্বোচ্চ ${bn(
  MAX_IMPORT_BYTES / (1024 * 1024),
)} মেগাবাইট পর্যন্ত নেওয়া যায়`;

/** 413, the status a size cap is supposed to answer with. */
class FileTooLargeException extends PayloadTooLargeException {
  constructor() {
    super(TOO_LARGE_MESSAGE);
  }
}

const DATE_PREFERENCES = ['DMY', 'MDY'] as const;

/**
 * A cleared filter arrives as `?accountId=` — an empty string, not an absent
 * key. Treating that as "no filter" is the difference between a working
 * "সব" chip and a 400 the user cannot explain.
 */
const optionalQuery = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (value === '' || value === null ? undefined : value), schema.optional());

const previewQuerySchema = z.object({
  filename: optionalQuery(z.string().max(255)),
  /** Set on the second pass, when the user corrects our guess. */
  datePreference: optionalQuery(z.enum(DATE_PREFERENCES)),
});
export type PreviewQuery = z.infer<typeof previewQuerySchema>;

const columnMatchSchema = z.object({
  index: z.number().int().min(0).max(1000),
  header: z.string().max(200).default(''),
  confidence: z.number().min(0).max(100).default(0),
});

/**
 * One row the user accepted in the preview.
 *
 * The rows come back from the client rather than being re-read from the file
 * on the server, because the preview grid is editable: the entire point of
 * showing somebody their data before it lands is to let them fix the row the
 * parser misread. Everything that could hurt the ledger is re-validated —
 * integer poisha, a positive amount, an ISO date, one of two directions — and
 * the account is workspace-checked in the service.
 */
const importRowSchema = z.object({
  /** The spreadsheet row this came from, for reporting a skip. Display only. */
  lineNumber: z.number().int().min(1).max(1_000_000).optional(),
  date: isoDate,
  description: z.string().max(500).optional(),
  /** Always positive; `direction` carries the sign. */
  amountMinor: positiveMinorAmount,
  direction: z.enum(['IN', 'OUT']),
  reference: z.string().max(200).nullish(),
  categoryName: z.string().max(120).nullish(),
});

const commitImportSchema = z.object({
  filename: z.string().min(1).max(255).default('upload.csv'),
  fileHash: z.string().max(128).optional(),
  /** Where every row lands. One import, one account. */
  accountId: cuid,
  /** Kept on the batch so the next import of the same export can reuse it. */
  mapping: z.record(z.string().max(40), columnMatchSchema).optional(),
  datePreference: z.enum(DATE_PREFERENCES).default('DMY'),
  rows: z
    .array(importRowSchema)
    .min(1, 'আমদানি করার মতো কোনো সারি নেই')
    .max(MAX_COMMIT_ROWS, `একবারে সর্বোচ্চ ${bn(MAX_COMMIT_ROWS)}টি সারি আমদানি করা যায়`),
});
export type CommitImportInput = z.infer<typeof commitImportSchema>;

const batchesQuerySchema = z.object({
  limit: optionalQuery(z.coerce.number().int().min(1).max(200)),
});
export type BatchesQuery = z.infer<typeof batchesQuerySchema>;

function contentTypeOf(req: Request): string {
  const raw = req.headers['content-type'] ?? '';
  return (raw.split(';')[0] ?? '').trim().toLowerCase();
}

/**
 * A filename is only ever shown back to the user and stored on the batch, but
 * it arrives from a client, so it loses anything that looks like a path or a
 * control character before it goes anywhere near a Content-Disposition header
 * or a log line.
 */
function safeFilename(raw: unknown): string {
  // A header sent twice arrives as an array; anything that is not a string is
  // simply not a filename.
  const text = typeof raw === 'string' ? raw : '';
  const base = text.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[^\p{L}\p{N}._ ()-]/gu, '').trim();
  return cleaned === '' ? 'upload.csv' : cleaned.slice(0, 200);
}

/**
 * The raw request body as text, refused past the cap.
 *
 * Counted as it arrives rather than after: a cap that only fires once the whole
 * thing is in memory is not a cap. Nest's default parsers only claim JSON and
 * form bodies, so a `text/csv` request reaches here with its stream untouched —
 * the buffered fallback is there in case that ever stops being true.
 */
async function readTextBody(req: Request): Promise<string> {
  const type = contentTypeOf(req);
  if (type !== '' && !ACCEPTED_CONTENT_TYPES.includes(type)) {
    throw new UnsupportedMediaTypeException(
      'শুধু CSV বা টেক্সট ফাইল পাঠানো যায় (text/csv বা text/plain)',
    );
  }

  const declared = Number(req.headers['content-length'] ?? '0');
  if (Number.isFinite(declared) && declared > MAX_IMPORT_BYTES) throw new FileTooLargeException();

  const alreadyParsed: unknown = (req as Request & { body?: unknown }).body;
  if (typeof alreadyParsed === 'string' && alreadyParsed !== '') return alreadyParsed;
  if (Buffer.isBuffer(alreadyParsed) && alreadyParsed.length > 0) {
    return alreadyParsed.toString('utf8');
  }

  // Something upstream drained the stream and left nothing behind. Say the file
  // is empty rather than waiting forever for an 'end' that already happened.
  if (req.readableEnded) return '';

  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_IMPORT_BYTES) {
        req.destroy();
        reject(new FileTooLargeException());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', (err) => reject(err));
  });
}

@Controller('import')
@UseGuards(JwtAuthGuard)
export class ImportController {
  constructor(private readonly imports: ImportService) {}

  /**
   * Read the file and report what would happen. Writes nothing to the ledger.
   *
   * 200 rather than 201: nothing was created.
   */
  @Post('preview')
  @HttpCode(200)
  async preview(
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
    @Query(zodPipe(previewQuerySchema)) query: PreviewQuery,
  ) {
    const text = await readTextBody(req);
    return this.imports.preview(user, {
      filename: safeFilename(query.filename ?? req.headers['x-filename']),
      text,
      datePreference: query.datePreference,
    });
  }

  @Post('commit')
  commit(
    @CurrentUser() user: AuthUser,
    @Body(zodPipe(commitImportSchema)) body: CommitImportInput,
  ) {
    return this.imports.commit(user, { ...body, filename: safeFilename(body.filename) });
  }

  @Get('batches')
  batches(@CurrentUser() user: AuthUser, @Query(zodPipe(batchesQuerySchema)) query: BatchesQuery) {
    return this.imports.batches(user, query.limit);
  }

  @Post('batches/:id/revert')
  @HttpCode(200)
  revert(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.imports.revert(user, id);
  }
}
