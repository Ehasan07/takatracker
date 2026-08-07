import { expect, test, type Page } from '@playwright/test';

/**
 * M24 acceptance from the user's side: the ceiling is visible before it is hit,
 * and hitting it produces a sentence rather than a generic failure.
 */
async function signup(page: Page): Promise<void> {
  await page.goto('/signup');
  await page.getByLabel('নাম').fill('প্ল্যান');
  await page
    .getByLabel('ইমেইল')
    .fill(`plan-${Date.now()}-${Math.trunc(performance.now())}@example.test`);
  await page.getByLabel('পাসওয়ার্ড').fill('hishab1234');
  await page.getByRole('button', { name: 'অ্যাকাউন্ট খুলুন' }).click();
  await expect(page.getByRole('heading', { name: 'ড্যাশবোর্ড' }).first()).toBeVisible();
}

async function addAccount(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'নতুন', exact: true }).click();
  await page.getByLabel('নাম').fill(name);
  await page.getByRole('button', { name: 'সংরক্ষণ করুন' }).click();
}

test.describe('plan limits', () => {
  test('shows the account quota and refuses the sixth with a real message', async ({ page }) => {
    await signup(page);
    await page.goto('/accounts');

    // The free plan allows five; the meter says so before anything is created.
    await expect(page.getByText('০/৫')).toBeVisible();

    for (const name of ['ক', 'খ', 'গ', 'ঘ', 'ঙ']) {
      await addAccount(page, name);
      await expect(page.getByRole('dialog')).toBeHidden();
    }

    await expect(page.getByText('৫/৫')).toBeVisible();
    await expect(page.getByText('প্ল্যানের সীমা শেষ।')).toBeVisible();

    // The button is disabled rather than letting the user walk into a refusal.
    await expect(page.getByRole('button', { name: 'নতুন', exact: true })).toBeDisabled();
  });

  test('settings reports the plan and its usage', async ({ page }) => {
    await signup(page);
    await page.goto('/settings');
    await expect(page.getByText('ফ্রি')).toBeVisible();
    await expect(page.getByText('এই মাসের লেনদেন')).toBeVisible();
  });
});
