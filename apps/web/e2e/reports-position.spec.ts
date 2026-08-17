import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * কোথায় দাঁড়িয়ে আছেন — the position panel, and the credit card statements
 * under it.
 *
 * ## What this suite is guarding
 *
 * Not "a panel appeared". The three things that would make this screen worse
 * than no screen at all, each of which has a specific way of breaking:
 *
 *   - **a group total that its own rows do not reach.** Every heading here is
 *     the sum of the lines beneath it. A reader who adds the lines up and gets
 *     a different number has no way to tell which of the two to believe, and
 *     will pick the smaller one.
 *   - **an undrawn credit limit counted as money.** ৳80,000 of unused limit is
 *     what the bank still holds and may withdraw; it is disclosed beside the
 *     debt and must never appear inside সম্পদ or inside হাতে নগদ. The totals
 *     are asserted exactly, which is the only way to prove a number is *not* in
 *     one of them.
 *   - **today's card balance presented as the bill.** They are different
 *     figures for most of every month, and somebody pays a bank from the one on
 *     this screen. The fixture makes them differ on purpose — one card has a
 *     statement, one has no statement day at all — so a screen that quietly
 *     used today's balance for both totals fails here.
 *
 * ## Why the fixture is built out of opening balances
 *
 * Every figure below is an `OPENING_BALANCE` transaction on a day this test
 * names. That makes the card's statement arithmetic deterministic — the debt
 * is dated a hundred days back, so it is inside every statement period this
 * suite can run in, whatever day of the month that is — and it keeps the
 * fixture off the transaction sheet, which is a screen this suite has no
 * business depending on.
 *
 * ## Why one signup for the lot
 *
 * Six accounts is a dozen sheet saves before a single assertion. The run is
 * single-worker and serial; every test navigates to `/reports` itself, so none
 * of them depends on where the last one left the page.
 */

const PASSWORD = 'hishab1234';

let seq = 0;
const uniqueEmail = (): string => `position-${Date.now()}-${(seq += 1)}@example.test`;
const uniquePhone = (): string =>
  `018${String((Date.now() % 1_000_000) * 100 + (seq % 100))
    .slice(-8)
    .padStart(8, '0')}`;

/* The fixture, in taka. Nothing ties, so every ordering below is a fact rather
   than a coincidence of a stable sort.

     নগদ            ৳ 1,00,000   liquid                  → হাতে নগদ ৳1,00,000
     বসিলার জমি      ৳ 9,00,000   asset, PROPERTY
     পালসার          ৳ 1,50,000   asset, VEHICLE          → যা নিজের ৳10,50,000
     ভিসা কার্ড      −৳   20,000   card, statement on the 1st, due on the 20th
     সিটি কার্ড      −৳   15,000   card, no statement day  → দায় ৳35,000

   Only the ভিসা has a statement day, so the statement total is ৳20,000 while
   ৳35,000 is owed today. Two figures that must not be each other.

   Five accounts and not one more: that is the whole free-plan quota, and the
   button to add a sixth is disabled rather than refused. The second card earns
   its slot ahead of a second bank account, because a card with no statement day
   is the case this panel most easily gets wrong. */
const CASH = 100_000;
const LAND = 900_000;
const BIKE = 150_000;
const VISA_OWED = 20_000;
const CITY_OWED = 15_000;
const LIQUID = CASH;
const OWNED = LAND + BIKE;
const OWED = VISA_OWED + CITY_OWED;
const VISA_LIMIT = 100_000;
const VISA_UNDRAWN = VISA_LIMIT - VISA_OWED;

/** The statement day. The 1st has always passed, whatever day the suite runs. */
const STATEMENT_DAY = '1';
const DUE_DAY = '20';

/**
 * "৳10,50,000" — the way `<Money decimals={false}>` prints it in taka.
 *
 * Lakh-crore grouping, because BDT groups that way and `formatMinor` knows it:
 * the last three digits, then pairs. A thousands-grouped expectation would pass
 * for ৳20,000 and fail for ৳9,00,000, which is the sort of test that gets
 * "fixed" with a regular expression until it asserts nothing.
 */
