import { expect, test, type Page } from '@playwright/test';

/**
 * Two ways of not scrolling: finding a খাত by typing, and teaching the quantity
 * field a unit this household actually uses.
 *
 * Both are searched or stored server-side, which is exactly why they are worth
 * a browser test. The API suite proves `?q=` transliterates and that the unit
 * list de-duplicates; what neither can prove is that picking a search result
 * lands in the two `<select>`s the form actually submits, or that a unit added
 * on the settings screen reaches the `<datalist>` in a different sheet. Both
 * are one wire away from being silently broken while every unit test passes.
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
  return `units-${Date.now()}-${counter}-${Math.trunc(performance.now())}@example.test`;
}

async function signup(page: Page): Promise<void> {
  await page.goto('/signup');
  await page.getByLabel('নাম').fill('একক পরীক্ষা');
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
  await pressAdd(page, 'নতুন অ্যাকাউন্ট যোগ করুন');
  await page.getByLabel('নাম').fill('নগদ');
  await page.getByRole('button', { name: 'সংরক্ষণ করুন', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.locator('li').filter({ hasText: 'নগদ' }).first()).toBeVisible();
}

/** The quick-add sheet, opened from wherever the floating + is. */
async function openEntrySheet(page: Page) {
  await page.goto('/transactions');
  await page.getByRole('button', { name: 'নতুন লেনদেন' }).first().click();
  const sheet = page.getByRole('dialog');
  await expect(sheet).toBeVisible();
  return sheet;
}

/**
 * The search results, and nothing else.
 *
 * Scoping matters here more than it looks. The same sheet carries the
 * accelerator strip — chips labelled with the very same খাত names — so an
 * unscoped `getByRole('button', {name: /যাতায়াত/})` finds a chip that was on
 * screen before anything was typed. It even *passes*, because tapping a chip
 * also fills both boxes: the assertion would be green while the search box it
 * claims to test did nothing at all.
 */
const results = (sheet: ReturnType<Page['getByRole']>) =>
  sheet.getByRole('list', { name: 'খোঁজার ফলাফল' });

/**
 * Press "add", whichever of the two buttons this width is showing.
 *
 * The খাত and ট্যাগ screens both carry a compact "নতুন" in a header that is
 * `hidden md:flex`, and a full-width "নতুন খাত যোগ করুন" that is `md:hidden`.
 * Both are in the DOM at every width; exactly one is visible. A locator naming
 * either one alone passes at two of the suite's four widths and times out at
 * the other two, which reads as a broken feature rather than a broken selector.
 */
