import {
  BadRequestException,
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
import { StatementReadError } from './statement-reader';
import { MAX_STATEMENT_BYTES, StatementService } from './statement.service';

/**
 * The HTTP surface of a spreadsheet import.
 *
 * The upload arrives as a raw body rather than multipart. A statement is one
 * file of one kind, multipart would buy nothing but a dependency, and the body
 * can then be size-capped as it streams instead of after it has already been
 * buffered.
 *
 * Two doors, kept apart on purpose:
 *
 *  - `POST /import/preview` reads delimited text and nothing else. It is the
 *    older, narrower one and stays exactly as it was.
 *  - `POST /import/statement` reads whatever the bank sent, decides the format
 *    from the bytes, and answers with every row plus the entries each one might
 *    already be. It is what the review screen talks to.
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

/**
 * The statement door's own cap, which is larger.
 *
 * A CSV is text and two megabytes of it is twenty thousand lines. A PDF of the
 * same twenty rows carries a logo, embedded fonts and a page of terms, and is
 * routinely bigger than the entire year of transactions it describes.
 */
class StatementTooLargeException extends PayloadTooLargeException {
  constructor() {
    super(
      `ফাইলটি খুব বড় — সর্বোচ্চ ${bn(MAX_STATEMENT_BYTES / (1024 * 1024))} মেগাবাইট পর্যন্ত নেওয়া যায়`,
    );
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
  /**
   * The category the user picked on the review screen, when they picked one.
   *
   * Beats `categoryName`, which is a free-text match against the workspace's
   * category names and cannot tell two "অন্যান্য" apart when they sit under
   * different parents. A name is the right thing to read out of a bank's own
   * category column; an id is the right thing to accept from somebody who was
   * shown a list and pointed at a row in it.
   */
  categoryId: cuid.nullish(),
  /**
   * "I was shown this might already be in the books and I want it anyway."
   *
   * Only the row-by-row review screen sets it, and only on a row somebody
   * actually pressed approve on. Absent — which is every row of a plain CSV
   * import — the server's own duplicate check still skips the row, because
   * nobody has looked at it.
   */
  acceptDuplicate: z.boolean().optional(),
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

const statementQuerySchema = z.object({
  filename: optionalQuery(z.string().max(255)),
  datePreference: optionalQuery(z.enum(DATE_PREFERENCES)),
  /**
   * Which account the statement is for.
   *
   * Optional, because a person often drops the file in before choosing. It is
   * only ever used to narrow the duplicate check, and the response says which
   * of the two it did — with no account, every real account is compared
   * against, which can only raise more questions and never fewer.
   */
  accountId: optionalQuery(cuid),
  /** A workbook tab, on the second pass, when the guessed one was wrong. */
  sheet: optionalQuery(z.string().max(120)),
});
export type StatementQuery = z.infer<typeof statementQuerySchema>;

/**
 * The re-check. Sent when the user picks a different account, or corrects a
 * column and the dates or amounts change underneath the answer.
 *
 * Rows and not the file: the file has already been read, the client is holding
 * the parsed rows, and asking it to upload eight megabytes again to re-run a
 * query would be absurd.
 */
const duplicateProbesSchema = z.object({
  accountId: cuid.nullish(),
  rows: z
    .array(
      z.object({
        lineNumber: z.number().int().min(1).max(1_000_000),
        date: isoDate,
        amountMinor: positiveMinorAmount,
      }),
    )
    .max(MAX_COMMIT_ROWS),
});
export type DuplicateProbesInput = z.infer<typeof duplicateProbesSchema>;

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
 * The raw request body, refused past `limit`.
 *
 * Counted as it arrives rather than after: a cap that only fires once the whole
 * thing is in memory is not a cap. Nest's default parsers only claim JSON and
 * form bodies, so a `text/csv` or `application/pdf` request reaches here with
 * its stream untouched — the buffered fallback is there in case that ever
 * stops being true.
 */
async function readBinaryBody(req: Request, limit: number, tooLarge: () => Error): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? '0');
  if (Number.isFinite(declared) && declared > limit) throw tooLarge();

  const alreadyParsed: unknown = (req as Request & { body?: unknown }).body;
  if (Buffer.isBuffer(alreadyParsed) && alreadyParsed.length > 0) return alreadyParsed;
  if (typeof alreadyParsed === 'string' && alreadyParsed !== '') {
    return Buffer.from(alreadyParsed, 'utf8');
  }

  // Something upstream drained the stream and left nothing behind. Say the file
  // is empty rather than waiting forever for an 'end' that already happened.
  if (req.readableEnded) return Buffer.alloc(0);

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        reject(tooLarge());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err) => reject(err));
  });
}

/** The CSV-only door's stricter reading: an allow-list, and text out. */
async function readTextBody(req: Request): Promise<string> {
  const type = contentTypeOf(req);
  if (type !== '' && !ACCEPTED_CONTENT_TYPES.includes(type)) {
    throw new UnsupportedMediaTypeException(
      'শুধু CSV বা টেক্সট ফাইল পাঠানো যায় (text/csv বা text/plain)',
    );
  }
  const bytes = await readBinaryBody(req, MAX_IMPORT_BYTES, () => new FileTooLargeException());
  return bytes.toString('utf8');
}

@Controller('import')
@UseGuards(JwtAuthGuard)
export class ImportController {
  constructor(
    private readonly imports: ImportService,
    private readonly statements: StatementService,
  ) {}

  /**
   * A statement in whatever format it arrived: CSV, TSV, Excel or PDF.
   *
   * **No content-type allow-list here, on purpose.** Browsers send
   * `application/octet-stream` for a `.xlsx` about half the time, and a person
   * who renames a file has not committed a protocol error. The format is
   * decided from the first bytes of the file, which is both more reliable and
   * the only way to answer "this is a photograph, and here is what to do
   * instead" rather than a bare 415.
   *
   * 200 rather than 201: nothing was created, and nothing will be until the
   * user approves rows one by one.
   */
  @Post('statement')
  @HttpCode(200)
  async statement(
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
    @Query(zodPipe(statementQuerySchema)) query: StatementQuery,
  ) {
    const bytes = await readBinaryBody(
      req,
      MAX_STATEMENT_BYTES,
      () => new StatementTooLargeException(),
    );

    try {
      return await this.statements.preview(user, {
        filename: safeFilename(query.filename ?? req.headers['x-filename']),
        bytes,
        accountId: query.accountId,
        datePreference: query.datePreference,
        sheet: query.sheet,
      });
    } catch (error) {
      /* A file we will not read is a 415 and a file we could not read is a 400,
       * and the difference matters to the client: one of them is worth offering
       * a different file for, the other is worth trying again. Both carry the
       * reader's own Bengali sentence, which already says what to do. */
      if (error instanceof StatementReadError) {
        throw error.kind === 'UNSUPPORTED'
          ? new UnsupportedMediaTypeException(error.message)
          : new BadRequestException(error.message);
      }
      throw error;
    }
  }

  /**
   * Re-run the duplicate check without re-uploading the file.
   *
   * Needed because the answer depends on the account, and the account is
   * usually chosen after the file has been read.
   */
  @Post('statement/duplicates')
  @HttpCode(200)
  duplicates(
    @CurrentUser() user: AuthUser,
    @Body(zodPipe(duplicateProbesSchema)) body: DuplicateProbesInput,
  ) {
    return this.statements.duplicates(user, body.accountId ?? null, body.rows);
  }

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
