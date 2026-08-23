import { makeXlsx, type FixtureCell } from '@hishab/parsers';
import { expect, test, type Page } from '@playwright/test';

/**
 * Uploading a statement in whatever format it came in, and being warned — not
 * overruled — about rows that might already be in the books.
 *
 * The formats and the matching rule are covered server-side in
 * `apps/api/test/statement-import.e2e-spec.ts`, where a real `.xlsx` and a real
 * PDF go through the endpoint. What only a browser can check is the half this
 * feature actually lives in:
 *
 * - **An Excel file goes in and rows come out.** Until now this screen refused
 *   `.xlsx` outright and told the user to go and re-save it as CSV, which is
 *   not advice you can follow on a phone. The test drops a workbook on the drop
 *   zone and expects transactions.
 * - **A possible duplicate is marked, and marked as *possible*.** The badge
 *   says সম্ভাব্য, the ⓘ opens on the entry it matched, and that entry names
 *   where it came from — which is the thing that lets somebody recognise it.
 * - **Nothing is done about it.** The flagged row is still there, still
 *   listed, still selectable. It is simply not ticked, so the default action on
 *   an ambiguous row is never "double it".
 * - **The person can overrule the warning**, tick it anyway, and the
 *   transaction is written. That is the whole design: the app raises the
 *   suspicion, the person who was there decides.
 */

const PASSWORD = 'hishab1234';

let phoneSeq = 0;
function uniquePhone(): string {
  phoneSeq += 1;
  return `018${String((Date.now() % 1_000_000) * 100 + (phoneSeq % 100))
    .slice(-8)
    .padStart(8, '0')}`;
}

let counter = 0;
function uniqueEmail(): string {
  counter += 1;
  return `stmt-${Date.now()}-${counter}-${Math.trunc(performance.now())}@example.test`;
}

async function signup(page: Page): Promise<void> {
  await page.goto('/signup');
  await page.getByLabel('নাম').fill('স্টেটমেন্ট পরীক্ষা');
  await page.getByLabel('ইমেইল').fill(uniqueEmail());
  await page.getByLabel('পাসওয়ার্ড').fill(PASSWORD);
  await page.getByLabel('মোবাইল নম্বর').fill(uniquePhone());
  await page.getByRole('button', { name: 'অ্যাকাউন্ট খুলুন' }).click();
  await expect(page.getByRole('heading', { name: 'ড্যাশবোর্ড' }).first()).toBeVisible({
    timeout: 30_000,
  });
}

async function saveSheet(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'সংরক্ষণ করুন' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
}

async function addAccount(page: Page, name: string): Promise<void> {
  await page.goto('/accounts');
  await page.getByRole('button', { name: 'নতুন', exact: true }).click();
  await page.getByLabel('নাম').fill(name);
  await saveSheet(page);
  await expect(page.locator('li').filter({ hasText: name }).first()).toBeVisible();
}

/**
 * One ৳৬০ expense on 5 July — exactly the last row of the workbook below.
 *
 * This is the situation the whole feature exists for: the bank sent an SMS at
 * the time and it went straight into the books, and the statement three weeks
 * later carries it again alongside two the SMS never mentioned.
 *
 * Every field is scoped to the dialog. The transactions screen has its own
 * "from" and "to" date filters, so a bare `getByLabel('তারিখ')` matches three
 * elements and the test fails for a reason that has nothing to do with import.
 */
async function recordRickshaw(page: Page, account: string): Promise<void> {
  await page.goto('/transactions');
  await page.getByRole('button', { name: 'নতুন লেনদেন' }).first().click();
  const sheet = page.getByRole('dialog');
  await sheet.getByLabel('পরিমাণ (৳)').fill('60');
  await sheet.getByLabel('তারিখ').fill('2026-07-05');
  await sheet.getByLabel('অ্যাকাউন্ট', { exact: true }).selectOption({ label: account });
  // Required by the form, and irrelevant to the match: a possible duplicate is
  // decided on the amount, the day and the account, never on the category.
  await sheet.getByLabel('ক্যাটাগরি').selectOption({ label: 'যাতায়াত' });
  await sheet.getByLabel('বিবরণ').fill('রিকশা');
  await saveSheet(page);
  await expect(page.getByText('রিকশা').first()).toBeVisible();
}

const s = (value: string): FixtureCell => ({ kind: 's', value });
const num = (value: string): FixtureCell => ({ kind: 'n', value });
const day = (value: string): FixtureCell => ({ kind: 'd', value });

/** 46204 is 1 July 2026. Serial dates, so the file is never day-first ambiguous. */
const WORKBOOK = makeXlsx([
  [s('হিসাব বিবরণী — জুলাই ২০২৬'), s(''), s(''), s('')],
  [s('তারিখ'), s('বিবরণ'), s('জমা'), s('খরচ')],
  [day('46204'), s('বেতন'), num('50000'), num('')],
  [day('46206'), s('বাজার'), num(''), num('1250.5')],
  [day('46208'), s('রিকশা ভাড়া'), num(''), num('60')],
]);

