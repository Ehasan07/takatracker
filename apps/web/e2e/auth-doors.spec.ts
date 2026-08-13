import { expect, test } from '@playwright/test';

/**
 * The three ways in, and the one way back.
 *
 * There was no browser test on `/login` at all, which is how the password
 * reset came to be finished and unreachable: the page, the API route and the
 * emailed link had all existed for weeks, and nothing on any screen linked to
 * them. A route that works and cannot be found is not a feature, and only a
 * test that walks the door rather than the destination can tell the difference.
 */

test.describe('the way in', () => {
  test('offers a way back for a forgotten password, and it goes somewhere real', async ({
    page,
  }) => {
    await page.goto('/login');

    const forgot = page.getByRole('link', { name: 'পাসওয়ার্ড ভুলে গেছেন?' });
    await expect(forgot).toBeVisible();
    await forgot.click();

    await expect(page).toHaveURL(/\/forgot/);
    /* Not just that the URL changed — that the page it landed on can actually
       take an address. A route that renders an error is still a dead end. */
    await expect(page.getByLabel('ইমেইল')).toBeVisible();
  });

  test('and a way to a new account', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('link', { name: 'নতুন অ্যাকাউন্ট খুলুন' }).click();
    await expect(page).toHaveURL(/\/signup/);
  });

  test('is branded Taka Tracker, which is the first thing anybody sees', async ({ page }) => {
    await page.goto('/login');
    /* The product was renamed from হিসাব; the sidebar and the email subject
       were changed at the time and this heading was missed. It is the first
       screen a new customer ever looks at. */
    await expect(page.getByRole('heading', { name: 'Taka Tracker' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'হিসাব', exact: true })).toBeHidden();
  });

  test('asking for a reset says the same thing whether or not the address exists', async ({
    page,
  }) => {
    /* The API answers identically either way on purpose — a different message
       would turn this form into a way of finding out who has an account. The
       screen must not undo that by rendering the two differently. */
    await page.goto('/forgot');
    await page.getByLabel('ইমেইল').fill(`nobody-${Date.now()}@example.test`);
    await page.getByRole('button', { name: 'লিংক পাঠান' }).click();

    await expect(page.getByRole('heading', { name: 'দেখে নিন আপনার ইমেইল' })).toBeVisible({
      timeout: 15_000,
    });
    /* The page says out loud why the answer is the same either way. That
       sentence is the feature, not decoration around it. */
    await expect(page.getByText('অ্যাকাউন্ট আছে কি নেই', { exact: false })).toBeVisible();
  });
});
