import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_E2E_DATABASE_URL =
  'postgresql://hishab:hishab@localhost:5433/hishab_e2e?schema=public';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'api', 'prisma', 'migrations');

/**
 * Refuse to run against a schema older than the code.
 *
 * A missing *database* already fails loudly above. A database that is merely
 * **out of date** does not: the tables are all there, the truncate succeeds, and
 * the run proceeds — until the first signup hits a column the schema has not got
 * and forty-odd specs fail with "could not create an account". Every one of them
 * points at the application, and none of them names the one-line cause.
 *
 * The check is a name comparison against `_prisma_migrations`, not
 * `prisma migrate status` — a string set difference costs one query on a
 * connection already being opened, where spawning the Prisma CLI costs seconds
 * on every run of the suite.
 */
function assertMigrated(psqlUrl: string, url: string, name: string): void {
  const onDisk = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  let applied: string[];
  try {
    const out = execFileSync(
      'psql',
      [
        psqlUrl,
        '-v',
        'ON_ERROR_STOP=1',
        '-t',
        '-A',
        '-c',
        'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL',
      ],
      { stdio: 'pipe' },
    ).toString();
    applied = out
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    /* No `_prisma_migrations` table at all: the database was created but never
       migrated. Reported by the same message as a partial one. */
    applied = [];
  }

  const pending = onDisk.filter((migration) => !applied.includes(migration));
  if (pending.length === 0) return;

  throw new Error(
    `[e2e] the "${name}" database is ${pending.length} migration(s) behind the code:\n` +
      pending.map((m) => `  - ${m}`).join('\n') +
      `\nEvery spec would fail on a missing column and blame the application. Run:\n` +
      `  DATABASE_URL="${url}" pnpm --filter @hishab/api exec prisma migrate deploy`,
  );
}

/** Same rule as apps/api/test/harness.ts: only ever truncate a throwaway. */
function assertE2eDatabase(url: string): string {
  let name: string;
  try {
    name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  } catch {
    throw new Error(`[e2e] E2E_DATABASE_URL is not a valid connection string: ${url}`);
  }

  if (name !== 'hishab_e2e' && name !== 'hishab_test' && !name.endsWith('_test')) {
    throw new Error(
      `[e2e] refusing to truncate database "${name}" — this step wipes every table.\n` +
        `E2E_DATABASE_URL must name a throwaway database: "hishab_e2e", "hishab_test", or ` +
        `anything ending in "_test".`,
    );
  }

  return name;
}

/**
 * Start every e2e run from an empty database. Signup is the first step of most
 * specs, so leftover users from previous runs only slow things down and make
 * failures harder to read.
 *
 * This throws rather than warning. It used to swallow any psql failure and
 * continue, which meant a missing or unreachable database produced eighty-odd
 * individual browser failures with a login error instead of one line saying the
 * database was not there. A setup step that cannot reach its database has not
 * set anything up.
 */
export default function globalSetup(): void {
  const url = process.env.E2E_DATABASE_URL ?? DEFAULT_E2E_DATABASE_URL;
  const name = assertE2eDatabase(url);

  const sql =
    'TRUNCATE TABLE "LedgerEntry", "Transaction", "Category", "Account", "Person", "RefreshToken", "User" RESTART IDENTITY CASCADE;';

  // psql rejects Prisma's ?schema= parameter, so hand it the bare connection URL.
  const psqlUrl = url.split('?')[0]!;

  try {
    execFileSync('psql', [psqlUrl, '-v', 'ON_ERROR_STOP=1', '-q', '-c', sql], { stdio: 'pipe' });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer };
    const detail = e.stderr?.toString().trim() || e.message.split('\n')[0] || String(err);

    if (e.code === 'ENOENT') {
      throw new Error(
        `[e2e] psql is not on PATH, so the "${name}" database cannot be reset before the run.\n` +
          `Install the Postgres client (macOS: brew install libpq, or use the postgresql ` +
          `formula) and try again.`,
      );
    }

    throw new Error(
      `[e2e] could not reset the database "${name}" at ${psqlUrl}.\n` +
        `${detail}\n` +
        `Is Postgres up (pnpm db:up), and has "${name}" been created and migrated? ` +
        `One command does both:\n` +
        `  DATABASE_URL="${url}" pnpm --filter @hishab/api exec prisma migrate deploy`,
    );
  }

  /* After the truncate, not before: an unreachable database should report that
     rather than "0 migrations applied", which would send somebody to the wrong
     command. */
  assertMigrated(psqlUrl, url, name);
}
