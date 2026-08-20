import { expect, test, type Page } from '@playwright/test';

/**
 * A bank message that was not in taka, from the screen a person actually uses.
 *
 * The SMS below is the owner's own, byte for byte. Before this existed the
 * review screen showed **4.60** in a box labelled **টাকার পরিমাণ (৳)** — a
 * subscription costing about ৳560, one tap from being filed at ৳4.60, with
 * nothing on the screen saying dollars and nowhere to say so. The API suite
 * proves the columns; only a browser can prove the half of the bug that was
 * visible, which is the label and the missing question.
 *
 * ## Why the rate endpoint is stubbed in every test here
 *
 * `/fx/rate` proxies a third party. Left alone it would make this suite depend
 * on somebody else's uptime, and — worse — the fetched rate fills the amount box
 * on arrival, so a test asserting "the box is empty until you say something"
 * would pass or fail on network timing. Both branches are covered deliberately
 * instead: the feed refusing, which is when the person types the figure
 * themselves, and the feed answering, which must arrive as a suggestion and
 * never as a decision.
 */

/** The message, exactly as the bank sent it. */
const OPENAI_SMS =
  'USD 4.6 transacted at OPENAI *CHATGPT SUBSCR on 16/08/26 [10:33:37 PM BST] ' +
  'using Card#***0492. Available balance: USD 538.24. Helpline 16221.';

let counter = 0;
function uniqueEmail(): string {
  counter += 1;
  return `fx-${Date.now()}-${counter}-${Math.trunc(performance.now())}@example.test`;
}

/**
 * A distinct Bangladeshi mobile per signup.
 *
 * The number is unique across accounts, and this file runs at four viewport
 * widths in the same process — so the counter alone is not enough, and two
 * projects a millisecond apart would collide on the clock.
 */
let phoneSeq = 0;
function uniquePhone(): string {
  phoneSeq += 1;
  const seed =
    (Date.now() % 1_000_000) * 100 + ((phoneSeq * 7 + Math.trunc(Math.random() * 90)) % 100);
  return `018${String(seed).slice(-8).padStart(8, '0')}`;
}

async function signup(page: Page): Promise<void> {
  await page.goto('/signup');
  await page.getByLabel('নাম').fill('মুদ্রা পরীক্ষা');
  await page.getByLabel('ইমেইল').fill(uniqueEmail());
  await page.getByLabel('পাসওয়ার্ড').fill('hishab1234');
  await page.getByLabel('মোবাইল নম্বর').fill(uniquePhone());
  await page.getByRole('button', { name: 'অ্যাকাউন্ট খুলুন' }).click();
  await expect(page.getByRole('heading', { name: 'ড্যাশবোর্ড' }).first()).toBeVisible({
    timeout: 30_000,
  });
}

/** A real account to file the entry against — signup seeds only hidden ones. */
async function addCashAccount(page: Page): Promise<void> {
  await page.goto('/accounts');
  await page.getByRole('button', { name: 'নতুন', exact: true }).click();
  await page.getByLabel('নাম').fill('নগদ');
  await page.getByLabel('প্রারম্ভিক জের (৳)').fill('10000');
  await page.getByRole('button', { name: 'সংরক্ষণ করুন' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.locator('li').filter({ hasText: 'নগদ' }).first()).toBeVisible();
}

/**
 * Put a message through the real webhook, from inside the page.
 *
 * The browser's cookies authenticate the config call, and the webhook itself
 * takes the workspace's own shared secret — the same door an SMS forwarder on a
 * phone knocks on. Driving it any other way would be testing a fixture.
 */
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

/** The published feed, refusing. The form still works; it just has to be told. */
async function stubRateDown(page: Page): Promise<void> {
  await page.route('**/api/v1/fx/rate*', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'rate unavailable' }),
    }),
  );
}

/** The published feed, answering. A suggestion, never a decision. */
async function stubRate(page: Page, rate: number): Promise<void> {
  await page.route('**/api/v1/fx/rate*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ rate, asOf: '2026-08-16', provider: 'open.er-api.com' }),
    }),
  );
}

