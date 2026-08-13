import { expect, test } from '@playwright/test';

/**
 * Point the login-door checks at the deployed site rather than a local build.
 *
 * Run by hand after a release — `PROD=1 pnpm exec playwright test prod-smoke`
 * — and skipped otherwise, so it never runs against localhost and never gates
 * a commit. Its whole job is to answer "is the thing that was just shipped
 * actually on the screen", which no test of a local build can say.
 */
const BASE = 'https://takatracker.com';

test.skip(!process.env.PROD, 'set PROD=1 to smoke the deployed site');
test.use({ baseURL: BASE });

test('the deployed login screen carries the brand and the way back', async ({ page }) => {
  await page.goto(`${BASE}/login`);

  await expect(page.getByRole('heading', { name: 'Taka Tracker' })).toBeVisible();

  const forgot = page.getByRole('link', { name: 'পাসওয়ার্ড ভুলে গেছেন?' });
  await expect(forgot).toBeVisible();
  await forgot.click();
  await expect(page).toHaveURL(/\/forgot/);
  await expect(page.getByLabel('ইমেইল')).toBeVisible();
});

test('the deployed service worker carries this release, so installed apps update', async ({
  request,
}) => {
  const sw = await (await request.get(`${BASE}/sw.js`)).text();
  const health = await (await request.get(`${BASE}/api/v1/health`)).json();

  /* The whole auto-update mechanism rests on these two agreeing: if the worker
     is not stamped with the release that is serving it, its bytes did not
     change, no new worker installs, and every installed home-screen app keeps
     running the release before it. */
  expect(sw).toContain(`const BUILD = '${health.release}'`);
});
