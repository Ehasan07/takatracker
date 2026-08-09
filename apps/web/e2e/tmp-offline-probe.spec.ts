import { expect, test, type Page } from '@playwright/test';

/** TEMPORARY probe — delete. Does an offline quick-add close on a page whose
 *  reads the service worker no longer caches? */

async function signup(page: Page): Promise<void> {
  await page.goto('/signup');
  await page.getByLabel('নাম').fill('প্রোব');
  await page
    .getByLabel('ইমেইল')
    .fill(`probe-${Date.now()}-${Math.trunc(performance.now())}@example.test`);
  await page.getByLabel('পাসওয়ার্ড').fill('hishab1234');
  await page.getByRole('button', { name: 'অ্যাকাউন্ট খুলুন' }).click();
  await expect(page.getByRole('heading', { name: 'ড্যাশবোর্ড' })).toBeVisible();
}

test('offline quick add closes on /loans', async ({ page }) => {
  await signup(page);

  await page.goto('/accounts');
  await page.getByRole('button', { name: 'নতুন', exact: true }).click();
  await page.getByLabel('নাম').fill('নগদ');
  await page.getByRole('button', { name: 'সংরক্ষণ করুন' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();

  await page.goto('/loans');
  await page.waitForLoadState('networkidle');

  await page.context().setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));

  await page.getByRole('button', { name: 'নতুন লেনদেন' }).first().click();
  await page.getByLabel('পরিমাণ (৳)').fill('77');
  await page.getByLabel('ক্যাটাগরি').selectOption({ label: 'যাতায়াত' });
  await page.getByRole('button', { name: 'সংরক্ষণ করুন' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByTestId('offline-bar')).toContainText('অপেক্ষমাণ');
});
