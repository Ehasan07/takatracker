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
async function addPlan(
  page: Page,
  name: string,
  linkTo?: string,
  type = 'ডিপিএস',
  sourceFrom?: string,
): Promise<void> {
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
  if (sourceFrom) {
    await sheet.getByLabel('কিস্তির টাকা কোন হিসাব থেকে যায়').selectOption({ label: sourceFrom });
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

    /* Named, not `getByRole('dialog')`. Closing this sheet deliberately
       reopens the plan behind it — so *a* dialog is always on screen
       afterwards, and a generic locator can never go hidden. */
    const sheet = page.getByRole('dialog').filter({ hasText: 'কিস্তি জমা দিলাম' });
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

  /**
   * The account an instalment comes *out* of, remembered.
   *
   * The deposit dialog used to default to the first bank account, which is
   * wrong for anybody paying a DPS from bKash — and wrong again every month for
   * five years. Two accounts here, and the bank is the one the old guess would
   * have picked, so a passing test means the plan's own answer beat it.
   */
  test('a plan remembers which account the instalment comes out of', async ({ page }) => {
    await signup(page);
    await addAccount(page, 'বেতন হিসাব', 'ব্যাংক', '50000');
    await addAccount(page, 'বিকাশ', 'মোবাইল ওয়ালেট', '30000');
    await addAccount(page, 'ইসলামী ডিপিএস', 'সঞ্চয় / ডিপিএস');
    await addPlan(page, 'বিকাশ ডিপিএস', 'ইসলামী ডিপিএস', 'ডিপিএস', 'বিকাশ');

    await openPlan(page, 'বিকাশ ডিপিএস');
    await page.getByRole('dialog').getByRole('button', { name: 'জমা দিলাম' }).first().click();
    const sheet = page.getByRole('dialog').filter({ hasText: 'কিস্তি জমা দিলাম' });

    // Not the bank, which is what it would have guessed.
    await expect(sheet.getByLabel('কোন অ্যাকাউন্ট থেকে গেল').locator('option:checked')).toHaveText(
      'বিকাশ',
    );

    await sheet.getByRole('button', { name: 'জমা দিন ও টাকা সরান' }).click();
    await expect(sheet).toBeHidden({ timeout: 15_000 });

    await page.goto('/accounts');
    await expect(accountRow(page, 'বিকাশ')).toContainText('28,000.00');
    // Untouched: the guess would have taken it from here.
    await expect(accountRow(page, 'বেতন হিসাব')).toContainText('50,000.00');
  });

  /* Half a transfer is not a thing to ask about: with nowhere for the money to
     go, "where does it come from" has no answer worth storing. */
  test('the source field waits until there is somewhere for the money to go', async ({ page }) => {
    await signup(page);
    await addAccount(page, 'সঞ্চয় হিসাব', 'সঞ্চয় / ডিপিএস');
    await page.goto('/savings');
    await page.getByRole('main').getByRole('button', { name: 'নতুন', exact: true }).click();
    const sheet = page.getByRole('dialog');
    await expect(sheet.getByLabel('কিস্তির টাকা কোন হিসাবে জমা হয়')).toBeVisible();
    await expect(sheet.getByLabel('কিস্তির টাকা কোন হিসাব থেকে যায়')).toBeHidden();

    await sheet
      .getByLabel('কিস্তির টাকা কোন হিসাবে জমা হয়')
      .selectOption({ label: 'সঞ্চয় হিসাব' });
    await expect(sheet.getByLabel('কিস্তির টাকা কোন হিসাব থেকে যায়')).toBeVisible();
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

    // Named for the same reason as above: the plan reopens behind this one.
    const sheet = page.getByRole('dialog').filter({ hasText: 'কিস্তি জমা দিলাম' });
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
 * Accrued profit sits beside received profit, and neither is the other.
 *
 * The accrued figure is arithmetic at the stated rate — an estimate of what
 * should have built up. The received figure is what the bank actually handed
 * over, after it deducted source tax. They answer different questions and are
 * never the same number.
 *
 * The button to record a payout is offered on **every** plan, and that is the
 * correction this describes. In Bangladesh a DPS and a সঞ্চয়পত্র are both
 * routinely opened against a bank account, and the profit on both is commonly
 * credited to that account as it accrues; some DPS products hold it to
 * maturity instead. Only the passbook knows which, so the app does not guess.
 * The safeguard is the empty box, asserted below.
 */
test.describe('accrued profit is not received profit', () => {
  test('a running DPS shows what has built up and still lets a payout be recorded', async ({
    page,
  }) => {
    await signup(page);
    await addAccount(page, 'চলতি হিসাব', 'ব্যাংক', '50000');
    await addPlan(page, 'চলমান ডিপিএস');

    await openPlan(page, 'চলমান ডিপিএস');
    const detail = page.getByRole('dialog');

    // What the rate says should have built up — an estimate, plainly labelled.
    await expect(detail.getByText('এ পর্যন্ত জমেছে')).toBeVisible();
    await expect(detail.getByText('আনুমানিক', { exact: false })).toBeVisible();

    /* Offered here too. A bank crediting a DPS every month is the common case,
       and hiding this hid it from exactly those people. */
    await expect(detail.getByRole('button', { name: 'মুনাফা পেয়েছি' })).toBeVisible();

    // Bringing the money home at maturity is still offered, as it must be.
    await expect(detail.getByRole('button', { name: 'মেয়াদপূর্তি' })).toBeVisible();
  });

  test('the amount box opens empty, whatever the instrument', async ({ page }) => {
    /* The whole safeguard, now that there is no gate. A figure sitting in a box
       labelled "কত টাকা পেলেন" reads as a claim that it arrived — and on
       anything short of maturity nobody has been paid it. */
    await signup(page);
    await addAccount(page, 'চলতি হিসাব', 'ব্যাংক', '50000');
    await addPlan(page, 'চলমান ডিপিএস');

    await openPlan(page, 'চলমান ডিপিএস');
    await page.getByRole('dialog').getByRole('button', { name: 'মুনাফা পেয়েছি' }).click();
    const sheet = page.getByRole('dialog', { name: 'মুনাফা পেয়েছি' });
    await expect(sheet.getByLabel('কত টাকা পেলেন (৳)')).toHaveValue('');
  });

  test('a Sanchayapatra keeps the button too', async ({ page }) => {
    await signup(page);
    await addAccount(page, 'চলতি হিসাব', 'ব্যাংক', '50000');
    await addPlan(page, 'পরিবার সঞ্চয়পত্র', undefined, 'সঞ্চয়পত্র');

    await openPlan(page, 'পরিবার সঞ্চয়পত্র');
    const detail = page.getByRole('dialog');
    await expect(detail.getByRole('button', { name: 'মুনাফা পেয়েছি' })).toBeVisible();
    await expect(detail.getByText('এ পর্যন্ত মুনাফা পেয়েছি')).toBeVisible();
  });
});

/**
 * Paying a loan back from the + sheet.
 *
 * The tab that was missing is the one used most: a loan is made once and repaid
 * in pieces. Without it somebody recording a ৳2,000 repayment reaches for "ধার
 * দিয়েছি" — the only ধার tab there was — and books a *second* loan, leaving
 * ৳7,000 outstanding where ৳3,000 is. Both numbers look right on their own.
 */
test.describe('paying a loan back from the entry sheet', () => {
  test('records the instalment against the loan, not as a new one', async ({ page }) => {
    await signup(page);
    await addAccount(page, 'হাতের নগদ', 'নগদ', '50000');

    const openSheet = async () => {
      await page.goto('/transactions');
      await page.getByRole('button', { name: 'নতুন লেনদেন' }).first().click();
      return page.getByRole('dialog');
    };

    // ৳5,000 lent to somebody.
    let sheet = await openSheet();
    await sheet.getByRole('tab', { name: 'ধার দিয়েছি' }).click();
    await sheet.locator('#qa-amount').fill('5000');
    await sheet.getByLabel('কোন অ্যাকাউন্ট থেকে দিলেন').selectOption({ label: 'হাতের নগদ' });
    await sheet.getByLabel('কাকে ধার দিয়েছেন').fill('করিম');
    await sheet.getByRole('button', { name: /সংরক্ষণ/ }).click();
    await expect(sheet).toBeHidden({ timeout: 15_000 });

    // ৳2,000 of it back.
    sheet = await openSheet();
    await sheet.getByRole('tab', { name: 'ধার ফেরত' }).click();
    await sheet.locator('#qa-amount').fill('2000');
    /* The option carries what is still owed, which is the number somebody
       checks against the money in their hand. */
    await sheet.getByLabel('কোন ধারের ফেরত').selectOption({ index: 1 });
    await expect(sheet.getByLabel('কোন ধারের ফেরত')).not.toHaveValue('');
    await sheet.getByRole('button', { name: /সংরক্ষণ/ }).click();
    await expect(sheet).toBeHidden({ timeout: 15_000 });

    // ৳3,000 left, not ৳7,000 — and the cash is back where it came from.
    await page.goto('/loans');
    await expect(page.getByText('3,000.00').first()).toBeVisible({ timeout: 15_000 });
    await page.goto('/accounts');
    await expect(accountRow(page, 'হাতের নগদ')).toContainText('47,000.00');
  });

  /**
   * The other direction, which is where a sign error would hide.
   *
   * Repaying money you borrowed moves the cash the opposite way and reduces a
   * liability rather than an asset. Both halves look right in isolation — the
   * loan goes down either way — so the account balance is what actually decides
   * it: ৳2,000 must *leave*, not arrive.
   */
  test('a borrowed loan repays in the other direction', async ({ page }) => {
    await signup(page);
    await addAccount(page, 'হাতের নগদ', 'নগদ', '50000');

    const openSheet = async () => {
      await page.goto('/transactions');
      await page.getByRole('button', { name: 'নতুন লেনদেন' }).first().click();
      return page.getByRole('dialog');
    };

    let sheet = await openSheet();
    await sheet.getByRole('tab', { name: 'ধার নিয়েছি' }).click();
    await sheet.locator('#qa-amount').fill('5000');
    await sheet.getByLabel('কোন অ্যাকাউন্টে এল').selectOption({ label: 'হাতের নগদ' });
    await sheet.getByLabel('কার কাছ থেকে ধার নিয়েছেন').fill('রহিম');
    await sheet.getByRole('button', { name: /সংরক্ষণ/ }).click();
    await expect(sheet).toBeHidden({ timeout: 15_000 });

    // Borrowed: the cash arrived.
    await page.goto('/accounts');
    await expect(accountRow(page, 'হাতের নগদ')).toContainText('55,000.00');

    sheet = await openSheet();
    await sheet.getByRole('tab', { name: 'ধার ফেরত' }).click();
    await sheet.locator('#qa-amount').fill('2000');
    await sheet.getByLabel('কোন ধারের ফেরত').selectOption({ index: 1 });
    // The picker says which way this one goes, so nobody has to work it out.
    await expect(sheet.getByText('আপনার হিসাব থেকে যাবে', { exact: false })).toBeVisible();
    await sheet.getByRole('button', { name: /সংরক্ষণ/ }).click();
    await expect(sheet).toBeHidden({ timeout: 15_000 });

    // ৳2,000 left the account, and ৳3,000 is still owed.
    await page.goto('/accounts');
    await expect(accountRow(page, 'হাতের নগদ')).toContainText('53,000.00');
    await page.goto('/loans');
    await expect(page.getByText('3,000.00').first()).toBeVisible({ timeout: 15_000 });
  });
});
