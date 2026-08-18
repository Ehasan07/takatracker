import { expect, test, type Page } from '@playwright/test';

/**
 * The reports screen's charts, and the controls that decide what goes in them.
 *
 * ## What this suite is actually guarding
 *
 * Not "a chart appeared". A donut that renders is easy; a donut that is *true*
 * is the thing worth a browser. So the assertions are about the properties that
 * make it readable and honest, each of which has a specific way of breaking:
 *
 *   - the number in the middle is the sum of the ring, and it agrees with the
 *     summary panel further down the same screen
 *   - drilling into a parent shows that parent's total, sub-categories *and*
 *     the money spent on the parent itself — the row an obvious implementation
 *     loses, which is exactly when the middle stops matching the row you tapped
 *   - every slice is also a line of text with a name, a share and an amount, so
 *     nothing on the screen is carried by colour alone
 *   - the whole arrangement is in the URL, so it survives a reload and a paste
 *
 * ## Why one signup for the lot
 *
 * The fixture is a workspace with an account, a sub-category somebody made, and
 * five entries — eight sheet saves before a single assertion. Repeating that per
 * test costs a minute of the suite to prove nothing. The run is single-worker
 * and serial already; each test navigates to the URL it wants first, so no test
 * depends on where the last one left the page.
 */

const PASSWORD = 'hishab1234';

let seq = 0;
const uniqueEmail = (): string => `charts-${Date.now()}-${(seq += 1)}@example.test`;
const uniquePhone = (): string =>
  `017${String((Date.now() % 1_000_000) * 100 + (seq % 100))
    .slice(-8)
    .padStart(8, '0')}`;

/** The 44px floor, measured the way a browser reports it — see responsive.spec.ts. */
const TAP_TARGET_MIN = 43.99;

/* The fixture, in taka. খাবার is the largest, যাতায়াত is second and is the only
   one with anything inside it, বাসা ভাড়া is third. No two parents tie, so the
   order of the ring is a fact rather than a coincidence of a stable sort. */
const GROCERIES = 5000;
const TRAVEL_DIRECT = 1000;
const RICKSHAW = 3000;
const RENT = 2000;
const SALARY = 50_000;
const TRAVEL = TRAVEL_DIRECT + RICKSHAW;
const SPENT = GROCERIES + TRAVEL + RENT;

async function saveSheet(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'সংরক্ষণ করুন' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
}

async function signup(page: Page): Promise<void> {
  await page.goto('/signup');
  await page.getByLabel('নাম').fill('চিত্র পরীক্ষা');
  await page.getByLabel('ইমেইল').fill(uniqueEmail());
  await page.getByLabel('পাসওয়ার্ড').fill(PASSWORD);
  await page.getByLabel('মোবাইল নম্বর').fill(uniquePhone());
  await page.getByRole('button', { name: 'অ্যাকাউন্ট খুলুন' }).click();
  await expect(page.getByRole('heading', { name: 'ড্যাশবোর্ড' }).first()).toBeVisible({
    timeout: 30_000,
  });
}

async function spend(page: Page, category: string, taka: number): Promise<void> {
  await page.getByRole('button', { name: 'নতুন লেনদেন' }).first().click();
  await page.getByLabel('পরিমাণ (৳)').fill(String(taka));
  await page.getByLabel('ক্যাটাগরি').selectOption({ label: category });
  await saveSheet(page);
}

async function seedBooks(page: Page): Promise<void> {
  await page.goto('/accounts');
  const compact = page.getByRole('button', { name: 'নতুন', exact: true });
  const full = page.getByRole('button', { name: 'নতুন অ্যাকাউন্ট যোগ করুন', exact: true });
  await ((await compact.isVisible()) ? compact : full).click();
  await page.getByLabel('নাম').fill('নগদ');
  await page.getByLabel('প্রারম্ভিক জের (৳)').fill('100000');
  await saveSheet(page);

  /* A sub-category, because none of the seeded ones has children and the whole
     drill-down is about the second level. Scoped to the content area: the
     desktop sidebar carries a row with this exact name too. */
  await page
    .getByTestId('app-scroll')
    .getByRole('link', { name: 'ক্যাটাগরি', exact: true })
    .click();
  await expect(page).toHaveURL(/\/categories/);
  await page.getByRole('button', { name: 'যাতায়াত-এ উপ-খাত যোগ করুন' }).click();
  await page.getByLabel('নাম', { exact: true }).fill('রিকশা');
  await saveSheet(page);
  await expect(page.getByText('রিকশা').first()).toBeVisible();

  await page.goto('/');
  await page.getByRole('button', { name: 'নতুন লেনদেন' }).first().click();
  await page.getByRole('tab', { name: 'আয়' }).click();
  await page.getByLabel('পরিমাণ (৳)').fill(String(SALARY));
  await page.getByLabel('ক্যাটাগরি').selectOption({ label: 'বেতন' });
  await saveSheet(page);

  await spend(page, 'খাবার ও বাজার', GROCERIES);
  await spend(page, 'যাতায়াত', TRAVEL_DIRECT);
  await spend(page, 'রিকশা', RICKSHAW);
  await spend(page, 'বাসা ভাড়া', RENT);
}

