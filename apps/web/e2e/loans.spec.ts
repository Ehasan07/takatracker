import { readFile } from 'node:fs/promises';
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * The loan screens end to end: the hub, one loan, its statement, its CSV and
 * the party ledger. Every test signs up its own workspace, so loan numbers
 * always start at L-0001 and nothing leaks between tests.
 *
 * Two facts about digits, both read off the components rather than guessed:
 *
 *   money  goes through <Money> → formatMinor, which is ASCII with South Asian
 *          grouping. A lakh is "৳1,00,000.00", never "৳100,000.00", and the
 *          decimals are there unless a call site passes `decimals={false}`
 *          (the loan rows and the dashboard tiles do; the headline figures do
 *          not).
 *   counts, serial numbers, percentages and dates go through toBengaliDigits:
 *          "৩টি কিস্তি", "৪৫%", "৩০ দিন পার হয়েছে".
 *
 * And one fact about layout: below 768px the payment history and the statement
 * are lists of cards, above it they are tables, and the other one is in the DOM
 * with `display: none`. Assertions on that content therefore go through
 * `useInnerText`, which sees only what is on the screen, so the same test reads
 * correctly at all four widths.
 */

const PASSWORD = 'hishab1234';

let counter = 0;
function uniqueEmail(): string {
  counter += 1;
  return `loans-${Date.now()}-${counter}-${Math.trunc(performance.now())}@example.test`;
}

async function signup(page: Page): Promise<void> {
  await page.goto('/signup');
  await page.getByLabel('নাম').fill('ঋণ পরীক্ষা');
  await page.getByLabel('ইমেইল').fill(uniqueEmail());
  await page.getByLabel('পাসওয়ার্ড').fill(PASSWORD);
  await page.getByRole('button', { name: 'অ্যাকাউন্ট খুলুন' }).click();
  // Argon2 is deliberately slow, and nine signups in a row on a loaded machine
  // can outlast the default expect timeout. Waiting is not flakiness.
  await expect(page.getByRole('heading', { name: 'ড্যাশবোর্ড' }).first()).toBeVisible({
    timeout: 30_000,
  });
}

/** Save the sheet and wait for it to close — navigating early aborts the POST. */
async function saveSheet(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name, exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
}

/** A loan has to come out of somewhere; a fresh workspace has no accounts. */
async function addCashAccount(page: Page, name = 'নগদ'): Promise<void> {
  await page.goto('/accounts');
  await page.getByRole('button', { name: 'নতুন', exact: true }).click();
  await page.getByLabel('নাম').fill(name);
  await saveSheet(page, 'সংরক্ষণ করুন');
  // Scope to the list: the account-type <select> carries these words too.
  await expect(page.locator('li').filter({ hasText: name }).first()).toBeVisible();
}

interface NewLoan {
  /** A name types a new person; `existingPerson` picks one already in the khata. */
  person?: string;
  existingPerson?: string;
  amount: string;
  direction?: 'BORROWED' | 'LENT';
  loanDate?: string;
  dueDate?: string;
}

/** Records a loan from the hub. Assumes /loans is already open. */
async function addLoan(page: Page, loan: NewLoan): Promise<void> {
  await page.getByRole('button', { name: 'নতুন', exact: true }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet).toBeVisible();

  await sheet.getByLabel('ধরন').selectOption(loan.direction ?? 'BORROWED');
  if (loan.existingPerson) {
    // The people list is built from the unfiltered loan list, which only loads
    // once the sheet is open; selectOption waits for the option to arrive.
    await sheet.getByLabel('কার সাথে').selectOption({ label: loan.existingPerson });
  } else {
    await sheet.getByLabel('নাম', { exact: true }).fill(loan.person ?? '');
  }
  await sheet.getByLabel('মূল টাকা (৳)').fill(loan.amount);
  // Order matters: the due date's `min` follows the loan date.
  if (loan.loanDate) await sheet.getByLabel('তারিখ', { exact: true }).fill(loan.loanDate);
  if (loan.dueDate) await sheet.getByLabel('ফেরতের শেষ তারিখ').fill(loan.dueDate);

  await saveSheet(page, 'সংরক্ষণ করুন');
}

