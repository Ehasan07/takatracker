import { expect, test, type Page } from '@playwright/test';

/**
 * আয়, খরচ ও সঞ্চয় — the three figures side by side, and the one of them the
 * books could answer and no screen had ever asked.
 *
 * ## What this suite is guarding
 *
 * Not "a panel appeared". The four ways this feature can be worse than not
 * having it, each of which has a specific way of breaking:
 *
 *   - **সঞ্চয় read as the surplus.** ৳40,000 was not spent; ৳2,000 of it
 *     actually went into a DPS. They are different numbers in almost every real
 *     month and only the second one answers the question that was asked. The
 *     fixture makes them differ by a factor of twenty on purpose, so a panel
 *     that quietly printed income less spending fails here immediately.
 *   - **two savings rates on one screen.** There is exactly one in this
 *     product now, it means সঞ্চয় ÷ আয়, and the সারসংক্ষেপ panel's old
 *     surplus-over-income line — "আয়ের X% রাখা গেছে" — is gone rather than left
 *     to disagree with it. A screen carrying both would put ৪% and ৮০% one panel
 *     apart, and the reader would believe the larger one.
 *   - **a deposit counted as spending.** A DPS instalment is one asset becoming
 *     another. The month spends ৳10,000 and saves ৳2,000, and if the ৳2,000 ever
 *     reaches the খরচ figure this suite says so.
 *   - **money coming back out ignored.** The last test breaks into the savings,
 *     and the panel has to go negative — figure, rate and the word for it.
 *
 * ## Why the fixture is built through the savings screen
 *
 * "জমা দিলাম" on a linked plan books a real `TRANSFER` from the bank account
 * into the savings account, which is what a correct ledger looks like. Nothing
 * here types the word DPS into a description and hopes: the report counts
 * transfers into savings-shaped accounts and this suite gives it transfers.
 *
 * Two accounts and not one more — that is the whole free-plan quota, and the
 * two it has to be are the one money leaves and the one it arrives in.
 */

const PASSWORD = 'hishab1234';

let seq = 0;
const uniqueEmail = (): string => `monthly-${Date.now()}-${(seq += 1)}@example.test`;
const uniquePhone = (): string =>
  `016${String((Date.now() % 1_000_000) * 100 + (seq % 100))
    .slice(-8)
    .padStart(8, '0')}`;

/* The month, in taka:
 *
 *   opening   চলতি হিসাব              ৳1,00,000
 *   income    বেতন     → চলতি হিসাব    ৳  50,000
 *   expense   খাবার    ← চলতি হিসাব    ৳  10,000
 *   transfer  চলতি হিসাব → ডিপিএস      ৳   2,000   the instalment
 *
 *   surplus = 50,000 − 10,000 = ৳40,000   ← what was *not spent*
 *   saved   =                    ৳ 2,000   ← what was actually put away
 *   rate    = 2,000 / 50,000   =  4.0%     ← and never 80.0%
 *
 * The last test then takes ৳3,000 back out, which makes the month −৳1,000. */
const SALARY = 50_000;
const GROCERIES = 10_000;
const INSTALMENT = 2000;
const SURPLUS = SALARY - GROCERIES;
const WITHDRAWAL = 3000;
const AFTER_WITHDRAWAL = INSTALMENT - WITHDRAWAL;

/** "৳50,000" — the way `<Money decimals={false}>` prints it in taka. */
const taka = (amount: number): string => {
  const digits = String(Math.abs(amount));
  const tail = digits.slice(-3);
  const head = digits.slice(0, -3);
  const grouped = head ? `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${tail}` : tail;
  return `${amount < 0 ? '-' : ''}৳${grouped}`;
};

/** "৪.০%" — a rate follows the reader's digits, an amount does not. */
const percent = (value: string): string =>
  `${value.replace(/\d/g, (d) => '০১২৩৪৫৬৭৮৯'[Number(d)]!)}%`;

/** Save the sheet and wait for it to close — navigating early aborts the POST. */
async function saveSheet(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'সংরক্ষণ করুন' }).click();
  await expect(page.getByRole('dialog')).toBeHidden({ timeout: 15_000 });
}

