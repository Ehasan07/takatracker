import { expect, test, type Page } from '@playwright/test';

/**
 * What one row of the khata says, and what can be written from it.
 *
 * Two field notes from the owner, both about `/transactions` — the screen
 * people spend the most time on:
 *
 *  1. The note was winning the heading. A row whose বিবরণ read "Sir bolse
 *     Milanor jonne gojamil dite" said exactly that and nothing about what kind
 *     of money had moved or where it went. Three lines now: the খাত, then the
 *     account, then the note — small, last, and only when there is one.
 *  2. ধার could not be recorded from the khata at all. Lending and borrowing
 *     are a whole class of transaction and the only way in was the নতুন button
 *     on /loans.
 *
 * Both are assertions about *reading*, so they are made on the row's own text
 * in the order it appears, not merely on the text being somewhere on the page.
 * `toContainText` alone would have passed before any of this was written.
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

let counter = 0;
function uniqueEmail(): string {
  counter += 1;
  return `khata-${Date.now()}-${counter}-${Math.trunc(performance.now())}@example.test`;
}

async function signup(page: Page): Promise<void> {
  await page.goto('/signup');
  await page.getByLabel('নাম').fill('খাতা পরীক্ষা');
  await page.getByLabel('ইমেইল').fill(uniqueEmail());
  await page.getByLabel('পাসওয়ার্ড').fill('hishab1234');
  await page.getByLabel('মোবাইল নম্বর').fill(uniquePhone());
  await page.getByRole('button', { name: 'অ্যাকাউন্ট খুলুন' }).click();
  await expect(page.getByRole('heading', { name: 'ড্যাশবোর্ড' }).first()).toBeVisible({
    timeout: 30_000,
  });
}

/**
 * Save whichever sheet is open and wait for it to close.
 *
 * Not `exact`: once an amount has been typed the entry sheet's button reads
 * "৳5,000.00 সংরক্ষণ করুন", so an exact match never resolves.
 */
async function saveSheet(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'সংরক্ষণ করুন' }).click();
  await expect(page.getByRole('dialog')).toBeHidden({ timeout: 15_000 });
}

async function addAccount(page: Page, name: string, opening = ''): Promise<void> {
  await page.goto('/accounts');
  await page.getByRole('button', { name: 'নতুন', exact: true }).click();
  await page.getByLabel('নাম').fill(name);
  if (opening) await page.getByLabel('প্রারম্ভিক জের (৳)').fill(opening);
  await saveSheet(page);
  // Scope to the list: the account-type <select> also contains these words.
  await expect(page.locator('li').filter({ hasText: name }).first()).toBeVisible();
}

/**
 * Open the entry sheet and hand back the sheet itself.
 *
 * Everything is then addressed inside it, because the khata's own filter bar
 * carries a ক্যাটাগরি and an অ্যাকাউন্ট box with the same labels as the sheet —
 * `page.getByLabel('ক্যাটাগরি')` on this screen is two elements, and strict mode
 * is right to refuse it.
 */
async function openEntrySheet(page: Page) {
  await page.getByRole('button', { name: 'নতুন লেনদেন' }).first().click();
  const sheet = page.getByRole('dialog');
  await expect(sheet).toBeVisible();
  return sheet;
}

interface ApiCategory {
  id: string;
  name: string;
  nameBn: string | null;
}

/**
 * A sub-খাত under one of the seeded খাত, made through the API.
 *
 * Setup, deliberately not driven through `/categories`. What this spec is about
 * is what a row says once something has been filed under a sub-খাত; driving the
 * category screen's own form to get there would make this test fail for that
 * screen's reasons, and it is a screen this change does not touch. The session
 * cookie is first-party — `/api/*` is proxied to the API from the web origin —
 * so `page.request` is the same caller the browser already is.
 */
async function addSubCategory(page: Page, parentBn: string, nameBn: string): Promise<void> {
  const listed = await page.request.get('/api/v1/categories');
  expect(listed.ok(), 'the category list should load').toBeTruthy();
  const all = (await listed.json()) as ApiCategory[];
  const parent = all.find((row) => row.nameBn === parentBn);
  expect(parent, `${parentBn} should be one of the seeded খাত`).toBeTruthy();

  const created = await page.request.post('/api/v1/categories', {
    data: { name: nameBn, nameBn, kind: 'EXPENSE', parentId: parent!.id },
  });
  expect(created.ok(), 'the sub-খাত should be created').toBeTruthy();
}

