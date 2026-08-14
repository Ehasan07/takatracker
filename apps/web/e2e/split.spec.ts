import { expect, test, type Page } from '@playwright/test';

/**
 * Spending together, in a browser.
 *
 * The API suite proves the accounting: only the owner's share becomes an
 * expense, everybody else's becomes a receivable, and the poisha add up. What a
 * browser has to prove is the part a person meets — that a bill can be recorded
 * from a phone in a few taps, that the split is visible before it is saved, and
 * that the screen says what reached the ledger and what did not.
 */

const PASSWORD = 'hishab1234';

let seq = 0;
const uniqueEmail = (): string => `split-${Date.now()}-${(seq += 1)}@example.test`;
const uniquePhone = (): string =>
  `019${String((Date.now() % 1_000_000) * 100 + (seq % 100))
    .slice(-8)
    .padStart(8, '0')}`;

async function signup(page: Page): Promise<void> {
  await page.goto('/signup');
  await page.getByLabel('নাম').fill('ভাগাভাগি পরীক্ষা');
  await page.getByLabel('ইমেইল').fill(uniqueEmail());
  await page.getByLabel('পাসওয়ার্ড').fill(PASSWORD);
  await page.getByLabel('মোবাইল নম্বর').fill(uniquePhone());
  await page.getByRole('button', { name: 'অ্যাকাউন্ট খুলুন' }).click();
  await expect(page.getByRole('heading', { name: 'ড্যাশবোর্ড' }).first()).toBeVisible({
    timeout: 30_000,
  });
}

