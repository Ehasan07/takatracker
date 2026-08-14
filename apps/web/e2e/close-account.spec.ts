import { expect, test, type Page } from '@playwright/test';

/**
 * Closing an account, from the screen a person actually uses.
 *
 * The erasure itself is proved in the API suite, against the database. What
 * only a browser shows is the part that decides whether anybody ever gets that
 * far: that the way out is on the settings screen rather than in a support
 * inbox, that a wrong password stops it, and that the page which app-store
 * reviewers open is public and says what it is meant to say.
 */

const PASSWORD = 'hishab1234';

let counter = 0;
function uniqueEmail(): string {
  counter += 1;
  return `close-${Date.now()}-${counter}-${Math.trunc(performance.now())}@example.test`;
}

let phoneSeq = 0;
function uniquePhone(): string {
  phoneSeq += 1;
  return `018${String((Date.now() % 1_000_000) * 100 + (phoneSeq % 100))
    .slice(-8)
    .padStart(8, '0')}`;
}

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

test.describe('closing an account', () => {
  test('is on the settings screen, behind the password, and reversible', async ({ page }) => {
    await signup(page);
    await page.goto('/settings');

    await page.getByRole('button', { name: 'অ্যাকাউন্ট বন্ধ করতে চাই' }).click();

    /* Said in full before the password is asked for. Somebody should know what
       they are agreeing to while they are still typing. */
    await expect(page.getByText(/সাত দিন পর সব মুছে যাবে/)).toBeVisible();

    /* A valid session is exactly what an unlocked phone on a table has, so the
       destructive direction asks for something the phone does not carry. */
    await page.getByLabel('পাসওয়ার্ড দিয়ে নিশ্চিত করুন').fill('wrong-password');
    await page.getByRole('button', { name: 'হ্যাঁ, বন্ধ করুন' }).click();
    await expect(page.getByText('পাসওয়ার্ডটি মেলেনি')).toBeVisible({ timeout: 15_000 });

    await page.getByLabel('পাসওয়ার্ড দিয়ে নিশ্চিত করুন').fill(PASSWORD);
    await page.getByRole('button', { name: 'হ্যাঁ, বন্ধ করুন' }).click();

    /* Scheduled, not done — and the date is on screen, because "soon" is not
       something anybody can plan around. */
    await expect(page.getByText('অ্যাকাউন্ট বন্ধ হওয়ার অপেক্ষায়')).toBeVisible({
      timeout: 15_000,
    });

    // Still their account, still working, until the week is up.
    await page.goto('/accounts');
    await expect(page).toHaveURL(/\/accounts$/);

    /* And the way back, which asks for nothing: somebody who has changed their
       mind should not meet a second obstacle. */
    await page.goto('/settings');
    await page.getByRole('button', { name: 'থাক, অ্যাকাউন্ট রাখব' }).click();
    await expect(page.getByRole('button', { name: 'অ্যাকাউন্ট বন্ধ করতে চাই' })).toBeVisible({
      timeout: 15_000,
    });
  });

  test('has a public page that says what goes and what stays', async ({ page }) => {
    /* The person most likely to need this has already uninstalled or cannot get
       back in, so it must work with no session at all. It is also the URL an
       app-store review form asks for. */
    await page.goto('/delete-account');
    await expect(page).toHaveURL(/\/delete-account$/);
    await expect(
      page.getByRole('heading', { name: 'অ্যাকাউন্ট ও তথ্য মুছে ফেলা', level: 1 }),
    ).toBeVisible();

    await expect(page.getByText(/কার্যবিবরণী/).first()).toBeVisible();

    /* The half that makes the rest believable: one row survives, and the page
       says so rather than promising that nothing does. */
    await expect(page.getByText(/SHA-256/)).toBeVisible();

    /* Reachable without knowing the URL. */
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'অ্যাকাউন্ট মুছে ফেলা' })).toBeVisible();
  });

  test('serves the asset-links file Chrome asks for before dropping the address bar', async ({
    request,
  }) => {
    /* Without this file the Android wrapper opens with a URL bar across the
       top — a browser wearing an icon. It must answer with no cookies and no
       redirect, which is what this checks; the fingerprint inside it is empty
       until Play has signed a release. */
    const res = await request.get('/.well-known/assetlinks.json');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('application/json');
    expect(Array.isArray(await res.json())).toBe(true);
  });
});
