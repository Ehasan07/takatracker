import { expect, test, type Page } from '@playwright/test';

/**
 * A DPS instalment reaching the balance sheet.
 *
 * The API suite already proves the arithmetic, the tenancy and that the row is
 * a `TRANSFER`. What only a browser can prove is the two things this feature
 * turns on:
 *
 *  1. **The money actually arrives.** Somebody ticks "জমা দিলাম" and their
 *     savings account is ৳2,000 richer and their bank account ৳2,000 poorer.
 *     Ten plans and ৳31,000 of savings is what it looked like before.
 *  2. **Nothing moves unless they say so.** A plan with no linked account
 *     behaves exactly as this screen always has, and a linked one still offers
 *     "শুধু চিহ্ন দিন" beside the button that moves the money.
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
  return `savings-link-${Date.now()}-${counter}-${Math.trunc(performance.now())}@example.test`;
}

async function signup(page: Page): Promise<void> {
  await page.goto('/signup');
  await page.getByLabel('নাম').fill('কিস্তি পরীক্ষা');
  await page.getByLabel('ইমেইল').fill(uniqueEmail());
  await page.getByLabel('পাসওয়ার্ড').fill('hishab1234');
  await page.getByLabel('মোবাইল নম্বর').fill(uniquePhone());
  await page.getByRole('button', { name: 'অ্যাকাউন্ট খুলুন' }).click();
  await expect(page.getByRole('heading', { name: 'ড্যাশবোর্ড' }).first()).toBeVisible({
    timeout: 30_000,
  });
}

/** `type` matters here: only a সঞ্চয় account can be linked to a plan. */
async function addAccount(page: Page, name: string, type: string, opening?: string): Promise<void> {
  await page.goto('/accounts');
  await page.getByRole('main').getByRole('button', { name: 'নতুন', exact: true }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByLabel('নাম', { exact: true })).toBeVisible();
  await sheet.getByLabel('নাম', { exact: true }).fill(name);
  await sheet.getByLabel('ধরন', { exact: true }).selectOption({ label: type });
  if (opening) await sheet.getByLabel('প্রারম্ভিক জের (৳)').fill(opening);
  await sheet.getByRole('button', { name: 'সংরক্ষণ করুন', exact: true }).click();
  await expect(sheet).toBeHidden({ timeout: 15_000 });
}

/**
 * A monthly plan. `linkTo` is the savings account's name, or nothing; `type` is
 * the instrument, which decides whether profit can have arrived yet.
 */
async function addPlan(page: Page, name: string, linkTo?: string, type = 'ডিপিএস'): Promise<void> {
  await page.goto('/savings');
  await page.getByRole('main').getByRole('button', { name: 'নতুন', exact: true }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByLabel('নাম', { exact: true })).toBeVisible();
  await sheet.getByLabel('নাম', { exact: true }).fill(name);
  await sheet.getByLabel('ধরন', { exact: true }).selectOption({ label: type });
  await sheet.getByLabel('প্রতি কিস্তি (৳)').fill('2000');
  await sheet.getByLabel('মুনাফার হার (%)').fill('8.25');
  if (linkTo) {
    await sheet.getByLabel('কিস্তির টাকা কোন হিসাবে জমা হয়').selectOption({ label: linkTo });
  }
  await sheet.getByRole('button', { name: 'সংরক্ষণ করুন', exact: true }).click();
  await expect(sheet).toBeHidden({ timeout: 15_000 });
}

/* Scoped to `main` and exact: the sidebar link reads "সঞ্চয় ও ডিপিএস", so a
   loose match opens the navigation instead of the plan. */
const openPlan = (page: Page, name: string) =>
  page.getByRole('main').getByText(name, { exact: true }).first().click();

/** One account row, by its exact name — the list nests rows inside rows. */
const accountRow = (page: Page, name: string) =>
  page
    .getByRole('listitem')
    .filter({ has: page.getByText(name, { exact: true }) })
    .last();