/** One instalment. Assumes a loan detail page is open. */
async function addPayment(page: Page, amount: string, note?: string): Promise<void> {
  await page.getByRole('button', { name: 'কিস্তি যোগ করুন', exact: true }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet).toBeVisible();
  await sheet.getByLabel('পরিমাণ (৳)').fill(amount);
  if (note) await sheet.getByLabel('নোট').fill(note);
  await saveSheet(page, 'কিস্তি সংরক্ষণ করুন');
}

/** The value beside a <dt> in one of the summary grids. */
function stat(scope: Page | Locator, label: string): Locator {
  return scope.locator('dt', { hasText: label }).locator('~ dd');
}

/** One row of the hub list. */
function loanRow(page: Page, text: string): Locator {
  return page.getByRole('tabpanel').getByRole('listitem').filter({ hasText: text });
}

/** The dashboard card for one direction — a <button>, not the <button role="tab">. */
function summaryCard(page: Page, direction: 'BORROWED' | 'LENT'): Locator {
  return page
    .getByRole('button')
    .filter({ hasText: direction === 'BORROWED' ? 'আমি যা ধার নিয়েছি' : 'আমি যা ধার দিয়েছি' });
}

/** The payment history on a loan, cards or table depending on the width. */
function history(page: Page): Locator {
  return page.locator('section').filter({ hasText: 'কিস্তির হিসাব' });
}

/** The statement body: filters, opening/closing and the entries. */
function statement(page: Page): Locator {
  return page.locator('section').filter({ hasText: 'প্রারম্ভিক জের' });
}

/** Today where the browser lives (the config pins it to Asia/Dhaka). */
async function todayIso(page: Page): Promise<string> {
  return page.evaluate(() =>
    new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date()),
  );
}

function shiftIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

