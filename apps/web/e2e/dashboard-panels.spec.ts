import { expect, test, type Page } from '@playwright/test';

/**
 * The dashboard's analysis panels, and the layout they were added to fix.
 *
 * ## The bug this suite exists for
 *
 * The dashboard was a two-column grid of four cards laid out in source order. On
 * the right, the account breakdown — every liquid account, every asset, every
 * liability, card limits, a dozen rows. On the left, one card ninety pixels tall
 * with three figures on it. A grid row is as tall as its tallest cell, so at
 * 1280px the left column was that card followed by roughly twelve hundred pixels
 * of white, and the two cards that should have filled it began *below* the
 * breakdown instead.
 *
 * So the assertion that matters is a *measurement*: at desktop widths neither
 * column may be a small fraction of the other. Before this change that ratio was
 * about one to fourteen. It is asserted at 768 and 1280, where there are two
 * columns to compare, and skipped on the phone widths where there is one.
 *
 * ## And the assertions about honesty
 *
 * Filling a column with panels that lie is worse than the white space. Each
 * panel here compares the same stretch of two months — the 1st to today against
 * the 1st to the same day of last month — and the screen has to say so, because
 * a reader who takes "গত মাস" for the whole of last month draws the opposite
 * conclusion from the right numbers. The seeded books put every entry on the 1st
 * of its month precisely so that both windows contain them whatever day this
 * suite runs on, including the 1st.
 */

const PASSWORD = 'hishab1234';

let seq = 0;
const uniqueEmail = (): string => `dash-${Date.now()}-${(seq += 1)}@example.test`;
const uniquePhone = (): string =>
  `019${String((Date.now() % 1_000_000) * 100 + (seq % 100))
    .slice(-8)
    .padStart(8, '0')}`;

/** The first of a month, N months back, as the `YYYY-MM-DD` the API takes. */
function firstOfMonth(monthsBack: number): string {
  const now = new Date();
  const at = new Date(now.getFullYear(), now.getMonth() - monthsBack, 1);
  const month = String(at.getMonth() + 1).padStart(2, '0');
  return `${at.getFullYear()}-${month}-01`;
}

interface ApiAccount {
  id: string;
  name: string;
}
interface ApiCategory {
  id: string;
  nameBn: string | null;
  kind: string;
}

async function signup(page: Page): Promise<void> {
  await page.goto('/signup');
  await page.waitForLoadState('networkidle');
  await page.getByLabel('নাম').fill('ড্যাশবোর্ড পরীক্ষা');
  await page.getByLabel('ইমেইল').fill(uniqueEmail());
  await page.getByLabel('পাসওয়ার্ড').fill(PASSWORD);
  await page.getByLabel('মোবাইল নম্বর').fill(uniquePhone());
  await page.getByRole('button', { name: 'অ্যাকাউন্ট খুলুন' }).click();
  await expect(page.getByRole('heading', { name: 'ড্যাশবোর্ড' }).first()).toBeVisible({
    timeout: 30_000,
  });
}

/**
 * A workspace with enough in it for both columns to have something to say.
 *
 * Driven through the API rather than the entry sheet, on purpose: this suite is
 * about what the dashboard does with two months of books, and thirty passes
 * through a form would make it fail for that form's reasons. The session cookie
 * is first-party — `/api/*` is proxied to the API from the web origin — so
 * `page.request` is the same caller the browser is.
 */
