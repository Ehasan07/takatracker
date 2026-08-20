import { expect, test, type Page } from '@playwright/test';

/**
 * A page that is not there.
 *
 * Next's built-in 404 is a black screen reading `This page could not be found.`
 * — no header, no navigation, no Bengali, and no way onwards except the
 * browser's back button. Somebody who lands on it cannot tell whether the app
 * broke or they followed a stale link, and there is nothing on it to press.
 *
 * It was not hypothetical: the সম্পদ screen linked every asset to
 * `/accounts/[id]`, a route nobody ever wrote, so tapping any row served
 * exactly that page. `routes.test.ts` now refuses the whole class off the
 * source; this is the other half — what a 404 does when one is reached anyway,
 * by an old bookmark or a shared link to a page since renamed.
 */

const PASSWORD = 'hishab1234';

let seq = 0;
const uniqueEmail = (): string => `nf-${Date.now()}-${(seq += 1)}@example.test`;
const uniquePhone = (): string =>
  `016${String((Date.now() % 1_000_000) * 100 + (seq % 100))
    .slice(-8)
    .padStart(8, '0')}`;

async function signup(page: Page): Promise<void> {
  await page.goto('/signup');
  await page.getByLabel('নাম').fill('৪০৪ পরীক্ষা');
  await page.getByLabel('ইমেইল').fill(uniqueEmail());
  await page.getByLabel('পাসওয়ার্ড').fill(PASSWORD);
  await page.getByLabel('মোবাইল নম্বর').fill(uniquePhone());
  await page.getByRole('button', { name: 'অ্যাকাউন্ট খুলুন' }).click();
  await expect(page.getByRole('heading', { name: 'ড্যাশবোর্ড' }).first()).toBeVisible({
    timeout: 30_000,
  });
}

test.describe('a page that is not there', () => {
  test('says so in Bengali and offers a way onwards', async ({ page }) => {
    await signup(page);
    await page.goto('/accounts/not-a-real-id');

    await expect(page.getByRole('heading', { name: 'পাতাটি খুঁজে পাওয়া গেল না' })).toBeVisible({
      timeout: 15_000,
    });
    /* The sentence that matters most to somebody who thinks they broke their
       own books. */
    await expect(page.getByText('আপনার হিসাবের কিছু হারায়নি', { exact: false })).toBeVisible();

    await page.getByRole('link', { name: 'হোমে ফিরুন' }).click();
    await expect(page.getByRole('heading', { name: 'ড্যাশবোর্ড' }).first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test('an asset row opens its account rather than a dead end', async ({ page }) => {
    /* The link that shipped broken. Every asset on the সম্পদ screen pointed at
       `/accounts/[id]`, and the account's own screen is its statement. */
    await signup(page);

    await page.goto('/accounts');
    await page.getByRole('main').getByRole('button', { name: 'নতুন', exact: true }).click();
    const sheet = page.getByRole('dialog');
    await expect(sheet.getByLabel('নাম', { exact: true })).toBeVisible();
    await sheet.getByLabel('নাম', { exact: true }).fill('বসিলার জমি');
    await sheet.getByLabel('ধরন').selectOption('ASSET');
    await sheet.getByLabel('কী ধরনের সম্পদ').selectOption('PROPERTY');
    await sheet.getByLabel('প্রারম্ভিক জের (৳)').fill('900000');
    await sheet.getByRole('button', { name: 'সংরক্ষণ করুন', exact: true }).click();
    await expect(sheet).toBeHidden({ timeout: 15_000 });

    await page.goto('/assets');
    await page.getByRole('link').filter({ hasText: 'বসিলার জমি' }).first().click();

    await expect(page.getByText('পাতাটি খুঁজে পাওয়া গেল না')).toHaveCount(0);
    await expect(page.getByText('বসিলার জমি').first()).toBeVisible({ timeout: 15_000 });
  });
});
