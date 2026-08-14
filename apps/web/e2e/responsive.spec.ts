import { expect, test, type Page } from '@playwright/test';

/**
 * The 44px floor, measured the way a browser actually reports it.
 *
 * `getBoundingClientRect` returns a float, and a box laid out as exactly
 * `2.75rem` comes back as 43.99998474121094 often enough to fail a run at
 * random — a difference of three ten-millionths of a pixel, which is not a
 * target anybody can miss. The floor is a design rule about CSS pixels, so it
 * is compared in CSS pixels rather than in the float noise underneath.
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

const TAP_TARGET_MIN = 43.99;

/** M4 acceptance: the responsive shell and the PWA plumbing. */

async function signup(page: Page): Promise<void> {
  await page.goto('/signup');
  await page.getByLabel('নাম').fill('রেসপন্সিভ');
  await page
    .getByLabel('ইমেইল')
    .fill(`resp-${Date.now()}-${Math.trunc(performance.now())}@example.test`);
  await page.getByLabel('পাসওয়ার্ড').fill('hishab1234');
  await page.getByLabel('মোবাইল নম্বর').fill(uniquePhone());
  await page.getByRole('button', { name: 'অ্যাকাউন্ট খুলুন' }).click();
  await expect(page.getByRole('heading', { name: 'ড্যাশবোর্ড' })).toBeVisible();
}

