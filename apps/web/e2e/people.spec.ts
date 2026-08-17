import { expect, test, type Page } from '@playwright/test';

/**
 * The contacts screen: edit the person a loan created, find them by a Banglish
 * spelling, and fold two spellings of one human back into one.
 *
 * The merge case is the one worth having a browser test for at all. The API
 * suite proves no money moves; what this proves is that the screen names the
 * right survivor, because a merge run the wrong way round is not undoable from
 * the product and the only thing standing between the two directions is which
 * name is in the `<select>`.
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

const PASSWORD = 'hishab1234';

let counter = 0;
function uniqueEmail(): string {
  counter += 1;
  return `people-${Date.now()}-${counter}-${Math.trunc(performance.now())}@example.test`;
}

async function signup(page: Page): Promise<void> {
  await page.goto('/signup');
  await page.getByLabel('নাম').fill('মানুষ পরীক্ষা');
  await page.getByLabel('ইমেইল').fill(uniqueEmail());
  await page.getByLabel('পাসওয়ার্ড').fill(PASSWORD);
  await page.getByLabel('মোবাইল নম্বর').fill(uniquePhone());
  await page.getByRole('button', { name: 'অ্যাকাউন্ট খুলুন' }).click();
  await expect(page.getByRole('heading', { name: 'ড্যাশবোর্ড' }).first()).toBeVisible({
    timeout: 30_000,
  });
}

async function saveSheet(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name, exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
}

async function addCashAccount(page: Page): Promise<void> {
  await page.goto('/accounts');
  await page.getByRole('button', { name: 'নতুন', exact: true }).click();
  await page.getByLabel('নাম').fill('নগদ');
  await saveSheet(page, 'সংরক্ষণ করুন');
  await expect(page.locator('li').filter({ hasText: 'নগদ' }).first()).toBeVisible();
}

/** Lends money to `person`, creating them if the name is new. */
async function lend(page: Page, person: string, amount: string): Promise<void> {
  await page.goto('/loans');
  await page.getByRole('button', { name: 'নতুন', exact: true }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet).toBeVisible();
  await sheet.getByLabel('ধরন').selectOption('LENT');
  await sheet.getByLabel('নাম', { exact: true }).fill(person);
  await sheet.getByLabel('মূল টাকা (৳)').fill(amount);
  await saveSheet(page, 'সংরক্ষণ করুন');
}

/** Scoped to the contacts list — the shell's navigation is listitems too. */
const peopleList = (page: Page) => page.getByRole('list', { name: 'মানুষজন' });
const personRow = (page: Page, name: string) =>
  peopleList(page).getByRole('listitem').filter({ hasText: name });