async function pressAdd(page: Page, phoneLabel: string): Promise<void> {
  const compact = page.getByRole('button', { name: 'নতুন', exact: true });
  const full = page.getByRole('button', { name: phoneLabel, exact: true });
  await ((await compact.isVisible()) ? compact : full).click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

test.describe('খাত search', () => {
  test('typing Banglish finds the Bengali খাত and fills both boxes', async ({ page }) => {
    await signup(page);
    await addCashAccount(page);

    const sheet = await openEntrySheet(page);
    const search = sheet.getByLabel('খাত খুঁজুন');
    await expect(search).toBeVisible();

    /* `poribohon` and যাতায়াত share no characters. A filter over the array the
       sheet already holds would find nothing here — which is the whole reason
       this goes through `GET /categories?q=`. */
    await search.fill('poribohon');

    const result = results(sheet)
      .getByRole('button', { name: /যাতায়াত/ })
      .first();
    await expect(result).toBeVisible({ timeout: 15_000 });
    await result.click();

    /* The picked খাত is in the `<select>` that will actually be submitted —
       the point of the whole feature. A search box that highlighted a row and
       left the form unchanged would look identical until somebody saved. */
    await expect(sheet.getByLabel('ক্যাটাগরি')).toHaveValue(/.+/);
    const chosen = await sheet.getByLabel('ক্যাটাগরি').locator('option:checked').textContent();
    expect(chosen).toContain('যাতায়াত');

    // Picking clears the box, so the results do not sit over the amount field.
    await expect(search).toHaveValue('');
  });

  test('a sub-category is offered with the খাত it sits under', async ({ page }) => {
    await signup(page);
    await addCashAccount(page);

    // A sub-category of this workspace's own, added from its parent's row.
    await page.goto('/categories');
    await page.getByRole('button', { name: 'যাতায়াত-এ উপ-খাত যোগ করুন' }).click();
    const catSheet = page.getByRole('dialog');
    await expect(catSheet).toBeVisible();
    await catSheet.getByLabel('নাম', { exact: true }).fill('রিকশা');
    await page.getByRole('button', { name: 'সংরক্ষণ করুন', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeHidden();

    const sheet = await openEntrySheet(page);
    await sheet.getByLabel('খাত খুঁজুন').fill('রিকশা');

    /* `যাতায়াত › রিকশা`, not a bare "রিকশা" three rows from nowhere. The
       prefix is the only thing telling somebody which খাত they are choosing. */
    const child = results(sheet)
      .getByRole('button', { name: /যাতায়াত.*›.*রিকশা/ })
      .first();
    await expect(child).toBeVisible({ timeout: 15_000 });
    await child.click();

    // Both boxes: the parent in ক্যাটাগরি, the child in উপ-খাত.
    const sub = sheet.getByLabel('উপ-খাত');
    await expect(sub).toBeVisible();
    const chosenSub = await sub.locator('option:checked').textContent();
    expect(chosenSub).toContain('রিকশা');
  });

  test('a name that matches nothing says so instead of emptying the form', async ({ page }) => {
    await signup(page);
    await addCashAccount(page);

    const sheet = await openEntrySheet(page);
    await sheet.getByLabel('খাত খুঁজুন').fill('zzzqqq');
    await expect(sheet.getByText('এই নামে কোনো খাত নেই', { exact: false })).toBeVisible({
      timeout: 15_000,
    });

    // The wheel below is untouched — search failing must not cost the fallback.
    await expect(sheet.getByLabel('ক্যাটাগরি')).toBeVisible();
  });
});

test.describe('নিজের একক', () => {
  test('a unit added in settings is offered in the entry sheet', async ({ page }) => {
    await signup(page);
    await addCashAccount(page);

    await page.goto('/settings');
    const input = page.getByLabel('নতুন একক');
    await expect(input).toBeVisible();
    await input.fill('গজ');
    await page.getByRole('button', { name: 'যোগ করুন' }).click();

    /* Rendered from the server's answer, not the submitted string — so seeing
       it here means it was stored and cleaned, not just echoed. */
    await expect(page.getByRole('button', { name: 'গজ এককটি সরান' })).toBeVisible({
      timeout: 15_000,
    });
    const sheet = await openEntrySheet(page);
    await sheet.getByRole('button', { name: /পরিমাণ লিখবেন/ }).click();

    /* A `<datalist>` cannot be opened from Playwright, so the option itself is
       asserted: it is in the document, attached to the field, which is what
       decides whether the browser offers it. */
    const option = sheet.locator('#qty-units option[value="গজ"]');
    await expect(option).toHaveCount(1);

    // The eight shipped ones are still there beside it.
    await expect(sheet.locator('#qty-units option[value="কেজি"]')).toHaveCount(1);
  });

  test('refuses to add a unit the app already offers, and says why', async ({ page }) => {
    await signup(page);
    await page.goto('/settings');

    await page.getByLabel('নতুন একক').fill('কেজি');
    /* Off rather than an error after pressing: a duplicate কেজি would show
       twice in the dropdown with only one of them removable here. */
    await expect(page.getByRole('button', { name: 'যোগ করুন' })).toBeDisabled();
    await expect(page.getByText('তালিকায় আগে থেকেই আছে', { exact: false })).toBeVisible();
  });

  test('removing a unit is immediate and needs no confirmation', async ({ page }) => {
    await signup(page);
    await page.goto('/settings');

    await page.getByLabel('নতুন একক').fill('ভরি');
    await page.getByRole('button', { name: 'যোগ করুন' }).click();
    const remove = page.getByRole('button', { name: 'ভরি এককটি সরান' });
    await expect(remove).toBeVisible({ timeout: 15_000 });

    /* No dialog: removing a suggestion is not destructive. Transactions already
       saved in ভরি keep it, and the report keeps grouping them. */
    await remove.click();
    await expect(remove).toBeHidden({ timeout: 15_000 });

    await page.reload();
    await expect(page.getByRole('button', { name: 'ভরি এককটি সরান' })).toBeHidden();
  });
});

/**
 * Two names, two columns.
 *
 * The sheets used to carry one name box and send it as *both* columns —
 * `{ name, nameBn: name }`. That was harmless while every screen was Bengali
 * and became a data loss the moment a box could prefill with the English name:
 * saving an untouched খাত would overwrite the Bengali one with it. The browser
 * is the only place that can prove the two boxes stay apart, because the bug
 * lives in what the form sends, not in what the API accepts.
 */
test.describe('বাংলা আর ইংরেজি নাম', () => {
  test('a খাত keeps both names, and neither box overwrites the other', async ({ page }) => {
    await signup(page);
    await page.goto('/categories');

    await pressAdd(page, 'নতুন খাত যোগ করুন');
    const sheet = page.getByRole('dialog');
    await sheet.getByLabel('নাম', { exact: true }).fill('গাড়ির তেল');
    await sheet.getByLabel('ইংরেজি নাম (ঐচ্ছিক)').fill('Fuel');
    await page.getByRole('button', { name: 'সংরক্ষণ করুন', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeHidden();

    /* The list is Bengali, because this workspace is. The English name is
       stored, not shown — which is exactly the state stage one delivers. */
    await expect(page.getByText('গাড়ির তেল').first()).toBeVisible();

    // Reopen: each box shows its own column, not the same string twice.
    await page.getByRole('button', { name: 'গাড়ির তেল সম্পাদনা' }).click();
    const again = page.getByRole('dialog');
    await expect(again.getByLabel('নাম', { exact: true })).toHaveValue('গাড়ির তেল');
    await expect(again.getByLabel('ইংরেজি নাম (ঐচ্ছিক)')).toHaveValue('Fuel');

    /* Save without touching anything. The old one-box form would have written
       whichever string was in the box into both columns. */
    await page.getByRole('button', { name: 'সংরক্ষণ করুন', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeHidden();

    await page.getByRole('button', { name: 'গাড়ির তেল সম্পাদনা' }).click();
    const third = page.getByRole('dialog');
    await expect(third.getByLabel('নাম', { exact: true })).toHaveValue('গাড়ির তেল');
    await expect(third.getByLabel('ইংরেজি নাম (ঐচ্ছিক)')).toHaveValue('Fuel');
  });

  test('leaving the English box empty mirrors the name, as it always did', async ({ page }) => {
    await signup(page);
    await page.goto('/categories');

    await pressAdd(page, 'নতুন খাত যোগ করুন');
    await page.getByRole('dialog').getByLabel('নাম', { exact: true }).fill('বাজার খরচ');
    await page.getByRole('button', { name: 'সংরক্ষণ করুন', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeHidden();

    /* Empty, not prefilled with the Bengali name. A box labelled "ইংরেজি নাম"
       showing Bengali would claim an English name had been set. */
    await page.getByRole('button', { name: 'বাজার খরচ সম্পাদনা' }).click();
    await expect(page.getByRole('dialog').getByLabel('ইংরেজি নাম (ঐচ্ছিক)')).toHaveValue('');
  });

  test('a tag keeps both names too', async ({ page }) => {
    await signup(page);
    await page.goto('/tags');

    await pressAdd(page, 'নতুন ট্যাগ যোগ করুন');
    const sheet = page.getByRole('dialog');
    await sheet.getByLabel('নাম', { exact: true }).fill('শ্বশুরবাড়ি');
    await sheet.getByLabel('ইংরেজি নাম (ঐচ্ছিক)').fill('In-laws');
    await page.getByRole('button', { name: 'সংরক্ষণ করুন', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeHidden();

    await page.getByRole('button', { name: 'শ্বশুরবাড়ি সম্পাদনা' }).click();
    const again = page.getByRole('dialog');
    await expect(again.getByLabel('নাম', { exact: true })).toHaveValue('শ্বশুরবাড়ি');
    await expect(again.getByLabel('ইংরেজি নাম (ঐচ্ছিক)')).toHaveValue('In-laws');
  });
});
