import { expect, test, type Page } from '@playwright/test';

/**
 * স্থাবর ও দীর্ঘমেয়াদি সম্পদ — the land, the car, the gold, the shares.
 *
 * These lived among the wallets on `/accounts`, between a bKash balance and a
 * credit card, and the dashboard collapsed the lot into one line. What only a
 * browser can prove is that a flat and a motorcycle now land under different
 * headings, and that a rise in value is shown without ever being called income.
 */

let phoneSeq = 0;
function uniquePhone(): string {
  phoneSeq += 1;
  return `016${String((Date.now() % 1_000_000) * 100 + (phoneSeq % 100))
    .slice(-8)
    .padStart(8, '0')}`;
}

let counter = 0;
function uniqueEmail(): string {
  counter += 1;
  return `assets-${Date.now()}-${counter}-${Math.trunc(performance.now())}@example.test`;
}

async function signup(page: Page): Promise<void> {
  await page.goto('/signup');
  await page.getByLabel('নাম').fill('সম্পদ পরীক্ষা');
  await page.getByLabel('ইমেইল').fill(uniqueEmail());
  await page.getByLabel('পাসওয়ার্ড').fill('hishab1234');
  await page.getByLabel('মোবাইল নম্বর').fill(uniquePhone());
  await page.getByRole('button', { name: 'অ্যাকাউন্ট খুলুন' }).click();
  await expect(page.getByRole('heading', { name: 'ড্যাশবোর্ড' }).first()).toBeVisible({
    timeout: 30_000,
  });
}

/** An asset, with its kind and what it cost — both asked at creation. */
async function addAsset(
  page: Page,
  name: string,
  kind: string,
  value: string,
  cost?: string,
): Promise<void> {
  await page.goto('/accounts');
  await page.getByRole('main').getByRole('button', { name: 'নতুন', exact: true }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByLabel('নাম', { exact: true })).toBeVisible();
  await sheet.getByLabel('নাম', { exact: true }).fill(name);
  await sheet.getByLabel('ধরন').selectOption('ASSET');
  await sheet.getByLabel('কী ধরনের সম্পদ').selectOption(kind);
  await sheet.getByLabel('প্রারম্ভিক জের (৳)').fill(value);
  if (cost) await sheet.getByLabel('কেনা দাম (৳)').fill(cost);
  await sheet.getByRole('button', { name: 'সংরক্ষণ করুন', exact: true }).click();
  await expect(sheet).toBeHidden({ timeout: 15_000 });
}