async function seedBooks(page: Page): Promise<void> {
  /* Five, which is every account the free plan allows — `accounts.max` on the
     seeded FREE plan. A sixth comes back 402 and would fail this suite for a
     billing reason that has nothing to do with the dashboard. They are spread
     across all three groups of the breakdown so that card is as tall as it
     realistically gets on a free workspace. */
  const accounts: Record<string, string> = {};
  for (const [name, type, opening] of [
    ['নগদ', 'CASH', 20_000_00],
    ['ব্যাংক', 'BANK', 180_000_00],
    ['বিকাশ', 'MOBILE_WALLET', 4_500_00],
    ['ডিপিএস', 'SAVINGS', 90_000_00],
    ['জমি', 'ASSET', 1_200_000_00],
  ] as const) {
    const created = await page.request.post('/api/v1/accounts', {
      data: { name, type, currency: 'BDT', openingBalance: opening },
    });
    expect(created.ok(), `${name} should be created`).toBeTruthy();
    accounts[name] = ((await created.json()) as ApiAccount).id;
  }

  const listed = await page.request.get('/api/v1/categories');
  expect(listed.ok(), 'the seeded categories should load').toBeTruthy();
  const categories = (await listed.json()) as ApiCategory[];
  const idOf = (nameBn: string): string => {
    const found = categories.find((row) => row.nameBn === nameBn);
    expect(found, `${nameBn} should be a seeded category`).toBeTruthy();
    return found!.id;
  };

  const post = async (
    date: string,
    type: 'INCOME' | 'EXPENSE',
    taka: number,
    category: string,
  ): Promise<void> => {
    const created = await page.request.post('/api/v1/transactions', {
      data: {
        date,
        type,
        amountMinor: taka * 100,
        accountId: accounts['ব্যাংক'],
        categoryId: idOf(category),
        description: category,
      },
    });
    expect(created.ok(), `${category} on ${date} should be recorded`).toBeTruthy();
  };

  /* Every entry on the 1st, so both comparison windows hold all of them on any
     day of any month — including the 1st, when each window is one day long. */
  const thisMonth = firstOfMonth(0);
  const lastMonth = firstOfMonth(1);
  const before = firstOfMonth(2);

  await post(before, 'INCOME', 48_000, 'বেতন');
  await post(before, 'EXPENSE', 9_000, 'খাবার ও বাজার');

  await post(lastMonth, 'INCOME', 50_000, 'বেতন');
  await post(lastMonth, 'EXPENSE', 10_000, 'খাবার ও বাজার');
  await post(lastMonth, 'EXPENSE', 4_000, 'যাতায়াত');
  await post(lastMonth, 'EXPENSE', 12_000, 'বাসা ভাড়া');

  /* Deliberately a different shape from last month: income up a little, food up
     a lot, transport down, and one খাত that did not exist last month at all —
     which is the row whose percentage change is undefined. */
  await post(thisMonth, 'INCOME', 55_000, 'বেতন');
  await post(thisMonth, 'EXPENSE', 16_000, 'খাবার ও বাজার');
  await post(thisMonth, 'EXPENSE', 1_500, 'যাতায়াত');
  await post(thisMonth, 'EXPENSE', 12_000, 'বাসা ভাড়া');
  await post(thisMonth, 'EXPENSE', 7_000, 'স্বাস্থ্য');
}

/** Every panel painted, not merely the shell. */
async function openDashboard(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('dashboard-compare')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('dashboard-pace')).toBeVisible();
  await expect(page.getByTestId('dashboard-movers')).toBeVisible();
  await expect(page.getByTestId('dashboard-trend')).toBeVisible();
  await page.waitForLoadState('networkidle');
}

test.describe.configure({ mode: 'serial' });

