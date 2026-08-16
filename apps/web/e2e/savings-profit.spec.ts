import { expect, test, type Page } from '@playwright/test';

/**
 * Profit on a savings instrument, from the screen.
 *
 * The API suite already proves the arithmetic and the tenancy. What only a
 * browser can prove is the thing this feature exists for: that somebody holding
 * a Sanchayapatra can record a quarterly payout without ever being asked
 * whether it is income, and that the certificate remembers what it paid.
 *
 * The maturity case is here for the opposite reason — it is the one place a
 * person is most likely to book their own returning deposit as earnings, so the
 * test asserts that the money moves and the income statement does not.
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
  return `savings-${Date.now()}-${counter}-${Math.trunc(performance.now())}@example.test`;
}

async function signup(page: Page): Promise<void> {
  await page.goto('/signup');
  await page.getByLabel('নাম').fill('সঞ্চয় পরীক্ষা');
  await page.getByLabel('ইমেইল').fill(uniqueEmail());
  await page.getByLabel('পাসওয়ার্ড').fill('hishab1234');
  await page.getByLabel('মোবাইল নম্বর').fill(uniquePhone());
  await page.getByRole('button', { name: 'অ্যাকাউন্ট খুলুন' }).click();
  await expect(page.getByRole('heading', { name: 'ড্যাশবোর্ড' }).first()).toBeVisible({
    timeout: 30_000,
  });
}

/** An account with money already in it, so a transfer has something to move. */
async function addAccount(page: Page, name: string, opening?: string): Promise<void> {
  await page.goto('/accounts');
  await page.getByRole('main').getByRole('button', { name: 'নতুন', exact: true }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByLabel('নাম', { exact: true })).toBeVisible();
  await sheet.getByLabel('নাম', { exact: true }).fill(name);
  if (opening) await sheet.getByLabel('প্রারম্ভিক জের (৳)').fill(opening);
  await sheet.getByRole('button', { name: 'সংরক্ষণ করুন', exact: true }).click();
  await expect(sheet).toBeHidden({ timeout: 15_000 });
}

/**
 * A plan, of a named type.
 *
 * `type` matters now. "মুনাফা পেয়েছি" is offered only where profit can actually
 * have arrived — a সঞ্চয়পত্র, which credits a bank account every month or
 * quarter, or any plan that has matured. A running ডিপিএস pays nothing at all
 * before the end, so it gets no such button and these tests must not ask for
 * one: that was the bug the button had on every plan.
 */
async function addPlan(page: Page, name: string, type = 'ডিপিএস', rate = '8.25'): Promise<void> {
  await page.goto('/savings');
  await page.getByRole('main').getByRole('button', { name: 'নতুন', exact: true }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByLabel('নাম', { exact: true })).toBeVisible();
  await sheet.getByLabel('নাম', { exact: true }).fill(name);
  await sheet.getByLabel('ধরন', { exact: true }).selectOption({ label: type });
  await sheet.getByLabel('প্রতি কিস্তি (৳)').fill('2000');
  await sheet.getByLabel('মুনাফার হার (%)').fill(rate);
  await sheet.getByRole('button', { name: 'সংরক্ষণ করুন', exact: true }).click();
  await expect(sheet).toBeHidden({ timeout: 15_000 });
}

/** One account row, by its exact name — the list nests rows inside rows. */
const accountRow = (page: Page, name: string) =>
  page
    .getByRole('listitem')
    .filter({ has: page.getByText(name, { exact: true }) })
    .last();

/* Scoped to `main` and exact: the sidebar link reads "সঞ্চয় ও ডিপিএস", so a
   loose match opens the navigation instead of the plan. */
const openPlan = (page: Page, name: string) =>
  page.getByRole('main').getByText(name, { exact: true }).first().click();