/** "৳5,000" — the way `<Money decimals={false}>` prints it. */
const taka = (amount: number): string => `৳${amount.toLocaleString('en-US')}`;

/** "৪৫.৫%" — shares follow the reader's digits, amounts do not. See lib/format.ts. */
const share = (part: number, whole: number): string => {
  const tenths = Math.floor((part / whole) * 1000 + 0.5) / 10;
  return `${tenths.toFixed(1).replace(/\d/g, (d) => '০১২৩৪৫৬৭৮৯'[Number(d)]!)}%`;
};

const donut = (page: Page) => page.getByTestId('breakdown').getByRole('img');
const legend = (page: Page) => page.getByTestId('breakdown-legend');
const cut = (page: Page) => page.getByRole('group', { name: 'কীভাবে ভাগ করে দেখবেন' });
const side = (page: Page) => page.getByRole('group', { name: 'আয় দেখবেন না খরচ' });

test.describe.configure({ mode: 'serial' });

test.describe('the reports charts', () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await signup(page);
    await seedBooks(page);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('puts the period total in the middle of the ring, and every slice in words', async () => {
    await page.goto('/reports');

    /* The chart itself, for a reader who cannot see it: the figures, not the
       word "chart". A `role="img"` with no numbers in its label is the failure
       this asserts against. */
    const label = await donut(page).getAttribute('aria-label');
    expect(label).toContain(taka(SPENT));
    expect(label).toContain(`খাবার ও বাজার: ${taka(GROCERIES)}`);
    expect(label).toContain(share(GROCERIES, SPENT));

    // And in the middle, where a sighted reader looks first.
    await expect(page.getByTestId('breakdown')).toContainText('মোট খরচ');
    await expect(page.getByTestId('breakdown')).toContainText(taka(SPENT));

    /* Three rows, each carrying a name, a share and an amount. Colour is never
       the only signal, so every one of those three has to be text. */
    const rows = legend(page).getByRole('listitem');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText('খাবার ও বাজার');
    await expect(rows.nth(0)).toContainText(share(GROCERIES, SPENT));
    await expect(rows.nth(0)).toContainText(taka(GROCERIES));
    /* যাতায়াত carries its sub-category's money, which is the whole point of a
       rolled-up view — ৳4,000, not the ৳1,000 spent on it directly. */
    await expect(rows.nth(1)).toContainText('যাতায়াত');
    await expect(rows.nth(1)).toContainText(taka(TRAVEL));
    await expect(rows.nth(2)).toContainText('বাসা ভাড়া');
    await expect(rows.nth(2)).toContainText(taka(RENT));
  });

  test('agrees with the summary panel about what the period cost', async () => {
    /* Two panels, two queries, one period. A ring that quietly drops the
       uncategorised bucket or folds a tail away without counting it still looks
       perfectly good on its own; it stops looking good beside this figure. */
    await page.goto('/reports');
    await expect(page.getByTestId('breakdown')).toContainText(taka(SPENT));
    const summary = page.locator('section').filter({ hasText: 'সারসংক্ষেপ' }).first();
    await expect(summary).toContainText(taka(SPENT));
    await expect(summary).toContainText(taka(SALARY));
    /* A percentage used to be asserted here: "আয়ের ৭৮% রাখা গেছে", the surplus
       over income. It has gone, and deliberately. Those words describe a savings
       rate and that number is not one — money not spent may be sitting in a
       wallet — and the আয়, খরচ ও সঞ্চয় panel directly below now prints a rate
       that means what it says: what actually went into savings, over income. Two
       percentages one panel apart answering the same question differently is
       worse than one that is missing, so this one was removed rather than left
       to disagree. See reports-monthly.spec.ts.

       What is asserted instead is the figure the two totals above it reconcile
       to, which is what this panel was always really for. */
    await expect(summary).toContainText('নিট');
    await expect(summary).toContainText(taka(SALARY - SPENT));
  });

  test('opens a category on its sub-categories, and comes back', async () => {
    await page.goto('/reports');

    await legend(page).getByRole('button', { name: 'যাতায়াত — উপ-খাত' }).click();

    // Where you are is in the URL, so this view can be sent to somebody.
    await expect(page).toHaveURL(/focus=/);

    /* The middle now reads the parent's rolled-up total — the same ৳4,000 the
       row that was tapped said. If these two ever disagree, one of them is
       lying about the same money. */
    const opened = page.getByTestId('breakdown');
    await expect(opened).toContainText('যাতায়াত');
    await expect(opened).toContainText(taka(TRAVEL));

    /* Both rows, including the one an obvious implementation loses: money spent
       on যাতায়াত itself rather than on any child. Without it the ring would
       total ৳3,000 under a middle reading ৳4,000. */
    const rows = legend(page).getByRole('listitem');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('রিকশা');
    await expect(rows.nth(0)).toContainText(taka(RICKSHAW));
    await expect(rows.nth(1)).toContainText('সরাসরি যাতায়াত');
    await expect(rows.nth(1)).toContainText(taka(TRAVEL_DIRECT));

    await page.getByRole('button', { name: 'সব খাত' }).click();
    await expect(page).not.toHaveURL(/focus=/);
    await expect(page.getByTestId('breakdown')).toContainText('মোট খরচ');
  });

  test('lists a sub-category on its own line when asked for the finer cut', async () => {
    await page.goto('/reports');
    await cut(page).getByRole('button', { name: 'উপ-খাত', exact: true }).click();

    await expect(page).toHaveURL(/by=detail/);

    /* Nothing is rolled up here, so যাতায়াত appears at its own ৳1,000 and
       রিকশা stands beside it — the view in which three sub-categories of one
       parent stop hiding inside it. */
    const rows = legend(page).getByRole('listitem');
    await expect(rows).toHaveCount(4);
    await expect(legend(page)).toContainText('রিকশা');
    await expect(legend(page)).toContainText(taka(RICKSHAW));
    // Still the period's total in the middle: a different cut, the same money.
    await expect(page.getByTestId('breakdown')).toContainText(taka(SPENT));
  });

  test('turns the ring over to the income side', async () => {
    await page.goto('/reports');
    await side(page).getByRole('button', { name: 'আয়', exact: true }).click();

    await expect(page).toHaveURL(/kind=INCOME/);
    await expect(page.getByTestId('breakdown')).toContainText('আয় কোথা থেকে এলো');
    await expect(page.getByTestId('breakdown')).toContainText('মোট আয়');
    await expect(page.getByTestId('breakdown')).toContainText(taka(SALARY));
    await expect(legend(page)).toContainText('বেতন');
  });

  test('reopens exactly the view a shared link was made from', async () => {
    /* The reason all of this is in the query string rather than in component
       state: an arrangement somebody made is worth sending to somebody else. */
    await page.goto('/reports?preset=thisMonth&kind=INCOME&by=detail');

    await expect(side(page).getByRole('button', { name: 'আয়', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(cut(page).getByRole('button', { name: 'উপ-খাত', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByTestId('breakdown')).toContainText(taka(SALARY));
  });

  test('states the month figures on the trend chart and offers them as a table', async () => {
    await page.goto('/reports');

    const trend = page.locator('section').filter({ hasText: 'মাসভিত্তিক আয় ও খরচ' }).first();
    const label = await trend.getByRole('img').getAttribute('aria-label');
    expect(label).toContain(taka(SALARY));
    expect(label).toContain(taka(SPENT));

    /* Income up, spending down, and both named in the legend — the bars must
       never be telling a red-green reader apart by colour alone. */
    await expect(trend).toContainText('আয় ↑');
    await expect(trend).toContainText('খরচ ↓');

    // A picture is not a figure. The same data is one tap away as text.
    await trend.getByText('সংখ্যায় দেখুন').click();
    const table = trend.getByRole('table');
    await expect(table).toBeVisible();
    await expect(table).toContainText(taka(SALARY));
    await expect(table).toContainText(taka(SPENT));
  });

  test('never scrolls sideways, at any of the four widths', async () => {
    for (const url of ['/reports', '/reports?by=detail', '/reports?kind=INCOME']) {
      await page.goto(url);
      await page.waitForLoadState('networkidle');
      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(
        overflow.scrollWidth,
        `${url} overflows at ${page.viewportSize()?.width}px`,
      ).toBeLessThanOrEqual(overflow.clientWidth + 1);
    }
  });

  test('keeps the cut controls thumb-sized on a phone', async () => {
    await page.goto('/reports');
    /* 44px is a rule about fingers. From 768px up the pointer is a mouse and
       these tighten to the same height every other control on the screen takes
       — the floor `Chip` has always kept. */
    if ((page.viewportSize()?.width ?? 0) >= 768) return;

    for (const group of [side(page), cut(page)]) {
      const buttons = group.getByRole('button');
      for (let i = 0; i < (await buttons.count()); i += 1) {
        const box = await buttons.nth(i).boundingBox();
        expect(box, 'a cut control should be laid out').not.toBeNull();
        expect(box!.height).toBeGreaterThanOrEqual(TAP_TARGET_MIN);
      }
    }
  });

  test('says so plainly when the period has nothing in it', async () => {
    /* A period before this workspace existed. An empty ring must be a sentence,
       not a blank card or a `NaN%` — the arc maths divides by a total that is
       zero here, which is the case `ringArcs` has its own unit test for. */
    await page.goto('/reports?preset=custom&from=2001-01-01&to=2001-01-31');
    /* Longer than the suite's default: this is the one range in the file that
       nothing has fetched before, so every panel on the screen is a cold query
       at once and a loaded machine can take a while over them. */
    await expect(page.getByTestId('breakdown')).toContainText('এই সময়ে কিছু নেই', {
      timeout: 20_000,
    });
  });
});