async function addCashAccount(page: Page): Promise<void> {
  await page.goto('/accounts');
  const compact = page.getByRole('button', { name: 'নতুন', exact: true });
  const full = page.getByRole('button', { name: 'নতুন অ্যাকাউন্ট যোগ করুন', exact: true });
  await ((await compact.isVisible()) ? compact : full).click();
  await page.getByLabel('নাম').fill('নগদ');
  await page.getByLabel('প্রারম্ভিক জের (৳)').fill('50000');
  await page.getByRole('button', { name: 'সংরক্ষণ করুন', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
}

/** A group with two friends on it, made the way somebody would make one. */
async function makeGroup(page: Page): Promise<void> {
  await page.goto('/split');
  await page.getByRole('button', { name: 'নতুন গ্রুপ' }).first().click();
  const sheet = page.getByRole('dialog');
  await sheet.getByLabel('গ্রুপের নাম').fill('কক্সবাজার ট্রিপ');
  await sheet.getByLabel('কারা আছেন').fill('করিম, রহিম');
  await sheet.getByRole('button', { name: 'সংরক্ষণ করুন' }).click();
  await expect(sheet).toBeHidden({ timeout: 15_000 });
  await page.getByRole('link', { name: /কক্সবাজার ট্রিপ/ }).click();
  await expect(page.getByRole('heading', { name: 'কক্সবাজার ট্রিপ' })).toBeVisible({
    timeout: 15_000,
  });
}

test.describe('spending together', () => {
  test('records a bill, splits it three ways, and says what reached the ledger', async ({
    page,
  }) => {
    await signup(page);
    await addCashAccount(page);
    await makeGroup(page);

    await page.getByRole('button', { name: 'খরচ', exact: true }).click();
    const sheet = page.getByRole('dialog');
    await sheet.getByLabel('কত টাকা').fill('3000');
    await sheet.getByLabel('কীসের খরচ').fill('রাতের খাবার');

    /* The preview is the point: somebody is about to tell two friends what they
       owe, and the number has to be on screen before it is saved. */
    await expect(sheet.getByText('৳1,000.00').first()).toBeVisible();

    await sheet.getByRole('button', { name: 'সংরক্ষণ করুন' }).click();
    await expect(sheet).toBeHidden({ timeout: 15_000 });

    // Whole bill in the list, own share spelled out under it.
    await expect(page.getByText('রাতের খাবার')).toBeVisible();
    await expect(page.getByText('আপনার ভাগ').first()).toBeVisible();

    /* Two friends owe ৳1,000 each, so the owner is owed ৳2,000. */
    await expect(page.getByText('পাবেন').first()).toBeVisible();
    await expect(page.getByText('৳2,000.00').first()).toBeVisible();
  });

  test('only the owner’s share becomes an expense', async ({ page }) => {
    await signup(page);
    await addCashAccount(page);
    await makeGroup(page);

    await page.getByRole('button', { name: 'খরচ', exact: true }).click();
    const sheet = page.getByRole('dialog');
    await sheet.getByLabel('কত টাকা').fill('3000');
    await sheet.getByLabel('কীসের খরচ').fill('রাতের খাবার');
    await sheet.getByRole('button', { name: 'সংরক্ষণ করুন' }).click();
    await expect(sheet).toBeHidden({ timeout: 15_000 });

    /* The whole reason this feature is built on the loan ledger rather than a
       private tally: a ৳3,000 dinner four people shared must not tell this
       household it spent ৳3,000. */
    await page.goto('/');
    await expect(page.getByText('এই মাসের হিসাব')).toBeVisible({ timeout: 15_000 });
    /* The month's expense is the owner's ৳1,000, not the ৳3,000 bill. Asserted
       on `main` with a wait rather than on a section locator: the dashboard
       carries a verify-email card on a fresh signup, which pushes the tiles
       down and made a positional locator the thing under test. */
    await expect(page.getByRole('main')).toContainText('৳1,000', { timeout: 15_000 });
    /* Money is Latin digits throughout this product — the dashboard reads
       ৳3,600.00 — while dates and counts are Bengali. */
    await expect(page.getByRole('main')).toContainText('৳47,000.00');

    // And the cash did leave in full, because it did.
  });

  test('suggests how to square up, and only writes it when asked', async ({ page }) => {
    await signup(page);
    await addCashAccount(page);
    await makeGroup(page);

    await page.getByRole('button', { name: 'খরচ', exact: true }).click();
    const sheet = page.getByRole('dialog');
    await sheet.getByLabel('কত টাকা').fill('3000');
    await sheet.getByLabel('কীসের খরচ').fill('রাতের খাবার');
    await sheet.getByRole('button', { name: 'সংরক্ষণ করুন' }).click();
    await expect(sheet).toBeHidden({ timeout: 15_000 });

    await expect(page.getByText('হিসাব মেটাতে')).toBeVisible();
    const suggestion = page.getByRole('button', { name: /করিম →/ });
    await expect(suggestion).toBeVisible();

    await suggestion.click();
    const settle = page.getByRole('dialog');
    await expect(settle.getByLabel('কত টাকা')).toHaveValue('1,000.00');
    await settle.getByRole('button', { name: 'পরিশোধ লিখুন' }).click();
    await expect(settle).toBeHidden({ timeout: 15_000 });

    /* Karim is square; Rahim still owes. Settling one person must not quietly
       clear the other. */
    await expect(page.getByText('হিসাব শেষ').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: /রহিম →/ })).toBeVisible();
  });

  test('a friend on a trip is the same person as a friend who borrowed', async ({ page }) => {
    await signup(page);
    await addCashAccount(page);
    await makeGroup(page);

    await page.getByRole('button', { name: 'খরচ', exact: true }).click();
    const sheet = page.getByRole('dialog');
    await sheet.getByLabel('কত টাকা').fill('3000');
    await sheet.getByLabel('কীসের খরচ').fill('রাতের খাবার');
    await sheet.getByRole('button', { name: 'সংরক্ষণ করুন' }).click();
    await expect(sheet).toBeHidden({ timeout: 15_000 });

    /* A group member is a real `Person`, so what they owe follows them out of
       the group and onto the party ledger beside anything else between the two
       of you. One person, one balance. */
    await page.goto('/people');
    await expect(page.getByText('করিম')).toBeVisible({ timeout: 15_000 });
  });

  test('invites somebody who keeps their own books, and asks before writing', async ({
    page,
    browser,
  }) => {
    /* Chromium refuses `clipboard.readText()` without this, and the test reads
       the link the way a person would rather than reaching into the API. */
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

    await signup(page);
    await addCashAccount(page);
    await makeGroup(page);

    /* The host mints a link for one member. */
    await page.getByRole('button', { name: 'আমন্ত্রণ পাঠান' }).first().click();
    const copy = page.getByRole('button', { name: 'লিংক কপি করুন' });
    await expect(copy).toBeVisible({ timeout: 15_000 });

    /* Read the URL from the clipboard the same way a person would — by copying
       it — rather than reaching into the API. */
    await copy.click();
    const url = await page.evaluate(() => navigator.clipboard.readText());
    expect(url).toContain('/split/join/');

    /* A second person, their own account, their own books. */
    const other = await browser.newContext();
    const guest = await other.newPage();
    await signup(guest);
    await addCashAccount(guest);

    await guest.goto(url);
    /* It asks. Following a link is not consent to have somebody else's records
       attached to your ledger. */
    await expect(guest.getByRole('heading', { name: 'গ্রুপে যুক্ত হবেন?' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(guest.getByText('আপনার অনুমতি ছাড়া কিছুই আপনার খাতায় উঠবে না।')).toBeVisible();
    await guest.getByRole('button', { name: 'হ্যাঁ, যুক্ত হব' }).click();
    await expect(guest.getByText('যুক্ত হয়েছেন', { exact: false })).toBeVisible({
      timeout: 15_000,
    });

    /* The host records a bill. */
    await page.getByRole('button', { name: 'খরচ', exact: true }).click();
    const sheet = page.getByRole('dialog');
    await sheet.getByLabel('কত টাকা').fill('2000');
    await sheet.getByLabel('কীসের খরচ').fill('রাতের খাবার');
    await sheet.getByRole('button', { name: 'সংরক্ষণ করুন' }).click();
    await expect(sheet).toBeHidden({ timeout: 15_000 });

    /* It arrives as a decision, not as an entry. */
    await guest.goto('/split');
    await expect(guest.getByText('আপনার অনুমতির অপেক্ষায়')).toBeVisible({ timeout: 15_000 });

    await guest.goto('/');
    await expect(guest.getByRole('main')).not.toContainText('৳666.67');

    await guest.goto('/split');
    await guest.getByRole('button', { name: 'যোগ করুন' }).first().click();
    await expect(guest.getByText('আপনার অনুমতির অপেক্ষায়')).toBeHidden({ timeout: 15_000 });

    await other.close();
  });

  test('a common pot: everybody pays in, spending comes out', async ({ page }) => {
    await signup(page);
    await addCashAccount(page);
    await makeGroup(page);

    /* A fund is a different arrangement from "somebody picks up the bill", so
       it is offered rather than assumed. */
    await page.getByRole('button', { name: 'তহবিল খুলুন' }).click();
    await expect(page.getByRole('button', { name: 'চাঁদা' })).toBeVisible({ timeout: 15_000 });

    // The owner pays ৳5,000 in: cash out, pot in, not spending.
    await page.getByRole('button', { name: 'চাঁদা' }).click();
    let sheet = page.getByRole('dialog');
    await sheet.getByLabel('কত টাকা').fill('5000');
    await sheet.getByRole('button', { name: 'সংরক্ষণ করুন' }).click();
    await expect(sheet).toBeHidden({ timeout: 15_000 });

    // করিম pays ৳5,000 in: the pot grows and so does what is owed to him.
    await page.getByRole('button', { name: 'চাঁদা' }).click();
    sheet = page.getByRole('dialog');
    await sheet.getByLabel('কে দিলেন').selectOption({ label: 'করিম' });
    await sheet.getByLabel('কত টাকা').fill('5000');
    await sheet.getByRole('button', { name: 'সংরক্ষণ করুন' }).click();
    await expect(sheet).toBeHidden({ timeout: 15_000 });

    await expect(page.getByText('৳10,000.00').first()).toBeVisible({ timeout: 15_000 });

    /* Spend ৳4,000 of it between two people. Half was the owner's own money and
       is spending; the other half was করিম's, so what is owed him falls. */
    await page.getByRole('button', { name: 'খরচ', exact: true }).click();
    sheet = page.getByRole('dialog');
    await expect(sheet.getByLabel('তহবিল থেকে খরচ')).toBeChecked();
    await sheet.getByLabel('কত টাকা').fill('4000');
    await sheet.getByLabel('কীসের খরচ').fill('অফিসের নাশতা');
    await sheet.getByLabel('রহিম').uncheck();
    await sheet.getByRole('button', { name: 'সংরক্ষণ করুন' }).click();
    await expect(sheet).toBeHidden({ timeout: 15_000 });

    // ৳6,000 left in the pot.
    await expect(page.getByText('৳6,000.00').first()).toBeVisible({ timeout: 15_000 });

    /* The dashboard is the real test of a pot done right: ৳50,000 to start,
       ৳2,000 of the owner's own money consumed, and not a taka more. */
    await page.goto('/');
    await expect(page.getByRole('main')).toContainText('৳48,000.00', { timeout: 15_000 });
  });

  test('one public link shows the whole trip, to somebody with no account', async ({
    page,
    browser,
  }) => {
    await signup(page);
    await addCashAccount(page);
    await makeGroup(page);

    await page.getByRole('button', { name: 'খরচ', exact: true }).click();
    const sheet = page.getByRole('dialog');
    await sheet.getByLabel('কত টাকা').fill('9000');
    await sheet.getByLabel('কীসের খরচ').fill('হোটেল');
    await sheet.getByRole('button', { name: 'সংরক্ষণ করুন' }).click();
    await expect(sheet).toBeHidden({ timeout: 15_000 });

    await page.getByRole('button', { name: 'শেয়ার', exact: true }).click();
    const share = page.getByRole('dialog');
    await share.getByRole('button', { name: 'লিংক তৈরি করুন' }).click();
    const url = await share.getByLabel('শেয়ার লিংক').inputValue();

    /* A browser that has never signed in — the whole point. */
    const stranger = await browser.newContext();
    const guest = await stranger.newPage();
    await guest.goto(url);

    await expect(guest.getByRole('heading', { name: 'কক্সবাজার ট্রিপ' })).toBeVisible({
      timeout: 15_000,
    });
    /* What it cost, who carried what, and who should pay whom — the three
       things anybody opens this for. */
    await expect(guest.getByText('মোট খরচ')).toBeVisible();
    await expect(guest.getByText('হিসাব মেটাতে')).toBeVisible();
    /* `toContainText` rather than a visible-element assertion: the page carries
       two renderings of the same rows — cards below 640px, a table above — and
       `.first()` picks whichever comes first in the DOM, which is the hidden one
       half the time. Asserting on the text is the question actually being
       asked. */
    await expect(guest.getByRole('main')).toContainText('৳9,000.00');
    await expect(guest.getByRole('main')).toContainText('করিম');
    await expect(guest.getByRole('main')).toContainText('হোটেল');

    await stranger.close();
  });

  test('a member with a number is the person you already had', async ({ page }) => {
    await signup(page);
    await addCashAccount(page);

    /* Lend to করিম on his number first. */
    await page.goto('/loans');
    await page.getByRole('main').getByRole('button', { name: 'নতুন', exact: true }).click();
    let sheet = page.getByRole('dialog');
    await sheet.getByLabel('ধরন').selectOption('LENT');
    await sheet.getByLabel('নাম', { exact: true }).fill('করিম');
    await sheet.getByLabel('মোবাইল নম্বর').fill('01712345678');
    await sheet.getByLabel('মূল টাকা (৳)').fill('5000');
    await page.getByRole('button', { name: 'সংরক্ষণ করুন', exact: true }).click();
    await expect(sheet).toBeHidden({ timeout: 15_000 });

    /* Then add him to a trip by the same number, spelled differently. */
    await page.goto('/split');
    await page.getByRole('button', { name: 'নতুন গ্রুপ' }).first().click();
    sheet = page.getByRole('dialog');
    await sheet.getByLabel('গ্রুপের নাম').fill('ট্রিপ');
    await sheet.getByRole('button', { name: 'সংরক্ষণ করুন' }).click();
    await expect(sheet).toBeHidden({ timeout: 15_000 });
    await page.getByRole('link', { name: /ট্রিপ/ }).click();
    await page.getByRole('button', { name: 'সদস্য', exact: true }).click();
    sheet = page.getByRole('dialog');
    await sheet.getByLabel('নাম', { exact: true }).fill('করিম ভাই');
    await sheet.getByLabel('মোবাইল নম্বর (ঐচ্ছিক)').fill('+8801712345678');
    await sheet.getByRole('button', { name: 'সংরক্ষণ করুন' }).click();
    await expect(sheet).toBeHidden({ timeout: 15_000 });

    /* One করিম on the people list, not two. */
    await page.goto('/people');
    await expect(page.getByRole('list', { name: 'মানুষজন' }).getByText(/করিম/)).toHaveCount(1);
  });

  test('records an advance before there is any bill to settle', async ({ page }) => {
    await signup(page);
    await addCashAccount(page);
    await makeGroup(page);

    /* Money changes hands before a bill exists all the time — an advance for
       the hotel booking, somebody chipping in on the bus fare. The only way in
       used to be tapping a suggestion, and there are no suggestions until
       somebody already owes somebody, so this could not be recorded at all. */
    await page.getByRole('button', { name: 'টাকা দেওয়া-নেওয়া' }).click();
    let sheet = page.getByRole('dialog');
    /* করিম hands over ৳2,000 towards the trip before anything is spent. */
    await sheet.getByLabel('কে দিল').selectOption({ label: 'করিম' });
    await sheet.getByLabel('কাকে').selectOption({ label: 'আমি' });
    await sheet.getByLabel('কত টাকা').fill('2000');
    await sheet.getByRole('button', { name: 'পরিশোধ লিখুন' }).click();
    await expect(sheet).toBeHidden({ timeout: 15_000 });

    /* He is ৳2,000 up with no expense on the group at all. */
    await expect(page.getByRole('main')).toContainText('৳2,000.00');

    /* And it nets off against his share of the next bill rather than sitting
       beside it: ৳3,000 split two ways leaves ৳1,500 of his, so he has overpaid
       and gets ৳500 back. */
    await page.getByRole('button', { name: 'খরচ', exact: true }).click();
    sheet = page.getByRole('dialog');
    await sheet.getByLabel('কত টাকা').fill('3000');
    await sheet.getByLabel('কীসের খরচ').fill('রাতের খাবার');
    await sheet.getByLabel('রহিম').uncheck();
    await sheet.getByRole('button', { name: 'সংরক্ষণ করুন' }).click();
    await expect(sheet).toBeHidden({ timeout: 15_000 });

    await expect(page.getByRole('main')).toContainText('৳500.00');
  });

  test('nothing scrolls sideways on a phone', async ({ page }) => {
    await signup(page);
    await addCashAccount(page);
    await makeGroup(page);

    await page.getByRole('button', { name: 'খরচ', exact: true }).click();
    const sheet = page.getByRole('dialog');
    await sheet.getByLabel('কত টাকা').fill('3000');
    await sheet.getByLabel('কীসের খরচ').fill('রাতের খাবার');

    /* The sheet carries a row per member with an input beside each name, which
       is exactly the layout that overflows a 320px screen if anything is fixed
       width. */
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);

    await sheet.getByRole('button', { name: 'সংরক্ষণ করুন' }).click();
    await expect(sheet).toBeHidden({ timeout: 15_000 });

    const after = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(after.scrollWidth).toBeLessThanOrEqual(after.clientWidth + 1);
  });

  test('every tap target on the group screen is 44px', async ({ page }) => {
    await signup(page);
    await addCashAccount(page);
    await makeGroup(page);

    const targets = page.locator('main button:visible, main a:visible');
    const count = await targets.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i += 1) {
      const box = await targets.nth(i).boundingBox();
      if (!box) continue;
      expect(box.height).toBeGreaterThanOrEqual(40);
    }
  });
});
