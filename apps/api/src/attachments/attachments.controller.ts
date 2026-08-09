import {
  Controller,
  Delete,
  Get,
  Param,
  PayloadTooLargeException,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UnsupportedMediaTypeException,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { zodPipe } from '../common/zod.pipe';
import {
  AttachmentsService,
  MAX_ATTACHMENT_BYTES,
  TOO_LARGE_MESSAGE,
  type AttachmentView,
  type UploadedAttachmentView,
} from './attachments.service';

/**
 * The HTTP surface of an attachment.
 *
 * The upload is raw bytes with the type in the header and the name in a query
 * parameter, exactly as `/import/preview` takes a spreadsheet. Not multipart,
 * and not because multipart is hard: one upload is one file, so the envelope
 * would carry no information, and parsing it means a body-parser dependency
 * sitting on the request path of the endpoint that handles people's bank
 * documents. There is nothing to gain and a dependency to audit. (Nest's
 * default parsers claim JSON and form bodies only, so an `image/jpeg` request
 * arrives here with its stream untouched.)
 */

/** A cleared parameter arrives as `?filename=` — an empty string, not an absent key. */
const optionalQuery = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (value === '' || value === null ? undefined : value), schema.optional());

const uploadQuerySchema = z.object({
  filename: optionalQuery(z.string().max(255)),
});
export type UploadAttachmentQuery = z.infer<typeof uploadQuerySchema>;

/** 413, the status a size cap is supposed to answer with. */
class FileTooLargeException extends PayloadTooLargeException {
  constructor() {
    super(TOO_LARGE_MESSAGE);
  }
}

const MULTIPART_MESSAGE = 'ফাইলটি সরাসরি পাঠান — ফর্ম-ডেটা (multipart) দিয়ে আপলোড করা যায় না';

function contentTypeOf(req: Request): string {
  const raw = req.headers['content-type'] ?? '';
  return (raw.split(';')[0] ?? '').trim().toLowerCase();
}

/**
 * The name the user knows the file by, stripped of everything else.
 *
 * It is stored on the row and echoed in a `Content-Disposition`, and it never
 * touches a path — the path comes from the SHA-256. This still runs, because
 * "never touches a path" is a property of today's code and a header injection
 * is a property of the string: anything path-like, and every control character
 * that could break a header line, is removed here. Bengali letters survive
 * (`\p{L}`); `filename*=UTF-8''` on the way out is what carries them.
 *
 * Returns an empty string when nothing usable is left, and the service names
 * the file after its sniffed type instead.
 */
function safeFilename(raw: unknown): string {
  // A header sent twice arrives as an array; anything not a string is not a name.
  const text = typeof raw === 'string' ? raw : '';
  const base = text.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[^\p{L}\p{N}._ ()-]/gu, '').trim();
  // A name that is only dots would be useless for display and is exactly what a
  // traversal attempt leaves behind after the split above.
  return /^\.*$/.test(cleaned) ? '' : cleaned.slice(0, 200);
}

/**
 * `Content-Disposition` with both an ASCII fallback and the UTF-8 form, as in
 * `import/export.controller.ts`. Always `attachment`, never `inline`: an
 * inline PDF renders as a top-level document on the API origin, where the
 * access token lives as an httpOnly cookie, and a PDF can run script. An
 * `<img src="/v1/attachments/:id">` is unaffected — the disposition only
 * governs navigation, so the web app can still show a receipt.
 */
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * The raw request body as bytes, refused past the cap.
 *
 * Counted as it arrives rather than after: a cap that only fires once the whole
 * file is in memory is not a cap, it is a description of how much memory an
 * attacker gets to use first. The declared `Content-Length` is checked before a
 * single chunk is read, so an honest oversized upload is rejected immediately,
 * and the running total catches a chunked body that declared nothing.
 */
async function readBinaryBody(req: Request): Promise<Buffer> {
  const type = contentTypeOf(req);
  /* Worth its own message. Somebody reaching for `FormData` gets told the shape
   * is wrong, rather than "unsupported file type" — which would be true of the
   * multipart envelope and utterly misleading about their JPEG. */
  if (type.startsWith('multipart/')) throw new UnsupportedMediaTypeException(MULTIPART_MESSAGE);

  const declared = Number(req.headers['content-length'] ?? '0');
  if (Number.isFinite(declared) && declared > MAX_ATTACHMENT_BYTES) {
    throw new FileTooLargeException();
  }

  const alreadyParsed: unknown = (req as Request & { body?: unknown }).body;
  if (Buffer.isBuffer(alreadyParsed) && alreadyParsed.length > 0) {
    if (alreadyParsed.length > MAX_ATTACHMENT_BYTES) throw new FileTooLargeException();
    return alreadyParsed;
  }

  // Something upstream drained the stream and left nothing behind. Say the file
  // is empty rather than waiting forever for an 'end' that already happened.
  if (req.readableEnded) return Buffer.alloc(0);

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_ATTACHMENT_BYTES) {
        req.destroy();
        reject(new FileTooLargeException());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err) => reject(err));
  });
}

@Controller('attachments')
@UseGuards(JwtAuthGuard)
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  /**
   * Upload. The bytes are the body; the name is `?filename=` or `X-Filename`.
   *
   * 201 with the row. The declared `Content-Type` is read only to reject a
   * multipart envelope — what the file *is* comes from its first bytes.
   */
  @Post()
  async upload(
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
    @Query(zodPipe(uploadQuerySchema)) query: UploadAttachmentQuery,
  ): Promise<UploadedAttachmentView> {
    const bytes = await readBinaryBody(req);
    return this.attachments.upload(user, {
      filename: safeFilename(query.filename ?? req.headers['x-filename']),
      bytes,
    });
  }

  /** The row without the bytes — what a list or a chip needs. */
  @Get(':id/meta')
  meta(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<AttachmentView> {
    return this.attachments.meta(user, id);
  }

  /**
   * The bytes.
   *
   * Streamed rather than buffered, so ten people opening receipts at once costs
   * ten file handles and not fifty megabytes. `@Res({ passthrough: true })`
   * because the headers have to be set by hand while Nest still owns sending
   * the body — so a 404 from another workspace's id is an ordinary JSON error
   * and not a half-written file.
   */
  @Get(':id')
  async download(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const file = await this.attachments.download(user, id);

    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Length', String(file.sizeBytes));
    res.setHeader('Content-Disposition', contentDisposition(file.filename));
    /* The sniffed type is the only thing standing between a stored file and the
     * browser deciding for itself what to run. Helmet already sets this
     * globally; it is repeated here because if it is ever loosened there, this
     * is the response that must not lose it. */
    res.setHeader('X-Content-Type-Options', 'nosniff');
    /* Belt and braces for the PDF case: if this response is ever reached as a
     * top-level document, it may load nothing and run nothing. */
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");

    return new StreamableFile(file.stream);
  }

  /** Soft-delete. The file goes only if no other live row shares its hash. */
  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<{ id: string }> {
    return this.attachments.remove(user, id);
  }
}
