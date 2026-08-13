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
  return `lang-${Date.now()}-${counter}-${Math.trunc(performance.now())}@example.test`;
}

async function signup(page: Page): Promise<void> {
  await page.goto('/signup');
  await page.getByLabel('নাম').fill('ভাষা পরীক্ষা');
  await page.getByLabel('ইমেইল').fill(uniqueEmail());
  await page.getByLabel('পাসওয়ার্ড').fill(PASSWORD);
  await page.getByLabel('মোবাইল নম্বর').fill(uniquePhone());
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

  /* Armed before the click, and waiting for the navigation itself.
   *
   * Two earlier signals both looked right and both fired too early.
   * `waitForLoadState('load')` returns immediately, because the current
   * document is already loaded and the reload has not begun. Waiting for the
   * settings note to change language is worse: `onSuccess` writes the new
   * locale into the React Query cache *before* calling `reload()`, so the note
   * flips while the old page is still on screen — and the next `goto` then
   * races a reload that is still coming.
   *
   * The reload is the thing being waited for, so it is the thing to wait on.
   */
  /* Both buttons are disabled until the server has said which language the
     workspace is already in — see `language-settings.tsx`. Clicking before
     that lands on a control that cannot act. */
  const button = page.getByRole('group', { name: 'ভাষা' }).getByRole('button', { name: label });
  await expect(button).toBeEnabled({ timeout: 15_000 });

  const reloaded = page.waitForEvent('load');
  await button.click();
  await reloaded;
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
