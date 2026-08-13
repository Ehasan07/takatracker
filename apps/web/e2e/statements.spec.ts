import { expect, test, type Page } from '@playwright/test';

/**
 * The four financial statements.
 *
 * The API suite proves the arithmetic — that the cash flow's three sections
 * reconcile with the closing balance, and that opening net worth plus the
 * surplus lands on the closing figure. What a browser proves is that a person
 * can reach the page, choose a window, and print something worth handing to a
 * bank: with the basis of preparation on it, which is what makes a statement
 * checkable rather than merely printed.
 */

const PASSWORD = 'hishab1234';

let seq = 0;
const uniqueEmail = (): string => `stmt-${Date.now()}-${(seq += 1)}@example.test`;
const uniquePhone = (): string =>
  `016${String((Date.now() % 1_000_000) * 100 + (seq % 100))
    .slice(-8)
    .padStart(8, '0')}`;

async function signup(page: Page): Promise<void> {
  await page.goto('/signup');
  await page.getByLabel('নাম').fill('বিবৃতি পরীক্ষা');
  await page.getByLabel('ইমেইল').fill(uniqueEmail());
  await page.getByLabel('পাসওয়ার্ড').fill(PASSWORD);
  await page.getByLabel('মোবাইল নম্বর').fill(uniquePhone());
  await page.getByRole('button', { name: 'অ্যাকাউন্ট খুলুন' }).click();
  await expect(page.getByRole('heading', { name: 'ড্যাশবোর্ড' }).first()).toBeVisible({
    timeout: 30_000,
  });
}

async function seedBooks(page: Page): Promise<void> {
  await page.goto('/accounts');
  const compact = page.getByRole('button', { name: 'নতুন', exact: true });
  const full = page.getByRole('button', { name: 'নতুন অ্যাকাউন্ট যোগ করুন', exact: true });
  await ((await compact.isVisible()) ? compact : full).click();
  await page.getByLabel('নাম').fill('নগদ');
  await page.getByLabel('প্রারম্ভিক জের (৳)').fill('50000');
  await page.getByRole('button', { name: 'সংরক্ষণ করুন', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
}

test.describe('financial statements', () => {
  test('carries all four, and says what basis they are on', async ({ page }) => {
    await signup(page);
    await seedBooks(page);

    await page.goto('/reports');
    await page.getByRole('link', { name: 'আর্থিক বিবৃতি' }).click();

    await expect(page.getByRole('heading', { name: 'আর্থিক বিবৃতি' })).toBeVisible({
      timeout: 15_000,
    });

    await expect(page.getByRole('heading', { name: 'আয়-ব্যয় বিবরণী' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'স্থিতিপত্র' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'নগদ প্রবাহ' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'নিট সম্পদের পরিবর্তন' })).toBeVisible();

    /* The part that makes it a statement rather than a screenshot of numbers.
       A reader cannot check a report whose basis is not stated. */
    await expect(page.getByRole('heading', { name: 'প্রস্তুতির ভিত্তি' })).toBeVisible();
    await expect(page.getByText('নগদ ভিত্তিতে তৈরি', { exact: false })).toBeVisible();
  });

  test('the cash flow shows three sections, not one total', async ({ page }) => {
    await signup(page);
    await seedBooks(page);
    await page.goto('/reports/statements');

    /* IAS 7's requirement, and the reason for it: salary and borrowing are the
       same number and completely different facts. */
    await expect(page.getByText('পরিচালন', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('বিনিয়োগ', { exact: true })).toBeVisible();
    await expect(page.getByText('অর্থায়ন', { exact: true })).toBeVisible();
  });

  test('the balance sheet separates current from non-current', async ({ page }) => {
    await signup(page);
    await seedBooks(page);
    await page.goto('/reports/statements');

    /* `exact` on both: "অচলতি সম্পদ" contains "চলতি সম্পদ", so a substring
       match finds two rows and fails on strict mode — while looking like the
       balance sheet is broken. */
    await expect(page.getByText('চলতি সম্পদ', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('অচলতি সম্পদ', { exact: true })).toBeVisible();
    await expect(page.getByText('চলতি মূলধন', { exact: false })).toBeVisible();
  });

  test('net worth reconciles, and the page says so', async ({ page }) => {
    await signup(page);
    await seedBooks(page);
    await page.goto('/reports/statements');

    /* The check that makes the other three answerable to each other. It is on
       the page rather than in a test only, because the person holding the
       printout is the one who needs to know it holds. */
    await expect(page.getByText('শুরু + উদ্বৃত্ত + অন্যান্য = শেষ ✓')).toBeVisible({
      timeout: 15_000,
    });
  });

  test('revaluing land moves net worth without inventing income', async ({ page }) => {
    await signup(page);
    await seedBooks(page);

    /* Buy land: a transfer out of cash into an asset account, which is an
       investing outflow and not spending. */
    await page.goto('/accounts');
    const compact = page.getByRole('button', { name: 'নতুন', exact: true });
    const full = page.getByRole('button', { name: 'নতুন অ্যাকাউন্ট যোগ করুন', exact: true });
    await ((await compact.isVisible()) ? compact : full).click();
    const sheet = page.getByRole('dialog');
    await sheet.getByLabel('নাম').fill('বসিলার জমি');
    await sheet.getByLabel('ধরন').selectOption('ASSET');
    await sheet.getByLabel('প্রারম্ভিক জের (৳)').fill('1000000');
    await sheet.getByRole('button', { name: 'সংরক্ষণ করুন', exact: true }).click();
    await expect(sheet).toBeHidden();

    /* Cash gets "মেলান"; land gets "মূল্যায়ন". Two different questions, so two
       different buttons rather than one icon meaning both. */
    await page.getByRole('button', { name: /বসিলার জমি — মূল্যায়ন/ }).click();
    const revalue = page.getByRole('dialog');
    await revalue.getByLabel('এখনকার মূল্য (৳)').fill('1200000');
    await revalue.getByLabel('কেন').fill('বাজারদর');
    await revalue.getByRole('button', { name: 'সংরক্ষণ করুন' }).click();
    await expect(revalue).toBeHidden({ timeout: 15_000 });

    await page.goto('/reports/statements');
    await expect(page.getByRole('heading', { name: 'নিট সম্পদের পরিবর্তন' })).toBeVisible({
      timeout: 15_000,
    });

    /* Itemised on the line that explains it — "other movements: ৳2,00,000" is
       not an explanation. */
    await expect(page.getByText('বসিলার জমি — বাজারদর')).toBeVisible();

    /* And the basis stops claiming assets are at cost, which became false the
       moment one of them was revalued. */
    await expect(page.getByText('বর্তমান বাজারমূল্যে দেখানো', { exact: false })).toBeVisible();

    /* Still reconciles, with the revaluation in the "other" line rather than in
       the surplus. */
    await expect(page.getByText('শুরু + উদ্বৃত্ত + অন্যান্য = শেষ ✓')).toBeVisible();
  });

  test('nothing scrolls sideways on a phone', async ({ page }) => {
    await signup(page);
    await seedBooks(page);
    await page.goto('/reports/statements');
    await expect(page.getByRole('heading', { name: 'স্থিতিপত্র' })).toBeVisible({
      timeout: 15_000,
    });

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
  });
});
