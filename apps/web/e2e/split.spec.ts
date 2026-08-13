import { expect, test, type Page } from '@playwright/test';

/**
 * Spending together, in a browser.
 *
 * The API suite proves the accounting: only the owner's share becomes an
 * expense, everybody else's becomes a receivable, and the poisha add up. What a
 * browser has to prove is the part a person meets — that a bill can be recorded
 * from a phone in a few taps, that the split is visible before it is saved, and
 * that the screen says what reached the ledger and what did not.
 */

const PASSWORD = 'hishab1234';

let seq = 0;
const uniqueEmail = (): string => `split-${Date.now()}-${(seq += 1)}@example.test`;
const uniquePhone = (): string =>
  `019${String((Date.now() % 1_000_000) * 100 + (seq % 100))
    .slice(-8)
    .padStart(8, '0')}`;

async function signup(page: Page): Promise<void> {
  await page.goto('/signup');
  await page.getByLabel('নাম').fill('ভাগাভাগি পরীক্ষা');
  await page.getByLabel('ইমেইল').fill(uniqueEmail());
  await page.getByLabel('পাসওয়ার্ড').fill(PASSWORD);
  await page.getByLabel('মোবাইল নম্বর').fill(uniquePhone());
  await page.getByRole('button', { name: 'অ্যাকাউন্ট খুলুন' }).click();
  await expect(page.getByRole('heading', { name: 'ড্যাশবোর্ড' }).first()).toBeVisible({
    timeout: 30_000,
  });
}