async function uploadWorkbook(page: Page): Promise<void> {
  await page.getByLabel('ইমপোর্ট করার ফাইল').setInputFiles({
    name: 'july-2026.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from(WORKBOOK),
  });
}

test.describe('reading a statement', () => {
  test('reads an Excel workbook the app used to send the user away to re-save', async ({
    page,
  }) => {
    await signup(page);
    await addAccount(page, 'নগদ');

    await page.goto('/import');
    await uploadWorkbook(page);

    await expect(page.getByText('july-2026.xlsx')).toBeVisible({ timeout: 30_000 });
    /* Not "save it as CSV" — the rows themselves. Matched on a description no
       seeded category shares, because a category picker sits on every row and
       `getByText` reads `<option>` elements too. */
    await expect(page.getByText('রিকশা ভাড়া').first()).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'এই সারিটি যোগ করুন' })).toHaveCount(3);
  });

  test('marks a possible duplicate, shows what it matched, and does nothing about it', async ({
    page,
  }) => {
    await signup(page);
    await addAccount(page, 'নগদ');
    await recordRickshaw(page, 'নগদ');

    await page.goto('/import');
    await uploadWorkbook(page);
    await expect(page.getByText('july-2026.xlsx')).toBeVisible({ timeout: 30_000 });

    /* The account narrows the comparison; choosing it re-runs the check without
       the file going up the wire again. */
    await page.getByLabel('কোন অ্যাকাউন্টে যাবে').selectOption({ label: 'নগদ' });

    const badge = page.getByRole('button', { name: /সম্ভাব্য ডুপ্লিকেট/ });
    await expect(badge.first()).toBeVisible({ timeout: 20_000 });
    // Exactly one row matches: the ৳৬০ on 5 July. Not the salary, not the bazar.
    await expect(badge).toHaveCount(1);

    // The row is still there, whole. Nothing was skipped, merged or removed.
    await expect(page.getByText('রিকশা ভাড়া').first()).toBeVisible();

    await badge.first().click();
    const sheet = page.getByRole('dialog');
    await expect(sheet).toBeVisible();
    // The entry it matched, and — the part that lets somebody recognise it —
    // where that entry came from.
    await expect(sheet.getByText('রিকশা', { exact: false }).first()).toBeVisible();
    await expect(sheet.getByText('হাতে লেখা')).toBeVisible();
    // It never claims to be sure.
    await expect(sheet.getByText(/হতেই পারে/)).toBeVisible();
  });

  test('leaves a flagged row unticked, and imports it when the person says so', async ({
    page,
  }) => {
    await signup(page);
    await addAccount(page, 'নগদ');
    await recordRickshaw(page, 'নগদ');

    await page.goto('/import');
    await uploadWorkbook(page);
    await expect(page.getByText('july-2026.xlsx')).toBeVisible({ timeout: 30_000 });
    await page.getByLabel('কোন অ্যাকাউন্টে যাবে').selectOption({ label: 'নগদ' });

    const badge = page.getByRole('button', { name: /সম্ভাব্য ডুপ্লিকেট/ });
    await expect(badge.first()).toBeVisible({ timeout: 20_000 });

    /* Two of three rows ticked: the flagged one is deliberately left out, so
       the default action on an ambiguous row is never to double it. */
    const ticks = page.getByRole('checkbox', { name: 'এই সারিটি যোগ করুন' });
    await expect(ticks).toHaveCount(3);
    await expect(page.getByRole('button', { name: /যোগ করুন \(২\)/ })).toBeVisible();

    // Somebody really can pay ৳৬০ twice on the same day. They decide, not us.
    const flaggedRow = page.locator('li').filter({ hasText: 'রিকশা ভাড়া' }).first();
    await flaggedRow.getByRole('checkbox').check();
    await expect(page.getByRole('button', { name: /যোগ করুন \(৩\)/ })).toBeVisible();

    await page.getByRole('button', { name: /যোগ করুন \(৩\)/ }).click();
    await expect(page.getByText('ইমপোর্ট শেষ')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('৩টি লেনদেন যোগ হয়েছে')).toBeVisible();

    // And it really is a second one, not a replacement for the first.
    await page.goto('/transactions');
    await expect(page.getByText('রিকশা ভাড়া').first()).toBeVisible();
    await expect(page.getByText('রিকশা', { exact: true }).first()).toBeVisible();
  });

  test('refuses a photograph and says what to send instead', async ({ page }) => {
    await signup(page);
    await addAccount(page, 'নগদ');
    await page.goto('/import');

    /* A screenshot of a statement is the commonest thing somebody has to hand,
       and it is the one thing this cannot read. Being told why, with the two
       things that do work, beats a file picker that greys the file out. */
    await page.getByLabel('ইমপোর্ট করার ফাইল').setInputFiles({
      name: 'statement.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489',
        'hex',
      ),
    });

    await expect(page.getByText(/ছবি থেকে এখনো লেনদেন পড়া যায় না/)).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText(/পিডিএফ/).first()).toBeVisible();
  });
});
