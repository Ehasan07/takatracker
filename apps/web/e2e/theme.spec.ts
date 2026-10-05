import { expect, test, type Page } from '@playwright/test';

/**
 * The four themes, in a browser.
 *
 * The palettes themselves are unit-tested — `src/lib/theme.test.ts` parses
 * `tokens.css` and checks every face for contrast, for a complete token set and
 * for green still meaning money in. What only a real browser can show is the
 * plumbing around them: that a tap actually repaints the app rather than only
 * the settings screen, that the choice is still there after a reload and on a
 * route that has never heard of the picker, that the boot script beats the
 * first paint, and that no palette pushes the page sideways.
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
  return `theme-${Date.now()}-${counter}-${Math.trunc(performance.now())}@example.test`;
}

async function signup(page: Page): Promise<void> {
  await page.goto('/signup');
  /* The first navigation of a run meets a server that has served nothing yet,
     and a submit that lands before the form has hydrated is swallowed without
     a trace — the page simply sits there until the assertion times out. This
     cost one flaky first test before it was added. */
  await page.waitForLoadState('networkidle');
  await page.getByLabel('নাম').fill('থিম পরীক্ষা');
  await page.getByLabel('ইমেইল').fill(uniqueEmail());
  await page.getByLabel('পাসওয়ার্ড').fill('hishab1234');
  await page.getByLabel('মোবাইল নম্বর').fill(uniquePhone());
  await page.getByRole('button', { name: 'অ্যাকাউন্ট খুলুন' }).click();
  await expect(page.getByRole('heading', { name: 'ড্যাশবোর্ড' }).first()).toBeVisible({
    timeout: 30_000,
  });
}

/** What the page is actually painted in, rather than what it was asked for. */
async function paint(page: Page): Promise<{
  theme: string | null;
  mode: string | null;
  paper: string;
  ink: string;
}> {
  return page.evaluate(() => {
    const root = document.documentElement;
    const style = getComputedStyle(root);
    return {
      theme: root.getAttribute('data-theme'),
      mode: root.getAttribute('data-mode'),
      paper: style.getPropertyValue('--hishab-paper').trim(),
      ink: style.getPropertyValue('--hishab-ink').trim(),
    };
  });
}

/** `#f7f7f7` the way `getComputedStyle` hands a painted colour back. */
function rgb(hex: string): string {
  const channel = (at: number): number => parseInt(hex.slice(at, at + 2), 16);
  return `rgb(${channel(1)}, ${channel(3)}, ${channel(5)})`;
}

async function choose(page: Page, testId: string): Promise<void> {
  const button = page.getByTestId(testId);
  await button.scrollIntoViewIfNeeded();
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
}