test.describe('savings profit', () => {
  test('a quarterly payout is recorded against the certificate that paid it', async ({ page }) => {
    await signup(page);
    await addAccount(page, 'সিটি ব্যাংক');
    await addPlan(page, 'পরিবার সঞ্চয়পত্র', 'সঞ্চয়পত্র');

    await openPlan(page, 'পরিবার সঞ্চয়পত্র');
    await page.getByRole('dialog').getByRole('button', { name: 'মুনাফা পেয়েছি' }).click();

    const sheet = page.getByRole('dialog');
    await expect(sheet.getByLabel('কত টাকা পেলেন (৳)')).toBeVisible();
    /* Empty, and this is the assertion, not an omission. The box used to open
       with the whole projected maturity profit already in it — a figure nobody
       has been paid — and a number sitting in a box labelled "কত টাকা পেলেন"
       reads as a claim that it arrived. The bank deducts source tax before it
       pays and sometimes adds a bonus, so the only true figure is the one on
       the passbook. */
    await expect(sheet.getByLabel('কত টাকা পেলেন (৳)')).toHaveValue('');
    await sheet.getByLabel('কত টাকা পেলেন (৳)').fill('2760');
    /* The income head is required — money filed under nothing is invisible on
       every report — and the picker is grouped, so pick by index rather than
       by a label this test would have to keep in step with the seed. */
    await sheet.getByLabel('আয়ের খাত').selectOption({ index: 1 });
    await sheet.getByRole('button', { name: 'সংরক্ষণ করুন', exact: true }).click();
    await expect(sheet).toBeHidden({ timeout: 15_000 });

    // The certificate remembers. This is the number that had no answer before.
    await openPlan(page, 'পরিবার সঞ্চয়পত্র');
    const detail = page.getByRole('dialog');
    await expect(detail.getByText('এ পর্যন্ত মুনাফা পেয়েছি')).toBeVisible();
    /* Either numeral system: which one renders depends on the workspace's
       locale, and what this test is about is the figure, not the script. */
    await expect(detail.getByText(/2,760|২,৭৬০/).first()).toBeVisible();
  });

  test('maturity moves the money and calls it a transfer, not income', async ({ page }) => {
    await signup(page);
    await addAccount(page, 'ডিপিএস হিসাব', '50000');
    await addAccount(page, 'চলতি হিসাব');
    await addPlan(page, 'ব্যাংক ডিপিএস');

    await openPlan(page, 'ব্যাংক ডিপিএস');
    await page.getByRole('dialog').getByRole('button', { name: 'মেয়াদপূর্তি' }).click();

    const sheet = page.getByRole('dialog');
    /* Said before anything is filled in. Somebody booking their own returning
       deposit as earnings would overstate the year by the size of the deposit,
       and this sentence is the only thing standing in the way. */
    await expect(sheet.getByText('আয় নয়', { exact: false })).toBeVisible();

    await sheet.getByLabel('কোন অ্যাকাউন্টে টাকাটা আছে').selectOption({ label: 'ডিপিএস হিসাব' });
    await sheet.getByLabel('কোথায় নিয়ে যাবেন').selectOption({ label: 'চলতি হিসাব' });
    // Prefilled with the whole balance, so emptying the account is one tap.
    await expect(sheet.getByLabel('কত টাকা (৳)')).toHaveValue(/50,?000/);
    await sheet.getByRole('button', { name: 'সংরক্ষণ করুন', exact: true }).click();
    await expect(sheet).toBeHidden({ timeout: 15_000 });

    await page.goto('/accounts');
    await expect(accountRow(page, 'ডিপিএস হিসাব')).toContainText('0.00');

    /* And nothing landed on the income statement. A transfer between two of
       your own accounts is not earnings, whatever the money was doing before. */
    await page.goto('/savings');
    await openPlan(page, 'ব্যাংক ডিপিএস');
    await expect(page.getByRole('dialog').getByText('এ পর্যন্ত মুনাফা পেয়েছি')).toBeVisible();
  });

  test('money can still be moved once the plan is no longer running', async ({ page }) => {
    /* A plan already marked মেয়াদপূর্ণ or বন্ধ is exactly the one whose balance is
       sitting in a savings account waiting to be moved. Hiding the transfer
       there would strand the money — which is what the first cut of this screen
       did, by only offering it while the plan was চলমান. */
    await signup(page);
    await addAccount(page, 'ডিপিএস হিসাব', '20000');
    await addAccount(page, 'নগদ');
    await addPlan(page, 'পুরনো ডিপিএস');

    await openPlan(page, 'পুরনো ডিপিএস');
    await page.getByRole('dialog').getByRole('button', { name: 'মেয়াদপূর্তি' }).click();
    let sheet = page.getByRole('dialog');
    await sheet.getByLabel('কোন অ্যাকাউন্টে টাকাটা আছে').selectOption({ label: 'ডিপিএস হিসাব' });
    await sheet.getByLabel('কোথায় নিয়ে যাবেন').selectOption({ label: 'নগদ' });
    await sheet.getByLabel('কত টাকা (৳)').fill('5000');
    await sheet.getByRole('button', { name: 'সংরক্ষণ করুন', exact: true }).click();
    await expect(sheet).toBeHidden({ timeout: 15_000 });

    // The plan is MATURED now, and the rest of the balance is still stuck.
    await openPlan(page, 'পুরনো ডিপিএস');
    await page.getByRole('dialog').getByRole('button', { name: 'টাকা সরান' }).click();
    sheet = page.getByRole('dialog');
    await sheet.getByLabel('কোন অ্যাকাউন্টে টাকাটা আছে').selectOption({ label: 'ডিপিএস হিসাব' });
    await sheet.getByLabel('কোথায় নিয়ে যাবেন').selectOption({ label: 'নগদ' });
    await sheet.getByRole('button', { name: 'সংরক্ষণ করুন', exact: true }).click();
    await expect(sheet).toBeHidden({ timeout: 15_000 });

    await page.goto('/accounts');
    await expect(accountRow(page, 'ডিপিএস হিসাব')).toContainText('0.00');
  });
});
