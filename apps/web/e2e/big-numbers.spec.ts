import { expect, test, type Page } from '@playwright/test';

/**
 * A crore on a statement.
 *
 * Every figure in this app is right-aligned in a column, and the columns were
 * sized for a household's numbers. A net worth of ৳1,00,81,963.92 is fifteen
 * characters of tabular monospace, and where that does not fit the amount does
 * not wrap or shrink — it runs out past the card's own edge and the last digits
 * are cut off. A balance sheet whose closing figure cannot be read in full is
 * not a balance sheet.
 *
 * The responsive suite does not catch this: it asserts the *page* never scrolls
 * sideways, and this overflow is clipped by an ancestor rather than scrolling
 * anything. So the check here is different — every amount must sit inside the
 * box that contains it.
 */

const PASSWORD = 'hishab1234';

let seq = 0;
const uniqueEmail = (): string => `big-${Date.now()}-${(seq += 1)}@example.test`;
const uniquePhone = (): string =>
  `016${String((Date.now() % 1_000_000) * 100 + (seq % 100))
    .slice(-8)
    .padStart(8, '0')}`;

async function signup(page: Page): Promise<void> {
  await page.goto('/signup');
  await page.getByLabel('নাম').fill('বড় অঙ্ক');
  await page.getByLabel('ইমেইল').fill(uniqueEmail());
  await page.getByLabel('পাসওয়ার্ড').fill(PASSWORD);
  await page.getByLabel('মোবাইল নম্বর').fill(uniquePhone());
  await page.getByRole('button', { name: 'অ্যাকাউন্ট খুলুন' }).click();
  await expect(page.getByRole('heading', { name: 'ড্যাশবোর্ড' }).first()).toBeVisible({
    timeout: 30_000,
  });
}

/** A crore and change, which is what the owner's books actually hold. */
async function addBigAccount(page: Page): Promise<void> {
  await page.goto('/accounts');
  await page.getByRole('main').getByRole('button', { name: 'নতুন', exact: true }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByLabel('নাম', { exact: true })).toBeVisible();
  await sheet.getByLabel('নাম', { exact: true }).fill('ব্যাংক');
  await sheet.getByLabel('প্রারম্ভিক জের (৳)').fill('11912726.85');
  await sheet.getByRole('button', { name: 'সংরক্ষণ করুন', exact: true }).click();
  await expect(sheet).toBeHidden({ timeout: 15_000 });
}

/**
 * Every `.money` on the page, and whether it fits the card it is drawn in.
 *
 * Measured against the nearest bordered box rather than the viewport, because
 * an amount that has escaped its card is already unreadable even when the page
 * itself does not scroll.
 */
async function overflowing(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const bad: string[] = [];
    for (const el of Array.from(document.querySelectorAll('.money'))) {
      const box = el.getBoundingClientRect();
      if (box.width === 0) continue;
      const card = el.closest('section, article, li, [class*="rounded-card"]') ?? el.parentElement;
      if (!card) continue;
      const bounds = card.getBoundingClientRect();
      /* One pixel of slack for sub-pixel layout; anything past that is a digit
         somebody cannot read. */
      if (box.right > bounds.right + 1 || box.left < bounds.left - 1) {
        bad.push(
          `${(el.textContent ?? '').trim()} escapes by ${Math.round(box.right - bounds.right)}px` +
            ` [in ${card.tagName}.${(card.className || '').toString().slice(0, 70)}]` +
            ` [near "${(card.textContent ?? '').trim().slice(0, 40)}"]`,
        );
      }
    }
    return bad;
  });
}

test.describe('a crore on a statement', () => {
  test('every amount fits the card it is drawn in', async ({ page }) => {
    await signup(page);
    await addBigAccount(page);

    await page.goto('/reports/statements');
    await expect(page.getByRole('heading', { name: 'স্থিতিপত্র' })).toBeVisible({
      timeout: 20_000,
    });

    expect(await overflowing(page)).toEqual([]);
  });

  test('the dashboard and the accounts list hold big figures too', async ({ page }) => {
    await signup(page);
    await addBigAccount(page);

    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'ড্যাশবোর্ড' }).first()).toBeVisible();
    expect(await overflowing(page)).toEqual([]);

    await page.goto('/accounts');
    await expect(page.getByText('ব্যাংক').first()).toBeVisible({ timeout: 15_000 });
    expect(await overflowing(page)).toEqual([]);
  });

  test('holds when the reader has turned the text up', async ({ page }) => {
    /* Somebody reading a balance sheet on a phone is very often zoomed in, or
       has the system text size raised. Both land in the page as a larger root
       font, and a column sized in `rem` grows with it while the card does not.
       This is the state the owner's own screenshot was taken in. */
    await signup(page);
    await addBigAccount(page);

    await page.goto('/reports/statements');
    await expect(page.getByRole('heading', { name: 'স্থিতিপত্র' })).toBeVisible({
      timeout: 20_000,
    });

    await page.evaluate(() => {
      document.documentElement.style.fontSize = '24px';
    });
    /* A reflow, then measure. */
    await page.waitForTimeout(300);

    expect(await overflowing(page)).toEqual([]);
  });
});
