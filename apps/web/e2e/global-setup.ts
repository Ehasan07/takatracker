import { execFileSync } from 'node:child_process';

/**
 * Start every e2e run from an empty database. Signup is the first step of most
 * specs, so leftover users from previous runs only slow things down and make
 * failures harder to read.
 */
export default function globalSetup(): void {
  const url =
    process.env.E2E_DATABASE_URL ??
    'postgresql://hishab:hishab@localhost:5433/hishab_e2e?schema=public';

  const sql =
    'TRUNCATE TABLE "LedgerEntry", "Transaction", "Category", "Account", "Person", "RefreshToken", "User" RESTART IDENTITY CASCADE;';

  // psql rejects Prisma's ?schema= parameter, so hand it the bare connection URL.
  const psqlUrl = url.split('?')[0]!;

  try {
    execFileSync('psql', [psqlUrl, '-v', 'ON_ERROR_STOP=1', '-q', '-c', sql], { stdio: 'pipe' });
  } catch (err) {
    // psql may not exist on the runner; the suite still works, just not from a
    // clean slate. Say so rather than failing the whole run.
    console.warn(
      `[e2e] could not reset the database (${(err as Error).message.split('\n')[0]}) — continuing`,
    );
  }
}
