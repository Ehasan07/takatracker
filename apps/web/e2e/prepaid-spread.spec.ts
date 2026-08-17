import { expect, test, type Page } from '@playwright/test';

/**
 * A year's insurance, read as a month at a time.
 *
 * The API suite proves the arithmetic and that nothing is posted. What only a
 * browser can prove is that both halves are visible to the person deciding:
 * the spread says ৳1,000 a month, and the khata still says ৳12,000 on the day
 * the money left. If the second half were ever hidden, the first would read as
 * an accrual — and these books declare `basis: 'CASH'` on every statement they
 * serve.
 */

let phoneSeq = 0;
function uniquePhone(): string {
  phoneSeq += 1;
  return `019${String((Date.now() % 1_000_000) * 100 + (phoneSeq % 100))
    .slice(-8)
    .padStart(8, '0')}`;
}

let counter = 0;
function uniqueEmail(): string {
  counter += 1;
  return `prepaid-${Date.now()}-${counter}-${Math.trunc(performance.now())}@example.test`;
}

async function signup(page: Page): Promise<void> {
  await page.goto('/signup');
  await page.getByLabel('নাম').fill('প্রিপেইড পরীক্ষা');
  await page.getByLabel('ইমেইল').fill(uniqueEmail());
  await page.getByLabel('পাসওয়ার্ড').fill('hishab1234');
  await page.getByLabel('মোবাইল নম্বর').fill(uniquePhone());
  await page.getByRole('button', { name: 'অ্যাকাউন্ট খুলুন' }).click();
  await expect(page.getByRole('heading', { name: 'ড্যাশবোর্ড' }).first()).toBeVisible({
    timeout: 30_000,
  });
}

async function addAccount(page: Page, name: string, opening: string): Promise<void> {
  await page.goto('/accounts');
  await page.getByRole('main').getByRole('button', { name: 'নতুন', exact: true }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByLabel('নাম', { exact: true })).toBeVisible();
  await sheet.getByLabel('নাম', { exact: true }).fill(name);
  await sheet.getByLabel('প্রারম্ভিক জের (৳)').fill(opening);
  await sheet.getByRole('button', { name: 'সংরক্ষণ করুন', exact: true }).click();
  await expect(sheet).toBeHidden({ timeout: 15_000 });
}

/** ৳12,000 of car insurance — the case the whole feature exists for. */
async function addPremium(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'নতুন লেনদেন' }).first().click();
  const sheet = page.getByRole('dialog');
  await sheet.getByLabel('পরিমাণ (৳)').fill('12000');
  await sheet.getByLabel('ক্যাটাগরি').selectOption({ index: 1 });
  await sheet.getByLabel('বিবরণ').fill('গাড়ির বীমা');
  /* Not `exact`: once an amount is typed the button reads
     "৳12,000.00 সংরক্ষণ করুন", so an exact match never resolves. */
  await sheet.getByRole('button', { name: 'সংরক্ষণ করুন' }).click();
  await expect(sheet).toBeHidden({ timeout: 15_000 });
}

/* The transaction detail renders twice — an aside beside the list on a wide
   screen, a sheet over it on a narrow one — so a plain `.first()` can resolve to
   the copy that is not on screen. That one never settles, and the click waits
   out the timeout against an element nobody can see. Hence `:visible`. */
test.describe('prepaid expenses, spread for the eye', () => {
  test('a year of insurance reads as a month at a time, and the khata does not move', async ({
    page,
  }) => {
    await signup(page);
    await addAccount(page, 'সিটি ব্যাংক', '100000');
    await addPremium(page);

    await page.goto('/transactions');
    await page.getByTestId('ledger-list').getByText('গাড়ির বীমা').first().click();

    /* Said on the row itself, where somebody is deciding. "It will be divided"
       without "the books do not change" is the half that misleads. */
    await expect(
      page.locator('p:visible', { hasText: 'খাতায় কিছু বদলাবে না' }).first(),
    ).toBeVisible();
    await page.locator('button:visible', { hasText: 'কয়েক মাসের খরচ' }).first().click();

    /* By accessible name, not by text. "কয়েক মাসের খরচ" is both this sheet's
       title *and* the label of the button that opened it, and the transaction's
       own sheet stays open underneath — so a `hasText` filter matches both and
       `toBeHidden` on the pair can only ever time out. */
    const sheet = page.getByRole('dialog', { name: 'কয়েক মাসের খরচ' });
    await expect(sheet.getByLabel('কত মাসের')).toHaveValue('12');
    await sheet.getByRole('button', { name: 'ভাগ করে দেখান' }).click();
    await expect(sheet).toBeHidden({ timeout: 15_000 });

    // The khata still carries the whole payment on the day it was made.
    await expect(page.getByTestId('ledger-list').getByText(/12,000\.00|১২,০০০\.০০/)).toBeVisible();

    await page.goto('/transactions/prepaid');
    await expect(page.getByRole('heading', { name: 'মাসে মাসে ভাগ' })).toBeVisible();
    /* Said again at the top of the page, before a single figure: a reader who
       thought these numbers were in the books would misread all of them. */
    await expect(page.getByText('এটি শুধু দেখার হিসাব', { exact: false })).toBeVisible();

    // ৳12,000 a year is ৳1,000 a month, which is the whole point.
    await expect(page.getByText(/1,000\.00|১,০০০\.০০/).first()).toBeVisible();
    await expect(page.getByText('গাড়ির বীমা').first()).toBeVisible();
  });

  test('the spread can be taken back, and the payment is untouched', async ({ page }) => {
    await signup(page);
    await addAccount(page, 'সিটি ব্যাংক', '100000');
    await addPremium(page);

    await page.goto('/transactions');
    await page.getByTestId('ledger-list').getByText('গাড়ির বীমা').first().click();
    await page.locator('button:visible', { hasText: 'কয়েক মাসের খরচ' }).first().click();
    // Named, for the same reason: the transaction sheet stays open behind it.
    /* By accessible name, not by text. "কয়েক মাসের খরচ" is both this sheet's
       title *and* the label of the button that opened it, so a `hasText`
       filter matches the transaction sheet underneath as well — and that one
       never closes, so `toBeHidden` on the pair can only ever time out. */
    let sheet = page.getByRole('dialog', { name: 'কয়েক মাসের খরচ' });
    await sheet.getByRole('button', { name: 'ভাগ করে দেখান' }).click();
    await expect(sheet).toBeHidden({ timeout: 15_000 });

    await page.getByTestId('ledger-list').getByText('গাড়ির বীমা').first().click();
    await page.locator('button:visible', { hasText: 'মেয়াদ বদলান' }).first().click();
    sheet = page.getByRole('dialog', { name: 'কয়েক মাসের খরচ' });
    await sheet.getByRole('button', { name: 'ভাগ করা বন্ধ করুন' }).click();
    await expect(sheet).toBeHidden({ timeout: 15_000 });

    /* Nothing was ever posted, so there is nothing to unwind — clearing a
       spread removes a way of reading the row, not a transaction. */
    await page.goto('/transactions/prepaid');
    await expect(page.getByText('এখনও কোনো খরচকে কয়েক মাসের বলা হয়নি।')).toBeVisible();

    await page.goto('/accounts');
    await expect(page.getByText(/88,000\.00|৮৮,০০০\.০০/).first()).toBeVisible();
  });
});
