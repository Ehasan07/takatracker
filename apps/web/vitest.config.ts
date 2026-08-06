import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The e2e/ directory belongs to Playwright (`pnpm test:e2e`), not Vitest.
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['e2e/**', 'node_modules/**', '.next/**'],
    environment: 'node',
  },
});