const taka = (amount: number): string => {
  const digits = String(Math.abs(amount));
  const tail = digits.slice(-3);
  const head = digits.slice(0, -3);
  const grouped = head ? `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${tail}` : tail;
  return `৳${amount < 0 ? '-' : ''}${grouped}`;
};

/** A day comfortably before any statement period this suite could be run in. */
const longAgo = (): string => {
  const date = new Date(Date.now() - 100 * 86_400_000);
  return date.toISOString().slice(0, 10);
};

async function signup(page: Page): Promise<void> {
  await page.goto('/signup');
  await page.getByLabel('নাম').fill('অবস্থান পরীক্ষা');
  await page.getByLabel('ইমেইল').fill(uniqueEmail());
  await page.getByLabel('পাসওয়ার্ড').fill(PASSWORD);
  await page.getByLabel('মোবাইল নম্বর').fill(uniquePhone());
  await page.getByRole('button', { name: 'অ্যাকাউন্ট খুলুন' }).click();
  await expect(page.getByRole('heading', { name: 'ড্যাশবোর্ড' }).first()).toBeVisible({
    timeout: 30_000,
  });
}

async function openNewAccount(page: Page): Promise<Locator> {
  await page.goto('/accounts');
  await page.getByRole('main').getByRole('button', { name: 'নতুন', exact: true }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByLabel('নাম', { exact: true })).toBeVisible();
  return sheet;
}

async function save(sheet: Locator): Promise<void> {
  await sheet.getByRole('button', { name: 'সংরক্ষণ করুন', exact: true }).click();
  await expect(sheet).toBeHidden({ timeout: 15_000 });
}

/** An account with an opening balance dated a hundred days back. */
async function addAccount(
  page: Page,
  options: { name: string; type: string; taka: number; assetKind?: string },
): Promise<void> {
  const sheet = await openNewAccount(page);
  await sheet.getByLabel('নাম', { exact: true }).fill(options.name);
  await sheet.getByLabel('ধরন').selectOption(options.type);
  if (options.assetKind) await sheet.getByLabel('কী ধরনের সম্পদ').selectOption(options.assetKind);
  await sheet.getByLabel('প্রারম্ভিক জের (৳)').fill(String(options.taka));
  await sheet.getByLabel('জেরটি কোন তারিখের').fill(longAgo());
  await save(sheet);
}

/**
 * A credit card, owing money from a hundred days back.
 *
 * The debt is a negative opening balance, which is what a card carrying a
 * balance *is*: credit-normal, so what is owed is a negative figure in the
 * ledger and a positive one on every report. The statement day is set in the
 * edit sheet because the create sheet does not ask for one.
 */
async function addCard(
  page: Page,
  options: { name: string; owedTaka: number; limitTaka?: number; statementDay?: string },
): Promise<void> {
  const sheet = await openNewAccount(page);
  await sheet.getByLabel('নাম', { exact: true }).fill(options.name);
  await sheet.getByLabel('ধরন').selectOption('CREDIT_CARD');
  if (options.limitTaka) {
    await sheet.getByLabel('কার্ডের লিমিট (৳)').fill(String(options.limitTaka));
    await sheet.getByLabel('পেমেন্টের শেষ তারিখ (মাসের কত তারিখ)').fill(DUE_DAY);
  }
  await sheet.getByLabel('প্রারম্ভিক জের (৳)').fill(`-${options.owedTaka}`);
  await sheet.getByLabel('জেরটি কোন তারিখের').fill(longAgo());
  await save(sheet);

  if (!options.statementDay) return;

  await page.getByRole('button', { name: `${options.name} — সম্পাদনা` }).click();
  const edit = page.getByRole('dialog');
  await expect(edit.getByLabel('স্টেটমেন্টের তারিখ (মাসের কত তারিখ)')).toBeVisible();
  await edit.getByLabel('স্টেটমেন্টের তারিখ (মাসের কত তারিখ)').fill(options.statementDay);
  await save(edit);
}

const position = (page: Page) => page.getByTestId('position');
const cards = (page: Page) => page.getByTestId('card-statements');

test.describe.configure({ mode: 'serial' });

