import { inflateRawSync } from 'node:zlib';

/**
 * Just enough of the ZIP format to open a `.xlsx`.
 *
 * ## Why this exists rather than a dependency
 *
 * An `.xlsx` is a ZIP of XML documents and nothing more. Reading one needs the
 * central directory and `inflate`, and Node ships `inflate` — so the whole of
 * the ZIP half of an Excel reader is the eighty lines below. The libraries that
 * would have supplied it (`exceljs`, `jszip`, SheetJS) also supply writing,
 * streaming, encryption, styles and a hundred other things this app will never
 * ask for, at thirty to forty megabytes of dependency tree that then has to be
 * kept patched on somebody's VPS.
 *
 * The trade is stated plainly: this reads the ZIPs that spreadsheet software
 * writes, and refuses anything else out loud. No ZIP64 (a bank statement is not
 * four gigabytes), no encryption, no multi-disk archives, no data descriptors
 * we have to guess the length of. Each of those throws a named error rather
 * than returning something half-read, because a spreadsheet that silently loses
 * its last four hundred rows is far worse than one that will not open.
 *
 * ## Why the central directory and not the local headers
 *
 * A local file header is allowed to carry zeroes for the sizes and put the real
 * ones in a *data descriptor* after the payload, which cannot be found without
 * decompressing first. The central directory at the end of the file always has
 * the true figures. So entries are enumerated from there and the local header is
 * read only for the two lengths needed to find where the bytes start.
 */

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

const SIGNATURE_EOCD = 0x06054b50;
const SIGNATURE_CENTRAL = 0x02014b50;
const SIGNATURE_LOCAL = 0x04034b50;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

/** The ZIP comment field is a `u16` length, so the record starts within 64 KiB + 22 of the end. */
const MAX_EOCD_SEARCH = 0xffff + 22;

/** A single member of the archive, already decompressed. */
export interface ZipEntry {
  /** The path inside the archive, e.g. `xl/worksheets/sheet1.xml`. */
  name: string;
  bytes: Buffer;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const earliest = Math.max(0, buffer.length - MAX_EOCD_SEARCH);
  /* Backwards, because the signature can also occur inside compressed data and
   * the *last* one is the real record. */
  for (let at = buffer.length - 22; at >= earliest; at -= 1) {
    if (buffer.readUInt32LE(at) === SIGNATURE_EOCD) return at;
  }
  throw new ZipError('not a zip archive: no end-of-central-directory record');
}

/**
 * Every member of the archive, decompressed, keyed by its path.
 *
 * Read whole rather than streamed: the caller is holding the entire upload in
 * memory already (it arrived as one request body), and an `.xlsx` that would
 * not fit is one the size cap has refused long before this.
 */
export function readZip(buffer: Buffer): Map<string, Buffer> {
  const eocd = findEndOfCentralDirectory(buffer);

  const entryCount = buffer.readUInt16LE(eocd + 10);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);

  /* The sentinel ZIP64 writes into the 32-bit fields. Nothing this app accepts
   * is anywhere near four gigabytes, so this is a corrupt file or a format we
   * have deliberately not implemented — either way, say so. */
  if (directoryOffset === 0xffffffff || entryCount === 0xffff) {
    throw new ZipError('zip64 archives are not supported');
  }
  if (directoryOffset >= buffer.length) {
    throw new ZipError('zip central directory points past the end of the file');
  }

  const entries = new Map<string, Buffer>();
  let at = directoryOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== SIGNATURE_CENTRAL) {
      throw new ZipError(`zip central directory entry ${index + 1} is malformed`);
    }

    const flags = buffer.readUInt16LE(at + 8);
    const method = buffer.readUInt16LE(at + 10);
    const compressedSize = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const localOffset = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);

    // Bit 0 of the general purpose flags. There is no password to try.
    if ((flags & 0x1) !== 0) throw new ZipError('the file is password protected');

    at += 46 + nameLength + extraLength + commentLength;

    // Directory markers carry no payload and are simply not interesting here.
    if (name.endsWith('/')) continue;

    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== SIGNATURE_LOCAL) {
      throw new ZipError(`zip entry "${name}" has no local header`);
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const end = start + compressedSize;
    if (end > buffer.length)
      throw new ZipError(`zip entry "${name}" runs past the end of the file`);

    const payload = buffer.subarray(start, end);
    if (method === METHOD_STORED) {
      entries.set(name, Buffer.from(payload));
      continue;
    }
    if (method !== METHOD_DEFLATE) {
      throw new ZipError(
        `zip entry "${name}" uses compression method ${method}, which is not deflate`,
      );
    }

    try {
      entries.set(name, inflateRawSync(payload));
    } catch {
      throw new ZipError(`zip entry "${name}" could not be decompressed`);
    }
  }

  return entries;
}