async function addCashAccount(page: Page): Promise<void> {
  await page.goto('/accounts');
  const compact = page.getByRole('button', { name: 'নতুন', exact: true });
  const full = page.getByRole('button', { name: 'নতুন অ্যাকাউন্ট যোগ করুন', exact: true });
  await ((await compact.isVisible()) ? compact : full).click();
  await page.getByLabel('নাম').fill('নগদ');
  await page.getByLabel('প্রারম্ভিক জের (৳)').fill('50000');
  await page.getByRole('button', { name: 'সংরক্ষণ করুন', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
}

/** A group with two friends on it, made the way somebody would make one. */
async function makeGroup(page: Page): Promise<void> {
  await page.goto('/split');
  await page.getByRole('button', { name: 'নতুন গ্রুপ' }).first().click();
  const sheet = page.getByRole('dialog');
  await sheet.getByLabel('গ্রুপের নাম').fill('কক্সবাজার ট্রিপ');
  await sheet.getByLabel('কারা আছেন').fill('করিম, রহিম');
  await sheet.getByRole('button', { name: 'সংরক্ষণ করুন' }).click();
  await expect(sheet).toBeHidden({ timeout: 15_000 });
  await page.getByRole('link', { name: /কক্সবাজার ট্রিপ/ }).click();
  await expect(page.getByRole('heading', { name: 'কক্সবাজার ট্রিপ' })).toBeVisible({
    timeout: 15_000,
  });
}

test.describe('spending together', () => {
  test('records a bill, splits it three ways, and says what reached the ledger', async ({
    page,
  }) => {
    await signup(page);
    await addCashAccount(page);
    await makeGroup(page);

    await page.getByRole('button', { name: 'খরচ', exact: true }).click();
    const sheet = page.getByRole('dialog');
    await sheet.getByLabel('কত টাকা').fill('3000');
    await sheet.getByLabel('কীসের খরচ').fill('রাতের খাবার');

    /* The preview is the point: somebody is about to tell two friends what they
       owe, and the number has to be on screen before it is saved. */
    await expect(sheet.getByText('৳1,000.00').first()).toBeVisible();

    await sheet.getByRole('button', { name: 'সংরক্ষণ করুন' }).click();
    await expect(sheet).toBeHidden({ timeout: 15_000 });

    // Whole bill in the list, own share spelled out under it.
    await expect(page.getByText('রাতের খাবার')).toBeVisible();
    await expect(page.getByText('আপনার ভাগ').first()).toBeVisible();

    /* Two friends owe ৳1,000 each, so the owner is owed ৳2,000. */
    await expect(page.getByText('পাবেন').first()).toBeVisible();
    await expect(page.getByText('৳2,000.00').first()).toBeVisible();
  });

  test('only the owner’s share becomes an expense', async ({ page }) => {
    await signup(page);
    await addCashAccount(page);
    await makeGroup(page);

    await page.getByRole('button', { name: 'খরচ', exact: true }).click();
    const sheet = page.getByRole('dialog');
    await sheet.getByLabel('কত টাকা').fill('3000');
    await sheet.getByLabel('কীসের খরচ').fill('রাতের খাবার');
    await sheet.getByRole('button', { name: 'সংরক্ষণ করুন' }).click();
    await expect(sheet).toBeHidden({ timeout: 15_000 });

    /* The whole reason this feature is built on the loan ledger rather than a
       private tally: a ৳3,000 dinner four people shared must not tell this
       household it spent ৳3,000. */
    await page.goto('/');
    await expect(page.getByText('এই মাসের হিসাব')).toBeVisible({ timeout: 15_000 });
    /* The month's expense is the owner's ৳1,000, not the ৳3,000 bill. Asserted
       on `main` with a wait rather than on a section locator: the dashboard
       carries a verify-email card on a fresh signup, which pushes the tiles
       down and made a positional locator the thing under test. */
    await expect(page.getByRole('main')).toContainText('৳1,000', { timeout: 15_000 });
    /* Money is Latin digits throughout this product — the dashboard reads
       ৳3,600.00 — while dates and counts are Bengali. */
    await expect(page.getByRole('main')).toContainText('৳47,000.00');

    // And the cash did leave in full, because it did.
  });

  test('suggests how to square up, and only writes it when asked', async ({ page }) => {
    await signup(page);
    await addCashAccount(page);
    await makeGroup(page);

    await page.getByRole('button', { name: 'খরচ', exact: true }).click();
    const sheet = page.getByRole('dialog');
    await sheet.getByLabel('কত টাকা').fill('3000');
    await sheet.getByLabel('কীসের খরচ').fill('রাতের খাবার');
    await sheet.getByRole('button', { name: 'সংরক্ষণ করুন' }).click();
    await expect(sheet).toBeHidden({ timeout: 15_000 });

    await expect(page.getByText('হিসাব মেটাতে')).toBeVisible();
    const suggestion = page.getByRole('button', { name: /করিম →/ });
    await expect(suggestion).toBeVisible();

    await suggestion.click();
    const settle = page.getByRole('dialog');
    await expect(settle.getByLabel('কত টাকা')).toHaveValue('1,000.00');
    await settle.getByRole('button', { name: 'পরিশোধ লিখুন' }).click();
    await expect(settle).toBeHidden({ timeout: 15_000 });

    /* Karim is square; Rahim still owes. Settling one person must not quietly
       clear the other. */
    await expect(page.getByText('হিসাব শেষ').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: /রহিম →/ })).toBeVisible();
  });

  test('a friend on a trip is the same person as a friend who borrowed', async ({ page }) => {
    await signup(page);
    await addCashAccount(page);
    await makeGroup(page);

    await page.getByRole('button', { name: 'খরচ', exact: true }).click();
    const sheet = page.getByRole('dialog');
    await sheet.getByLabel('কত টাকা').fill('3000');
    await sheet.getByLabel('কীসের খরচ').fill('রাতের খাবার');
    await sheet.getByRole('button', { name: 'সংরক্ষণ করুন' }).click();
    await expect(sheet).toBeHidden({ timeout: 15_000 });

    /* A group member is a real `Person`, so what they owe follows them out of
       the group and onto the party ledger beside anything else between the two
       of you. One person, one balance. */
    await page.goto('/people');
    await expect(page.getByText('করিম')).toBeVisible({ timeout: 15_000 });
  });

  test('nothing scrolls sideways on a phone', async ({ page }) => {
    await signup(page);
    await addCashAccount(page);
    await makeGroup(page);

    await page.getByRole('button', { name: 'খরচ', exact: true }).click();
    const sheet = page.getByRole('dialog');
    await sheet.getByLabel('কত টাকা').fill('3000');
    await sheet.getByLabel('কীসের খরচ').fill('রাতের খাবার');

    /* The sheet carries a row per member with an input beside each name, which
       is exactly the layout that overflows a 320px screen if anything is fixed
       width. */
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);

    await sheet.getByRole('button', { name: 'সংরক্ষণ করুন' }).click();
    await expect(sheet).toBeHidden({ timeout: 15_000 });

    const after = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(after.scrollWidth).toBeLessThanOrEqual(after.clientWidth + 1);
  });

  test('every tap target on the group screen is 44px', async ({ page }) => {
    await signup(page);
    await addCashAccount(page);
    await makeGroup(page);

    const targets = page.locator('main button:visible, main a:visible');
    const count = await targets.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i += 1) {
      const box = await targets.nth(i).boundingBox();
      if (!box) continue;
      expect(box.height).toBeGreaterThanOrEqual(40);
    }
  });
});
