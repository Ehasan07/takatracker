import { expect, test, type Page } from '@playwright/test';

/**
 * The guide, which is the one screen whose whole job is to be found.
 *
 * Two things can break it and neither shows up in a unit test:
 *
 * - **The way in.** A manual nobody can reach from Settings is a file in the
 *   repository, not a feature. So the test walks the route a person walks —
 *   Settings, then the link — rather than going straight to `/guide`.
 * - **The English half.** Every string on the page is `t(key, bengali)`, which
 *   falls back to Bengali when a key is missing from the catalogue. That
 *   fallback is a good failure mode everywhere else in the app and a silent one
 *   here, because a page of 120 strings hides a handful of untranslated ones
 *   perfectly. Switching the workspace to English and asserting there is not a
 *   single Bengali character left inside the page is what catches them.
 */

const PASSWORD = 'hishab1234';

let counter = 0;
function uniqueEmail(): string {
  counter += 1;
  return `help-${Date.now()}-${counter}-${Math.trunc(performance.now())}@example.test`;
}

/** Unique per signup: the mobile number is unique across accounts now. */
let phoneSeq = 0;
function uniquePhone(): string {
  phoneSeq += 1;
  return `018${String((Date.now() % 1_000_000) * 100 + (phoneSeq % 100))
    .slice(-8)
    .padStart(8, '0')}`;
}

async function signup(page: Page): Promise<void> {
  await page.goto('/signup');
  await page.getByLabel('নাম').fill('গাইড পরীক্ষা');
  await page.getByLabel('ইমেইল').fill(uniqueEmail());
  await page.getByLabel('পাসওয়ার্ড').fill(PASSWORD);
  await page.getByLabel('মোবাইল নম্বর').fill(uniquePhone());
  await page.getByRole('button', { name: 'অ্যাকাউন্ট খুলুন' }).click();
  await expect(page.getByRole('heading', { name: 'ড্যাশবোর্ড' }).first()).toBeVisible({
    timeout: 30_000,
  });
}

test.describe('the guide', () => {
  test('is reachable from settings and says where each thing lives', async ({ page }) => {
    await signup(page);

    await page.goto('/settings');
    await page.getByRole('link', { name: 'তালিকা দেখুন' }).click();

    const guide = page.getByTestId('guide');
    await expect(guide.getByRole('heading', { name: 'কী কী করা যায়', level: 1 })).toBeVisible();

    /* One entry from each end of the page, so a group quietly dropped from the
       array fails here rather than at the next person who looks for it.

       `exact`, because every entry's "where to find it" line names the screen
       too — কার্যবিবরণী appears as the title and again inside আরও → কার্যবিবরণী,
       and a substring match resolves to both. */
    await expect(guide.getByText('আয় ও খরচ লেখা', { exact: true })).toBeVisible();
    await expect(guide.getByText('কার্যবিবরণী', { exact: true })).toBeVisible();

    /* The half that is the reason the page is hand-written: not that splitting
       exists, but what it does to your own figures. */
    await expect(guide.getByText(/৳750 উঠবে/)).toBeVisible();

    /* And the way back, because this sits outside the tab bar's five. */
    await guide.getByRole('link', { name: 'সেটিংস' }).click();
    await expect(page.getByRole('heading', { name: 'প্ল্যান' })).toBeVisible();
  });

  test('is fully English for a workspace that reads English', async ({ page }) => {
    await signup(page);

    await page.goto('/settings');
    const english = page
      .getByRole('group', { name: 'ভাষা' })
      .getByRole('button', { name: 'English' });
    /* Disabled until the server has said which language the workspace is in. */
    await expect(english).toBeEnabled({ timeout: 15_000 });
    const reloaded = page.waitForEvent('load');
    await english.click();
    await reloaded;

    await page.goto('/help');
    const guide = page.getByTestId('guide');
    await expect(guide.getByRole('heading', { name: 'What this app can do' })).toBeVisible({
      timeout: 15_000,
    });

    /* The assertion the whole spec exists for. Any key missing from `en.ts`
       renders its Bengali fallback, and one Bengali codepoint anywhere in the
       page fails this.
       ৳ (U+09F3) is cut out of the range: it is the currency sign the English
       screens use too, so matching it would fail every build. */
    await expect(guide).not.toContainText(/[ঀ-৲৴-৿]/);
  });
});
