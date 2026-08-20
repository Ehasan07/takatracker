import { expect, test, type Page } from '@playwright/test';

/**
 * The way out, on a phone.
 *
 * Logging out lived in two places, and a phone could reach neither from every
 * screen: the account menu sat in the sidebar, which is `md:` and up, and the
 * button at the foot of /settings needed somebody to already be on /settings.
 *
 * For an operator that was not an inconvenience, it was a dead end. Their tab
 * bar is five admin destinations — সারসংক্ষেপ, গ্রাহক, বিশ্লেষণ, বার্তা,
 * প্যাকেজ — with no সেটিংস and no আরও, and the sidebar they would otherwise
 * have used is not drawn on a handset. A super-admin signed in on a phone had
 * no way to sign out short of typing a URL.
 */

/* The header this lives in is `md:hidden`, and `md` is 768px — so from w768 up
   the sidebar is what carries the control, and it is already covered there. */
const WIDE = ['w768', 'w1280'];

const PASSWORD = 'hishab1234';

let seq = 0;
const uniqueEmail = (): string => `out-${Date.now()}-${(seq += 1)}@example.test`;
const uniquePhone = (): string =>
  `016${String((Date.now() % 1_000_000) * 100 + (seq % 100))
    .slice(-8)
    .padStart(8, '0')}`;

async function signup(page: Page): Promise<void> {
  await page.goto('/signup');
  await page.getByLabel('নাম').fill('বিদায় পরীক্ষা');
  await page.getByLabel('ইমেইল').fill(uniqueEmail());
  await page.getByLabel('পাসওয়ার্ড').fill(PASSWORD);
  await page.getByLabel('মোবাইল নম্বর').fill(uniquePhone());
  await page.getByRole('button', { name: 'অ্যাকাউন্ট খুলুন' }).click();
  await expect(page.getByRole('heading', { name: 'ড্যাশবোর্ড' }).first()).toBeVisible({
    timeout: 30_000,
  });
}

test.describe('signing out', () => {
  test('is reachable from the top bar on any screen', async ({ page, isMobile }, testInfo) => {
    /* The header this lives in is `md:hidden`; above that the sidebar carries
       the same control and is already covered. */
    test.skip(WIDE.includes(testInfo.project.name), 'the sidebar carries it from md up');
    void isMobile;

    await signup(page);

    /* Not the dashboard — a screen deep in the app, where the header is in its
       back-button layout and the centred title must stay centred. */
    await page.goto('/reports/statements');
    await expect(page.getByRole('heading', { name: 'আর্থিক বিবৃতি' })).toBeVisible({
      timeout: 20_000,
    });

    await page.getByRole('button', { name: 'অ্যাকাউন্ট' }).click();
    await page.getByRole('menuitem', { name: 'লগআউট' }).click();

    await expect(page).toHaveURL(/\/login/, { timeout: 20_000 });
  });

  test('the menu opens downward, inside the screen', async ({ page }, testInfo) => {
    /* The sidebar's copy opens upward, which is right at the foot of a column
       and would put this one off the top of the phone. */
    test.skip(WIDE.includes(testInfo.project.name), 'the sidebar carries it from md up');

    await signup(page);
    await page.getByRole('button', { name: 'অ্যাকাউন্ট' }).click();

    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    const box = await menu.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThan(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  });
});
