import { expect, test, type Page } from '@playwright/test';

/**
 * Sharing a statement with somebody who has no account.
 *
 * The API suite proves the link cannot be widened, expires, and reaches exactly
 * one subject. What only a browser can show is the part the feature exists for:
 * that the link works in a session that has never signed in, and that the page
 * it opens is a document rather than the app.
 */

const PASSWORD = 'hishab1234';

let seq = 0;
const uniqueEmail = (): string => `share-${Date.now()}-${(seq += 1)}@example.test`;
const uniquePhone = (): string =>
  `018${String((Date.now() % 1_000_000) * 100 + (seq % 100))
    .slice(-8)
    .padStart(8, '0')}`;

/**
 * The share button on a person's row, and nothing else.
 *
 * Scoping matters here for a reason worth remembering: the sidebar's account
 * button is named after the signed-in user, so a test user called
 * "শেয়ার পরীক্ষা" made `getByRole('button', {name: 'শেয়ার'})` match *it*
 * first — the click opened the account menu and the sheet never appeared. The
 * test data caused the failure and an unscoped `.first()` let it.
 */
const shareButton = (page: Page) =>
  page.getByRole('list', { name: 'মানুষজন' }).getByRole('button', { name: 'শেয়ার', exact: true });

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

/** A cash account and one loan, which is the smallest thing worth sharing. */
async function lend(page: Page): Promise<void> {
  await page.goto('/accounts');
  const compact = page.getByRole('button', { name: 'নতুন', exact: true });
  const full = page.getByRole('button', { name: 'নতুন অ্যাকাউন্ট যোগ করুন', exact: true });
  await ((await compact.isVisible()) ? compact : full).click();
  await page.getByLabel('নাম').fill('নগদ');
  await page.getByRole('button', { name: 'সংরক্ষণ করুন', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();

  await page.goto('/loans');
  await page.getByRole('button', { name: 'নতুন', exact: true }).click();
  const sheet = page.getByRole('dialog');
  await sheet.getByLabel('ধরন').selectOption('LENT');
  await sheet.getByLabel('নাম', { exact: true }).fill('করিম');
  await sheet.getByLabel('মূল টাকা (৳)').fill('50000');
  await page.getByRole('button', { name: 'সংরক্ষণ করুন', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
}

test.describe('sharing a statement', () => {
  test('a link made in the app opens for somebody with no session', async ({ page, browser }) => {
    await signup(page);
    await lend(page);

    await page.goto('/people');
    await shareButton(page).first().click();

    const sheet = page.getByRole('dialog');
    await expect(sheet).toBeVisible();
    await sheet.getByRole('button', { name: 'লিংক তৈরি করুন' }).click();

    const box = sheet.getByLabel('শেয়ার লিংক');
    await expect(box).toBeVisible({ timeout: 15_000 });
    const url = await box.inputValue();
    expect(url).toContain('/s/');

    /* Said out loud, because only the hash is stored and there is genuinely no
       showing it a second time. */
    await expect(sheet.getByText('আর দ্বিতীয়বার দেখানো যাবে না', { exact: false })).toBeVisible();

    /* A context that has never signed in — no cookies, nothing carried over.
       This is the whole feature: a creditor with no account opening it. */
    const stranger = await browser.newContext();
    const guest = await stranger.newPage();
    await guest.goto(url);

    await expect(guest.getByRole('heading', { name: 'করিম' })).toBeVisible({ timeout: 15_000 });

    /* Written the way the workspace is, not the way the database is. The first
       version printed the API's `YYYY-MM-DD` straight through, so a Bengali
       statement was dated 2026-03-01 — the kind of thing that never fails a
       test and always fails a reader. */
    const body = await guest.locator('main').innerText();
    expect(body).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(body).toMatch(/[০-৯]/);

    /* A document, not the app: no navigation to wander into. */
    await expect(guest.getByTestId('bottom-nav')).toHaveCount(0);
    await expect(guest.getByTestId('sidebar')).toHaveCount(0);
    await expect(guest.getByRole('button', { name: /প্রিন্ট|Print/ })).toBeVisible();
    await stranger.close();
  });

  test('and stops opening once it is taken back', async ({ page, browser }) => {
    await signup(page);
    await lend(page);

    await page.goto('/people');
    await shareButton(page).first().click();
    const sheet = page.getByRole('dialog');
    await sheet.getByRole('button', { name: 'লিংক তৈরি করুন' }).click();
    const url = await sheet.getByLabel('শেয়ার লিংক').inputValue();

    await sheet.getByRole('button', { name: 'এই লিংকটি বাতিল করুন' }).first().click();

    const stranger = await browser.newContext();
    const guest = await stranger.newPage();
    await guest.goto(url);
    /* One sentence for revoked, expired and never-existed alike. */
    await expect(guest.getByText('লিংকটি আর কাজ করছে না')).toBeVisible({ timeout: 15_000 });
    await stranger.close();
  });

  test('the shared page never scrolls sideways', async ({ page, browser }) => {
    await signup(page);
    await lend(page);

    await page.goto('/people');
    await shareButton(page).first().click();
    const sheet = page.getByRole('dialog');
    await sheet.getByRole('button', { name: 'লিংক তৈরি করুন' }).click();
    const url = await sheet.getByLabel('শেয়ার লিংক').inputValue();

    const stranger = await browser.newContext({ viewport: page.viewportSize() ?? undefined });
    const guest = await stranger.newPage();
    await guest.goto(url);
    await expect(guest.getByRole('heading', { name: 'করিম' })).toBeVisible({ timeout: 15_000 });

    /* A statement is a wide table on a narrow phone. It scrolls inside its own
       box; the page must not. */
    const overflow = await guest.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
    await stranger.close();
  });
});