async function signup(page: Page): Promise<void> {
  await page.goto('/signup');
  await page.getByLabel('নাম').fill('সঞ্চয় পরীক্ষা');
  await page.getByLabel('ইমেইল').fill(uniqueEmail());
  await page.getByLabel('পাসওয়ার্ড').fill(PASSWORD);
  await page.getByLabel('মোবাইল নম্বর').fill(uniquePhone());
  await page.getByRole('button', { name: 'অ্যাকাউন্ট খুলুন' }).click();
  await expect(page.getByRole('heading', { name: 'ড্যাশবোর্ড' }).first()).toBeVisible({
    timeout: 30_000,
  });
}

async function addAccount(page: Page, name: string, type: string, opening?: string): Promise<void> {
  await page.goto('/accounts');
  await page.getByRole('main').getByRole('button', { name: 'নতুন', exact: true }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByLabel('নাম', { exact: true })).toBeVisible();
  await sheet.getByLabel('নাম', { exact: true }).fill(name);
  await sheet.getByLabel('ধরন', { exact: true }).selectOption({ label: type });
  if (opening) await sheet.getByLabel('প্রারম্ভিক জের (৳)').fill(opening);
  await saveSheet(page);
}

/** A monthly DPS whose instalments land in a savings account. */
async function addPlan(page: Page, name: string, linkTo: string): Promise<void> {
  await page.goto('/savings');
  await page.getByRole('main').getByRole('button', { name: 'নতুন', exact: true }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByLabel('নাম', { exact: true })).toBeVisible();
  await sheet.getByLabel('নাম', { exact: true }).fill(name);
  await sheet.getByLabel('ধরন', { exact: true }).selectOption({ label: 'ডিপিএস' });
  await sheet.getByLabel('প্রতি কিস্তি (৳)').fill(String(INSTALMENT));
  await sheet.getByLabel('মুনাফার হার (%)').fill('8.25');
  await sheet.getByLabel('কিস্তির টাকা কোন হিসাবে জমা হয়').selectOption({ label: linkTo });
  await saveSheet(page);
}

/**
 * "জমা দিলাম" on the plan, with an account for the money to leave.
 *
 * This is the whole point of building the fixture through this screen: the row
 * it writes is a `TRANSFER` between two of the household's own accounts, which
 * is what a DPS instalment *is* and what the report is written against.
 */
async function payInstalment(page: Page, plan: string, from: string): Promise<void> {
  await page.goto('/savings');
  await page.getByRole('main').getByText(plan, { exact: true }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'জমা দিলাম' }).first().click();

  /* Named rather than `getByRole('dialog')`: closing this sheet reopens the
     plan behind it, so *a* dialog is always on screen and a generic locator can
     never go hidden. */
  const sheet = page.getByRole('dialog').filter({ hasText: 'কিস্তি জমা দিলাম' });
  await sheet.getByLabel('কোন অ্যাকাউন্ট থেকে গেল').selectOption({ label: from });
  await sheet.getByRole('button', { name: 'জমা দিন ও টাকা সরান' }).click();
  await expect(sheet).toBeHidden({ timeout: 15_000 });
}

const monthly = (page: Page) => page.getByTestId('monthly');

test.describe.configure({ mode: 'serial' });