test.describe('themes', () => {
  test('a tap repaints the app, not just the settings screen', async ({ page }) => {
    await signup(page);
    await page.goto('/settings');

    const before = await paint(page);
    expect(before.theme).toBe('default');

    await choose(page, 'theme-mono');
    const after = await paint(page);
    expect(after.theme).toBe('mono');
    /* The tokens moved, which is the only definition of "the colours changed"
       that does not depend on which element happens to be on screen. */
    expect(after.paper).not.toBe(before.paper);

    /* And the actual pixels. `bg-surface` on a card resolves through the same
       variables, so if the cascade were wired to the wrong selector this is
       where it would show. */
    const card = page.getByTestId('theme-preview');
    await expect(card).toBeVisible();
    const monoCard = await card.evaluate((el) => getComputedStyle(el).backgroundColor);

    /* A screen that has never heard of the picker. The theme lives on <html>,
       so this is the check that it is the app's and not the section's. */
    await page.goto('/transactions');
    const elsewhere = await paint(page);
    expect(elsewhere.theme).toBe('mono');
    const body = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(body).toBe(rgb(elsewhere.paper));

    await page.goto('/settings');
    await choose(page, 'theme-calm');
    expect(await card.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(monoCard);
  });

  test('the choice survives a reload, and arrives before the first paint', async ({ page }) => {
    await signup(page);
    await page.goto('/settings');
    await choose(page, 'theme-contrast');
    await choose(page, 'mode-dark');

    await page.reload();
    const reloaded = await paint(page);
    expect(reloaded.theme).toBe('contrast');
    expect(reloaded.mode).toBe('dark');
    await expect(page.getByTestId('theme-contrast')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('mode-dark')).toHaveAttribute('aria-pressed', 'true');

    /**
     * No flash of the wrong theme.
     *
     * The attribute is set by a blocking script in the head, so it is already
     * on `<html>` in the markup the parser is still working through — which is
     * strictly earlier than anything React can do. Catching it at
     * `domcontentloaded`, with the page's own scripts still to run, is as close
     * as a test can stand to "before the first paint": if the theme were
     * applied from an effect instead, this read would come back `default`.
     */
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const early = await paint(page);
    expect(early.theme).toBe('contrast');
    expect(early.mode).toBe('dark');
  });

  test('light until somebody chooses otherwise, and the system only when asked', async ({
    browser,
  }) => {
    /* A reader who has expressed no preference gets the light face even on a
       dark-mode phone; `dark` is their choice to make, and `system` hands it
       to the OS — the phone flipping to dark at sunset still works for anybody
       who asks for that. */
    const context = await browser.newContext({ colorScheme: 'dark' });
    const page = await context.newPage();
    await signup(page);

    expect((await paint(page)).mode).toBe('light');

    await page.goto('/settings');
    await choose(page, 'mode-dark');
    expect((await paint(page)).mode).toBe('dark');
    await page.goto('/');
    expect((await paint(page)).mode).toBe('dark');

    await page.goto('/settings');
    await choose(page, 'mode-system');
    expect((await paint(page)).mode).toBe('dark');

    await page.goto('/settings');
    await choose(page, 'mode-light');
    expect((await paint(page)).mode).toBe('light');

    await context.close();
  });

  test('money in never looks like money out, in any of the four', async ({ page }) => {
    await signup(page);
    await page.goto('/settings');

    for (const theme of ['default', 'mono', 'contrast', 'calm']) {
      await choose(page, `theme-${theme}`);

      const income = page.getByTestId('theme-preview-in').locator('.money');
      const expense = page.getByTestId('theme-preview-out').locator('.money');

      /* The signal that is in every theme and needs no eyesight at all. */
      await expect(expense).toContainText('-');
      await expect(income).not.toContainText('-');

      const shown = await Promise.all(
        [income, expense].map((el) =>
          el.evaluate((node) => {
            const style = getComputedStyle(node);
            return { color: style.color, decoration: style.textDecorationLine };
          }),
        ),
      );

      /* Different colour, or — in the theme that has no colour to give — a rule
         under the outgoing figure. One of the two, in all four. */
      const distinct =
        shown[0]!.color !== shown[1]!.color || shown[1]!.decoration.includes('underline');
      expect(distinct, `${theme} renders money in and money out identically`).toBe(true);

      if (theme === 'mono') expect(shown[1]!.decoration).toContain('underline');
    }
  });

  /* One test per palette rather than one loop over four. A single test doing
     four signups' worth of navigation ran past the 45s ceiling and failed on
     the clock rather than on the layout, which is the least useful kind of red
     there is. */
  for (const theme of ['default', 'mono', 'contrast', 'calm']) {
    test(`${theme} breaks no layout`, async ({ page }) => {
      await signup(page);
      await page.goto('/settings');
      await choose(page, `theme-${theme}`);

      /* Every control this screen added, at the 44px floor. A two-line label in
         a one-line box is how a theme picker ships with buttons a thumb cannot
         hit, and the notes under the palette names are the longest strings on
         the page. `43.99` rather than `44` because a box laid out at exactly
         2.75rem is reported as 43.99998 often enough to fail a run at random. */
      const buttons = page.locator('button[data-testid^="theme-"], button[data-testid^="mode-"]');
      for (let i = 0; i < (await buttons.count()); i += 1) {
        const target = buttons.nth(i);
        const box = await target.boundingBox();
        expect(box, 'an appearance control should be laid out').not.toBeNull();
        expect(
          box!.height,
          `${await target.getAttribute('data-testid')} is ${box!.height}px tall in ${theme}`,
        ).toBeGreaterThanOrEqual(43.99);
      }

      for (const path of ['/settings', '/', '/transactions']) {
        await page.goto(path);
        await page.waitForLoadState('networkidle');
        const overflow = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }));
        expect(
          overflow.scrollWidth,
          `${theme} pushes ${path} sideways at ${page.viewportSize()?.width}px`,
        ).toBeLessThanOrEqual(overflow.clientWidth + 1);
      }
    });
  }
});
