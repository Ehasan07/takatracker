import { expect, test, type Page } from '@playwright/test';

/**
 * The personal-business screen, and the guide behind it.
 *
 * The API suite proves the arithmetic — that one tag's income less its costs is
 * the profit, and that the household statement is left whole. What a browser
 * has to prove is different and is the whole point of this screen: that
 * somebody who has never kept a set of books can find out *how*. The guide is
 * the feature here, so the test presses it.
 */

const PASSWORD = 'hishab1234';

let seq = 0;
const uniqueEmail = (): string => `seg-${Date.now()}-${(seq += 1)}@example.test`;
const uniquePhone = (): string =>
  `016${String((Date.now() % 1_000_000) * 100 + (seq % 100))
    .slice(-8)
    .padStart(8, '0')}`;

async function signup(page: Page): Promise<void> {
  await page.goto('/signup');
  await page.getByLabel('নাম').fill('ব্যবসা পরীক্ষা');
  await page.getByLabel('ইমেইল').fill(uniqueEmail());
  await page.getByLabel('পাসওয়ার্ড').fill(PASSWORD);
  await page.getByLabel('মোবাইল নম্বর').fill(uniquePhone());
  await page.getByRole('button', { name: 'অ্যাকাউন্ট খুলুন' }).click();
  await expect(page.getByRole('heading', { name: 'ড্যাশবোর্ড' }).first()).toBeVisible({
    timeout: 30_000,
  });
}

test.describe('a personal business', () => {
  test('is reachable from the reports screen and explains itself', async ({ page }) => {
    await signup(page);

    await page.goto('/reports');
    await page.getByRole('link', { name: 'ব্যক্তিগত ব্যবসার হিসাব' }).click();

    await expect(page.getByRole('heading', { name: 'ব্যক্তিগত ব্যবসার হিসাব' })).toBeVisible({
      timeout: 15_000,
    });

    /* A workspace with no tags has nothing this page can draw, so the guide is
       what the page *is* for that person and it opens on its own. */
    const guide = page.getByRole('button', {
      name: 'ব্যক্তিগত ব্যবসার হিসাব কীভাবে রাখবেন',
    });
    await expect(guide).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('heading', { name: 'সেটআপ — একবারের কাজ' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'শেয়ার কেনাবেচা' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'দোকান বা মুদির ব্যবসা' })).toBeVisible();

    /* And the step that has to be taken before any of it is worth reading. */
    await expect(page.getByRole('heading', { name: 'আগে একটা ট্যাগ বানান' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'ট্যাগ পাতায় যান' })).toBeVisible();

    await guide.click();
    await expect(guide).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('heading', { name: 'সেটআপ — একবারের কাজ' })).toBeHidden();
  });

  test('says under which rule, for whoever wants to check', async ({ page }) => {
    await signup(page);
    await page.goto('/reports/segment');

    /* The ⓘ beside the title. Its accessible name says which note it is,
       because a page carrying several must not offer several controls all
       called the same thing. */
    const note = page.getByRole('button', { name: /ব্যবসা আলাদা করে দেখা/ });
    await expect(note).toHaveAttribute('aria-expanded', 'false');
    await note.click();
    await expect(note).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByText('IFRS 8.5')).toBeVisible();
  });
});