async function openTheDraft(page: Page): Promise<void> {
  await page.goto('/inbox');
  await page.getByRole('button').filter({ hasText: 'OPENAI' }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

test.describe('a draft that was not in taka', () => {
  test('says dollars, asks for the rate, and never labels the box in taka', async ({ page }) => {
    await stubRateDown(page);
    await signup(page);
    await addCashAccount(page);
    await forward(page, OPENAI_SMS);

    await page.goto('/inbox');

    /* The queue itself. A dollar draft carries no taka figure, and before this
       the row would have read ৳4.60 — the wrong number, in the wrong money,
       with nothing to distinguish it from the taka drafts around it. */
    /* The draft's own row, found by the sender rather than by position: from
       768px up the shell puts a navigation list on the page and `listitem`
       finds "ড্যাশবোর্ড" first. */
    const row = page.getByRole('button').filter({ hasText: 'OPENAI' }).first();
    await expect(row).toContainText('4.60');
    await expect(row).toContainText('USD');
    /* The number that used to be there. ৳4.60 for a charge of about ৳560 was
       the whole bug, and a taka sign anywhere on this row is it coming back. */
    await expect(row.getByText(/৳/)).toHaveCount(0);

    await openTheDraft(page);
    const sheet = page.getByRole('dialog');

    /* The visible half of the bug. The taka box is gone, replaced by one that
       says what it holds, and the amount is not claimed at all until asked. */
    await expect(sheet.getByText('টাকার পরিমাণ (৳)')).toHaveCount(0);
    await expect(sheet.getByText('বার্তাটি অন্য মুদ্রার')).toBeVisible();
    await expect(sheet.getByText('বার্তায় লেখা ছিল')).toBeVisible();
    await expect(sheet.getByLabel('খাতায় কত টাকা যাবে (৳)')).toHaveValue('');

    // And the feed being down is a sentence, not a broken screen.
    await expect(sheet.getByText('রেট আনা যায়নি — নিজে লিখে দিন।')).toBeVisible();
  });

  test('refuses to be accepted until somebody says what it cost', async ({ page }) => {
    await stubRateDown(page);
    await signup(page);
    await addCashAccount(page);
    await forward(page, OPENAI_SMS);
    await openTheDraft(page);

    const sheet = page.getByRole('dialog');
    await sheet.getByRole('tab', { name: 'খরচ' }).click();
    /* By id: the message's own highlights carry `aria-label`s naming the same
       words — "অ্যাকাউন্টের সূত্র" sits over `Card#***0492` — and a label
       lookup finds both. */
    await sheet.locator('#dr-account').selectOption({ label: 'নগদ' });
    await sheet.locator('#dr-category').selectOption({ label: 'খাবার ও বাজার' });

    await sheet.getByRole('button', { name: 'খাতায় যোগ করুন' }).click();
    await expect(sheet.getByRole('alert')).toContainText('রেট দিন');

    // Nothing was written on the way past.
    await page.goto('/accounts');
    await expect(page.getByText('৳10,000.00').first()).toBeVisible();
  });

  test('turns a typed rate into the taka figure, and books that figure', async ({ page }) => {
    await stubRateDown(page);
    await signup(page);
    await addCashAccount(page);
    await forward(page, OPENAI_SMS);
    await openTheDraft(page);

    const sheet = page.getByRole('dialog');
    const amount = sheet.getByLabel('খাতায় কত টাকা যাবে (৳)');

    /* 4.60 × 122 = 561.20, computed as integers throughout — see
       `components/fx-convert.ts`. The rate itself is never sent anywhere: what
       reaches the server is this figure, and the rate is recoverable from it
       and the stored $4.60 as a ratio of two integers. */
    await sheet.locator('#dr-fx-rate').fill('122');
    await expect(amount).toHaveValue('561.20');

    await sheet.getByRole('tab', { name: 'খরচ' }).click();
    /* By id: the message's own highlights carry `aria-label`s naming the same
       words — "অ্যাকাউন্টের সূত্র" sits over `Card#***0492` — and a label
       lookup finds both. */
    await sheet.locator('#dr-account').selectOption({ label: 'নগদ' });
    await sheet.locator('#dr-category').selectOption({ label: 'খাবার ও বাজার' });
    await sheet.getByRole('button', { name: 'খাতায় যোগ করুন' }).click();
    await expect(sheet).toBeHidden({ timeout: 15_000 });

    /* ৳561.20 out of ৳10,000, not ৳4.60. The whole point, at the far end. */
    await page.goto('/accounts');
    await expect(page.getByText('৳9,438.80').first()).toBeVisible({ timeout: 15_000 });
  });

  test('offers a published rate as a suggestion the person can overrule', async ({ page }) => {
    await stubRate(page, 120);
    await signup(page);
    await addCashAccount(page);
    await forward(page, OPENAI_SMS);
    await openTheDraft(page);

    const sheet = page.getByRole('dialog');
    const rate = sheet.locator('#dr-fx-rate');
    const amount = sheet.getByLabel('খাতায় কত টাকা যাবে (৳)');

    // Filled in, and said out loud to be a suggestion rather than a reading.
    await expect(rate).toHaveValue('120');
    await expect(amount).toHaveValue('552.00');
    await expect(sheet.getByText(/আপনি বদলে দিতে পারেন/)).toBeVisible();

    /* Overruled. The rate the card issuer actually applied is not the
       mid-market one, and whatever is in the box at the end is what the books
       get. */
    await rate.fill('125');
    await expect(amount).toHaveValue('575.00');
  });

  test('leaves an ordinary taka alert exactly as it was', async ({ page }) => {
    await stubRateDown(page);
    await signup(page);
    await addCashAccount(page);
    await forward(
      page,
      'Your A/C **4521 is debited BDT 1,250.50 on 09-08-26. Avl Bal BDT 12,430.00',
    );

    await page.goto('/inbox');
    await page.getByRole('button').filter({ hasText: 'UCB-ALERT' }).first().click();
    const sheet = page.getByRole('dialog');

    // The taka label is back, the figure is claimed, and no rate is asked for.
    await expect(sheet.getByLabel('টাকার পরিমাণ (৳)')).toHaveValue('1,250.50');
    await expect(sheet.getByText('বার্তাটি অন্য মুদ্রার')).toHaveCount(0);
  });
});

/**
 * The half a bank message cannot see.
 *
 * A DPS alert says ৳10,000 arrived and has no way to say it left a bKash wallet
 * a second earlier — the bank does not know. Accepted as income it invents
 * ৳10,000 of earnings every month, which is how this ledger came to hold
 * ৳66,98,616 of savings deposits filed as spending. So the reviewer has to be
 * able to name the other side on the screen, and naming it has to move money
 * rather than conjure it.
 */
test.describe('a message that was really a transfer', () => {
  const DPS_SMS =
    'প্রিয় গ্রাহক, 18-AUG-2026 এ আপনার মাসিক ইসলামী ডিপিএস অ্যাকাউন্ট 1783060406070 ' +
    'র মাসিক কিস্তি 10000 টাকা জমা হয়েছে। ধন্যবাদ।';

  test('books it between two accounts, with no খাত and no income', async ({ page }) => {
    await signup(page);
    await addCashAccount(page);

    // The other end: the DPS the money lands in.
    await page.goto('/accounts');
    await page.getByRole('button', { name: 'নতুন', exact: true }).click();
    await page.getByLabel('নাম').fill('ইসলামী ডিপিএস');
    await page.getByLabel('ধরন', { exact: true }).selectOption({ label: 'সঞ্চয় / ডিপিএস' });
    await page.getByRole('button', { name: 'সংরক্ষণ করুন' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();

    await forward(page, DPS_SMS);
    await page.goto('/inbox');
    await page.getByRole('button').filter({ hasText: 'UCB-ALERT' }).first().click();
    const sheet = page.getByRole('dialog');

    // Ordinary income until the tab says otherwise.
    await sheet.getByRole('tab', { name: 'আয়' }).click();
    await expect(sheet.locator('#dr-category')).toBeVisible();

    /* The খাত box goes on ট্রান্সফার, because there is no longer a question it
       answers: one of your accounts became another and nothing was earned. */
    await sheet.getByRole('tab', { name: 'ট্রান্সফার' }).click();
    await expect(sheet.locator('#dr-category')).toHaveCount(0);
    await expect(sheet.getByText('আয়ও নয়, খরচও নয়')).toBeVisible();

    await sheet.locator('#dr-account').selectOption({ label: 'নগদ' });
    await sheet.locator('#dr-counter').selectOption({ label: 'ইসলামী ডিপিএস' });

    await sheet.getByRole('button', { name: 'খাতায় যোগ করুন' }).click();
    await expect(sheet).toBeHidden({ timeout: 15_000 });

    // ৳10,000 out of one and into the other, and the khata calls it a transfer.
    await page.goto('/accounts');
    await expect(page.getByText('৳10,000.00').first()).toBeVisible({ timeout: 15_000 });
    await page.goto('/transactions');
    await expect(page.getByTestId('ledger-list').getByText('নগদ → ইসলামী ডিপিএস')).toBeVisible();
  });

  /**
   * The screen saying one thing while the form holds another.
   *
   * The counter-account picker lists everything except the account the message
   * is about, so changing *that* account to the one already chosen as the other
   * side deletes the selected option. The browser falls back to drawing its
   * first option — "আয় বা খরচ" — while the state still holds the id, and the
   * খাত box stays hidden under a label that says it should not be. A reviewer
   * reading that screen has no way to know what would be booked.
   */
  test('the two account pickers can never name the same account', async ({ page }) => {
    await signup(page);
    await addCashAccount(page);
    await page.goto('/accounts');
    await page.getByRole('button', { name: 'নতুন', exact: true }).click();
    await page.getByLabel('নাম').fill('ইসলামী ডিপিএস');
    await page.getByLabel('ধরন', { exact: true }).selectOption({ label: 'সঞ্চয় / ডিপিএস' });
    await page.getByRole('button', { name: 'সংরক্ষণ করুন' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();

    await forward(page, DPS_SMS);
    await page.goto('/inbox');
    await page.getByRole('button').filter({ hasText: 'UCB-ALERT' }).first().click();
    const sheet = page.getByRole('dialog');

    await sheet.getByRole('tab', { name: 'ট্রান্সফার' }).click();
    await sheet.locator('#dr-account').selectOption({ label: 'ইসলামী ডিপিএস' });
    await sheet.locator('#dr-counter').selectOption({ label: 'নগদ' });

    /* Neither picker offers the other's answer, so the pair can never name one
       account twice — and a list that loses its selected option must clear the
       value rather than quietly draw its first entry. */
    await expect(sheet.locator('#dr-account').locator('option', { hasText: 'নগদ' })).toHaveCount(0);
    await sheet.locator('#dr-account').selectOption({ label: 'ইসলামী ডিপিএস' });
    await expect(sheet.locator('#dr-counter')).not.toHaveValue('');

    // Off the transfer tab the খাত box is back and the other side is gone.
    await sheet.getByRole('tab', { name: 'আয়' }).click();
    await expect(sheet.locator('#dr-counter')).toHaveCount(0);
    await expect(sheet.locator('#dr-category')).toBeVisible();
  });
});

/**
 * The money somebody borrowed, coming back.
 *
 * ৳3,000 arrives in bKash and it is a repayment. Accepted as আয় it invents
 * ৳3,000 of earnings *and* leaves the debt standing at its full size — the
 * books wrong twice, and the one entry that mattered never made. Before this
 * the review screen had three tabs and a repayment was none of them, so the
 * message could only be filed wrongly or left in the queue forever.
 */
test.describe('a message that was a loan repayment', () => {
  const CASH_IN =
    'Cash In Tk 3,000.00 from 01322277399 successful. Fee Tk 0.00. ' +
    'Balance Tk 5,005.04. TrxID DHK6N1NC3O at 20/08/2026 20:16';

  test('pays the loan down instead of inventing income', async ({ page }) => {
    await signup(page);
    await addCashAccount(page);

    /* Somebody owes ৳10,000. */
    await page.goto('/loans');
    await page.getByRole('button', { name: 'নতুন', exact: true }).first().click();
    const loanSheet = page.getByRole('dialog');
    await expect(loanSheet).toBeVisible();
    await loanSheet.getByLabel('ধরন').selectOption('LENT');
    await loanSheet.getByLabel('নাম', { exact: true }).fill('Rasel');
    await loanSheet.getByLabel('মূল টাকা (৳)').fill('10000');
    await loanSheet.getByRole('button', { name: 'সংরক্ষণ করুন' }).click();
    await expect(loanSheet).toBeHidden({ timeout: 15_000 });

    await forward(page, CASH_IN);
    await page.goto('/inbox');
    await page.getByRole('button').filter({ hasText: 'UCB-ALERT' }).first().click();
    const sheet = page.getByRole('dialog');

    /* The tab that did not exist. Choosing it takes the খাত box away — a
       repayment is neither income nor spending — and asks the only question
       an amount cannot answer: which loan. */
    await sheet.getByRole('tab', { name: 'ধার ফেরত' }).click();
    await expect(sheet.locator('#dr-category')).toHaveCount(0);
    await expect(sheet.getByText('আয়ও নয়, খরচও নয়')).toBeVisible();

    await sheet.locator('#dr-account').selectOption({ label: 'নগদ' });
    await sheet.locator('#dr-loan').selectOption({ index: 1 });

    await sheet.getByRole('button', { name: 'খাতায় যোগ করুন' }).click();
    await expect(sheet).toBeHidden({ timeout: 15_000 });

    /* ৳10,000 owed less ৳3,000 back is ৳7,000 — and it is the loan that moved,
       not an income line. */
    await page.goto('/loans');
    await expect(page.getByText('৳7,000.00').first()).toBeVisible({ timeout: 15_000 });
  });
});
