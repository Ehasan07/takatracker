import { expect, test, type Page } from '@playwright/test';

/**
 * The way in from another product.
 *
 * The staging, the spreadsheet and the rollback are covered against a stubbed
 * Wallet in apps/api/test/migration.e2e-spec.ts, and nothing here reaches a
 * third-party API — a browser test that depends on somebody else's server being
 * up is a test that fails for reasons nobody can fix.
 *
 * What is left is what only a browser can check, and it is the part a person
 * meets first: that the screen is reachable without being told a URL, that the
 * three promises the feature rests on are written on it rather than implied,
 * and that the button cannot be pressed with nothing in the box — a request
 * that returns "token too short" after a spinner is a worse answer than a
 * button that plainly is not ready.
 */

const PASSWORD = 'hishab1234';

let counter = 0;
function uniqueEmail(): string {
  counter += 1;
  return `migration-${Date.now()}-${counter}-${Math.trunc(performance.now())}@example.test`;
}

let phoneSeq = 0;
function uniquePhone(): string {
  phoneSeq += 1;
  return `018${String((Date.now() % 1_000_000) * 100 + (phoneSeq % 100))
    .slice(-8)
    .padStart(8, '0')}`;
}

async function signup(page: Page): Promise<void> {
  await page.goto('/signup');
  await page.getByLabel('নাম').fill('মাইগ্রেশন পরীক্ষা');
  await page.getByLabel('ইমেইল').fill(uniqueEmail());
  await page.getByLabel('পাসওয়ার্ড').fill(PASSWORD);
  await page.getByLabel('মোবাইল নম্বর').fill(uniquePhone());
  await page.getByRole('button', { name: 'অ্যাকাউন্ট খুলুন' }).click();
  await expect(page.getByRole('heading', { name: 'ড্যাশবোর্ড' }).first()).toBeVisible({
    timeout: 30_000,
  });
}

test.describe('bringing another product across', () => {
  test('is reachable from আরও and says what it will and will not do', async ({ page }) => {
    await signup(page);

    /* The route a person walks. A screen only reachable by typing the URL is a
       file in the repository, not a feature.

       A regex, and the hub row rather than the sidebar one: above 768px both
       exist, and the hub row's accessible name carries its blurb as well as its
       label, so an exact match resolves to the sidebar alone. */
    await page.goto('/more');
    await page
      .getByRole('link', { name: /^আগের সফটওয়্যার থেকে/ })
      .last()
      .click();

    await expect(
      page.getByRole('heading', { name: 'আগের সফটওয়্যার থেকে আনুন', level: 1 }),
    ).toBeVisible();

    /* Draft until approved, and reversible after — the two things the owner
       asked for in as many words. Both are on the screen, not in a policy. */
    await expect(page.getByText(/অনুমোদন না দিলে খাতায় কিছুই তৈরি হবে না/)).toBeVisible();
    await expect(page.getByText(/ফিরিয়ে নেওয়া যাবে/).first()).toBeVisible();

    /* And the cost of the thing being asked for, beside the box asking for it. */
    await expect(page.getByText(/কোথাও জমা রাখা হয় না/)).toBeVisible();
  });

  test('will not send an empty or half-pasted token', async ({ page }) => {
    await signup(page);
    await page.goto('/migration');

    const submit = page.getByRole('button', { name: 'অ্যাকাউন্ট ও খাত আনুন' });
    await expect(submit).toBeDisabled();

    await page.getByLabel('Wallet API টোকেন').fill('eyJhbGci');
    await expect(submit).toBeDisabled();

    await page.getByLabel('Wallet API টোকেন').fill('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc');
    await expect(submit).toBeEnabled();
  });

  test('the token box is a password field, so it is not left on screen', async ({ page }) => {
    /* Somebody pastes this at a desk with other people in the room, and it is a
       live credential to their bank records in another app. */
    await signup(page);
    await page.goto('/migration');
    await expect(page.getByLabel('Wallet API টোকেন')).toHaveAttribute('type', 'password');
  });
});
