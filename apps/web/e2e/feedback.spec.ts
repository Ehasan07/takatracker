import { expect, test, type Page } from '@playwright/test';

/**
 * Two things a unit test in this repo cannot reach, because Vitest runs in
 * Node with no DOM:
 *
 *  1. **The way in, and the round trip.** A feedback form nobody can find from
 *     the app is a file in the repository. So this walks the route a person
 *     walks — Settings, the link, type, send — rather than posting to the API.
 *  2. **The ⓘ notes as a control.** `aria-expanded` flipping, Space and Enter
 *     pressing a real button, a 44px target, and the note not pushing the page
 *     sideways at 320px. Every one of those is a property of a rendered
 *     browser, and every one of them is what makes the disclosure usable rather
 *     than merely present.
 */

const PASSWORD = 'hishab1234';
const TAP_TARGET_MIN = 43.99;

let counter = 0;
function uniqueEmail(): string {
  counter += 1;
  return `feedback-${Date.now()}-${counter}-${Math.trunc(performance.now())}@example.test`;
}

/** Unique per signup: the mobile number is unique across accounts. */
let phoneSeq = 0;
function uniquePhone(): string {
  phoneSeq += 1;
  return `018${String((Date.now() % 1_000_000) * 100 + (phoneSeq % 100))
    .slice(-8)
    .padStart(8, '0')}`;
}

async function signup(page: Page): Promise<void> {
  await page.goto('/signup');
  await page.getByLabel('নাম').fill('মতামত পরীক্ষা');
  await page.getByLabel('ইমেইল').fill(uniqueEmail());
  await page.getByLabel('পাসওয়ার্ড').fill(PASSWORD);
  await page.getByLabel('মোবাইল নম্বর').fill(uniquePhone());
  await page.getByRole('button', { name: 'অ্যাকাউন্ট খুলুন' }).click();
  await expect(page.getByRole('heading', { name: 'ড্যাশবোর্ড' }).first()).toBeVisible({
    timeout: 30_000,
  });
}

/** Nothing on any screen may make the page itself scroll sideways (spec §5). */
async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    return root.scrollWidth - root.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(1);
}

test.describe('sending feedback', () => {
  test('is reachable from settings, and says it arrived', async ({ page }) => {
    await signup(page);

    await page.goto('/settings');
    await page.getByRole('link', { name: 'মতামত লিখুন' }).click();

    const form = page.getByTestId('feedback');
    await expect(form.getByRole('heading', { name: 'মতামত পাঠান', level: 1 })).toBeVisible();

    /* The link carries where they came from, and the screen says so rather than
       collecting it quietly. */
    await expect(form.getByText('/settings')).toBeVisible();

    await page.getByLabel('কী নিয়ে বলছেন').selectOption('PROBLEM');
    await page
      .getByLabel('কী বলতে চান')
      .fill('স্থিতিপত্রের নিট সম্পদ আর ড্যাশবোর্ডের সংখ্যা মিলছে না।');
    await page.getByRole('button', { name: 'পাঠান' }).click();

    await expect(page.getByTestId('feedback-sent')).toBeVisible();
    await expect(page.getByText('পৌঁছে গেছে')).toBeVisible();

    /* And a way to say the next thing, because the second report is the one
       people swallow when the form disappears. */
    await page.getByRole('button', { name: 'আরেকটা কথা আছে' }).click();
    await expect(page.getByLabel('কী বলতে চান')).toBeVisible();

    await expectNoSidewaysScroll(page);
  });

  test('refuses an empty message before it costs a round trip', async ({ page }) => {
    await signup(page);
    await page.goto('/feedback');

    await page.getByRole('button', { name: 'পাঠান' }).click();
    /* Scoped to the form: Next's own route announcer is a `role="alert"` on
       every page, so an unscoped one matches two elements and fails strict
       mode rather than the assertion. */
    await expect(page.getByTestId('feedback').getByRole('alert')).toContainText(
      'খালি পাঠানো যাবে না',
    );
    /* Still on the form, with nothing sent. */
    await expect(page.getByTestId('feedback-sent')).toHaveCount(0);
  });

  test('is reachable from the guide, which has been telling people to write in', async ({
    page,
  }) => {
    await signup(page);
    await page.goto('/help');
    await page.getByRole('link', { name: 'মতামত লিখুন' }).click();
    await expect(page.getByTestId('feedback')).toBeVisible();
    await expect(page.getByText('/help')).toBeVisible();
  });
});

