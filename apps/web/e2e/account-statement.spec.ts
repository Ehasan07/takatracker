import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * The copy of a string that is actually on screen.
 *
 * Both the owner's statement and the shared one render every row twice — cards
 * for a phone, a table above it — and hide one with CSS. `.first()` therefore
 * picks the hidden copy at exactly the widths where the table is the visible
 * one, which is how this spec passed at 390 and failed at 768 and 1280.
 */
const shown = (page: Page, text: string): Locator =>
  page.getByText(text).filter({ visible: true }).first();

/**
 * The statement of account, in a browser.
 *
 * The arithmetic is proved in the API suite. What only a browser shows is that
 * a person can *get* to it — the accounts list had no way through to one before
 * — that the running balance is on screen rather than behind a scroll, and that
 * the link a landlord opens carries the same closing figure the owner saw.
 */

const PASSWORD = 'hishab1234';

let counter = 0;
function uniqueEmail(): string {
  counter += 1;
  return `acct-stmt-${Date.now()}-${counter}-${Math.trunc(performance.now())}@example.test`;
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
  await page.getByLabel('নাম').fill('বিবরণী পরীক্ষা');
  await page.getByLabel('ইমেইল').fill(uniqueEmail());
  await page.getByLabel('পাসওয়ার্ড').fill(PASSWORD);
  await page.getByLabel('মোবাইল নম্বর').fill(uniquePhone());
  await page.getByRole('button', { name: 'অ্যাকাউন্ট খুলুন' }).click();
  await expect(page.getByRole('heading', { name: 'ড্যাশবোর্ড' }).first()).toBeVisible({
    timeout: 30_000,
  });
}

