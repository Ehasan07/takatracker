import { expect, test, type Page } from '@playwright/test';

/**
 * M3 + M4 acceptance: full manual bookkeeping works on the web, and the shell
 * behaves correctly at 320 / 390 / 768 / 1280.
 */

/**
 * A distinct Bangladeshi mobile per signup. The number is unique across
 * accounts now, so a fixed one makes the second signup in a run fail with a
 * conflict — in whichever test happens to go second.
 */
let phoneSeq = 0;
function uniquePhone(): string {
  phoneSeq += 1;
  return `018${String((Date.now() % 1_000_000) * 100 + (phoneSeq % 100))
    .slice(-8)
    .padStart(8, '0')}`;
}

let counter = 0;
function uniqueEmail(): string {
  counter += 1;
  return `e2e-${Date.now()}-${counter}@example.test`;
}

async function signup(page: Page): Promise<string> {
  const email = uniqueEmail();
  await page.goto('/signup');
  await page.getByLabel('নাম').fill('পরীক্ষা');
  await page.getByLabel('ইমেইল').fill(email);
  await page.getByLabel('পাসওয়ার্ড').fill('hishab1234');
  await page.getByLabel('মোবাইল নম্বর').fill(uniquePhone());
  await page.getByRole('button', { name: 'অ্যাকাউন্ট খুলুন' }).click();
  await expect(page.getByRole('heading', { name: 'ড্যাশবোর্ড' })).toBeVisible();
  return email;
}

/** Save the sheet and wait for it to close — navigating early aborts the POST. */
async function saveSheet(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'সংরক্ষণ করুন' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
}

async function addAccount(page: Page, name: string, opening = ''): Promise<void> {
  await page.goto('/accounts');
  await page.getByRole('button', { name: 'নতুন', exact: true }).click();
  await page.getByLabel('নাম').fill(name);
  if (opening) await page.getByLabel('প্রারম্ভিক জের (৳)').fill(opening);
  await saveSheet(page);
  // Scope to the list: the account-type <select> also contains these words.
  await expect(page.locator('li').filter({ hasText: name }).first()).toBeVisible();
}

test.describe('bookkeeping', () => {
  test('signs up, adds accounts, records income, expense and a transfer', async ({ page }) => {
    await signup(page);

    await addAccount(page, 'নগদ', '1000');
    await addAccount(page, 'ব্যাংক');

    // Income
    await page.goto('/');
    await page.getByRole('button', { name: 'নতুন লেনদেন' }).first().click();
    await page.getByRole('tab', { name: 'আয়' }).click();
    await page.getByLabel('পরিমাণ (৳)').fill('50000');
    await page.getByLabel('অ্যাকাউন্ট', { exact: true }).selectOption({ label: 'ব্যাংক' });
    await page.getByLabel('ক্যাটাগরি').selectOption({ label: 'বেতন' });
    await page.getByLabel('বিবরণ').fill('মাসের বেতন');
    await saveSheet(page);

    await expect(page.getByText('মাসের বেতন')).toBeVisible();

    // Expense
    await page.getByRole('button', { name: 'নতুন লেনদেন' }).first().click();
    await page.getByLabel('পরিমাণ (৳)').fill('250.50');
    await page.getByLabel('অ্যাকাউন্ট', { exact: true }).selectOption({ label: 'নগদ' });
    await page.getByLabel('ক্যাটাগরি').selectOption({ label: 'খাবার ও বাজার' });
    await page.getByLabel('বিবরণ').fill('বাজার');
    await saveSheet(page);
    await expect(page.getByText('বাজার', { exact: true })).toBeVisible();

    // Transfer
    await page.getByRole('button', { name: 'নতুন লেনদেন' }).first().click();
    await page.getByRole('tab', { name: 'ট্রান্সফার' }).click();
    await page.getByLabel('পরিমাণ (৳)').fill('100');
    await page.getByLabel('যে অ্যাকাউন্ট থেকে').selectOption({ label: 'ব্যাংক' });
    await page.getByLabel('যে অ্যাকাউন্টে').selectOption({ label: 'নগদ' });
    await saveSheet(page);

    // Balances: cash 1000 + 100 − 250.50 = 849.50, bank 50000 − 100 = 49900
    await page.goto('/accounts');
    await expect(page.getByText('৳849.50').first()).toBeVisible();
    await expect(page.getByText('৳49,900.00').first()).toBeVisible();

    // The ledger lists all three
    await page.goto('/transactions');
    const ledger = page.getByTestId('ledger-list');
    await expect(ledger.getByText('মাসের বেতন')).toBeVisible();
    await expect(ledger.getByText('বাজার', { exact: true })).toBeVisible();
  });

  test('edits and deletes a transaction, and the balance follows', async ({ page }) => {
    await signup(page);
    await addAccount(page, 'নগদ');

    await page.goto('/');
    await page.getByRole('button', { name: 'নতুন লেনদেন' }).first().click();
    await page.getByLabel('পরিমাণ (৳)').fill('300');
    await page.getByLabel('ক্যাটাগরি').selectOption({ label: 'যাতায়াত' });
    await page.getByLabel('বিবরণ').fill('রিকশা');
    await saveSheet(page);

    await page.goto('/transactions');
    await page.getByRole('button', { name: 'সম্পাদনা' }).first().click();
    await page.getByLabel('পরিমাণ (৳)').fill('450');
    await saveSheet(page);

    await page.goto('/accounts');
    await expect(page.getByText('-৳450.00').first()).toBeVisible();

    await page.goto('/transactions');
    await page.getByRole('button', { name: 'মুছুন' }).first().click();
    await expect(page.getByTestId('ledger-list')).toBeHidden();

    await page.goto('/accounts');
    await expect(page.getByText('৳0.00').first()).toBeVisible();
  });

  test('reconciling books the difference', async ({ page }) => {
    await signup(page);
    await addAccount(page, 'নগদ', '500');

    /* "নগদ — মেলান", not "নগদ মেলান": the verb now comes from the string
       catalogue, so it is joined to the account name rather than written into
       the same template. */
    await page.getByRole('button', { name: 'নগদ — মেলান' }).click();
    await page.getByLabel('আসল ব্যালেন্স (৳)').fill('620.25');
    await page.getByRole('button', { name: 'মেলান' }).click();

    await expect(page.getByText('পার্থক্যটি সমন্বয় হিসেবে যোগ করা হয়েছে।')).toBeVisible();
    await page.reload();
    await expect(page.getByText('৳620.25').first()).toBeVisible();
  });

  test('redirects to login when there is no session', async ({ page }) => {
    await page.context().clearCookies();
    await page.goto('/transactions');
    await expect(page).toHaveURL(/\/login/);
  });
});