test.describe('the dashboard panels', () => {
  let page: Page;

  test.beforeAll(async ({ browser }, testInfo) => {
    page = await browser.newPage({ viewport: testInfo.project.use.viewport });
    await signup(page);
    await seedBooks(page);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('fills both columns instead of one', async ({}, testInfo) => {
    await openDashboard(page);

    const width = page.viewportSize()?.width ?? 0;
    const main = await page.getByTestId('dashboard-main').boundingBox();
    const side = await page.getByTestId('dashboard-side').boundingBox();

    if (width < 768) {
      /* One column below `md`: the wrappers are `display: contents` and have no
         box of their own, which is the mechanism and therefore worth asserting.
         The panels themselves are all still on the page. */
      expect(main, 'the column wrappers should not be boxes on a phone').toBeNull();
      expect(side).toBeNull();
      return;
    }

    expect(main, 'the main column should be laid out').not.toBeNull();
    expect(side, 'the side column should be laid out').not.toBeNull();

    /* Side by side, not stacked. */
    expect(Math.abs(main!.y - side!.y), 'the two columns should start level').toBeLessThan(4);
    expect(main!.x).toBeLessThan(side!.x);

    const shorter = Math.min(main!.height, side!.height);
    const taller = Math.max(main!.height, side!.height);

    /* What the old layout would have measured, from the two cards it put in one
       grid row: the row was as tall as the breakdown, and everything under the
       summary card in the left column was white. Recorded rather than asserted —
       it is the *reason* for the assertion above, and it is worth being able to
       read it off a run. */
    const card = (text: string) =>
      page.locator('section').filter({ hasText: text }).first().boundingBox();
    const summary = await card('এই মাসের হিসাব');
    const breakdown = await card('নিট সম্পদ');
    testInfo.annotations.push({
      type: 'column heights',
      description:
        `${width}px: main ${Math.trunc(main!.height)}px, side ${Math.trunc(side!.height)}px` +
        ` · old left-column content ${Math.trunc(summary?.height ?? 0)}px against a` +
        ` ${Math.trunc(breakdown?.height ?? 0)}px row`,
    });

    /* The measurement this whole change is about. The old layout put a 90px card
       against a column many times its height; anything above a half is two
       columns a person would call balanced. */
    expect(
      shorter / taller,
      `columns are ${Math.trunc(main!.height)}px and ${Math.trunc(side!.height)}px at ${width}px`,
    ).toBeGreaterThan(0.5);

    /* And no column ends more than a screen's worth above the other, which is
       the same statement in the units the complaint was made in. */
    expect(taller - shorter).toBeLessThan(700);
  });

  test('nothing scrolls sideways, at any width', async () => {
    await openDashboard(page);
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(
      overflow.scrollWidth,
      `the dashboard overflows at ${page.viewportSize()?.width}px`,
    ).toBeLessThanOrEqual(overflow.clientWidth + 1);

    /* The two panels most able to push a page sideways: a table of three money
       columns, and a chart drawn at a fixed pixel width. Each is measured on its
       own, because a chart that scrolls *inside its own box* is correct and
       would not show up in the document's scroll width. */
    for (const id of ['dashboard-compare', 'dashboard-movers', 'dashboard-pace']) {
      const box = await page.getByTestId(id).evaluate((el) => ({
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      }));
      expect(box.scrollWidth, `${id} overflows its card`).toBeLessThanOrEqual(box.clientWidth + 1);
    }
  });

  test('compares the same stretch of each month, and says so', async () => {
    await openDashboard(page);
    const panel = page.getByTestId('dashboard-compare');

    /* Both months, from the seeded books: income ৳55,000 against ৳50,000 and
       spending ৳36,500 against ৳26,000. The figures are the assertion — a panel
       that renders the right words about the wrong numbers is the failure this
       is guarding against. */
    await expect(panel).toContainText('৳55,000');
    await expect(panel).toContainText('৳50,000');
    await expect(panel).toContainText('৳36,500');
    await expect(panel).toContainText('৳26,000');

    /* The change, in the three signals that are not colour: the amount, the
       percentage and the word. */
    await expect(panel).toContainText('বেড়েছে');
    await expect(panel).toContainText('%');

    /* And the sentence that stops the right-hand column being read as a whole
       month. Either wording is correct — which one depends on the day this runs. */
    await expect(panel).toContainText(/মাসের প্রথম|মাস শেষ/);
  });

  test('says where the month is going, and marks the estimate as one', async () => {
    await openDashboard(page);
    const pace = page.getByTestId('dashboard-pace');

    await expect(pace).toContainText('৳36,500');
    await expect(pace).toContainText('মাস পেরিয়েছে');
    /* A verdict in words, so the two bars are never the only signal. */
    await expect(pace).toContainText(/দ্রুত|ধীরে|একই গতিতে/);
    /* Last month's whole spending is named as such, beside the partial figure it
       is a share of. */
    await expect(pace).toContainText('৳26,000');
    /* The projection is either absent with a reason, or present and labelled. */
    await expect(pace).toContainText(/অনুমান|মাস সবে শুরু|মাস শেষ/);
  });

  test('names the categories that moved, with both months on the row', async () => {
    await openDashboard(page);
    const movers = page.getByTestId('dashboard-movers');

    /* খাবার rose ৳6,000 and স্বাস্থ্য appeared at ৳7,000 — the two biggest
       movements, and both bigger than বাসা ভাড়া, which did not move at all. */
    await expect(movers).toContainText('খাবার ও বাজার');
    await expect(movers).toContainText('স্বাস্থ্য');
    await expect(movers).not.toContainText('বাসা ভাড়া');

    /* A খাত with nothing behind it last month has no percentage change — the
       row says that in words instead of printing an infinity. */
    await expect(movers).toContainText('গত মাসে এই খাতে কিছু ছিল না');

    /* যাতায়াত fell, so both directions are on the panel at once. */
    await expect(movers).toContainText('কমেছে');
    await expect(movers).toContainText('বেড়েছে');
  });

  test('draws the trend from the existing chart, and says the last month is unfinished', async () => {
    await openDashboard(page);
    const trend = page.getByTestId('dashboard-trend');

    /* `FlowBars`, unchanged: one `role="img"` whose label carries every figure,
       and the same numbers as a table underneath. */
    const chart = trend.getByRole('img');
    await expect(chart).toBeVisible();
    const label = await chart.getAttribute('aria-label');
    expect(label, 'the chart should read out its own figures').toContain('৳');

    await trend.getByText('সংখ্যায় দেখুন').click();
    await expect(trend.getByRole('table')).toBeVisible();
  });

  test('keeps the phone order: this month, then the balances, then the analysis', async () => {
    await openDashboard(page);
    if ((page.viewportSize()?.width ?? 0) >= 768) return;

    /* The regression a two-column rework invites is burying net worth under six
       analysis panels on the one screen where it is read most. */
    const order = await page.evaluate(() => {
      const texts = ['এই মাসের হিসাব', 'নিট সম্পদ', 'এই মাস বনাম গত মাস'];
      return texts.map((text) => {
        const found = [...document.querySelectorAll('section')].find((el) =>
          el.textContent?.includes(text),
        );
        return found ? found.getBoundingClientRect().top + globalThis.scrollY : Number.NaN;
      });
    });

    expect(order.every((value) => Number.isFinite(value))).toBe(true);
    expect(order[0]!).toBeLessThan(order[1]!);
    expect(order[1]!).toBeLessThan(order[2]!);
  });
});