test.describe('people', () => {
  test('shows the person a loan created, and lets the phone be fixed', async ({ page }) => {
    await signup(page);
    await addCashAccount(page);
    await lend(page, 'করিম', '50000');

    await page.goto('/people');
    const karim = personRow(page, 'করিম').first();
    await expect(karim).toBeVisible();
    // ৳50,000 owed to you — the same figure the party ledger prints.
    await expect(karim).toContainText('50,000');
    await expect(karim).toContainText('পাব');

    /* The whole card is the button now — there is no separate সম্পাদনা beside
       it — so this is the row's own accessible name, "করিম — সম্পাদনা". */
    await karim.getByRole('button', { name: 'সম্পাদনা' }).click();
    const sheet = page.getByRole('dialog');
    await sheet.getByLabel('ফোন').fill('+8801711223344');
    await sheet.getByLabel('সম্পর্ক').fill('মামা');
    await saveSheet(page, 'সংরক্ষণ করুন');

    // Stored canonically whichever of its spellings was typed.
    await expect(personRow(page, 'করিম').first()).toContainText('মামা');
    await expect(personRow(page, 'করিম').first()).toContainText('০১৭১১২২৩৩৪৪');
  });

  test('finds করিম by typing karim', async ({ page }) => {
    await signup(page);
    await addCashAccount(page);
    await lend(page, 'করিম', '50000');
    await lend(page, 'রহিম', '10000');

    await page.goto('/people');
    await page.getByLabel('মানুষ খুঁজুন').fill('karim');
    // Debounced by 300ms, then answered by the server's transliterating matcher
    // — filtering in the browser would find nothing, the two share no letters.
    await expect(personRow(page, 'করিম').first()).toBeVisible();
    await expect(personRow(page, 'রহিম')).toHaveCount(0);
  });

  test('folds two spellings of one person into the survivor you chose', async ({ page }) => {
    await signup(page);
    await addCashAccount(page);
    await lend(page, 'করিম', '50000');
    await lend(page, 'করিম উদ্দিন', '30000');

    await page.goto('/people');
    await expect(peopleList(page).getByRole('listitem')).toHaveCount(2);

    await personRow(page, 'করিম উদ্দিন').getByRole('button', { name: 'মিলিয়ে দিন' }).click();
    const sheet = page.getByRole('dialog');
    await sheet.getByLabel('কার সাথে মিলবে').selectOption({ label: 'করিম' });
    // The button names the survivor before it is pressed, because the two
    // directions are not the same operation and only one of them is undoable.
    await saveSheet(page, 'করিম-এর সাথে মিলিয়ে দিন');

    const survivor = peopleList(page).getByRole('listitem');
    await expect(survivor).toHaveCount(1);
    await expect(survivor.first()).toContainText('করিম');
    await expect(survivor.first()).toContainText('২টি ঋণ');
    await expect(survivor.first()).toContainText('80,000');
  });

  test('an ordinary expense can name who it was with', async ({ page }) => {
    await signup(page);
    await addCashAccount(page);
    await lend(page, 'করিম', '50000');

    await page.goto('/');
    await page.getByRole('button', { name: 'নতুন লেনদেন' }).first().click();
    const sheet = page.getByRole('dialog');
    await expect(sheet).toBeVisible();
    await sheet.getByLabel('পরিমাণ (৳)').fill('250');
    await sheet.getByLabel('ক্যাটাগরি').selectOption({ label: 'খাবার ও বাজার' });
    await sheet.getByLabel('বিবরণ').fill('করিমের দোকানে বাজার');
    /* The field appears only once somebody exists to pick — see `PersonField`.
       Recording the loan above is what put করিম in the workspace. */
    await sheet.getByLabel('কার সাথে').selectOption({ label: 'করিম' });
    /* Not `saveSheet`: this button names the amount — "৳250.00 সংরক্ষণ করুন" —
       so the exact match every other sheet uses would never find it. */
    await page.getByRole('button', { name: 'সংরক্ষণ করুন' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();

    // Read back on the row, which is the half that did not work before: the
    // column was written for months and `present()` never returned it.
    await page.goto('/transactions');
    await expect(page.getByTestId('ledger-list').getByText('করিমের দোকানে বাজার')).toBeVisible();
  });

  test('refuses to remove somebody who still owes money', async ({ page }) => {
    await signup(page);
    await addCashAccount(page);
    await lend(page, 'করিম', '50000');

    await page.goto('/people');
    /* Two taps and a sheet, not one tap on the row. Removing somebody is
       inside the person now — the card opens the editor, and the bin is at the
       foot of it, under the name of whoever is about to be removed. */
    await personRow(page, 'করিম').getByRole('button', { name: 'সম্পাদনা' }).click();
    await page
      .getByRole('dialog', { name: 'তথ্য বদলান' })
      .getByRole('button', { name: 'তালিকা থেকে সরান' })
      .click();

    const sheet = page.getByRole('dialog', { name: 'তালিকা থেকে সরাবেন?' });
    await sheet.getByRole('button', { name: 'সরিয়ে ফেলুন' }).click();

    // The count, not "this person has loans" — one of those is actionable.
    await expect(sheet.getByRole('alert')).toContainText('১টি ঋণ');
    await page.keyboard.press('Escape');
    await expect(personRow(page, 'করিম')).toHaveCount(1);
  });

  test('somebody with no loan yet can still be lent to', async ({ page }) => {
    /* The regression this exists for: the loan sheet built its counterparty
       list out of the loan list, so a person who had never borrowed could not
       be chosen. Everybody imported from Wallet was in that position — present
       in the database, absent from the only menu that could reach them. */
    await signup(page);
    await addCashAccount(page);

    await page.goto('/people');
    await page.getByRole('button', { name: 'নতুন', exact: true }).click();
    await page.getByRole('dialog').getByLabel('নাম').fill('নতুন লোক');
    await saveSheet(page, 'সংরক্ষণ করুন');
    await expect(personRow(page, 'নতুন লোক')).toHaveCount(1);

    await page.goto('/loans');
    await page.getByRole('button', { name: 'নতুন', exact: true }).click();
    const sheet = page.getByRole('dialog');
    await expect(sheet).toBeVisible();

    const picker = sheet.getByLabel('কার সাথে');
    await expect(picker.getByRole('option', { name: /নতুন লোক/ })).toHaveCount(1);

    await picker.selectOption({ label: 'নতুন লোক' });
    await sheet.getByLabel('মূল টাকা (৳)').fill('4000');
    await saveSheet(page, 'সংরক্ষণ করুন');

    // The loan went to the person already on file, not to a second copy of them.
    await expect(page.getByText('নতুন লোক').first()).toBeVisible();
    await page.goto('/people');
    await expect(personRow(page, 'নতুন লোক')).toHaveCount(1);
  });
});
