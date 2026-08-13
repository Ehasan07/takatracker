import { expect, test, type Page } from '@playwright/test';

/**
 * M24 acceptance from the user's side: the ceiling is visible before it is hit,
 * and hitting it produces a sentence rather than a generic failure.
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

async function signup(page: Page): Promise<void> {
  await page.goto('/signup');
  await page.getByLabel('নাম').fill('প্ল্যান');
  await page
    .getByLabel('ইমেইল')
    .fill(`plan-${Date.now()}-${Math.trunc(performance.now())}@example.test`);
  await page.getByLabel('পাসওয়ার্ড').fill('hishab1234');
  await page.getByLabel('মোবাইল নম্বর').fill(uniquePhone());
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

test.describe('categories and sub-categories', () => {
  test('adds a sub-category and rolls it up in the report', async ({ page }) => {
    await signup(page);

    // A cash account and a spend, so the report has something to show.
    await page.goto('/accounts');
    await page.getByRole('button', { name: 'নতুন', exact: true }).click();
    await page.getByLabel('নাম').fill('নগদ');
    await page.getByRole('button', { name: 'সংরক্ষণ করুন' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();

    // The categories link lives next to the accounts, where both are found
    // together. It says "ক্যাটাগরি", not "খাত" — that is one letter from the
    // ledger tab "খাতা" and reads ambiguously.
    //
    // Scoped to the content area, not `exact`: the desktop sidebar carries a
    // row with precisely this accessible name, so at 768px and above an
    // unscoped lookup is ambiguous however exactly it matches. What this test
    // is about is the link on the accounts screen.
    await page
      .getByTestId('app-scroll')
      .getByRole('link', { name: 'ক্যাটাগরি', exact: true })
      .click();
    await expect(page).toHaveURL(/\/categories/);

    // Nest রিকশা under যাতায়াত.
    await page.getByRole('button', { name: 'যাতায়াত-এ উপ-খাত যোগ করুন' }).click();
    /* `exact`, because the sheet now also carries "ইংরেজি নাম (ঐচ্ছিক)" and a
       substring match finds both. */
    await page.getByLabel('নাম', { exact: true }).fill('রিকশা');
    await page.getByRole('button', { name: 'সংরক্ষণ করুন' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(page.getByText('রিকশা')).toBeVisible();

    // Spend on the child.
    await page.getByRole('button', { name: 'নতুন লেনদেন' }).first().click();
    await page.getByLabel('পরিমাণ (৳)').fill('300');
    await page.getByLabel('ক্যাটাগরি').selectOption({ label: 'রিকশা' });
    await page.getByRole('button', { name: 'সংরক্ষণ করুন' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();

    // The report shows the parent, and expanding reveals the child.
    await page.goto('/reports');
    await expect(page.getByText('যাতায়াত').first()).toBeVisible();
    await page.getByRole('button', { name: 'যাতায়াত — উপ-খাত' }).click();
    await expect(page.getByText('রিকশা').first()).toBeVisible();
  });
});
