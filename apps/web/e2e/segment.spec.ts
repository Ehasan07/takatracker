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

/**
 * Opt-in, from settings. Most households have no shop, and for them the whole
 * apparatus is clutter — so nothing about it exists until somebody says it does.
 */
async function enableBusiness(page: Page): Promise<void> {
  await page.goto('/settings');
  /* `section` and not `getByRole('region')`: a section only takes that role
     when it carries an accessible name, and this one is titled by a plain
     heading. */
  const card = page.locator('section').filter({ hasText: 'ব্যক্তিগত ব্যবসা বা শেয়ার ট্রেডিং' });
  await card.getByRole('button', { name: 'চালু করুন' }).click();
  await expect(card.getByRole('button', { name: 'বন্ধ করুন' })).toBeVisible({ timeout: 15_000 });
}

test.describe('a personal business', () => {
  test('stays out of the way until somebody asks for it', async ({ page }) => {
    await signup(page);

    /* No link on the reports screen, and the page itself says where the switch
       is rather than showing a report for a shop nobody runs. */
    await page.goto('/reports');
    await expect(page.getByRole('link', { name: 'ব্যক্তিগত ব্যবসার হিসাব' })).toBeHidden();

    await page.goto('/reports/segment');
    await expect(page.getByRole('heading', { name: 'এই হিসাবটি চালু করা নেই' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole('link', { name: 'সেটিংসে যান' })).toBeVisible();
  });

  test('is reachable from the reports screen and explains itself', async ({ page }) => {
    await signup(page);
    await enableBusiness(page);

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

    /* And the step that has to be taken before any of it is worth reading —
       which the app does itself, given a name. */
    await expect(page.getByRole('heading', { name: 'ব্যবসার হিসাব চালু করুন' })).toBeVisible();
    await expect(page.getByLabel('ব্যবসার নাম')).toBeVisible();

    await guide.click();
    await expect(guide).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('heading', { name: 'সেটআপ — একবারের কাজ' })).toBeHidden();
  });

  test('says under which rule, for whoever wants to check', async ({ page }) => {
    await signup(page);
    await enableBusiness(page);
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

  test('offers the one press to a workspace that already has tags', async ({ page }) => {
    /* The bug this replaces: the setup card appeared only when the workspace
       had *no tags at all*. Almost everybody has tags — পারিবারিক, রমজান, a
       trip — so the one press this page exists to offer was unreachable for
       exactly the people most likely to want it. The real question is whether
       the business categories exist, not whether any tag does. */
    await signup(page);
    await enableBusiness(page);

    await page.goto('/tags');
    await page.getByRole('button', { name: 'প্রথম ট্যাগ বানান' }).click();
    const tagSheet = page.getByRole('dialog');
    await tagSheet.getByLabel('নাম', { exact: true }).fill('পারিবারিক');
    await tagSheet.getByRole('button', { name: 'সংরক্ষণ করুন', exact: true }).click();
    await expect(tagSheet).toBeHidden({ timeout: 15_000 });

    await page.goto('/reports/segment');
    await expect(page.getByRole('heading', { name: 'ব্যবসার হিসাব চালু করুন' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByLabel('ব্যবসার নাম')).toBeVisible();
  });

  test('builds the whole tree in one press, then counts the stock', async ({ page }) => {
    await signup(page);
    await enableBusiness(page);

    /* The stock sits in an asset account, and buying into it is a transfer —
       so ৳40,000 of opening stock is a balance, not a cost. */
    await page.goto('/accounts');
    await page.getByRole('main').getByRole('button', { name: 'নতুন', exact: true }).click();
    const sheet = page.getByRole('dialog');
    await expect(sheet.getByLabel('নাম', { exact: true })).toBeVisible();
    await sheet.getByLabel('নাম', { exact: true }).fill('মজুদ পণ্য');
    await sheet.getByLabel('ধরন').selectOption('ASSET');
    await sheet.getByLabel('কী ধরনের সম্পদ').selectOption('OTHER');
    await sheet.getByLabel('প্রারম্ভিক জের (৳)').fill('40000');
    await sheet.getByRole('button', { name: 'সংরক্ষণ করুন', exact: true }).click();
    await expect(sheet).toBeHidden({ timeout: 15_000 });

    await page.goto('/reports/segment');

    /* Eighteen categories and a tag, and the only thing asked for is the name.
       Typing them by hand is twenty minutes and a dozen chances to file a
       share purchase under খরচ. */
    await page.getByLabel('ব্যবসার নাম').fill('দোকান');
    await page.getByRole('button', { name: 'তৈরি করে দিন' }).click();
    /* The confirmation has to outlive the card that produced it: the card is
       gone the moment it succeeds, because the tag list it was waiting for
       arrives and the empty state stops rendering. */
    await expect(page.getByText('ট্যাগ তৈরি হয়েছে', { exact: false })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByLabel('কোন ব্যবসা বা কাজ')).toHaveValue(/.+/);

    /* "দুইটা ব্যবসা থাকলে দুইবার, দুই নামে" — so the button that does it cannot
       be a thing that appears once and never again. */
    await expect(page.getByRole('button', { name: 'নতুন ব্যবসা যোগ করুন' })).toBeVisible();

    await page.getByRole('button', { name: 'মাস শেষে মজুদ গুনুন' }).click();
    const count = page.getByRole('dialog');
    await expect(count.getByText('খাতা অনুযায়ী মজুদ')).toBeVisible({ timeout: 15_000 });
    /* The figure being contradicted, shown before the box that contradicts it. */
    await expect(count.getByText('৳40,000.00', { exact: false })).toBeVisible();

    await count.getByLabel('গুনে যা পেলেন (৳)').fill('25000');
    await expect(count.getByText('বিক্রীত পণ্যের ব্যয় হবে')).toBeVisible();

    await count.getByRole('button', { name: 'হিসাবে বসিয়ে দিন' }).click();
    await expect(count.getByText('বিক্রীত পণ্যের ব্যয় হিসেবে বসেছে')).toBeVisible({
      timeout: 20_000,
    });
    await expect(count.getByText('৳15,000.00', { exact: false })).toBeVisible();
  });
});
