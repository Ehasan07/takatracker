import { expect, test, type Page } from '@playwright/test';

/**
 * The way in from another product, and the door it sits behind.
 *
 * The staging, the spreadsheet and the rollback are covered against a stubbed
 * Wallet in apps/api/test/migration.e2e-spec.ts, and nothing here reaches a
 * third-party API — a browser test that depends on somebody else's server being
 * up is a test that fails for reasons nobody can fix.
 *
 * What is left is what only a browser can check:
 *
 * - **The token box is in nobody else's product.** It asks a person to paste a
 *   live credential to another finance app, and the day that appears in a
 *   stranger's menu, "Taka Tracker asks for your other app's password" has
 *   become a true sentence. The spreadsheet door beside it asks for nothing, so
 *   everybody gets that one — two doors, one allowlist, and the test has to
 *   hold them apart.
 * - **It is reachable from আরও**, without being told a URL.
 * - **The three promises are written on it** rather than implied.
 * - **The button cannot be pressed with nothing in the box** — a spinner
 *   followed by "token too short" is a worse answer than a button that plainly
 *   is not ready.
 *
 * The allowlist in `playwright.config.ts` names a whole domain, so each test
 * below signs up a fresh address either inside it or outside it. That one
 * choice is the whole difference between the two halves of this file.
 */

const PASSWORD = 'hishab1234';

let counter = 0;
function uniqueEmail(domain = '@example.test'): string {
  counter += 1;
  return `migration-${Date.now()}-${counter}-${Math.trunc(performance.now())}${domain}`;
}

/** The domain `playwright.config.ts` puts in the API's `MIGRATION_ALLOWED_EMAILS`. */
const allowedEmail = (): string => uniqueEmail('@migration.test');

let phoneSeq = 0;
function uniquePhone(): string {
  phoneSeq += 1;
  return `018${String((Date.now() % 1_000_000) * 100 + (phoneSeq % 100))
    .slice(-8)
    .padStart(8, '0')}`;
}

async function signup(page: Page, email: string): Promise<void> {
  await page.goto('/signup');
  await page.getByLabel('নাম').fill('মাইগ্রেশন পরীক্ষা');
  await page.getByLabel('ইমেইল').fill(email);
  await page.getByLabel('পাসওয়ার্ড').fill(PASSWORD);
  await page.getByLabel('মোবাইল নম্বর').fill(uniquePhone());
  await page.getByRole('button', { name: 'অ্যাকাউন্ট খুলুন' }).click();
  await expect(page.getByRole('heading', { name: 'ড্যাশবোর্ড' }).first()).toBeVisible({
    timeout: 30_000,
  });
}

test.describe('bringing another product across', () => {
  test('offers an ordinary account the spreadsheet, and never the token box', async ({ page }) => {
    /* The two doors are not the same door. A spreadsheet of headings asks for
       nothing, so everybody gets it; the Wallet box asks for a live credential
       to another finance app, so it is the one thing behind the allowlist. */
    await signup(page, uniqueEmail());

    await page.goto('/more');
    await page
      .getByRole('link', { name: /^আগের সফটওয়্যার থেকে/ })
      .last()
      .click();

    await expect(page.getByRole('heading', { name: 'এক্সেল থেকে আনুন' })).toBeVisible();
    await expect(page.getByLabel('Wallet API টোকেন')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'সংযোগ করুন' })).toHaveCount(0);
  });

  test('hands an ordinary account a sample file that actually imports', async ({ page }) => {
    /* The template is the whole of the spreadsheet route's documentation, so it
       has to be reachable without an account that has anything special, and the
       file that comes down has to be the one the parser accepts — which
       packages/core/src/migration.test.ts checks by round-tripping it. */
    await signup(page, uniqueEmail());
    await page.goto('/migration');

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'নমুনা ফাইল নামান' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe('migration-sample.csv');
  });

  test('is reachable from আরও and says what it will and will not do', async ({ page }) => {
    await signup(page, allowedEmail());

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
    await signup(page, allowedEmail());
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
    await signup(page, allowedEmail());
    await page.goto('/migration');
    await expect(page.getByLabel('Wallet API টোকেন')).toHaveAttribute('type', 'password');
  });
});