/** One cash account with an opening balance, so the statement has a floor. */
async function addCash(page: Page): Promise<void> {
  await page.goto('/accounts');
  const compact = page.getByRole('button', { name: 'নতুন', exact: true });
  const full = page.getByRole('button', { name: 'নতুন অ্যাকাউন্ট যোগ করুন', exact: true });
  await ((await compact.isVisible()) ? compact : full).click();
  await page.getByLabel('নাম').fill('নগদ');
  await page.getByLabel('প্রারম্ভিক জের (৳)').fill('10000');
  await page.getByRole('button', { name: 'সংরক্ষণ করুন' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
}

/** One expense, so there is a movement between the two balances. */
async function spend(page: Page, amount: string, note: string): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'নতুন লেনদেন' }).first().click();
  await page.getByLabel('পরিমাণ (৳)').fill(amount);
  await page.getByLabel('অ্যাকাউন্ট').selectOption({ label: 'নগদ' });
  await page.getByLabel('ক্যাটাগরি').selectOption({ label: 'খাবার ও বাজার' });
  await page.getByLabel('বিবরণ').fill(note);
  await page.getByRole('button', { name: 'সংরক্ষণ করুন' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
}

test.describe('a statement of account', () => {
  test('is one tap from the account, and shows opening, movement and closing', async ({ page }) => {
    await signup(page);
    await addCash(page);
    await spend(page, '2500', 'সবজি');

    await page.goto('/accounts');
    /* The way in. Before this link the question "when did money move on this
       account?" had no answer anywhere in the product. */
    await page.getByRole('link', { name: /নগদ — হিসাব বিবরণী/ }).click();

    await expect(page).toHaveURL(/\/accounts\/[^/]+\/statement$/);
    await expect(shown(page, 'প্রারম্ভিক জের')).toBeVisible();
    await expect(shown(page, 'সমাপনী জের')).toBeVisible();

    /* ৳10,000 opening, ৳2,500 spent, ৳7,500 left. The three figures are the
       document; if any one of them is missing the page is decoration. */
    await expect(shown(page, '৳10,000.00')).toBeVisible();
    await expect(shown(page, '৳7,500.00')).toBeVisible();
    await expect(shown(page, 'সবজি')).toBeVisible();

    /* Cash is debit-normal, and the page says which side that is rather than
       expecting a reader to know. */
    await expect(page.getByText(/ডেবিট মানে টাকা যোগ/)).toBeVisible();
  });

  test('prints as a document, with a letterhead and no column of dashes', async ({ page }) => {
    await signup(page);
    await addCash(page);
    await spend(page, '2500', 'সবজি');

    await page.goto('/accounts');
    await page.getByRole('link', { name: /নগদ — হিসাব বিবরণী/ }).click();
    await expect(shown(page, 'সমাপনী জের')).toBeVisible();

    /* The print stylesheet is the thing under test, so the page has to be asked
       for the print rendering. Everything below is invisible on screen and is
       exactly what comes out of the printer. */
    await page.emulateMedia({ media: 'print' });

    const letterhead = page.locator('.statement-letterhead');
    await expect(letterhead).toBeVisible();
    /* The mark and the name — the page used to open with nine-point grey text
       and nothing a reader could place. */
    await expect(letterhead.getByText('Taka Tracker')).toBeVisible();
    /* Whose document it is, and over what period: the two facts somebody checks
       before reading a figure. */
    await expect(letterhead.getByText('দিয়েছেন')).toBeVisible();
    await expect(letterhead.getByText('বিবরণী পরীক্ষা')).toBeVisible();
    await expect(letterhead.getByText('সময়কাল')).toBeVisible();

    /* One summary block above the table, not two. The strip carries opening,
       both column totals and closing; the view's own opening/closing pair used
       to print in a second box directly underneath it, which on paper reads as
       an error in the document. (The words appear again inside the table, on
       its opening line, which is where a bank statement puts them too.) */
    await expect(page.locator('.loan-print-block')).toHaveCount(1);

    /* No account entry has a reference number, so the column is not printed at
       all rather than printed empty down the right edge. */
    const table = page.locator('.loan-print-table table');
    await expect(table.getByRole('columnheader', { name: 'বিপরীত খাত' })).toBeVisible();
    await expect(table.getByRole('columnheader', { name: 'রেফারেন্স' })).toHaveCount(0);

    await page.emulateMedia({ media: 'screen' });
  });

  test('never scrolls sideways, at any width', async ({ page }) => {
    await signup(page);
    await addCash(page);
    await spend(page, '2500', 'সবজি');

    await page.goto('/accounts');
    await page.getByRole('link', { name: /নগদ — হিসাব বিবরণী/ }).click();
    await expect(shown(page, 'সমাপনী জের')).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('can be handed to somebody with no account, and reads the same', async ({
    page,
    context,
  }) => {
    await signup(page);
    await addCash(page);
    await spend(page, '2500', 'সবজি');

    await page.goto('/accounts');
    await page.getByRole('link', { name: /নগদ — হিসাব বিবরণী/ }).click();
    await expect(shown(page, 'সমাপনী জের')).toBeVisible();

    await page.getByRole('button', { name: 'লিংক', exact: true }).click();
    const sheet = page.getByRole('dialog');
    await expect(sheet).toBeVisible();
    await sheet.getByRole('button', { name: 'লিংক তৈরি করুন' }).click();

    /* The token is shown once, in the response that created it — the server
       keeps only a hash. Reading it off the box is the only way there is, which
       is exactly what a person does. */
    const box = sheet.getByLabel('শেয়ার লিংক');
    await expect(box).toBeVisible({ timeout: 15_000 });
    const path = await box.inputValue();
    expect(path).toContain('/s/');

    /* A fresh context: no cookies, no session, nothing but the link. */
    const stranger = await context.browser()!.newContext();
    const guest = await stranger.newPage();
    await guest.goto(path);

    await expect(guest.getByRole('heading', { name: 'নগদ' })).toBeVisible();
    // The same closing figure the owner was looking at.
    await expect(shown(guest, '৳7,500.00')).toBeVisible();
    await expect(shown(guest, 'সবজি')).toBeVisible();
    await stranger.close();
  });
});
