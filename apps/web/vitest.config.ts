import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  /**
   * The same `@/` the app uses, so a unit test can import a module that imports
   * another one.
   *
   * Without it Vitest resolves `@/lib/format` as a bare package name and fails
   * with "Failed to load url" — pointing at the *importer*, not at the missing
   * alias, which is why it reads as a broken file rather than a missing config.
   * Twice before, a pure function was pulled into its own alias-free module to
   * dodge this; that is a fine shape for `fx-convert.ts` and `quantity.ts` on
   * their own merits, but it is not a resolution strategy — the third time it
   * came up the answer was four lines here.
   *
   * `tsconfig.json` maps `@/*` to `./src/*`; this must stay in step with it.
   */
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    // The e2e/ directory belongs to Playwright (`pnpm test:e2e`), not Vitest.
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['e2e/**', 'node_modules/**', '.next/**'],
    environment: 'node',
  },
});
