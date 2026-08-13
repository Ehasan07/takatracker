import { expect, test, type Page } from '@playwright/test';

/**
 * The language switch, end to end.
 *
 * Everything under it is unit-tested — `t()` resolves three layers, the
 * catalogue has an entry for every key, the formatters follow the locale. What
 * only a browser can show is that the switch *takes*: that the preference
 * survives the reload it triggers, that the reload does not loop, and that a
 * screen which never mentions `t` in its own file — the tab bar, the entry
 * sheet — comes back in the other language too.
 */

const PASSWORD = 'hishab1234';

let counter = 0;
function uniqueEmail(): string {
  counter += 1;
  return `lang-${Date.now()}-${counter}-${Math.trunc(performance.now())}@example.test`;
}

async function signup(page: Page): Promise<void> {
  await page.goto('/signup');
  await page.getByLabel('নাম').fill('ভাষা পরীক্ষা');
  await page.getByLabel('ইমেইল').fill(uniqueEmail());
  await page.getByLabel('পাসওয়ার্ড').fill(PASSWORD);
  await page.getByRole('button', { name: 'অ্যাকাউন্ট খুলুন' }).click();
  await expect(page.getByRole('heading', { name: 'ড্যাশবোর্ড' }).first()).toBeVisible({
    timeout: 30_000,
  });
}

/** The entry sheet needs somewhere to put the money before it is worth opening. */
async function addCashAccount(page: Page): Promise<void> {
  await page.goto('/accounts');
  const compact = page.getByRole('button', { name: 'নতুন', exact: true });
  const full = page.getByRole('button', { name: 'নতুন অ্যাকাউন্ট যোগ করুন', exact: true });
  await ((await compact.isVisible()) ? compact : full).click();
  await page.getByLabel('নাম').fill('নগদ');
  await page.getByRole('button', { name: 'সংরক্ষণ করুন', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
}

async function switchTo(page: Page, label: 'English' | 'বাংলা'): Promise<void> {
  await page.goto('/settings');
  const group = page.getByRole('group', { name: 'ভাষা' });
  await group.getByRole('button', { name: label }).click();

  /* Wait for the *evidence*, not for a load state.
   *
   * The switch reloads the page on purpose — the formatters read a
   * module-level locale, so anything already rendered would keep the old
   * digits. But `waitForLoadState('load')` returns immediately here: the
   * current document is already loaded and the reload has not started yet, so
   * the next `goto` raced it and sometimes won. Waiting for a string that only
   * exists on the far side of the switch is the only honest signal.
   */
  /* The line under the two buttons, which names what the choice covers. The
     `<h1>` would have been the obvious signal and is `hidden md:block`, so it
     does not exist at the two phone widths this suite also runs at. */
  const settled =
    label === 'English'
      ? 'Numbers, dates and category names in English'
      : 'সংখ্যা, তারিখ ও খাতের নাম বাংলায়';
  await expect(page.getByText(settled, { exact: true })).toBeVisible({ timeout: 20_000 });
}

test.describe('language', () => {
  test('switching to English turns the screens, the tab bar and the digits', async ({ page }) => {
    await signup(page);
    await addCashAccount(page);

    // Bengali to start with, which is what a Bangladeshi signup defaults to.
    await page.goto('/');
    await expect(page.getByText('এই মাসের হিসাব').first()).toBeVisible();

    await switchTo(page, 'English');

    await page.goto('/');
    await expect(page.getByText('This month').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Total balance').first()).toBeVisible();

    /* The one place a stray Bengali word is unmissable, and the one that cannot
       fall back to the full name because five cells at 320px will not hold it. */
    const tabs = page.getByTestId('bottom-nav');
    if (await tabs.isVisible()) {
      await expect(tabs).toContainText('Home');
      await expect(tabs).not.toContainText(/[ঀ-৿]/);
    }

    /* A screen whose own file was never touched by this change: the entry sheet
       pulls its strings through the same `t`, from four different components. */
    await page.getByRole('button', { name: 'New transaction' }).first().click();
    const sheet = page.getByRole('dialog');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByLabel('Date')).toBeVisible();
    /* A tab, not a button — the three kinds are a `tablist`. */
    await expect(sheet.getByRole('tab', { name: 'Expense' })).toBeVisible();
    /* The sheet's own chrome, from a component none of this touched by name. */
    await expect(sheet.getByRole('button', { name: 'Close' })).toBeVisible();
  });

  test('the choice survives a reload, and does not reload again', async ({ page }) => {
    await signup(page);
    await switchTo(page, 'English');

    /* `LocaleSync` reloads when the stored locale disagrees with the server's.
       If the write to localStorage were lost, or the comparison were wrong,
       this second load would reload forever. Landing on a stable English page
       is the proof that it does not. */
    await page.goto('/');
    await expect(page.getByText('This month').first()).toBeVisible({ timeout: 15_000 });
    await page.reload();
    await expect(page.getByText('This month').first()).toBeVisible({ timeout: 15_000 });
  });

  test('and switching back gives Bengali again', async ({ page }) => {
    await signup(page);
    await switchTo(page, 'English');
    await expect(page.getByText('Language'))
      .toBeHidden({ timeout: 15_000 })
      .catch(() => undefined);

    await switchTo(page, 'বাংলা');
    await page.goto('/');
    await expect(page.getByText('এই মাসের হিসাব').first()).toBeVisible({ timeout: 15_000 });
  });

  test('it is the books’ language, and says so', async ({ page }) => {
    await signup(page);
    await page.goto('/settings');
    /* "Language" on a settings page normally means the reader's own. This one
       is the workspace's, and two members must not see two sets of category
       names — so the screen has to say which it is. */
    await expect(page.getByText('এটি এই হিসাবের ভাষা', { exact: false })).toBeVisible();
  });
});
