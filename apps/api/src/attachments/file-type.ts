/**
 * What a file actually is, decided from its first bytes.
 *
 * The declared `Content-Type` is a claim made by whoever is uploading, and this
 * endpoint serves people's bank documents back to a browser. A client that says
 * `image/png` and sends HTML would, if we echoed the claim back on download,
 * get a stored cross-site scripting hole on the API origin — where the access
 * token lives as an httpOnly cookie (auth/jwt.strategy.ts). So the declared
 * type is never stored and never served: the bytes are sniffed on the way in,
 * the sniffed type is what goes in the row, and that is what comes back out.
 *
 * The allowlist is deliberately short. It is not "formats we can store" — we
 * can store anything — it is "formats a browser can render inertly". A receipt
 * is a photo or a PDF; nothing else needs to be here, and every addition is a
 * new way for a file to execute rather than display.
 */

/** The only types we accept, and therefore the only types we ever serve. */
export const ATTACHMENT_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'application/pdf',
] as const;

export type AttachmentMimeType = (typeof ATTACHMENT_MIME_TYPES)[number];

/** Enough for the longest signature we check (WebP and HEIC both need 12). */
const MIN_SNIFF_BYTES = 12;

const JPEG = [0xff, 0xd8, 0xff];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

/**
 * ISO base media brands that mean "a still image in HEIF form", which is what
 * every phone camera writes. `avif`/`avis` are deliberately absent: an AVIF is
 * not a HEIC, and calling it one would have us serve a type the file is not.
 */
const HEIF_IMAGE_BRANDS = new Set([
  'heic',
  'heix',
  'heim',
  'heis',
  'hevc',
  'hevx',
  'hevm',
  'hevs',
  'mif1',
  'msf1',
]);

function hasBytesAt(buffer: Buffer, offset: number, signature: number[]): boolean {
  if (buffer.length < offset + signature.length) return false;
  return signature.every((byte, index) => buffer[offset + index] === byte);
}

/** Four bytes read as ASCII — the form every ISO-BMFF box tag is written in. */
function tagAt(buffer: Buffer, offset: number): string {
  if (buffer.length < offset + 4) return '';
  return buffer.subarray(offset, offset + 4).toString('latin1');
}

/**
 * The type these bytes really are, or `null` if it is not one we serve.
 *
 * Signatures are matched at their exact offset rather than searched for. PDF in
 * particular allows its header a little way into the file, and readers that
 * scan for `%PDF-` anywhere are exactly how a polyglot — a valid PNG that is
 * also a valid PDF that is also valid HTML — gets classified as the harmless
 * one of the three. A file whose first bytes are not the signature is refused,
 * and the user re-exports it.
 */
export function sniffMimeType(bytes: Buffer): AttachmentMimeType | null {
  if (bytes.length < MIN_SNIFF_BYTES) return null;

  if (hasBytesAt(bytes, 0, JPEG)) return 'image/jpeg';
  if (hasBytesAt(bytes, 0, PNG)) return 'image/png';
  if (hasBytesAt(bytes, 0, PDF)) return 'application/pdf';

  // RIFF container, WEBP payload. The four bytes between are the chunk size.
  if (tagAt(bytes, 0) === 'RIFF' && tagAt(bytes, 8) === 'WEBP') return 'image/webp';

  // ISO base media file: a `ftyp` box first, its major brand right after.
  if (tagAt(bytes, 4) === 'ftyp' && HEIF_IMAGE_BRANDS.has(tagAt(bytes, 8))) return 'image/heic';

  return null;
}

const EXTENSIONS: Record<AttachmentMimeType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'application/pdf': 'pdf',
};

/**
 * A name for a file that arrived without one. Used only for display and for the
 * download header — never for the path on disk, which comes from the hash.
 */
export function defaultFilenameFor(mimeType: AttachmentMimeType): string {
  return `attachment.${EXTENSIONS[mimeType]}`;
}