test.describe('the ⓘ notes on the statements', () => {
  /**
   * The disclosure, tested as a control rather than as text.
   *
   * `cashBasis` is the one chosen because it is the claim every other figure on
   * the page rests on: if only one note is ever opened, it is that one.
   */
  const CASH_BASIS = 'নগদ ভিত্তি — কেন এভাবে দেখানো হয়';

  test('open on a press, say which standard, and close again', async ({ page }) => {
    await signup(page);
    await page.goto('/reports/statements');
    await expect(page.getByRole('heading', { name: 'আর্থিক বিবৃতি', level: 1 })).toBeVisible();

    const trigger = page.getByRole('button', { name: CASH_BASIS });
    await expect(trigger).toBeVisible();

    /* Closed to begin with, and saying so — the state has to be announced, not
       only drawn. */
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');

    const panelId = await trigger.getAttribute('aria-controls');
    expect(panelId).toBeTruthy();
    /* `aria-controls` resolves to a real element even while closed, which is
       the whole reason the panel is hidden rather than unmounted.

       An attribute selector rather than `#id`: React's `useId` produces
       `«r1»`-style ids that are not valid CSS identifiers, and `CSS.escape`
       lives in the browser, not in the Node process this file runs in. */
    const panel = page.locator(`[id="${panelId!}"]`);
    await expect(panel).toHaveCount(1);
    await expect(panel).toBeHidden();

    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(panel).toBeVisible();
    /* The reference is the point of the note. Without it there is nothing for a
       reader to go and check. */
    await expect(panel).toContainText('IAS 1.27');
    /* And the explanation, not only the citation. A note that cites a standard
       without saying what it means in a household is a footnote for an
       accountant, which is the reader this one is not for. */
    await expect(panel).toContainText('হাতবদল');

    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(panel).toBeHidden();
  });

  test('are reachable and pressable from the keyboard alone', async ({ page }) => {
    await signup(page);
    await page.goto('/reports/statements');

    const trigger = page.getByRole('button', { name: CASH_BASIS });
    await expect(trigger).toBeVisible();

    /* Focusable at all — a `<div onClick>` would fail here, and so would a
       button with `tabindex="-1"`. */
    await trigger.focus();
    await expect(trigger).toBeFocused();

    /* Both keys, because a real button answers to both and an element faking
       one usually answers to neither. */
    await page.keyboard.press('Enter');
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Space');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  test('each carry their own name, and each open on their own', async ({ page }) => {
    await signup(page);
    await page.goto('/reports/statements');

    /* Seven notes on one page, so seven distinct accessible names: a screen
       reader user must be able to say which one they mean. */
    const names = [
      'নগদ ভিত্তি',
      'চলতি ও অচলতি',
      'তিন ভাগে নগদ প্রবাহ',
      'পুনর্মূল্যায়ন',
      'সম্পদের ধরন',
      'অবচয়',
      'বিক্রির লাভ',
    ];
    for (const name of names) {
      await expect(
        page.getByRole('button', { name: `${name} — কেন এভাবে দেখানো হয়` }),
        name,
      ).toHaveCount(1);
    }

    /* Not an accordion. Somebody comparing the cash-flow note against the
       revaluation note wants both open, and shutting one behind their back
       reads as a bug. */
    const flow = page.getByRole('button', { name: 'তিন ভাগে নগদ প্রবাহ — কেন এভাবে দেখানো হয়' });
    const reval = page.getByRole('button', { name: 'পুনর্মূল্যায়ন — কেন এভাবে দেখানো হয়' });
    await flow.click();
    await reval.click();
    await expect(flow).toHaveAttribute('aria-expanded', 'true');
    await expect(reval).toHaveAttribute('aria-expanded', 'true');
  });

  test('are a 44px target, and never push the page sideways', async ({ page }) => {
    await signup(page);
    await page.goto('/reports/statements');

    const trigger = page.getByRole('button', { name: CASH_BASIS });
    const box = await trigger.boundingBox();
    expect(box).not.toBeNull();
    /* Compared in CSS pixels: a box laid out as exactly 2.75rem comes back as
       43.99998474121094 often enough to fail a run at random. */
    expect(box!.width).toBeGreaterThanOrEqual(TAP_TARGET_MIN);
    expect(box!.height).toBeGreaterThanOrEqual(TAP_TARGET_MIN);

    await expectNoSidewaysScroll(page);
    /* The note is the widest thing either of these cards will ever hold, so
       opening every one of them at the narrowest width is the real test of the
       `basis-full` layout. */
    for (const button of await page.getByRole('button', { name: /কেন এভাবে দেখানো হয়/ }).all()) {
      await button.click();
    }
    await expectNoSidewaysScroll(page);
  });
});
