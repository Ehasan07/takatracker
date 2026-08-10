import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

/* The suite truncates every table it can reach, and `src/app.module.ts` loads
 * the repo-root `.env` — whose DATABASE_URL is the developer's own working
 * database. So a bare `pnpm test` used to wipe real data.
 *
 * Default to the disposable test database when the environment has not chosen
 * one, so the safe thing happens by construction rather than only being
 * refused. `test/harness.ts` still asserts the name looks like a test database,
 * which catches an exported DATABASE_URL that overrides this default. */
const DEFAULT_TEST_DATABASE_URL =
  'postgresql://hishab:hishab@localhost:5433/hishab_test?schema=public';
const DATABASE_URL = process.env.DATABASE_URL || DEFAULT_TEST_DATABASE_URL;

/* Written back onto the environment, not only into `test.env` below.
 *
 * `test.env` reaches the *workers*; `globalSetup` runs in vitest's own process,
 * where it never applied — so the one-shot TRUNCATE opened a PrismaClient with
 * no DATABASE_URL and the whole run died on `assertTestDatabase()` before a
 * single test executed. A bare `pnpm test` only ever worked when the shell
 * happened to export one. Both halves read the same value now. */
process.env.DATABASE_URL = DATABASE_URL;

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.e2e-spec.ts', 'src/**/*.spec.ts'],
    // Reaches the worker before any test file imports PrismaClient.
    env: { DATABASE_URL },
    // Suites share one Postgres database; run them one at a time.
    fileParallelism: false,
    // Wiped once, before anything runs — never between suites. See harness.ts.
    globalSetup: ['./test/global-setup.ts'],
    /* One fresh process per spec file.
     *
     * Each file boots a whole Nest application: a Prisma pool, a scheduler, an
     * in-memory throttler store, and an HTTP server supertest talks to. Running
     * thirteen of those one after another inside one reused worker accumulated
     * open handles, and the symptom was an intermittent failure that landed on a
     * different test each run — a 403, a socket hang up, an ECONNRESET. A file
     * per process costs a few seconds and makes a green run mean something. */
    pool: 'forks',
    poolOptions: { forks: { isolate: true, singleFork: false, maxForks: 1, minForks: 1 } },
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
