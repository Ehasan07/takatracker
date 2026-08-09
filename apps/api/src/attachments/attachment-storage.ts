import { randomUUID } from 'node:crypto';
import { createReadStream, type ReadStream } from 'node:fs';
import { mkdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';

/**
 * The bytes on disk.
 *
 * Local disk, not S3: one box, one filesystem, and a receipt is a few hundred
 * kilobytes. The whole surface is here so the one rule that matters has exactly
 * one place to be enforced.
 *
 * **The path is derived from the SHA-256 and from nothing else.** A filename
 * arrives from a client and is treated as hostile: it is stored on the row for
 * display and it is never, at any point, joined onto a path. `storagePathFor`
 * takes a hash and only a hash, and `absolutePathFor` re-checks the shape of
 * every path it is handed — including ones read back out of the database —
 * before resolving it, then asserts the resolved absolute path is still inside
 * the root. Two independent checks, because this is the failure that turns an
 * attachment feature into arbitrary file read and write.
 *
 * Layout: `ab/cd/abcd…` — two levels of two hex characters, so a workspace with
 * fifty thousand receipts is not one directory with fifty thousand entries in
 * it. Content-addressed, so the same receipt uploaded twice is one file.
 */

/** Where a provisioned box keeps them. `infra/deploy` owns creating it. */
const PRODUCTION_ROOT = '/var/lib/hishab/attachments';

/**
 * A hash we produced ourselves, but validated anyway: this is the value that
 * becomes a path, so it is checked at the boundary rather than trusted because
 * of where it came from.
 */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * The only shape a stored path is ever allowed to have. Anchored, hex only, no
 * dots and no separators beyond the two shards — so `..`, an absolute path, a
 * backslash on a Windows dev box and a NUL byte are all refused by the same
 * expression, before `resolve` is ever called on the value.
 */
const STORAGE_PATH = /^[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}$/;

/**
 * Half-written files live here and are renamed into place, so a reader can
 * never open a file that is still arriving. `.tmp` cannot collide with a shard
 * directory because a shard is two hex characters and this is not.
 */
const TEMP_DIRNAME = '.tmp';

/** Owner only. A directory of other people's bank documents is not world-readable. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * The attachment root, absolute.
 *
 * `ATTACHMENTS_DIR` overrides everywhere. Production otherwise lands on the
 * path the provisioner creates; development gets a directory beside the repo so
 * a fresh clone works with no setup and no risk of writing to a system path.
 */
export function attachmentsRoot(): string {
  const configured = process.env.ATTACHMENTS_DIR?.trim();
  if (configured) return resolve(configured);
  if (process.env.NODE_ENV === 'production') return PRODUCTION_ROOT;
  return resolve(process.cwd(), '.data/attachments');
}

/** The path these bytes belong at, from their hash alone. */
export function storagePathFor(sha256: string): string {
  if (!SHA256_HEX.test(sha256)) {
    // Unreachable from a request — createHash gives us this. A programming
    // error here would be a path built from something else, so it throws.
    throw new Error('storagePathFor requires a lowercase hex SHA-256');
  }
  return `${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
}

/** Thrown only when a stored path fails one of the two containment checks. */
export class UnsafeStoragePathError extends Error {
  constructor(storagePath: string) {
    super(`Refusing to touch a path that is not inside the attachment root: ${storagePath}`);
    this.name = 'UnsafeStoragePathError';
  }
}

export interface StoredFile {
  storagePath: string;
  /** False when the identical bytes were already on disk under this hash. */
  written: boolean;
}

@Injectable()
export class AttachmentStorage {
  private readonly logger = new Logger(AttachmentStorage.name);

  private readonly root = attachmentsRoot();

  /** Memoised so the mkdir happens once per process, not once per upload. */
  private rootReady: Promise<void> | null = null;

  get rootPath(): string {
    return this.root;
  }

  /**
   * The absolute path for a stored path, proven to be inside the root.
   *
   * Two checks that do not depend on each other. First the shape: only hex and
   * two slashes get through, which already excludes every traversal there is.
   * Then containment: `resolve` collapses any `..` and, given an absolute
   * argument, throws the root away entirely — so the answer is compared against
   * the root with a trailing separator before anything opens it. The prefix
   * must include the separator, or a sibling directory named
   * `attachments-evil` would pass a bare `startsWith`.
   */
  absolutePathFor(storagePath: string): string {
    if (!STORAGE_PATH.test(storagePath) || isAbsolute(storagePath)) {
      throw new UnsafeStoragePathError(storagePath);
    }

    const absolute = resolve(this.root, storagePath);
    const prefix = this.root.endsWith(sep) ? this.root : `${this.root}${sep}`;
    if (!absolute.startsWith(prefix)) throw new UnsafeStoragePathError(storagePath);

    return absolute;
  }

  /**
   * Create the root and its temp directory, once, on first write.
   *
   * Lazily rather than at boot: a deployment that never receives an upload
   * should not have a directory appear, and a read-only or misprovisioned path
   * should fail the upload that needs it with a visible error rather than
   * taking the whole API down at start-up.
   *
   * `mkdir`'s mode is masked by the process umask, but 0700 survives the usual
   * 022, so no chmod follows — deliberately, because an operator who has
   * widened the directory for a backup agent should not have it silently
   * narrowed again on every restart.
   */
  private async ensureRoot(): Promise<void> {
    this.rootReady ??= (async () => {
      try {
        await mkdir(join(this.root, TEMP_DIRNAME), { recursive: true, mode: DIR_MODE });
      } catch (err) {
        // Cleared so the next upload retries; a transient mount problem should
        // not poison the process for good.
        this.rootReady = null;
        this.logger.error(
          `Cannot create the attachment directory at ${this.root} — set ATTACHMENTS_DIR or fix ` +
            `its permissions: ${(err as Error).message}`,
        );
        throw err;
      }
    })();

    return this.rootReady;
  }

  /**
   * Put these bytes at their hash's path, if they are not already there.
   *
   * Written to a temp file and renamed, which is atomic within a filesystem, so
   * a concurrent download either sees the finished file or no file — never a
   * truncated one. Two uploads of the same receipt at the same instant rename
   * identical content onto the same target, so the race has no losing side.
   */
  async write(sha256: string, bytes: Buffer): Promise<StoredFile> {
    const storagePath = storagePathFor(sha256);
    const absolute = this.absolutePathFor(storagePath);

    await this.ensureRoot();

    const existing = await this.statOrNull(absolute);
    if (existing?.size === bytes.length) return { storagePath, written: false };

    await mkdir(dirname(absolute), { recursive: true, mode: DIR_MODE });

    const temp = join(this.root, TEMP_DIRNAME, randomUUID());
    try {
      await writeFile(temp, bytes, { mode: FILE_MODE });
      await rename(temp, absolute);
    } catch (err) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw err;
    }

    return { storagePath, written: true };
  }

  /** Size on disk, or null when the file is gone. */
  async size(storagePath: string): Promise<number | null> {
    const stats = await this.statOrNull(this.absolutePathFor(storagePath));
    return stats ? stats.size : null;
  }

  openReadStream(storagePath: string): ReadStream {
    return createReadStream(this.absolutePathFor(storagePath));
  }

  /**
   * Remove the file. Returns false when it was already gone, which is not an
   * error — a delete that runs twice should settle, not fail.
   */
  async remove(storagePath: string): Promise<boolean> {
    const absolute = this.absolutePathFor(storagePath);
    try {
      await unlink(absolute);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  }

  private async statOrNull(absolute: string): Promise<{ size: number } | null> {
    try {
      const stats = await stat(absolute);
      return stats.isFile() ? { size: stats.size } : null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }
}