test.describe('where you stand', () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await signup(page);
    await addAccount(page, { name: 'নগদ', type: 'CASH', taka: CASH });
    await addAccount(page, {
      name: 'বসিলার জমি',
      type: 'ASSET',
      taka: LAND,
      assetKind: 'PROPERTY',
    });
    await addAccount(page, { name: 'পালসার', type: 'ASSET', taka: BIKE, assetKind: 'VEHICLE' });
    await addCard(page, {
      name: 'ভিসা কার্ড',
      owedTaka: VISA_OWED,
      limitTaka: VISA_LIMIT,
      statementDay: STATEMENT_DAY,
    });
    await addCard(page, { name: 'সিটি কার্ড', owedTaka: CITY_OWED });
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('splits the position into what is owed, what is owned and what is spendable', async () => {
    await page.goto('/reports');
    await expect(position(page)).toBeVisible({ timeout: 20_000 });

    /* Three headings, three totals. Each is the figure the owner asked to see
       apart from the other two, and none of them is a number this screen adds
       up itself — see `buildBalanceSheet`. */
    const owed = page.getByTestId('position-owed');
    await expect(owed).toContainText('যা দেনা আছে');
    await expect(owed).toContainText(taka(OWED));

    const owned = page.getByTestId('position-owned');
    await expect(owned).toContainText('যা নিজের');
    await expect(owned).toContainText(taka(OWNED));

    const liquid = page.getByTestId('position-liquid');
    await expect(liquid).toContainText('যা এখনই খরচ করা যায়');
    await expect(liquid).toContainText(taka(LIQUID));
  });

  test('every group total is reached by the rows printed under it', async () => {
    await page.goto('/reports');
    await expect(position(page)).toBeVisible({ timeout: 20_000 });

    /* যা নিজের: ৳9,00,000 of land and ৳1,50,000 of motorcycle, which is exactly
       the ৳10,50,000 above them. A screen that dropped a kind, double-counted
       one, or folded a tail away without counting it fails on this pair. */
    const owned = page.getByTestId('position-owned');
    await expect(owned).toContainText('স্থাবর সম্পত্তি');
    await expect(owned).toContainText(taka(LAND));
    await expect(owned).toContainText('যানবাহন');
    await expect(owned).toContainText(taka(BIKE));
    // A household with no gold should not read a line saying it owns no gold.
    await expect(owned).not.toContainText('স্বর্ণ ও গয়না');

    const liquid = page.getByTestId('position-liquid');
    await expect(liquid).toContainText('নগদ');
    await expect(liquid).toContainText(taka(CASH));
    /* Nothing sits in a bank here, so no bank line is drawn. An empty group
       printed at zero would be the panel telling somebody about money they
       have never had. */
    await expect(liquid.getByRole('listitem')).toHaveCount(1);

    /* Two cards folded into one line of two, which is what "মোট দায়" for
       credit cards means, and the count says how many made it. */
    const owed = page.getByTestId('position-owed');
    await expect(owed).toContainText('ক্রেডিট কার্ড');
    await expect(owed).toContainText('২টি');
  });

  test('every row carries its name, its share and its amount as text', async () => {
    /* Colour is the third signal here, never the first: about one man in twelve
       cannot separate red from green, and one of the four themes is black and
       white. Turn the bars off entirely and the panel still reads. */
    await page.goto('/reports');
    const owned = page.getByTestId('position-owned');
    await expect(owned).toBeVisible({ timeout: 20_000 });

    const rows = owned.getByRole('listitem');
    await expect(rows).toHaveCount(2);
    // ৳9,00,000 of ৳10,50,000 is 85.7%, printed in the reader's own digits.
    await expect(rows.nth(0)).toContainText('স্থাবর সম্পত্তি');
    await expect(rows.nth(0)).toContainText('৮৫.৭%');
    await expect(rows.nth(0)).toContainText(taka(LAND));
    await expect(rows.nth(1)).toContainText('১৪.৩%');
  });

  test('keeps an undrawn credit limit out of everything it is not', async () => {
    /* ৳80,000 of unused limit is not cash under IAS 7.6 and not a resource the
       household controls — the bank may withdraw it. It is disclosed beside the
       debt and nowhere else. Asserting the two totals *exactly* is the only way
       to prove a number is absent from them. */
    await page.goto('/reports');
    await expect(cards(page)).toBeVisible({ timeout: 20_000 });

    await expect(cards(page)).toContainText('কার্ডের সীমা');
    await expect(cards(page)).toContainText(taka(VISA_UNDRAWN));
    await expect(cards(page)).toContainText('না-তোলা সীমা আপনার টাকা নয়');

    const liquid = page.getByTestId('position-liquid');
    await expect(liquid).toContainText(taka(LIQUID));
    await expect(liquid).not.toContainText(taka(LIQUID + VISA_UNDRAWN));

    const owned = page.getByTestId('position-owned');
    await expect(owned).toContainText(taka(OWNED));
    await expect(owned).not.toContainText(taka(OWNED + VISA_UNDRAWN));
  });

  test('tells the statement figure apart from what is owed today', async () => {
    await page.goto('/reports');
    await expect(cards(page)).toBeVisible({ timeout: 20_000 });

    /* The two headline figures, and they are different numbers on purpose: the
       সিটি card has no statement day, so it is owed today and is on no bill.
       A panel that quietly used today's balance for both would show ৳35,000
       twice, which is the failure this pair exists to catch. */
    await expect(cards(page)).toContainText('স্টেটমেন্ট অনুযায়ী মোট দেনা');
    await expect(cards(page)).toContainText(taka(VISA_OWED));
    await expect(cards(page)).toContainText('এই মুহূর্তে মোট দেনা');
    await expect(cards(page)).toContainText(taka(OWED));

    // And it says why they differ rather than leaving it to be worked out.
    await expect(cards(page)).toContainText('১টি কার্ডে স্টেটমেন্টের তারিখ দেওয়া নেই');
  });

  test('shows how each bill got to its figure, and when it falls due', async () => {
    await page.goto('/reports');
    await expect(cards(page)).toBeVisible({ timeout: 20_000 });

    const visa = cards(page).getByRole('listitem').filter({ hasText: 'ভিসা কার্ড' });
    await expect(visa).toContainText('বিল কাটা হয়েছে');
    await expect(visa).toContainText('শেষ তারিখ');
    /* The four lines that must close: brought forward, added, paid, and the
       statement. On this fixture the whole debt is brought forward, so the bill
       adds and pays nothing — and the arithmetic is on screen either way,
       because a reader who can check it can find the entry somebody forgot. */
    await expect(visa).toContainText('আগের বিলের বকেয়া');
    await expect(visa).toContainText('এই বিলে যোগ হয়েছে');
    await expect(visa).toContainText('এই বিলে শোধ হয়েছে');
    await expect(visa).toContainText('স্টেটমেন্ট অনুযায়ী');
    await expect(visa).not.toContainText('হিসাব মিলছে না');

    /* A card with no statement day gets no statement figure at all. There is no
       day for one to be true on, so the honest answer is to say so and show
       today's balance only. */
    const city = cards(page).getByRole('listitem').filter({ hasText: 'সিটি কার্ড' });
    await expect(city).toContainText('স্টেটমেন্টের তারিখ দেওয়া নেই');
    await expect(city).toContainText(taka(CITY_OWED));
    await expect(city).not.toContainText('আগের বিলের বকেয়া');
  });

  test('says what the figure is made from and what it cannot know', async () => {
    /* The disclosure, on the screen, in the language the books are read in.
       These books hold what the household recorded; a bank statement also
       carries interest and fees. A figure that looks like the bank's and is not
       is worse than no figure, because somebody pays a bill from it. */
    await page.goto('/reports');
    await expect(cards(page)).toContainText('এই হিসাব আপনার নিজের খাতা থেকে করা', {
      timeout: 20_000,
    });
    await expect(cards(page)).toContainText('ন্যূনতম পরিশোধের অঙ্ক এখানে বের করা যায় না');
  });

  test('never scrolls sideways, at any of the four widths', async () => {
    await page.goto('/reports');
    await expect(position(page)).toBeVisible({ timeout: 20_000 });
    await page.waitForLoadState('networkidle');

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(
      overflow.scrollWidth,
      `the position panel overflows at ${page.viewportSize()?.width}px`,
    ).toBeLessThanOrEqual(overflow.clientWidth + 1);
  });
});