test.describe('loans', () => {
  test('borrows ৳100,000 from করিম, repays it in three instalments, and still owes ৳55,000', async ({
    page,
  }) => {
    await signup(page);
    await addCashAccount(page);

    await page.goto('/loans');
    await addLoan(page, { person: 'করিম', amount: '100000' });

    // The hub shows it before we ever open it.
    const row = loanRow(page, 'করিম');
    await expect(row).toBeVisible();
    await expect(row).toContainText('L-0001');
    await expect(row).toContainText('৳1,00,000');

    await row.getByRole('link').click();
    await expect(page).toHaveURL(/\/loans\/[^/]+$/);
    await expect(page.getByRole('heading', { name: 'করিম' })).toBeVisible();

    await addPayment(page, '20000');
    await addPayment(page, '15000');
    await addPayment(page, '10000');

    // ৳100,000 − ৳20,000 − ৳15,000 − ৳10,000 = ৳55,000 still owed.
    await expect(stat(page, 'বাকি')).toHaveText('৳55,000.00');
    await expect(stat(page, 'মোট ঋণ')).toHaveText('৳1,00,000.00');
    await expect(stat(page, 'পরিশোধিত')).toHaveText('৳45,000.00');

    // Three instalments, forty-five percent of the way there — Bengali digits.
    await expect(history(page)).toContainText('৩টি কিস্তি');
    await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '45');
    await expect(page.getByText('৪৫%')).toBeVisible();

    // And the running balance walks down the history, one instalment at a time.
    await expect(history(page)).toHaveText(
      /৳1,00,000\.00[\s\S]*৳80,000\.00[\s\S]*৳65,000\.00[\s\S]*৳55,000\.00/,
      { useInnerText: true },
    );
  });

  test('the dashboard tiles move when a loan is recorded and again when it is paid', async ({
    page,
  }) => {
    await signup(page);
    await addCashAccount(page);
    await page.goto('/loans');

    const borrowed = summaryCard(page, 'BORROWED');
    await expect(borrowed).toContainText('০টি');
    await expect(stat(borrowed, 'মোট')).toHaveText('৳0');
    await expect(stat(borrowed, 'পরিশোধ করেছি')).toHaveText('৳0');

    await addLoan(page, { person: 'করিম', amount: '100000' });

    await expect(borrowed).toContainText('১টি');
    await expect(borrowed.getByText('৳1,00,000.00')).toBeVisible();
    await expect(stat(borrowed, 'মোট')).toHaveText('৳1,00,000');
    await expect(stat(borrowed, 'পরিশোধ করেছি')).toHaveText('৳0');

    // The other side of the khata has not moved.
    const lent = summaryCard(page, 'LENT');
    await expect(lent).toContainText('০টি');
    await expect(stat(lent, 'মোট')).toHaveText('৳0');

    await loanRow(page, 'করিম').getByRole('link').click();
    await addPayment(page, '40000');

    await page.goto('/loans');
    await expect(borrowed.getByText('৳60,000.00')).toBeVisible();
    await expect(stat(borrowed, 'পরিশোধ করেছি')).toHaveText('৳40,000');
    await expect(stat(borrowed, 'মোট')).toHaveText('৳1,00,000');
  });

  test('keeps money lent apart from money borrowed', async ({ page }) => {
    await signup(page);
    await addCashAccount(page);
    await page.goto('/loans');

    await addLoan(page, { person: 'করিম', amount: '100000', direction: 'BORROWED' });
    await addLoan(page, { person: 'রহিম', amount: '30000', direction: 'LENT' });

    // The borrowed tab is the one we are on.
    const panel = page.getByRole('tabpanel');
    await expect(page.getByRole('tab', { name: 'আমি যা ধার নিয়েছি' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(loanRow(page, 'করিম')).toBeVisible();
    await expect(loanRow(page, 'রহিম')).toHaveCount(0);
    await expect(panel).not.toContainText('৳30,000');

    await page.getByRole('tab', { name: 'আমি যা ধার দিয়েছি' }).click();

    await expect(loanRow(page, 'রহিম')).toBeVisible();
    await expect(loanRow(page, 'রহিম')).toContainText('৳30,000');
    await expect(loanRow(page, 'রহিম')).toContainText('এখনও পাব');
    await expect(loanRow(page, 'করিম')).toHaveCount(0);
    await expect(panel).not.toContainText('৳1,00,000');
  });

  test('finds a loan by the counterparty and by the loan number', async ({ page }) => {
    await signup(page);
    await addCashAccount(page);
    await page.goto('/loans');

    await addLoan(page, { person: 'করিম', amount: '100000' });
    await addLoan(page, { person: 'রহিম', amount: '25000' });
    await expect(loanRow(page, 'করিম')).toBeVisible();
    await expect(loanRow(page, 'রহিম')).toBeVisible();

    const search = page.getByLabel('নাম বা ঋণ নম্বর দিয়ে খুঁজুন');

    await search.fill('করিম');
    await expect(loanRow(page, 'রহিম')).toHaveCount(0);
    await expect(loanRow(page, 'করিম')).toBeVisible();

    // The second loan recorded is L-0002; numbering restarts per workspace.
    await search.fill('L-0002');
    await expect(loanRow(page, 'করিম')).toHaveCount(0);
    await expect(loanRow(page, 'রহিম')).toContainText('L-0002');

    await search.fill('');
    await expect(loanRow(page, 'করিম')).toBeVisible();
    await expect(loanRow(page, 'রহিম')).toBeVisible();
  });

  test('badges the loan whose date has passed and leaves the future one alone', async ({
    page,
  }) => {
    await signup(page);
    await addCashAccount(page);
    await page.goto('/loans');

    const today = await todayIso(page);
    await addLoan(page, {
      person: 'করিম',
      amount: '50000',
      loanDate: shiftIso(today, -60),
      dueDate: shiftIso(today, -30),
    });
    await addLoan(page, {
      person: 'রহিম',
      amount: '20000',
      loanDate: today,
      dueDate: shiftIso(today, 30),
    });

    const late = loanRow(page, 'করিম');
    await expect(late).toContainText('মেয়াদোত্তীর্ণ');
    await expect(late).toContainText('৩০ দিন পার হয়েছে');

    const soon = loanRow(page, 'রহিম');
    await expect(soon).toContainText('চলমান');
    await expect(soon).not.toContainText('মেয়াদোত্তীর্ণ');
    await expect(soon).not.toContainText('পার হয়েছে');

    // The overdue chip narrows the list to the late one.
    await page.getByRole('button', { name: 'মেয়াদোত্তীর্ণ', exact: true }).click();
    await expect(loanRow(page, 'করিম')).toBeVisible();
    await expect(loanRow(page, 'রহিম')).toHaveCount(0);
  });

  test('the statement opens at zero, lists the entries and re-cuts them by date', async ({
    page,
  }) => {
    await signup(page);
    await addCashAccount(page);
    await page.goto('/loans');

    const today = await todayIso(page);
    await addLoan(page, { person: 'করিম', amount: '100000', loanDate: shiftIso(today, -40) });

    await loanRow(page, 'করিম').getByRole('link').click();
    await addPayment(page, '40000');

    await page.getByRole('link', { name: 'বিবরণী', exact: true }).click();
    await expect(page).toHaveURL(/\/statement$/);
    await expect(page.getByRole('heading', { name: 'ঋণের বিবরণী' })).toBeVisible();

    // Whole life: nothing before it, both movements in it, ৳60,000 left at the end.
    await expect(stat(page, 'প্রারম্ভিক জের')).toHaveText('৳0.00');
    await expect(stat(page, 'সমাপনী জের')).toHaveText('৳60,000.00');
    await expect(statement(page)).toContainText('ধার নেওয়া — করিম (#L-0001)', {
      useInnerText: true,
    });
    await expect(statement(page)).toContainText('ধার পরিশোধ — করিম (#L-0001)', {
      useInnerText: true,
    });
    await expect(stat(page, 'মূল টাকা')).toHaveText('৳1,00,000.00');

    // Today only: the disbursement is forty days old, so it folds into the
    // opening balance and drops off the list. The instalment is today's.
    await page.getByRole('button', { name: 'আজ', exact: true }).click();

    await expect(stat(page, 'প্রারম্ভিক জের')).toHaveText('৳1,00,000.00');
    await expect(stat(page, 'সমাপনী জের')).toHaveText('৳60,000.00');
    await expect(statement(page)).not.toContainText('ধার নেওয়া — করিম', { useInnerText: true });
    await expect(statement(page)).toContainText('ধার পরিশোধ — করিম (#L-0001)', {
      useInnerText: true,
    });

    // A window with nothing in it says so rather than showing a stale list.
    await page.getByRole('button', { name: 'গতকাল', exact: true }).click();
    await expect(page.getByText('এই সময়ে কোনো লেনদেন নেই।')).toBeVisible();
    await expect(stat(page, 'প্রারম্ভিক জের')).toHaveText('৳1,00,000.00');
  });

  test('downloads the statement as a CSV Excel can actually read', async ({ page }) => {
    await signup(page);
    await addCashAccount(page);
    await page.goto('/loans');

    await addLoan(page, { person: 'করিম', amount: '100000' });
    await loanRow(page, 'করিম').getByRole('link').click();
    await addPayment(page, '40000');
    await page.getByRole('link', { name: 'বিবরণী', exact: true }).click();
    await expect(stat(page, 'সমাপনী জের')).toHaveText('৳60,000.00');

    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: 'এক্সেল' }).click();
    const download = await downloading;

    expect(download.suggestedFilename()).toBe('loan-L-0001-statement.csv');

    const file = await download.path();
    const bytes = await readFile(file);
    // The BOM is the whole trick — without it Excel renders Bengali as mojibake.
    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));

    const text = bytes.toString('utf8');
    expect(text.startsWith('﻿')).toBe(true);
    expect(text).toContain('করিম — ঋণের বিবরণী');
    expect(text).toContain('প্রারম্ভিক জের');
    expect(text).toContain('সমাপনী জের');
    expect(text).toContain('ধার নেওয়া — করিম (#L-0001)');
    // Amounts go out as plain decimals so the column stays numeric.
    expect(text).toContain('"100000.00"');
    expect(text).toContain('"60000.00"');

    await expect(page.getByText('এক্সেলের জন্য .csv ফাইল নামানো হয়েছে')).toBeVisible();
  });

  test('the party ledger puts both of a person’s loans on one running balance', async ({
    page,
  }) => {
    await signup(page);
    await addCashAccount(page);
    await page.goto('/loans');

    await addLoan(page, { person: 'করিম', amount: '100000', direction: 'BORROWED' });
    await loanRow(page, 'করিম').getByRole('link').click();
    await addPayment(page, '20000');

    // A second loan the other way, against the same person rather than a new one.
    await page.goto('/loans');
    await addLoan(page, { existingPerson: 'করিম', amount: '30000', direction: 'LENT' });

    // Reachable from the loan itself, which is how anybody would get there.
    await loanRow(page, 'করিম').getByRole('link').click();
    await page.getByRole('link', { name: 'পার্টি লেজার' }).click();
    await expect(page).toHaveURL(/\/loans\/people\/[^/]+$/);

    await expect(page.getByRole('heading', { name: 'করিম' })).toBeVisible();
    await expect(stat(page, 'যা ধার দিয়েছি (বাকি)')).toHaveText('৳30,000.00');
    await expect(stat(page, 'যা ধার নিয়েছি (বাকি)')).toHaveText('৳80,000.00');

    // ৳30,000 receivable against ৳80,000 payable: net ৳50,000 owed by us.
    await expect(page.getByText('সব মিলিয়ে আপনি দেবেন')).toBeVisible();
    await expect(page.getByText('৳50,000.00').first()).toBeVisible();

    // Both loans, listed and counted. Scoped to their own section: on a phone
    // the statement below is a list of cards that name the loans too.
    const loans = page
      .locator('section')
      .filter({ hasText: 'এই ব্যক্তির ঋণসমূহ' })
      .getByRole('listitem');
    await expect(loans).toHaveCount(2);
    await expect(loans.filter({ hasText: 'L-0001' })).toContainText('ধার নিয়েছি');
    await expect(loans.filter({ hasText: 'L-0002' })).toContainText('ধার দিয়েছি');
    await expect(page.getByText('২টি ঋণ')).toBeVisible();

    // And all three movements on one balance, borrowed money pushing it negative.
    await expect(stat(page, 'প্রারম্ভিক জের')).toHaveText('৳0.00');
    await expect(stat(page, 'সমাপনী জের')).toHaveText('-৳50,000.00');
    await expect(statement(page)).toContainText('ধার নেওয়া — করিম (#L-0001)', {
      useInnerText: true,
    });
    await expect(statement(page)).toContainText('ধার পরিশোধ — করিম (#L-0001)', {
      useInnerText: true,
    });
    await expect(statement(page)).toContainText('ধার দেওয়া — করিম (#L-0002)', {
      useInnerText: true,
    });
  });

  test('on a 320px phone the history is cards, nothing scrolls sideways, and every target is 44px', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'w320', 'the narrowest viewport is the one that matters');

    await signup(page);
    await addCashAccount(page);
    await page.goto('/loans');

    await addLoan(page, { person: 'করিম', amount: '100000' });
    await loanRow(page, 'করিম').getByRole('link').click();
    await addPayment(page, '20000');
    await expect(stat(page, 'বাকি')).toHaveText('৳80,000.00');

    const loanUrl = new URL(page.url()).pathname;

    // Nine columns do not fit on a 320px screen, so they become cards.
    await expect(page.locator('table')).toBeHidden();
    const cards = history(page).getByRole('listitem');
    await expect(cards).toHaveCount(2);
    await expect(cards.first()).toContainText('ঋণ গ্রহণ');
    await expect(cards.last()).toContainText('চলতি জের');
    await expect(cards.last()).toContainText('৳80,000.00');

    // Every loan screen, and none of them overflows.
    await page.getByRole('link', { name: 'পার্টি লেজার' }).click();
    const partyUrl = new URL(page.url()).pathname;

    for (const path of ['/loans', loanUrl, `${loanUrl}/statement`, partyUrl]) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      const box = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(box.scrollWidth, `${path} overflows at 320px`).toBeLessThanOrEqual(
        box.clientWidth + 1,
      );
    }

    // Back on the loan: every control in the page body is thumb-sized.
    await page.goto(loanUrl);
    await expect(stat(page, 'বাকি')).toHaveText('৳80,000.00');
    const body = page.getByTestId('app-scroll');
    const targets = [
      ...(await body.getByRole('button').all()),
      ...(await body.getByRole('link').all()),
    ];
    expect(targets.length).toBeGreaterThan(3);

    for (const target of targets) {
      const label = (await target.innerText()).trim() || (await target.getAttribute('aria-label'));
      const box = await target.boundingBox();
      expect(box, `${label ?? 'target'} should be laid out`).not.toBeNull();
      expect(box!.height, `${label ?? 'target'} is too short`).toBeGreaterThanOrEqual(44);
      expect(box!.width, `${label ?? 'target'} is too narrow`).toBeGreaterThanOrEqual(44);
    }
  });
});
