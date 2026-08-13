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

  test('offers a way in without a password, and asks for the code', async ({ page }) => {
    await page.goto('/login');

    /* Not a tab strip — one link that swaps the second field. */
    await page.getByRole('button', { name: 'পাসওয়ার্ড ছাড়া, ইমেইলে কোড নিয়ে ঢুকুন' }).click();
    await expect(page.getByLabel('পাসওয়ার্ড')).toBeHidden();

    await page.getByLabel('ইমেইল').fill(`nobody-${Date.now()}@example.test`);
    await page.getByRole('button', { name: 'কোড পাঠান' }).click();

    /* The API answers identically whether or not the address is registered, so
       the screen has to as well: it always moves on to the code box. A screen
       that stopped here for an unknown address would hand back exactly the
       enumeration oracle the route refuses to be. */
    await expect(page.getByLabel('ইমেইলে পাঠানো কোড')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'কোড দিয়ে ঢুকুন' })).toBeVisible();
  });

  test('and the password is still one tap away', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: 'পাসওয়ার্ড ছাড়া, ইমেইলে কোড নিয়ে ঢুকুন' }).click();
    await page.getByRole('button', { name: 'পাসওয়ার্ড দিয়ে ঢুকুন' }).click();
    await expect(page.getByLabel('পাসওয়ার্ড')).toBeVisible();
  });

  test('takes an email or a mobile number in one box', async ({ page }) => {
    await page.goto('/login');

    /* One box for both. Asking somebody to choose "email or phone" first is a
       decision about their own account they should not have to make, and a
       `type="email"` field would have the browser refuse a real, working
       Bangladeshi number before the request was ever built. */
    const box = page.getByLabel('ইমেইল বা মোবাইল নম্বর');
    await expect(box).toBeVisible();
    await expect(box).toHaveAttribute('type', 'text');

    await box.fill('01712345678');
    await page.getByLabel('পাসওয়ার্ড').fill('whatever-is-wrong');
    await page.getByRole('button', { name: 'লগইন', exact: true }).click();

    /* Refused, but for the password — not for the shape of what was typed.

       Matched on the message rather than on `getByRole('alert')`, which also
       finds Next's own route announcer — an empty `role="alert"` div that is in
       the page whether or not anything went wrong. Whenever it happened to be
       present this assertion failed on a strict-mode violation and looked like
       a broken login. */
    await expect(page.getByText('ইমেইল/মোবাইল বা পাসওয়ার্ড ভুল')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe('the password box', () => {
  test('can be looked at, and starts hidden', async ({ page }) => {
    /* Every one of these is filled on a phone keyboard, where a mis-hit is
       invisible until the form comes back "পাসওয়ার্ড ভুল" — and the person
       cannot tell whether they typed the wrong password or the right one
       badly. The usual next step is a reset nobody needed. */
    await page.goto('/login');

    const box = page.getByLabel('পাসওয়ার্ড');
    await expect(box).toHaveAttribute('type', 'password');

    const reveal = page.getByRole('button', { name: 'দেখান' });
    await expect(reveal).toBeVisible();
    await reveal.click();

    await expect(box).toHaveAttribute('type', 'text');
    await expect(page.getByRole('button', { name: 'লুকান' })).toBeVisible();
  });

  test('is hidden again on the next screen that asks for one', async ({ page }) => {
    /* Shoulders. Revealing is something somebody does deliberately, not a
       preference that follows them around. */
    await page.goto('/login');
    await page.getByRole('button', { name: 'দেখান' }).click();
    await expect(page.getByLabel('পাসওয়ার্ড')).toHaveAttribute('type', 'text');

    await page.goto('/signup');
    await expect(page.getByLabel('পাসওয়ার্ড')).toHaveAttribute('type', 'password');
  });
});
