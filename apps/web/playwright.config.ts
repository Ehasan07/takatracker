import { defineConfig, devices } from '@playwright/test';

/* Ports and database are deliberately not the development ones: the suite
 * truncates what it points at. The defaults below match infra/docker-compose.yml
 * (Postgres on 5433) and .github/workflows/ci.yml sets all four of these
 * explicitly, so CI and a laptop run the same wiring.
 *
 * `hishab_e2e` does not exist until someone creates it — see the Tests section
 * of README.md. e2e/global-setup.ts fails the run with that instruction rather
 * than letting every spec fail at the login screen. */
const WEB_PORT = process.env.E2E_WEB_PORT ?? '3100';
const API_PORT = process.env.E2E_API_PORT ?? '4100';
const BASE_URL = `http://127.0.0.1:${WEB_PORT}`;
const API_URL = `http://127.0.0.1:${API_PORT}`;

const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  'postgresql://hishab:hishab@localhost:5433/hishab_e2e?schema=public';

/**
 * Every milestone is verified at the four widths in spec §5:
 * 320 (small phone), 390 (phone), 768 (tablet), 1280 (desktop).
 */
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 45_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    locale: 'bn-BD',
    timezoneId: 'Asia/Dhaka',
  },

  projects: [
    { name: 'w320', use: { ...devices['Desktop Chrome'], viewport: { width: 320, height: 640 } } },
    { name: 'w390', use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 } } },
    { name: 'w768', use: { ...devices['Desktop Chrome'], viewport: { width: 768, height: 1024 } } },
    {
      name: 'w1280',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
  ],

  webServer: [
    {
      command: 'pnpm --filter @hishab/api run start',
      /* A real readiness probe now: /v1/health answers 503 while the database
       * is unreachable, so Playwright waits instead of starting a run against
       * an API that cannot serve a single request. */
      url: `${API_URL}/v1/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      cwd: '../..',
      env: {
        NODE_ENV: 'test',
        API_PORT,
        DATABASE_URL,
        /* No test may depend on api.pwnedpasswords.com being reachable. The
           local refusal list still applies, which is what the specs exercise. */
        HIBP_DISABLED: '1',
        JWT_ACCESS_SECRET: 'e2e-access-secret',
        JWT_REFRESH_SECRET: 'e2e-refresh-secret',
        CORS_ORIGINS: BASE_URL,
      },
    },
    {
      command: 'pnpm --filter @hishab/web run start',
      url: `${BASE_URL}/login`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      cwd: '../..',
      env: { WEB_PORT, API_INTERNAL_URL: API_URL, NODE_ENV: 'production' },
    },
  ],
});