test.describe('savings instalments on the balance sheet', () => {
  test('a linked plan moves the instalment as a transfer', async ({ page }) => {
    await signup(page);
    await addAccount(page, 'চলতি হিসাব', 'ব্যাংক', '50000');
    await addAccount(page, 'ডিপিএস হিসাব', 'সঞ্চয় / ডিপিএস');
    await addPlan(page, 'ব্র্যাক ডিপিএস', 'ডিপিএস হিসাব');

    await openPlan(page, 'ব্র্যাক ডিপিএস');
    await expect(
      page.getByRole('dialog').getByText('কিস্তির টাকা যে হিসাবে জমা হয়'),
    ).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'জমা দিলাম' }).first().click();

    const sheet = page.getByRole('dialog');
    /* Said before anything is filled in. Somebody who thinks a DPS deposit is
       spending would read their own net worth wrong by every poisha they have
       ever saved, and this sentence is the only thing in the way. */
    await expect(sheet.getByText('খরচ নয়', { exact: false })).toBeVisible();

    await sheet.getByLabel('কোন অ্যাকাউন্ট থেকে গেল').selectOption({ label: 'চলতি হিসাব' });
    // Prefilled from the schedule, and still editable.
    await expect(sheet.getByLabel('কত টাকা (৳)')).toHaveValue(/2,?000/);
    await sheet.getByRole('button', { name: 'জমা দিন ও টাকা সরান' }).click();
    await expect(sheet).toBeHidden({ timeout: 15_000 });

    // The money is really in both places it should be.
    await page.goto('/accounts');
    await expect(accountRow(page, 'ডিপিএস হিসাব')).toContainText('2,000.00');
    await expect(accountRow(page, 'চলতি হিসাব')).toContainText('48,000.00');

    // And the khata calls it a transfer between the two, not an expense.
    await page.goto('/transactions');
    const ledger = page.getByTestId('ledger-list');
    await expect(ledger.getByText('ব্র্যাক ডিপিএস — কিস্তি')).toBeVisible();
    await expect(ledger.getByText('চলতি হিসাব → ডিপিএস হিসাব')).toBeVisible();

    // The instalment now says the money reached the books, not merely that it
    // was ticked.
    await page.goto('/savings');
    await openPlan(page, 'ব্র্যাক ডিপিএস');
    await expect(page.getByRole('dialog').getByText('খাতায় জমা').first()).toBeVisible();
  });

  test('an unlinked plan ticks the instalment and moves nothing', async ({ page }) => {
    await signup(page);
    await addAccount(page, 'চলতি হিসাব', 'ব্যাংক', '50000');
    await addPlan(page, 'হাতের ডিপিএস');

    await openPlan(page, 'হাতের ডিপিএস');
    const detail = page.getByRole('dialog');
    await expect(detail.getByText('যুক্ত নেই').first()).toBeVisible();
    await detail.getByRole('button', { name: 'জমা দিলাম' }).first().click();

    /* No sheet, no question, no money — exactly what this button did before
       any of this existed. The tick lands straight away. */
    await expect(detail.getByText('জমা হয়েছে').first()).toBeVisible({ timeout: 15_000 });

    await page.goto('/accounts');
    await expect(accountRow(page, 'চলতি হিসাব')).toContainText('50,000.00');
  });

  test('a linked plan can still be ticked without moving the money', async ({ page }) => {
    /* The other half of the choice, and a real one: an auto-debit the bank
       statement already brought in, or an instalment entered by hand last week.
       Moving the money a second time would double it. */
    await signup(page);
    await addAccount(page, 'চলতি হিসাব', 'ব্যাংক', '50000');
    await addAccount(page, 'ডিপিএস হিসাব', 'সঞ্চয় / ডিপিএস');
    await addPlan(page, 'সিটি ডিপিএস', 'ডিপিএস হিসাব');

    await openPlan(page, 'সিটি ডিপিএস');
    await page.getByRole('dialog').getByRole('button', { name: 'জমা দিলাম' }).first().click();

    const sheet = page.getByRole('dialog');
    await sheet.getByRole('button', { name: 'শুধু চিহ্ন দিন, টাকা সরাবেন না' }).click();
    await expect(sheet).toBeHidden({ timeout: 15_000 });

    await page.goto('/accounts');
    await expect(accountRow(page, 'চলতি হিসাব')).toContainText('50,000.00');
    await expect(accountRow(page, 'ডিপিএস হিসাব')).toContainText('0.00');

    // Ticked all the same, and honest about which kind of tick it was.
    await page.goto('/savings');
    await openPlan(page, 'সিটি ডিপিএস');
    await expect(page.getByRole('dialog').getByText('জমা হয়েছে').first()).toBeVisible();
  });
});

/**
 * Profit that has built up, against profit that has arrived.
 *
 * A **DPS pays nothing at all before maturity** — principal and profit come
 * together at the end. A button offering to record "profit received" on a
 * running DPS is therefore an invitation to file income that has neither been
 * earned nor received, and the tax worksheet reads what gets filed. So the
 * button is not there, and a plainly-labelled accrued figure is.
 *
 * A **Sanchayapatra** is the opposite case and keeps the button, because it
 * really does credit a bank account every month or quarter.
 */
test.describe('accrued profit is not received profit', () => {
  test('a running DPS shows what has built up and offers no way to book it', async ({ page }) => {
    await signup(page);
    await addAccount(page, 'চলতি হিসাব', 'ব্যাংক', '50000');
    await addPlan(page, 'চলমান ডিপিএস');

    await openPlan(page, 'চলমান ডিপিএস');
    const detail = page.getByRole('dialog');

    // Said as what it is: built up, not in hand.
    await expect(detail.getByText('এ পর্যন্ত জমেছে')).toBeVisible();
    await expect(detail.getByText('হাতে আসেনি', { exact: false })).toBeVisible();

    /* And there is no button. This is the assertion the correction exists for:
       the figure above is a number to look at, never a number to file. */
    await expect(detail.getByRole('button', { name: 'মুনাফা পেয়েছি' })).toHaveCount(0);

    // Bringing the money home at maturity is still offered, as it must be.
    await expect(detail.getByRole('button', { name: 'মেয়াদপূর্তি' })).toBeVisible();
  });

  test('a Sanchayapatra keeps the button, because it really does pay out', async ({ page }) => {
    await signup(page);
    await addAccount(page, 'চলতি হিসাব', 'ব্যাংক', '50000');
    await addPlan(page, 'পরিবার সঞ্চয়পত্র', undefined, 'সঞ্চয়পত্র');

    await openPlan(page, 'পরিবার সঞ্চয়পত্র');
    const detail = page.getByRole('dialog');
    await expect(detail.getByRole('button', { name: 'মুনাফা পেয়েছি' })).toBeVisible();
    /* No accrued line here: a certificate that pays as it goes is described by
       what it has actually handed over, and two figures side by side would
       invite somebody to reconcile numbers that answer different questions. */
    await expect(detail.getByText('এ পর্যন্ত জমেছে')).toHaveCount(0);
    await expect(detail.getByText('এ পর্যন্ত মুনাফা পেয়েছি')).toBeVisible();
  });
});