test.describe('property and long-term assets', () => {
  test('a flat and a motorcycle land under different headings', async ({ page }) => {
    await signup(page);
    await addAsset(page, 'বসিলার জমি', 'PROPERTY', '900000');
    await addAsset(page, 'পালসার', 'VEHICLE', '150000');

    await page.goto('/assets');
    const main = page.getByRole('main');
    /* The whole point of IAS 1.54: two things that are both assets, and are not
       the same kind of fact, on their own lines. */
    await expect(main.getByText('স্থাবর সম্পত্তি', { exact: true })).toBeVisible();
    await expect(main.getByText('যানবাহন', { exact: true })).toBeVisible();
    await expect(main.getByText('বসিলার জমি')).toBeVisible();
    await expect(main.getByText('পালসার')).toBeVisible();

    // A household with no gold should not read a line saying it owns no gold.
    await expect(main.getByText('স্বর্ণ ও গয়না', { exact: true })).toHaveCount(0);
  });

  test('shows what it cost beside what it is worth, and does not call the gain income', async ({
    page,
  }) => {
    await signup(page);
    // Bought for ৳8,00,000, worth ৳9,00,000 today.
    await addAsset(page, 'বসিলার জমি', 'PROPERTY', '900000', '800000');

    await page.goto('/assets');
    const main = page.getByRole('main');
    await expect(main.getByText('কেনা দাম', { exact: true })).toBeVisible();
    await expect(main.getByText('মূল্য বেড়েছে')).toBeVisible();

    /* Said plainly, because a large green figure beside somebody's land reads
       as money earned. It is a revaluation surplus, it sits in equity
       (IAS 16.39), and it is neither spendable nor taxable income. */
    await expect(main.getByText('দাম বাড়া আয় নয়', { exact: false })).toBeVisible();
  });

  test('an asset with no cost recorded is counted but left out of the comparison', async ({
    page,
  }) => {
    await signup(page);
    await addAsset(page, 'বসিলার জমি', 'PROPERTY', '900000', '800000');
    await addAsset(page, 'পুরনো গয়না', 'GOLD', '200000');

    await page.goto('/assets');
    const main = page.getByRole('main');
    /* Treating a missing cost as zero would report the whole value as a gain,
       which is the most flattering possible lie. It is excluded and said so. */
    await expect(main.getByText('কেনা দাম লেখা নেই', { exact: true })).toBeVisible();
    await expect(main.getByText('তুলনায় সেগুলো ধরা হয়নি', { exact: false })).toBeVisible();

    // Still in the total of what is owned, though — ৳11,00,000 across both.
    await expect(main.getByText(/11,00,000|11,?00,?000|1,100,000/)).toBeVisible();
  });

  test('selling books the gain as income and moves the asset to সোল্ড', async ({ page }) => {
    await signup(page);
    // Bought and carried at ৳8,00,000.
    await addAsset(page, 'বসিলার জমি', 'PROPERTY', '800000', '800000');
    await page.goto('/accounts');
    await page.getByRole('main').getByRole('button', { name: 'নতুন', exact: true }).click();
    let sheet = page.getByRole('dialog');
    await expect(sheet.getByLabel('নাম', { exact: true })).toBeVisible();
    await sheet.getByLabel('নাম', { exact: true }).fill('সিটি ব্যাংক');
    await sheet.getByLabel('ধরন').selectOption('BANK');
    await sheet.getByRole('button', { name: 'সংরক্ষণ করুন', exact: true }).click();
    await expect(sheet).toBeHidden({ timeout: 15_000 });

    await page.getByRole('button', { name: /বসিলার জমি — বিক্রি/ }).click();
    sheet = page.getByRole('dialog');
    await sheet.getByLabel('কত টাকায় বিক্রি করলেন (৳)').fill('1100000');

    /* The arithmetic shown rather than left for somebody to do — and it is the
       gain over the *carrying amount*, which is the number people get wrong. */
    await expect(sheet.getByText('বিক্রির লাভ', { exact: true })).toBeVisible();
    await sheet.getByLabel('টাকাটা কোথায় ঢুকল').selectOption({ label: 'সিটি ব্যাংক' });
    await sheet.getByLabel('লাভ কোন খাতে').selectOption({ index: 1 });
    await sheet.getByRole('button', { name: 'সংরক্ষণ করুন', exact: true }).click();
    await expect(sheet).toBeHidden({ timeout: 15_000 });

    // Out of what is owned, into its own section, and never deleted.
    await page.goto('/assets');
    const main = page.getByRole('main');
    await expect(main.getByText('বিক্রি করা সম্পদ')).toBeVisible();
    await expect(main.getByText('বসিলার জমি')).toBeVisible();
    await expect(main.getByText('স্থাবর সম্পত্তি', { exact: true })).toHaveCount(0);
  });

  test('says so plainly when there is nothing to show', async ({ page }) => {
    await signup(page);
    await page.goto('/assets');
    await expect(page.getByText('এখনও কোনো জমি, গাড়ি বা স্বর্ণ যোগ করা হয়নি।')).toBeVisible();
  });

  test('nothing scrolls sideways on a phone', async ({ page }) => {
    await signup(page);
    await addAsset(page, 'বসিলার জমি অনেক লম্বা একটা নাম দিয়ে', 'PROPERTY', '900000', '800000');

    await page.goto('/assets');
    await expect(page.getByRole('main')).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