test.describe('income, spending and what was put away', () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    /* Two accounts, a plan, two entries and an instalment is a dozen sheet saves
       before a single assertion, and the default per-test budget is for one
       test rather than for a whole fixture. */
    test.setTimeout(180_000);
    page = await browser.newPage();
    await signup(page);
    await addAccount(page, 'চলতি হিসাব', 'ব্যাংক', '100000');
    await addAccount(page, 'ডিপিএস হিসাব', 'সঞ্চয় / ডিপিএস');
    await addPlan(page, 'ব্র্যাক ডিপিএস', 'ডিপিএস হিসাব');

    await page.goto('/');
    await page.getByRole('button', { name: 'নতুন লেনদেন' }).first().click();
    await page.getByRole('tab', { name: 'আয়' }).click();
    await page.getByLabel('পরিমাণ (৳)').fill(String(SALARY));
    await page.getByLabel('ক্যাটাগরি').selectOption({ label: 'বেতন' });
    await saveSheet(page);

    await page.getByRole('button', { name: 'নতুন লেনদেন' }).first().click();
    await page.getByLabel('পরিমাণ (৳)').fill(String(GROCERIES));
    await page.getByLabel('ক্যাটাগরি').selectOption({ label: 'খাবার ও বাজার' });
    await saveSheet(page);

    await payInstalment(page, 'ব্র্যাক ডিপিএস', 'চলতি হিসাব');
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('puts income, spending and savings side by side', async () => {
    await page.goto('/reports');
    await expect(monthly(page)).toBeVisible({ timeout: 20_000 });

    /* The three the owner asked for, each under its own word, each with its own
       amount as text. */
    await expect(page.getByTestId('monthly-income')).toContainText('আয়');
    await expect(page.getByTestId('monthly-income')).toContainText(taka(SALARY));
    await expect(page.getByTestId('monthly-expense')).toContainText('খরচ');
    await expect(page.getByTestId('monthly-expense')).toContainText(taka(GROCERIES));
    await expect(page.getByTestId('monthly-saved')).toContainText('সঞ্চয়');
    await expect(page.getByTestId('monthly-saved')).toContainText(taka(INSTALMENT));
  });

  test('never prints what was not spent as what was saved', async () => {
    /* ৳40,000 was left over and ৳2,000 of it went into a DPS. A panel that
       showed income less spending under সঞ্চয় would be telling somebody they
       saved twenty times what they saved, and it would look entirely plausible
       — which is why the two are asserted against each other rather than
       separately. */
    await page.goto('/reports');
    await expect(monthly(page)).toBeVisible({ timeout: 20_000 });

    await expect(page.getByTestId('monthly-saved')).not.toContainText(taka(SURPLUS));
    // The surplus is still on the panel, under its own name, so nothing is lost.
    await expect(monthly(page)).toContainText('খরচের পর বেঁচেছে');
    await expect(monthly(page)).toContainText(taka(SURPLUS));
  });

  test('states one savings rate, and it is savings over income', async () => {
    await page.goto('/reports');
    await expect(monthly(page)).toBeVisible({ timeout: 20_000 });

    const rate = page.getByTestId('monthly-rate');
    await expect(rate).toContainText('সঞ্চয়ের হার');
    // ৳2,000 of ৳50,000 is 4.0%, in the reader's own digits.
    await expect(rate).toContainText(percent('4.0'));
    // And never the surplus rate, which on this fixture is 80%.
    await expect(rate).not.toContainText(percent('80.0'));
    // It says which of the two it means rather than leaving it to be worked out.
    await expect(rate).toContainText('আয়ের কত অংশ সঞ্চয়ে গেছে');
  });

  test('carries no second, differently-computed rate anywhere on the screen', async () => {
    /* The সারসংক্ষেপ panel used to print "আয়ের ৮০% রাখা গেছে" from the surplus.
       Two percentages one panel apart answering the same question differently is
       worse than one that is missing, so it was removed rather than left to
       disagree. */
    await page.goto('/reports');
    await expect(monthly(page)).toBeVisible({ timeout: 20_000 });
    await page.waitForLoadState('networkidle');

    await expect(page.getByRole('main')).not.toContainText('রাখা গেছে');
    await expect(page.getByRole('main')).not.toContainText(percent('80.0'));
  });

  test('names each instrument, and the rows reach the total above them', async () => {
    await page.goto('/reports');
    await expect(monthly(page)).toBeVisible({ timeout: 20_000 });

    const instruments = page.getByTestId('monthly-instruments');
    await expect(instruments).toContainText('কোথায় জমা হয়েছে');
    /* The name the household gave the plan, not the account behind it — that is
       the word somebody recognises a year later. */
    await expect(instruments).toContainText('ব্র্যাক ডিপিএস');
    await expect(instruments).toContainText('ডিপিএস হিসাব');
    /* One instrument, so its row and the total are the same figure. A screen
       whose rows do not reach their own heading leaves a reader with two
       numbers and no way to choose between them. */
    await expect(instruments).toContainText('মোট');
    await expect(instruments).toContainText(taka(INSTALMENT));
  });

  test('says why the savings are in no expense figure', async () => {
    /* Somebody who has just seen ৳2,000 of সঞ্চয় that appears nowhere in খরচ
       will otherwise conclude the books lost it. */
    await page.goto('/reports');
    await expect(monthly(page)).toContainText('এক সম্পদ থেকে আরেক সম্পদে যাওয়া মাত্র', {
      timeout: 20_000,
    });
  });

  test('keeps the instalment out of spending entirely', async () => {
    await page.goto('/reports');
    await expect(monthly(page)).toBeVisible({ timeout: 20_000 });
    await page.waitForLoadState('networkidle');

    /* Asserting the expense figure *exactly* is the only way to prove a number
       is absent from it. ৳12,000 would be the deposit counted as spending;
       ৳10,000 is the groceries and nothing else. */
    const expense = page.getByTestId('monthly-expense');
    await expect(expense).toContainText(taka(GROCERIES));
    await expect(expense).not.toContainText(taka(GROCERIES + INSTALMENT));
  });

  test('shows the three month by month, as numbers and as bars', async () => {
    await page.goto('/reports');
    const trend = page.getByTestId('monthly-trend');
    await expect(trend).toBeVisible({ timeout: 20_000 });

    await expect(trend).toContainText('মাসে মাসে');
    /* The legend says up and down as well as colour, because red beside green
       is the one pairing this app has to be careful with. */
    await expect(trend).toContainText('সঞ্চয়ে গেছে');
    await expect(trend).toContainText('সঞ্চয় থেকে এসেছে');

    /* The picture is not the figure. The same months are a table underneath,
       with all three columns, which is the "প্রত্যেকটা পাশে" that was asked for. */
    const row = trend.getByRole('row').filter({ hasText: taka(INSTALMENT) });
    await expect(row).toContainText(taka(SALARY));
    await expect(row).toContainText(taka(GROCERIES));
  });

  test('never scrolls the page sideways, at any of the four widths', async () => {
    await page.goto('/reports');
    await expect(monthly(page)).toBeVisible({ timeout: 20_000 });
    await page.waitForLoadState('networkidle');

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(
      overflow.scrollWidth,
      `the savings panel overflows at ${page.viewportSize()?.width}px`,
    ).toBeLessThanOrEqual(overflow.clientWidth + 1);
  });

  /* Last, because it changes the fixture: ৳3,000 comes back out of the DPS
     against ৳2,000 that went in, so the month put away −৳1,000. */
  test('goes negative when more came out of savings than went in', async () => {
    await page.goto('/');
    await page.getByRole('button', { name: 'নতুন লেনদেন' }).first().click();
    await page.getByRole('tab', { name: 'ট্রান্সফার' }).click();
    await page.getByLabel('পরিমাণ (৳)').fill(String(WITHDRAWAL));
    await page.getByLabel('যে অ্যাকাউন্ট থেকে').selectOption({ label: 'ডিপিএস হিসাব' });
    await page.getByLabel('যে অ্যাকাউন্টে').selectOption({ label: 'চলতি হিসাব' });
    await saveSheet(page);

    await page.goto('/reports');
    await expect(monthly(page)).toBeVisible({ timeout: 20_000 });

    /* The sign, the rate and the word, all three. A report that counted only
       deposits would still be saying ৳2,000 here, on a month that ended ৳1,000
       poorer in savings than it started. */
    await expect(page.getByTestId('monthly-saved')).toContainText(taka(AFTER_WITHDRAWAL));
    await expect(page.getByTestId('monthly-rate')).toContainText(percent('-2.0'));
    await expect(page.getByTestId('monthly-rate')).toContainText(
      'সঞ্চয়ে যা গেছে তার চেয়ে বেশি ভাঙানো হয়েছে',
    );

    /* And the instrument's own row shows both halves, because "৳2,000 in and
       ৳3,000 out" and "−৳1,000 net" are different sentences. */
    const instruments = page.getByTestId('monthly-instruments');
    await expect(instruments).toContainText('জমা');
    await expect(instruments).toContainText('ফেরত নেওয়া');
    await expect(instruments).toContainText(taka(WITHDRAWAL));
  });
});
