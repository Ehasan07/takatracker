import { expect, test, type Page } from '@playwright/test';

/**
 * A tag belongs to the entry it was put on, and to nothing after it.
 *
 * The নতুন লেনদেন sheet has always cleared it — but the inbox review screen
 * carried it forward the way it carries the account and the খাত, and the
 * difference between those matters: the account and the খাত are a bank
 * repeating itself, while a tag says whose money this is. A tag that survives
 * into the next entry marks it with the last one's venture without anybody
 * saying so, and household spending inside a business's profit is not visible
 * until somebody reads a report and disbelieves it.
 *
 * This covers the sheet; `inbox-fx.spec.ts` covers the review screen.
 */

let counter = 0;
function uniqueEmail(): string {
  counter += 1;
  return `tag-scope-${Date.now()}-${counter}-${Math.trunc(performance.now())}@example.test`;
}

let phoneSeq = 0;
function uniquePhone(): string {
  phoneSeq += 1;
  const seed =
    (Date.now() % 1_000_000) * 100 + ((phoneSeq * 17 + Math.trunc(Math.random() * 90)) % 100);
  return `018${String(seed).slice(-8).padStart(8, '0')}`;
}

async function signup(page: Page): Promise<void> {
  await page.goto('/signup');
  await page.getByLabel('নাম').fill('ট্যাগ পরীক্ষা');
  await page.getByLabel('ইমেইল').fill(uniqueEmail());
  await page.getByLabel('পাসওয়ার্ড').fill('hishab1234');
  await page.getByLabel('মোবাইল নম্বর').fill(uniquePhone());
  await page.getByRole('button', { name: 'অ্যাকাউন্ট খুলুন' }).click();
  await expect(page.getByRole('heading', { name: 'ড্যাশবোর্ড' }).first()).toBeVisible({
    timeout: 30_000,
  });
}

async function addCashAccount(page: Page): Promise<void> {
  await page.goto('/accounts');
  await page.getByRole('button', { name: 'নতুন', exact: true }).click();
  await page.getByLabel('নাম').fill('নগদ');
  await page.getByLabel('প্রারম্ভিক জের (৳)').fill('10000');
  await page.getByRole('button', { name: 'সংরক্ষণ করুন' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
}

async function addTag(page: Page, name: string): Promise<void> {
  await page.goto('/tags');
  await page.getByRole('button', { name: 'প্রথম ট্যাগ বানান' }).click();
  const sheet = page.getByRole('dialog');
  await sheet.getByLabel('নাম', { exact: true }).fill(name);
  await sheet.getByRole('button', { name: 'সংরক্ষণ করুন', exact: true }).click();
  await expect(sheet).toBeHidden({ timeout: 15_000 });
}

test.describe('a tag on one entry', () => {
  test('is not still there when the next entry is opened', async ({ page }) => {
    await signup(page);
    await addCashAccount(page);
    await addTag(page, 'দোকান');

    await page.goto('/');
    await page.getByRole('button', { name: 'নতুন লেনদেন' }).first().click();
    const sheet = page.getByRole('dialog');

    await sheet.getByLabel('পরিমাণ (৳)').fill('250');
    await sheet.getByLabel('অ্যাকাউন্ট', { exact: true }).selectOption({ label: 'নগদ' });
    await sheet.getByLabel('ক্যাটাগরি').selectOption({ label: 'খাবার ও বাজার' });
    await sheet.getByRole('button', { name: 'দোকান', exact: true }).first().click();

    // Chosen, and shown as chosen before anything is saved.
    await expect(sheet.getByRole('button', { name: /দোকান ট্যাগটি সরান/ })).toHaveCount(1);

    await sheet.getByRole('button', { name: 'সংরক্ষণ করুন' }).click();
    await expect(sheet).toBeHidden({ timeout: 15_000 });

    // The entry kept it — counted where the tag lives.
    await page.goto('/tags');
    await expect(page.getByText('১টি লেনদেন').first()).toBeVisible({ timeout: 15_000 });

    // The next entry does not.
    await page.goto('/');
    await page.getByRole('button', { name: 'নতুন লেনদেন' }).first().click();
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('button', { name: /দোকান ট্যাগটি সরান/ })).toHaveCount(0);
    await expect(sheet.getByLabel('বেছে নেওয়া ট্যাগ')).toHaveCount(0);
  });
});
