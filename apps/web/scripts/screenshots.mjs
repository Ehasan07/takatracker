/**
 * Renders the PWA install-prompt screenshots from the real running app.
 *
 * Chrome only shows its richer install dialogue — the one with a preview and
 * the description, rather than a one-line bar — when the manifest declares
 * screenshots. Drawing them would guarantee they eventually lie about what the
 * app looks like, so this signs up a throwaway account against a running stack,
 * puts a plausible month of money into it, and photographs the result.
 *
 *   pnpm --filter @hishab/api run start &   # or any running stack
 *   pnpm --filter @hishab/web run start &
 *   node scripts/screenshots.mjs http://127.0.0.1:3100
 *
 * The sizes here must stay in step with `sizes:` in src/app/manifest.ts, and
 * Chrome rejects a form factor whose images disagree on aspect ratio.
 */
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../public/screenshots');
const baseURL = process.argv[2] ?? process.env.SCREENSHOT_BASE_URL ?? 'http://127.0.0.1:3100';

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

/** Enough to look like a household's month without looking like a demo. */
const ACCOUNTS = [
  ['ব্যাংক', '185000'],
  ['বিকাশ', '7400'],
  ['নগদ টাকা', '3200'],
];

const EXPENSES = [
  ['খাবার ও বাজার', '9850', 'সপ্তাহের বাজার'],
  ['বাসা ভাড়া', '18000', 'জুলাইয়ের ভাড়া'],
  ['ইউটিলিটি', '3120', 'বিদ্যুৎ বিল'],
  ['যাতায়াত', '2400', 'সিএনজি ও বাস'],
  ['মোবাইল/ইন্টারনেট', '1100', 'ইন্টারনেট বিল'],
];

async function saveSheet(page) {
  await page.getByRole('button', { name: 'সংরক্ষণ করুন' }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
}

async function main() {
  await mkdir(outDir, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: PHONE,
    deviceScaleFactor: 1,
    locale: 'bn-BD',
    timezoneId: 'Asia/Dhaka',
    baseURL,
  });
  const page = await context.newPage();

  await page.goto('/signup');
  await page.getByLabel('নাম').fill('রুবিনা আক্তার');
  await page.getByLabel('ইমেইল').fill(`shot-${Date.now()}@example.test`);
  await page.getByLabel('পাসওয়ার্ড').fill('hishab1234');
  await page.getByRole('button', { name: 'অ্যাকাউন্ট খুলুন' }).click();
  await page.waitForURL('**/');

  for (const [name, opening] of ACCOUNTS) {
    await page.goto('/accounts');
    await page.getByRole('button', { name: 'নতুন', exact: true }).click();
    await page.getByLabel('নাম').fill(name);
    await page.getByLabel('প্রারম্ভিক জের (৳)').fill(opening);
    await saveSheet(page);
  }

  await page.goto('/');
  await page.getByRole('button', { name: 'নতুন লেনদেন' }).first().click();
  await page.getByRole('tab', { name: 'আয়' }).click();
  await page.getByLabel('পরিমাণ (৳)').fill('62000');
  await page.getByLabel('অ্যাকাউন্ট').selectOption({ label: 'ব্যাংক' });
  await page.getByLabel('ক্যাটাগরি').selectOption({ label: 'বেতন' });
  await page.getByLabel('বিবরণ').fill('মাসের বেতন');
  await saveSheet(page);

  for (const [category, amount, note] of EXPENSES) {
    await page.getByRole('button', { name: 'নতুন লেনদেন' }).first().click();
    await page.getByLabel('পরিমাণ (৳)').fill(amount);
    await page.getByLabel('অ্যাকাউন্ট').selectOption({ label: 'ব্যাংক' });
    await page.getByLabel('ক্যাটাগরি').selectOption({ label: category });
    await page.getByLabel('বিবরণ').fill(note);
    await saveSheet(page);
  }

  const shots = [
    ['/', PHONE, 'phone-dashboard.png'],
    ['/more', PHONE, 'phone-more.png'],
    ['/', DESKTOP, 'desktop-dashboard.png'],
  ];

  for (const [path, viewport, file] of shots) {
    await page.setViewportSize(viewport);
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    // Let the 190ms enter animation finish, or the screenshot catches a
    // half-faded screen.
    await page.waitForTimeout(400);
    await page.screenshot({ path: resolve(outDir, file) });
    process.stdout.write(`wrote ${file}\n`);
  }

  await browser.close();
}

main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