/** The add button, whichever of the two this width shows. */
async function pressAdd(page: Page, phoneLabel: string): Promise<void> {
  const compact = page.getByRole('button', { name: 'নতুন', exact: true });
  const full = page.getByRole('button', { name: phoneLabel, exact: true });
  await ((await compact.isVisible()) ? compact : full).click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

test.describe('responsive shell', () => {
  test('carries the brand on a tab root and the page name inside', async ({ page }) => {
    /* An installed app opening with nothing but the word ড্যাশবোর্ড could be
       anybody's, and the home-screen icon is the only other place the brand
       appears. On a screen you navigated *into*, "where am I" is worth more
       than "whose app is this" — which by then the person knows.

       Phones only: the bar is `md:hidden`, because from 768px up the sidebar is
       on screen and already carries the mark. Asserting it at every width would
       be asserting the sidebar's copy, which is a different thing. */
    await signup(page);
    if ((page.viewportSize()?.width ?? 0) >= 768) return;

    const bar = page.locator('header').first();
    /* Both: whose app this is, and where in it you are. Showing only the brand
       answered the first question by dropping the second, which is what the bar
       existed for. */
    await expect(bar.getByText('Taka Tracker')).toBeVisible();
    await expect(bar.getByRole('heading')).toContainText('ড্যাশবোর্ড');

    await page.goto('/settings');
    await expect(page.locator('header').first().getByText('Taka Tracker')).toHaveCount(0);
    await expect(page.locator('header').first().getByRole('heading')).toContainText('সেটিংস');
  });

  test('shows the bottom tab bar below 768px and the sidebar above it', async ({
    page,
  }, testInfo) => {
    await signup(page);
    const width = page.viewportSize()?.width ?? 0;

    if (width < 768) {
      await expect(page.getByTestId('bottom-nav')).toBeVisible();
      await expect(page.getByTestId('sidebar')).toBeHidden();
    } else {
      await expect(page.getByTestId('sidebar')).toBeVisible();
      await expect(page.getByTestId('bottom-nav')).toBeHidden();
    }

    testInfo.annotations.push({ type: 'viewport', description: String(width) });
  });

  test('never scrolls horizontally, tables included', async ({ page }) => {
    await signup(page);

    for (const path of ['/', '/transactions', '/accounts', '/settings']) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(
        overflow.scrollWidth,
        `${path} overflows at ${page.viewportSize()?.width}px`,
      ).toBeLessThanOrEqual(overflow.clientWidth + 1);
    }
  });

  test('the entry sheet never overflows sideways either', async ({ page }) => {
    /* The page-level check above never opened a dialog, which is exactly where
       this was reported from: a phone screenshot with the keypad's third
       column, the amount and the tab strip all cut off at the same right edge.
       A sheet is `position: fixed` and can be wider than the document without
       the document itself scrolling, so it has to be measured on its own. */
    await signup(page);
    await page.goto('/accounts');
    await pressAdd(page, 'নতুন অ্যাকাউন্ট যোগ করুন');
    await page.getByLabel('নাম').fill('নগদ');
    await page.getByRole('button', { name: 'সংরক্ষণ করুন', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeHidden();

    await page.goto('/transactions');
    await page.getByRole('button', { name: 'নতুন লেনদেন' }).first().click();
    const sheet = page.getByRole('dialog');
    await expect(sheet).toBeVisible();
    await page.waitForLoadState('networkidle');

    const viewport = page.viewportSize()?.width ?? 0;
    const box = await sheet.boundingBox();
    expect(box, 'the sheet should be laid out').not.toBeNull();
    expect(box!.x, `sheet starts off-screen at ${viewport}px`).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width, `sheet runs past ${viewport}px`).toBeLessThanOrEqual(viewport + 1);

    /* And nothing inside it sticks out — a `chip-strip` scrolls on purpose, so
       the check is on the sheet's own scroll width, not on every descendant. */
    const inner = await sheet.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    expect(inner.scrollWidth, `sheet content overflows at ${viewport}px`).toBeLessThanOrEqual(
      inner.clientWidth + 1,
    );
  });

  test('every nav target is at least 44x44', async ({ page }) => {
    await signup(page);
    const width = page.viewportSize()?.width ?? 0;
    // The sidebar wraps the brand link outside <nav>; only nav targets count.
    const container = page.getByTestId(width < 768 ? 'bottom-nav' : 'sidebar');
    const links = (width < 768 ? container : container.getByRole('navigation')).getByRole('link');

    for (let i = 0; i < (await links.count()); i += 1) {
      const box = await links.nth(i).boundingBox();
      expect(box, 'nav link should be laid out').not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(TAP_TARGET_MIN);
      expect(box!.width).toBeGreaterThanOrEqual(TAP_TARGET_MIN);
    }
  });

  test('serves an installable manifest and an offline page', async ({ page, request }) => {
    const manifest = await request.get('/manifest.webmanifest');
    expect(manifest.ok()).toBeTruthy();
    const body = (await manifest.json()) as {
      display: string;
      icons: { sizes: string; purpose?: string }[];
      start_url: string;
    };
    expect(body.display).toBe('standalone');
    expect(body.icons.map((i) => i.sizes)).toContain('192x192');
    expect(body.icons.map((i) => i.sizes)).toContain('512x512');
    expect(body.icons.some((i) => i.purpose === 'maskable')).toBeTruthy();

    const sw = await request.get('/sw.js');
    expect(sw.ok()).toBeTruthy();
    expect(await sw.text()).toContain('DATA_CACHE');

    await page.goto('/offline');
    await expect(page.getByRole('heading', { name: 'এখন অফলাইন' })).toBeVisible();
  });

  test('queues a transaction made offline and shows the pending bar', async ({ page }) => {
    await signup(page);

    await page.goto('/accounts');
    await page.getByRole('button', { name: 'নতুন', exact: true }).click();
    await page.getByLabel('নাম').fill('নগদ');
    await page.getByRole('button', { name: 'সংরক্ষণ করুন' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(page.locator('li').filter({ hasText: 'নগদ' }).first()).toBeVisible();

    await page.context().setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));

    await page.getByRole('button', { name: 'নতুন লেনদেন' }).first().click();
    await page.getByLabel('পরিমাণ (৳)').fill('99');
    await page.getByLabel('ক্যাটাগরি').selectOption({ label: 'যাতায়াত' });
    await page.getByRole('button', { name: 'সংরক্ষণ করুন' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();

    await expect(page.getByTestId('offline-bar')).toContainText('অপেক্ষমাণ');

    await page.context().setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));

    await expect(page.getByTestId('offline-bar')).toBeHidden({ timeout: 15_000 });
    await page.goto('/transactions');
    await expect(page.getByText('-৳99.00').first()).toBeVisible();
  });
});
