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

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.e2e-spec.ts', 'src/**/*.spec.ts'],
    // Reaches the worker before any test file imports PrismaClient.
    env: { DATABASE_URL },
    // Suites share one Postgres database; run them one at a time.
    fileParallelism: false,
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