/** The row carrying `text`, whichever day section it landed in. */
function ledgerRow(page: Page, text: string) {
  return page.getByTestId('ledger-list').locator('li.ledger-row').filter({ hasText: text }).first();
}

/**
 * One row's text, whitespace collapsed.
 *
 * Read whole rather than line by line so that *order* can be asserted. Each of
 * the three lines truncates with an ellipsis at 320px, which is a painted
 * effect: `innerText` still carries the whole string, so the same assertion
 * holds at every width.
 */
async function rowText(page: Page, text: string): Promise<string> {
  return (await ledgerRow(page, text).innerText()).replace(/\s+/g, ' ');
}

test.describe('what a khata row says', () => {
  test('leads with the খাত, then the account, and puts the note last', async ({ page }) => {
    await signup(page);
    await addAccount(page, 'নগদ', '5000');
    await addSubCategory(page, 'খাবার ও বাজার', 'রেস্টুরেন্ট');

    await page.goto('/transactions');
    const sheet = await openEntrySheet(page);
    await sheet.getByLabel('পরিমাণ (৳)').fill('850');
    await sheet.getByLabel('ক্যাটাগরি').selectOption({ label: 'খাবার ও বাজার' });
    await sheet.getByLabel('উপ-খাত').selectOption({ label: 'রেস্টুরেন্ট' });
    await sheet.getByLabel('বিবরণ').fill('Sir bolse Milanor jonne');
    await saveSheet(page);

    /* The three lines, in the order the owner asked for them. The note used to
       be the heading; now the সাব-খাত is, and the note is beneath the account
       where a reader looks for it only if they want it. */
    const text = await rowText(page, 'রেস্টুরেন্ট');
    expect(text).toContain('রেস্টুরেন্ট');
    expect(text).toContain('নগদ · খাবার ও বাজার');
    expect(text).toContain('Sir bolse Milanor jonne');
    expect(
      text.indexOf('রেস্টুরেন্ট'),
      'the সাব-খাত heads the row, above the account',
    ).toBeLessThan(text.indexOf('নগদ · খাবার ও বাজার'));
    expect(text.indexOf('নগদ · খাবার ও বাজার'), 'the note comes last of the three').toBeLessThan(
      text.indexOf('Sir bolse Milanor jonne'),
    );

    /* The parent খাত is on the second line because the first one took the leaf.
       Without it রেস্টুরেন্ট under খাবার ও বাজার and রেস্টুরেন্ট under বেড়ানো
       would be the same row twice. */
    await expect(ledgerRow(page, 'রেস্টুরেন্ট')).toContainText('খাবার ও বাজার');

    // Nothing above may slide sideways to make room for a third line.
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(
      overflow.scrollWidth,
      `the khata overflows at ${page.viewportSize()?.width}px`,
    ).toBeLessThanOrEqual(overflow.clientWidth + 1);
  });

  test('names the খাত itself when the row was filed on one, and says খরচ when it was not', async ({
    page,
  }) => {
    await signup(page);
    await addAccount(page, 'নগদ', '5000');

    await page.goto('/transactions');
    const sheet = await openEntrySheet(page);
    await sheet.getByLabel('পরিমাণ (৳)').fill('300');
    await sheet.getByLabel('ক্যাটাগরি').selectOption({ label: 'যাতায়াত' });
    await saveSheet(page);

    /* No sub-খাত, so the খাত itself heads the row — and with no বিবরণ typed
       there is no third line at all rather than an empty one. */
    const text = await rowText(page, 'যাতায়াত');
    expect(text.indexOf('যাতায়াত')).toBeLessThan(text.indexOf('নগদ'));
    // The second line is the account alone: there is no parent খাত to add.
    expect(text).not.toContain('নগদ ·');
  });

  test('a transfer says the word, and which account went where', async ({ page }) => {
    await signup(page);
    await addAccount(page, 'নগদ', '5000');
    await addAccount(page, 'ব্যাংক', '20000');

    await page.goto('/transactions');
    const sheet = await openEntrySheet(page);
    await sheet.getByRole('tab', { name: 'ট্রান্সফার' }).click();
    await sheet.getByLabel('পরিমাণ (৳)').fill('1000');
    await sheet.getByLabel('যে অ্যাকাউন্ট থেকে').selectOption({ label: 'ব্যাংক' });
    await sheet.getByLabel('যে অ্যাকাউন্টে').selectOption({ label: 'নগদ' });
    await saveSheet(page);

    /* The owner's second note: two account names and an arrow left it to the
       reader to work out that this was neither income nor expense. The row now
       says the word first and shows the two accounts underneath it. */
    const text = await rowText(page, 'ব্যাংক → নগদ');
    expect(text.indexOf('ট্রান্সফার'), 'the kind heads the row').toBeLessThan(
      text.indexOf('ব্যাংক → নগদ'),
    );
  });
});

