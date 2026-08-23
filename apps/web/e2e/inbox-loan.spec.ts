import { expect, test, type Page } from '@playwright/test';

/**
 * ধার, accepted from the inbox — the two ways it stopped working in a browser.
 *
 * The API suite already proves the write: a draft accepted with a
 * `loanDirection` posts through the loans module and comes back as a loan. Both
 * bugs this file exists for were invisible to it, because both were on the
 * screen.
 *
 *   1. `/loans/people` answers `{ filtered, people }`, and the review sheet
 *      read it as a bare array. Opening ধার দিয়েছি ran `.map` over an object,
 *      the throw reached `app/error.tsx`, and the whole page became "কিছু একটা
 *      ভুল হয়েছে" — with the message still sitting unanswered in the queue.
 *   2. Every refusal from the form's own checks rendered at the bottom of a
 *      sheet taller than a phone. Somebody who had not chosen a counterparty
 *      pressed যোগ করে পরেরটি and saw nothing happen: the sentence naming what
 *      was missing was below the fold, under the button they had just pressed.
 *
 * Both are asserted at every width the suite runs, because the second one only
 * exists at the narrow ones.
 */

/** A plain taka debit, the shape the ধার tabs are for: money went out to somebody. */
const DEBIT_SMS =
  'Your A/C (***6948) has been debited BDT 500.00 for Ibanking Fund Transfer - Debit. ' +
  'Avl Bal: BDT 8,43,817.17 @ 12:37 PM. For query: 16419';

let counter = 0;
function uniqueEmail(): string {
  counter += 1;
  return `inbox-loan-${Date.now()}-${counter}-${Math.trunc(performance.now())}@example.test`;
}

/** Unique across accounts, and across four projects sharing one clock. */
let phoneSeq = 0;
function uniquePhone(): string {
  phoneSeq += 1;
  const seed =
    (Date.now() % 1_000_000) * 100 + ((phoneSeq * 13 + Math.trunc(Math.random() * 90)) % 100);
  return `018${String(seed).slice(-8).padStart(8, '0')}`;
}

async function signup(page: Page): Promise<void> {
  await page.goto('/signup');
  await page.getByLabel('নাম').fill('ধার পরীক্ষা');
  await page.getByLabel('ইমেইল').fill(uniqueEmail());
  await page.getByLabel('পাসওয়ার্ড').fill('hishab1234');
  await page.getByLabel('মোবাইল নম্বর').fill(uniquePhone());
  await page.getByRole('button', { name: 'অ্যাকাউন্ট খুলুন' }).click();
  await expect(page.getByRole('heading', { name: 'ড্যাশবোর্ড' }).first()).toBeVisible({
    timeout: 30_000,
  });
}

/** A loan has to come out of an account, and signup seeds only hidden ones. */
async function addCashAccount(page: Page): Promise<void> {
  await page.goto('/accounts');
  await page.getByRole('button', { name: 'নতুন', exact: true }).click();
  await page.getByLabel('নাম').fill('নগদ');
  await page.getByLabel('প্রারম্ভিক জের (৳)').fill('10000');
  await page.getByRole('button', { name: 'সংরক্ষণ করুন' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.locator('li').filter({ hasText: 'নগদ' }).first()).toBeVisible();
}

/** The real webhook, knocked on from inside the page — the door a phone uses. */
async function forward(page: Page, body: string): Promise<void> {
  const status = await page.evaluate(async (message: string) => {
    const config = await fetch('/api/v1/ingestion/webhook-config', {
      credentials: 'same-origin',
    }).then((r) => r.json());

    const res = await fetch('/api/v1/ingestion/webhook', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        [config.workspaceHeader]: config.workspaceId,
        [config.secretHeader]: config.secret,
      },
      body: JSON.stringify({ channel: 'SMS', sender: 'UCB-ALERT', body: message }),
    });
    return res.status;
  }, body);

  expect(status).toBe(200);
}

async function openTheDraft(page: Page): Promise<void> {
  await page.goto('/inbox');
  await page.getByRole('button').filter({ hasText: 'UCB-ALERT' }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

test.describe('a message accepted as ধার', () => {
  test('opens the counterparty picker instead of taking the page down', async ({ page }) => {
    await signup(page);
    await addCashAccount(page);
    await forward(page, DEBIT_SMS);
    await openTheDraft(page);

    const sheet = page.getByRole('dialog');
    await sheet.getByRole('tab', { name: 'ধার দিয়েছি' }).click();

    /* The picker, and the option a workspace with no people yet has to be
       offered — without it the tab is a dead end on the first loan. */
    const person = sheet.locator('#dr-person');
    await expect(person).toBeVisible();
    await expect(person.getByRole('option', { name: 'নতুন নাম লিখি' })).toHaveCount(1);

    // The error boundary, by its own words. Anything here means the throw is back.
    await expect(page.getByText('কিছু একটা ভুল হয়েছে')).toHaveCount(0);
  });

  test('says what is missing where the button that refused it is', async ({ page }) => {
    await signup(page);
    await addCashAccount(page);
    await forward(page, DEBIT_SMS);
    await openTheDraft(page);

    const sheet = page.getByRole('dialog');
    await sheet.getByRole('tab', { name: 'ধার দিয়েছি' }).click();
    await sheet.locator('#dr-account').selectOption({ label: 'নগদ' });

    /* One draft in the queue means the button reads খাতায় যোগ করুন; with
       another behind it, যোগ করে পরেরটি. Either is the accept. */
    await sheet.getByRole('button', { name: /যোগ করে পরেরটি|খাতায় যোগ করুন/ }).click();

    /* Visible is not enough — it was always in the DOM. It has to be on the
       screen, beside the button, on a 320px phone as much as on a desktop. */
    const alert = sheet.getByRole('alert');
    await expect(alert).toContainText('কার সাথে ধার');
    await expect(alert).toBeInViewport();

    // And nothing was written on the way past.
    await page.goto('/loans');
    await expect(page.getByText('করিম')).toHaveCount(0);
  });

  test('writes the loan, and takes the money out of the account', async ({ page }) => {
    await signup(page);
    await addCashAccount(page);
    await forward(page, DEBIT_SMS);
    await openTheDraft(page);

    const sheet = page.getByRole('dialog');
    await sheet.getByRole('tab', { name: 'ধার দিয়েছি' }).click();
    await sheet.locator('#dr-account').selectOption({ label: 'নগদ' });
    await sheet.locator('#dr-person').selectOption({ label: 'নতুন নাম লিখি' });
    await sheet.locator('#dr-person-name').fill('করিম');

    await sheet.getByRole('button', { name: 'খাতায় যোগ করুন' }).click();
    await expect(sheet).toBeHidden({ timeout: 15_000 });

    /* The loan itself, on the side it belongs to: money lent, not borrowed. */
    await page.goto('/loans');
    await page.getByRole('tab', { name: 'আমি যা ধার দিয়েছি' }).click();
    const row = page.getByRole('tabpanel').getByRole('listitem').filter({ hasText: 'করিম' });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText('৳500');

    /* And the cash really moved — a loan that books no entry is a note, not a
       ledger. ৳10,000 less the ৳500 that went out. */
    await page.goto('/accounts');
    await expect(page.getByText('৳9,500.00').first()).toBeVisible({ timeout: 15_000 });
  });
});
