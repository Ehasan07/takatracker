import { expect, test, type Page } from '@playwright/test';

/**
 * Which way a credit card's figure points.
 *
 * A card is a liability, so the ledger holds it negative when money is owed —
 * correct, and unreadable at a glance. The owner looked at `+৳1,66,867.64` in
 * green on four cards and asked whether that was due or available, which is the
 * question a minus sign does not answer for anybody who is not an accountant.
 * On a card the two readings are opposites, so the word says it.
 */

const PASSWORD = 'hishab1234';

let seq = 0;
const uniqueEmail = (): string => `card-${Date.now()}-${(seq += 1)}@example.test`;
const uniquePhone = (): string =>
  `016${String((Date.now() % 1_000_000) * 100 + (seq % 100))
    .slice(-8)
    .padStart(8, '0')}`;

async function signup(page: Page): Promise<void> {
  await page.goto('/signup');
  await page.getByLabel('নাম').fill('কার্ড পরীক্ষা');
  await page.getByLabel('ইমেইল').fill(uniqueEmail());
  await page.getByLabel('পাসওয়ার্ড').fill(PASSWORD);
  await page.getByLabel('মোবাইল নম্বর').fill(uniquePhone());
  await page.getByRole('button', { name: 'অ্যাকাউন্ট খুলুন' }).click();
  await expect(page.getByRole('heading', { name: 'ড্যাশবোর্ড' }).first()).toBeVisible({
    timeout: 30_000,
  });
}

async function addCard(page: Page, name: string, openingTaka: string): Promise<void> {
  await page.goto('/accounts');
  await page.getByRole('main').getByRole('button', { name: 'নতুন', exact: true }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByLabel('নাম', { exact: true })).toBeVisible();
  await sheet.getByLabel('নাম', { exact: true }).fill(name);
  await sheet.getByLabel('ধরন').selectOption('CREDIT_CARD');
  await sheet.getByLabel('প্রারম্ভিক জের (৳)').fill(openingTaka);
  await sheet.getByRole('button', { name: 'সংরক্ষণ করুন', exact: true }).click();
  await expect(sheet).toBeHidden({ timeout: 15_000 });
}

test.describe('a credit card on the dashboard', () => {
  test('says বকেয়া when it is owed and জমা when it is not', async ({ page }) => {
    await signup(page);
    await addCard(page, 'ভিসা কার্ড', '-18014.20');

    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'ড্যাশবোর্ড' }).first()).toBeVisible();

    const row = page.locator('li').filter({ hasText: 'ভিসা কার্ড' }).first();
    await expect(row.getByText('বকেয়া')).toBeVisible({ timeout: 15_000 });
    /* The magnitude, with no minus beside the word — "বকেয়া −৳18,014.20" reads
       as a double negative. */
    await expect(row.getByText('৳18,014.20')).toBeVisible();
    await expect(row.getByText('-৳18,014.20')).toHaveCount(0);
  });

  test('a card in credit is not silently read as money owed', async ({ page }) => {
    /* The owner's imported cards came out positive — a ৳23 lakh "balance"
       against a ৳4 lakh limit. Whatever the figure is, the screen has to say
       which of the two things it means. */
    await signup(page);
    await addCard(page, 'জমা কার্ড', '5000');

    await page.goto('/');
    const row = page.locator('li').filter({ hasText: 'জমা কার্ড' }).first();
    await expect(row.getByText('জমা', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(row.getByText('বকেয়া')).toHaveCount(0);
  });
});