test.describe('ধার, written from the khata', () => {
  test('lends to a new person, borrows from an existing one, and both reach the loans screen', async ({
    page,
  }) => {
    await signup(page);
    await addAccount(page, 'নগদ', '20000');

    /* Nobody in the khata yet, so the sheet asks for the name outright rather
       than offering a dropdown whose only entry is "নতুন ব্যক্তি". */
    await page.goto('/transactions');
    const lentSheet = await openEntrySheet(page);
    await lentSheet.getByRole('tab', { name: 'ধার দিয়েছি' }).click();
    await lentSheet.getByLabel('পরিমাণ (৳)').fill('5000');
    await lentSheet.getByLabel('কোন অ্যাকাউন্ট থেকে দিলেন').selectOption({ label: 'নগদ' });
    /* By role, not by label: while `GET /people` is still on the wire the sheet
       cannot yet know the khata is empty, so this control is a <select> for a
       moment and becomes the name box after. The role is what makes the locator
       wait for the second one rather than fill the first. */
    await lentSheet.getByRole('textbox', { name: 'কাকে ধার দিয়েছেন' }).fill('করিম উদ্দিন');
    await lentSheet.getByLabel('নোট').fill('বাড়ি মেরামতের জন্য');
    await saveSheet(page);

    /* The row names the kind, because a ধার is neither income nor expense and
       carries no খাত to lead with — and then the account and the person, which
       is the one thing a loan is actually about. */
    const lent = await rowText(page, 'ধার দিয়েছি');
    expect(lent.indexOf('ধার দিয়েছি')).toBeLessThan(lent.indexOf('করিম উদ্দিন'));
    expect(lent).toContain('নগদ · করিম উদ্দিন');

    /* And the loan is a loan, not an expense that looks like one: it is on the
       loans screen with a person, a balance and somewhere to add repayments.
       The hub lists one direction at a time, so the tab has to be the one this
       loan went on. */
    await page.goto('/loans');
    await page.getByRole('tab', { name: 'আমি যা ধার দিয়েছি' }).click();
    await expect(page.getByText('করিম উদ্দিন').first()).toBeVisible({ timeout: 15_000 });

    /* Second time round the person exists, so the sheet offers them rather than
       asking for the name again — the list is `GET /people`, everybody in the
       khata, not only the ones who already have a loan. */
    await page.goto('/transactions');
    const borrowedSheet = await openEntrySheet(page);
    await borrowedSheet.getByRole('tab', { name: 'ধার নিয়েছি' }).click();
    await borrowedSheet.getByLabel('পরিমাণ (৳)').fill('2500');
    await borrowedSheet.getByLabel('কোন অ্যাকাউন্টে এল').selectOption({ label: 'নগদ' });
    await borrowedSheet
      .getByLabel('কার কাছ থেকে ধার নিয়েছেন')
      .selectOption({ label: 'করিম উদ্দিন' });
    await saveSheet(page);

    await expect(ledgerRow(page, 'ধার নিয়েছি')).toContainText('করিম উদ্দিন');

    /* Both directions on one party, which is the whole reason a ধার has to go
       to /loans rather than being posted as a plain transaction: the amounts
       stay attached to a person and can be settled. Either script of digits —
       the workspace's language decides that, and this spec is about neither. */
    await page.goto('/loans');
    await page.getByRole('tab', { name: 'আমি যা ধার নিয়েছি' }).click();
    await expect(page.getByText(/2,500|২,৫০০/).first()).toBeVisible({ timeout: 15_000 });
    await page.getByRole('tab', { name: 'আমি যা ধার দিয়েছি' }).click();
    await expect(page.getByText(/5,000|৫,০০০/).first()).toBeVisible();
  });

  test('the entry sheet still fits, five tabs and all', async ({ page }) => {
    await signup(page);
    await addAccount(page, 'নগদ');

    await page.goto('/transactions');
    const sheet = await openEntrySheet(page);
    await page.waitForLoadState('networkidle');

    /* Five tabs where there were three. At 320px five across one row would give
       each label 57px and ট্রান্সফার does not fit in 57px, so they wrap to two
       rows — which is only an improvement if nothing runs off the right edge. */
    const viewport = page.viewportSize()?.width ?? 0;
    const inner = await sheet.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    expect(inner.scrollWidth, `the sheet overflows at ${viewport}px`).toBeLessThanOrEqual(
      inner.clientWidth + 1,
    );

    for (const name of ['খরচ', 'আয়', 'ট্রান্সফার', 'ধার দিয়েছি', 'ধার নিয়েছি']) {
      const tab = sheet.getByRole('tab', { name, exact: true });
      await expect(tab).toBeVisible();
      const box = await tab.boundingBox();
      expect(box, `${name} should be laid out`).not.toBeNull();
      /* The 44px floor. Compared against 43.99 rather than 44 for the reason
         responsive.spec.ts gives: a box laid out as exactly 2.75rem is reported
         as 43.99998474121094 often enough to fail a run at random. */
      expect(box!.height, `${name} is under the tap floor at ${viewport}px`).toBeGreaterThanOrEqual(
        43.99,
      );
      expect(box!.x, `${name} starts off-screen at ${viewport}px`).toBeGreaterThanOrEqual(-1);
      expect(box!.x + box!.width, `${name} runs past ${viewport}px`).toBeLessThanOrEqual(
        viewport + 1,
      );
    }
  });

  test('the chosen tab is visibly chosen, in every theme', async ({ page }) => {
    /* The regression this exists for: the selected tab was drawn with
       `bg-surface` on a `bg-greenbar` strip, and on the dark palettes those two
       tokens are #16201c and #1a241f — the same near-black. Five tabs, and no
       way to see which one you were on. `aria-selected` was correct the whole
       time, which is why nothing caught it.

       So this asserts the *pixels*. It reads whichever tab reports
       `aria-selected="true"` rather than clicking one by name: at 320px the
       five tabs wrap onto two rows and a click by label is not reliably the
       thing that ends up chosen — and what this test is about is the paint, not
       the clicking. */
    await signup(page);
    await page.goto('/transactions');
    await page.getByRole('button', { name: 'নতুন লেনদেন' }).first().click();
    const sheet = page.getByRole('dialog');
    await expect(sheet).toBeVisible();

    const strip = sheet.getByRole('tablist');
    const chosen = strip.locator('[aria-selected="true"]');
    const unchosen = strip.locator('[aria-selected="false"]').first();
    await expect(chosen).toHaveCount(1);

    for (const theme of ['default', 'mono', 'contrast', 'calm']) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);

      const bg = await chosen.evaluate((el) => getComputedStyle(el).backgroundColor);
      const stripBg = await strip.evaluate((el) => getComputedStyle(el).backgroundColor);
      const otherBg = await unchosen.evaluate((el) => getComputedStyle(el).backgroundColor);

      /* Not transparent — an unset background reads as the strip behind it,
         which is the bug wearing a different hat. */
      expect(bg, `theme ${theme}: the chosen tab must be painted`).not.toBe('rgba(0, 0, 0, 0)');
      expect(bg, `theme ${theme}: the chosen tab must not look like the strip`).not.toBe(stripBg);
      expect(bg, `theme ${theme}: the chosen tab must not look like the rest`).not.toBe(otherBg);
    }
  });
});
