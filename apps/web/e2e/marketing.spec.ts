import { expect, test, type Page } from '@playwright/test';

/**
 * The public site: the landing page, pricing, and the two things that decide
 * whether either of them is ever found — the HTML a crawler reads, and whether
 * the page behaves on a 320px phone.
 *
 * These run signed out on purpose. `/` is the dashboard for anybody with a
 * session and the landing page for everybody else, and the whole point of the
 * rewrite is that the second group is who a search engine is.
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

const PASSWORD = 'hishab1234';

let counter = 0;
const uniqueEmail = (): string => {
  counter += 1;
  return `mkt-${Date.now()}-${counter}-${Math.trunc(performance.now())}@example.test`;
};

async function signup(page: Page): Promise<void> {
  await page.goto('/signup');
  await page.getByLabel('নাম').fill('বাজার পরীক্ষা');
  await page.getByLabel('ইমেইল').fill(uniqueEmail());
  await page.getByLabel('পাসওয়ার্ড').fill(PASSWORD);
  await page.getByLabel('মোবাইল নম্বর').fill(uniquePhone());
  await page.getByRole('button', { name: 'অ্যাকাউন্ট খুলুন' }).click();
  await expect(page.getByRole('heading', { name: 'ড্যাশবোর্ড' }).first()).toBeVisible({
    timeout: 30_000,
  });
}

test.describe('the public site', () => {
  test('/ is the landing page when signed out and the dashboard when signed in', async ({
    page,
  }) => {
    await page.goto('/');
    // The URL stays `/` — a rewrite, not a redirect, because `/` is the address
    // that gets printed, linked and indexed.
    expect(new URL(page.url()).pathname).toBe('/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('আপনার টাকা কোথায় যায়');

    await signup(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'ড্যাশবোর্ড' }).first()).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).not.toContainText(
      'আপনার টাকা কোথায় যায়',
    );
  });

  test('puts the answer in the HTML, not in a fetch', async ({ page }) => {
    /* With JavaScript off there is no hydration, no client fetch and no
       framework — what is left is exactly what a crawler is handed. If the
       pitch, the features and the FAQ answers are not in here, the page does
       not rank however many keywords the metadata carries. */
    const context = await page.context().browser()!.newContext({ javaScriptEnabled: false });
    const bare = await context.newPage();
    await bare.goto('/');

    const html = await bare.content();
    expect(html).toContain('ডাবল-এন্ট্রি');
    expect(html).toContain('দেনাদার-পাওনাদার');
    /* The three groups that shipped after the first draft of this page. A
       feature the product has and the landing page does not mention is a
       feature nobody signs up for, and this is the check that notices. */
    expect(html).toContain('ভাগাভাগি (ShareCost)');
    expect(html).toContain('চারটি আর্থিক বিবৃতি');
    expect(html).toContain('পরিমাণের হিসাব');
    // An FAQ answer, in full, not behind a click.
    expect(html).toContain('ফ্রি প্যাকেজ আজীবন ফ্রি');
    // Structured data, both blocks.
    expect(html).toContain('"@type":"SoftwareApplication"');
    expect(html).toContain('"@type":"FAQPage"');
    await context.close();
  });

  test('tells a crawler which URL this is and how to share it', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      'href',
      'https://takatracker.com',
    );
    await expect(page.locator('meta[property="og:title"]')).toHaveCount(1);
    await expect(page.locator('meta[property="og:url"]')).toHaveAttribute(
      'content',
      'https://takatracker.com',
    );
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      'content',
      /ডাবল-এন্ট্রি/,
    );
    // Exactly one h1. Two would leave a crawler guessing which is the subject.
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  });

  test('serves robots.txt and a sitemap that agree with each other', async ({ request }) => {
    const robots = await request.get('/robots.txt');
    expect(robots.ok()).toBe(true);
    const robotsBody = await robots.text();
    expect(robotsBody).toContain('Sitemap: https://takatracker.com/sitemap.xml');
    // The screens behind a session must not compete with the page that ranks.
    expect(robotsBody).toContain('/transactions');

    const sitemap = await request.get('/sitemap.xml');
    expect(sitemap.ok()).toBe(true);
    const xml = await sitemap.text();
    // Spelled exactly as the canonical tag spells it — see sitemap.ts.
    expect(xml).toContain('<loc>https://takatracker.com</loc>');
    expect(xml).toContain('<loc>https://takatracker.com/pricing</loc>');
  });

  test('prices come from the API, and say what free actually means', async ({ page }) => {
    await page.goto('/pricing');
    await expect(page.getByRole('heading', { level: 1, name: 'দাম' })).toBeVisible();

    const free = page.locator('h2', { hasText: 'ফ্রি' }).first();
    await expect(free).toBeVisible();
    // ৳350/month and ৳3600/year, in Bengali numerals, read off the plan the
    // server enforces rather than typed into this page.
    await expect(page.getByText('৳৩৫০').first()).toBeVisible();
    await expect(page.getByText('৳৩,৬০০').first()).toBeVisible();
    await expect(page.getByText('আজীবন ফ্রি').first()).toBeVisible();

    // The comparison table names both tiers and the two ceilings that differ.
    const table = page.getByRole('table');
    await expect(table).toContainText('প্রিমিয়াম');
    await expect(table).toContainText('রসিদের ছবি');
  });

  test('gets from the landing page to a real account', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'ফ্রি অ্যাকাউন্ট খুলুন' }).first().click();
    await expect(page).toHaveURL(/\/signup/);
    await expect(page.getByRole('button', { name: 'অ্যাকাউন্ট খুলুন' })).toBeVisible();
  });

  test('the install guide carries all three devices in the HTML', async ({ page }) => {
    await page.goto('/guide');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('ফোনে বসাবেন');

    /* Every device's steps are server-rendered; the tabs only choose which is
       on top. A crawler and a reader whose JavaScript has not arrived both get
       the whole thing — and the iOS caveat matters, because on an iPhone only
       Safari can do this and somebody in Chrome will look for a button that is
       not there. */
    const html = await page.content();
    expect(html).toContain('Add to Home Screen');
    expect(html).toContain('শুধু Safari থেকেই');
    expect(html).toContain('Install app');
    expect(html).toContain('"@type":"HowTo"');

    // Switching device switches the steps.
    await page.getByRole('tab', { name: 'আইফোন / আইপ্যাড' }).click();
    await expect(page.getByRole('tab', { name: 'আইফোন / আইপ্যাড' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    /* Scoped to the visible list. The same sentences also sit in an `sr-only`
       block so a crawler gets every device's steps whatever the tabs show, and
       an unscoped match finds both. */
    await expect(
      page.getByRole('list', { name: /আইফোন/ }).getByText('নিচের শেয়ার বোতামে চাপ দিন'),
    ).toBeVisible();

    await page.getByRole('tab', { name: 'কম্পিউটার' }).click();
    await expect(page.getByText('Firefox আর Safari ডেস্কটপে').first()).toBeVisible();
  });

  test('signup asks which phone, and the answer sticks', async ({ page }) => {
    await page.goto('/signup');
    await page.getByLabel('নাম').fill('ডিভাইস পরীক্ষা');
    await page.getByLabel('ইমেইল').fill(uniqueEmail());
    await page.getByLabel('কোন ডিভাইস ব্যবহার করছেন').selectOption('IOS');
    await page.getByLabel('কারেন্সি').selectOption('USD');
    await page.getByLabel('পাসওয়ার্ড').fill(PASSWORD);
    await page.getByLabel('মোবাইল নম্বর').fill(uniquePhone());
    await page.getByRole('button', { name: 'অ্যাকাউন্ট খুলুন' }).click();
    await expect(page.getByRole('heading', { name: 'ড্যাশবোর্ড' }).first()).toBeVisible({
      timeout: 30_000,
    });

    // The currency chosen at signup is the one the books are kept in, so the
    // dashboard's figures carry its symbol rather than a hardcoded ৳.
    await expect(page.getByText('$', { exact: false }).first()).toBeVisible();
  });

  test('the English site is a real page, not a translated shell', async ({ page }) => {
    await page.goto('/en');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Know where every taka');

    const html = await page.content();
    // Written English, not a literal rendering of the Bengali phrasing.
    expect(html).toContain('Debts, the way accountants do them');
    expect(html).toContain('Double-entry ledger');
    expect(html).toContain('"@type":"FAQPage"');
    // No Bengali body copy leaking through from the other content object.
    expect(html).not.toContain('শুরু করতে তিনটি ধাপ');

    // hreflang in both directions, with Bengali as the default.
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      'href',
      'https://takatracker.com/en',
    );
    await expect(page.locator('link[hreflang="bn-BD"]')).toHaveAttribute(
      'href',
      'https://takatracker.com',
    );
    await expect(page.locator('link[hreflang="x-default"]')).toHaveAttribute(
      'href',
      'https://takatracker.com',
    );

    // The switch is a link a crawler can follow, both ways.
    await page.getByRole('link', { name: 'বাংলা' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('আপনার টাকা কোথায় যায়');
    await page.getByRole('link', { name: 'English' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Know where every taka');
    // `<html lang>` follows, and follows back — see `en/layout.tsx`.
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await page.getByRole('link', { name: 'বাংলা' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'bn');
  });

  test('English pricing quotes the same numbers the API enforces', async ({ page }) => {
    await page.goto('/en/pricing');
    await expect(page.getByRole('heading', { level: 1, name: 'Pricing' })).toBeVisible();
    // Latin numerals here, Bengali on the other page — same underlying poisha.
    await expect(page.getByText('৳350').first()).toBeVisible();
    await expect(page.getByText('৳3,600').first()).toBeVisible();
    await expect(page.getByText('saved', { exact: false }).first()).toBeVisible();
    await expect(page.getByRole('table')).toContainText('Unlimited');
  });

  test('carries the brand, the hotline and a way to pay', async ({ page }) => {
    await page.goto('/');
    // The brand's own fonts, self-hosted — no request to a Google domain.
    const families = await page.evaluate(() =>
      getComputedStyle(document.body).fontFamily.toLowerCase(),
    );
    expect(families).toContain('anek');
    expect(families).toContain('jamjuree');

    /* Blue is the primary. Green is money coming in and has to stay that, so
       the two must not be the same colour — this asserts the separation rather
       than a hex, which a designer is free to tune. */
    const brand = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--hishab-brand').trim(),
    );
    const income = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--hishab-income').trim(),
    );
    expect(brand).not.toBe('');
    expect(brand).not.toBe(income);

    // A finance product with no phone number is one nobody trusts their bank
    // statements to.
    await expect(page.getByRole('link', { name: /09642500400/ })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Facebook' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'LinkedIn' })).toBeVisible();

    await page.goto('/pricing');
    const pay = page.getByRole('link', { name: /পেমেন্ট করুন/ });
    await expect(pay).toBeVisible();
    // Hosted invoice, opened safely — `noopener` or the new tab keeps a live
    // handle back into this one.
    await expect(pay).toHaveAttribute('href', /invoice\.sslcommerz\.com/);
    await expect(pay).toHaveAttribute('rel', /noopener/);
    await expect(pay).toHaveAttribute('rel', /noreferrer/);
  });

  test('the privacy page names what an operator can see', async ({ page }) => {
    /* A privacy policy that lists cookie categories and never mentions that a
       member of staff can open your ledger is a disclaimer, not a policy. The
       operator panel can read balances — deliberately, so somebody can answer
       "my numbers look wrong" — and this page has to say so above the
       boilerplate. */
    await page.goto('/privacy');
    await expect(page.getByRole('heading', { name: 'গোপনীয়তা', level: 1 })).toBeVisible();

    await expect(
      page.getByRole('heading', { name: 'আমাদের কেউ কি আপনার হিসাব দেখতে পারে?' }),
    ).toBeVisible();
    await expect(page.getByText('পারে — এবং কখন পারে সেটা এখানে লেখা আছে।')).toBeVisible();
    /* And the other half: every such view is recorded where the customer can
       read it. A disclosure without that is only half true. */
    await expect(page.getByText('প্রতিবার দেখলে তার রেকর্ড থাকে।')).toBeVisible();
    await expect(page.getByText('বিক্রি করা হয় না', { exact: false })).toBeVisible();

    /* Reachable without knowing the URL. */
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'গোপনীয়তা' })).toBeVisible();
  });

  test('the tutorial is public, and teaches the rules before it sells anything', async ({
    page,
  }) => {
    /* The page exists for somebody who has not signed up, so the first thing
       worth proving is that they can read it at all — no session, no redirect
       to /login. */
    await page.goto('/tutorial');
    await expect(page).toHaveURL(/\/tutorial$/);
    await expect(
      page.getByRole('heading', { name: 'কীভাবে হিসাব রাখবেন', level: 1 }),
    ).toBeVisible();

    /* The four entries that carry the accounting, one from each treatment a
       first-timer gets wrong. If the copy is ever softened into marketing,
       these are the sentences that would go first. */
    await expect(page.getByText('ঋণ প্রদান — সম্পদ (প্রাপ্য)')).toBeVisible();
    await expect(page.getByText('ঋণ গ্রহণ — দায়')).toBeVisible();
    await expect(page.getByText('দায় পরিশোধ', { exact: true })).toBeVisible();
    await expect(page.getByText('পুনর্মূল্যায়ন', { exact: true })).toBeVisible();

    /* What you do not get, stated as plainly as what you do. A visitor who
       finds out after signing up does not stay. */
    await expect(page.getByRole('heading', { name: 'কী পাবেন না' })).toBeVisible();
    await expect(page.getByText(/ব্যাংকের সাথে সরাসরি সংযোগ/)).toBeVisible();

    /* The feature list is the in-app manual's table, rendered here. One entry
       from it proves the shared import survived. */
    await expect(page.getByText('সবাই মিলে তহবিল', { exact: true })).toBeVisible();

    /* The citations. A treatment named, never compliance claimed — the second
       is a statement about an entity and its auditors, and this product has
       neither. If that line is ever crossed it will be crossed in this copy,
       so the check lives here. */
    await expect(page.getByText(/IAS 7/).first()).toBeVisible();
    await expect(page.getByText(/IFRS 15/).first()).toBeVisible();
    await expect(page.getByText(/যে নিয়মে/).first()).toBeVisible();
    await expect(page.getByText(/IFRS.{0,3}(compliant|সম্মত)/i)).toHaveCount(0);
    await expect(page.getByText(/certified|নিরীক্ষিত/i)).toHaveCount(0);

    /* Reachable without knowing the URL. */
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'কীভাবে রাখবেন' }).first()).toBeVisible();

    /* And in English, from its own URL, with no Bengali left behind. */
    await page.goto('/en/tutorial');
    await expect(
      page.getByRole('heading', { name: 'How to keep your books', level: 1 }),
    ).toBeVisible();
    await expect(page.getByText('A loan given — an asset (receivable)')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'What you do not get' })).toBeVisible();
  });

  /**
   * The page somebody reads on one phone while setting up another.
   *
   * Every step of both phones has to be in the HTML that arrives — no tab, no
   * accordion, no "read more". A reader following instructions cannot hunt, a
   * crawler cannot click, and an assistant asked "how do I forward bank SMS to
   * this app" reads the markup or nothing.
   */
  test('the SMS guide carries both phones in the HTML, with HowTo markup', async ({ page }) => {
    await page.goto('/sms');
    await expect(page.getByRole('heading', { name: 'অ্যান্ড্রয়েড', level: 2 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'আইফোন ও আইপ্যাড', level: 2 })).toBeVisible();

    // Both lists complete, not a teaser with the rest behind a control.
    const steps = page.locator('ol > li');
    expect(await steps.count()).toBeGreaterThanOrEqual(17);

    /* Says out loud that no banking password is involved. This is the sentence
       that decides whether somebody sets it up at all, so it is asserted rather
       than left to survive an edit by luck. */
    await expect(page.getByText('পাসওয়ার্ড, পিন বা ওটিপি কখনো চাওয়া হয় না')).toBeVisible();

    const graph = await page.locator('script[type="application/ld+json"]').first().textContent();
    const parsed = JSON.parse(graph ?? '{}') as { '@graph': { '@type': string }[] };
    const types = parsed['@graph'].map((node) => node['@type']);
    expect(types.filter((t) => t === 'HowTo')).toHaveLength(2);
    expect(types).toContain('FAQPage');
  });

  /**
   * `/llms.txt` — the product as prose, for whatever is reading.
   *
   * Generated from the same `content.ts` the human page renders, so what it
   * asserts is not the text but that the two cannot drift: a feature named here
   * exists on the site, and the file is plain text rather than an HTML page
   * with a .txt name.
   */
  test('serves llms.txt as plain text, generated from the feature list', async ({ page }) => {
    const res = await page.request.get('/llms.txt');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/plain');

    const body = await res.text();
    expect(body).toContain('# Taka Tracker');
    // The claim the whole product rests on, said where a machine will read it.
    expect(body).toContain('double-entry');
    // Both halves of the SMS guide, not just a mention that it exists.
    expect(body).toContain('### Android');
    expect(body).toContain('### iPhone and iPad');
    // And the roadmap, so an assistant cannot promise what is not built.
    expect(body).toContain('## Not built yet');
  });

  test('never scrolls sideways, and every tap target is 44px', async ({ page }) => {
    for (const path of [
      '/',
      '/pricing',
      '/guide',
      '/tutorial',
      '/sms',
      '/en',
      '/en/pricing',
      '/en/tutorial',
      '/en/sms',
    ]) {
      await page.goto(path);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${path} scrolls horizontally by ${overflow}px`).toBeLessThanOrEqual(1);

      /* Only the links and buttons that are actually on screen. The phone menu
         is closed at rest, and a hidden control has no size to measure. */
      const controls = page.locator('a:visible, button:visible');
      const count = await controls.count();
      for (let i = 0; i < count; i += 1) {
        const box = await controls.nth(i).boundingBox();
        if (!box) continue;
        const text = (await controls.nth(i).innerText()).trim().slice(0, 30);
        /* Two exclusions, both narrow on purpose.
         *
         * A link inside a `<p>` or a `<summary>` is a word in a sentence — it
         * has no size of its own and giving it one would break the line. A
         * `sr-only` skip link has no size until it is focused, at which point
         * it does. `<li>` is deliberately *not* excused: a footer link list is
         * navigation, and that exclusion was hiding seven 17px targets. */
        const skip = await controls.nth(i).evaluate((el) => {
          const parent = el.parentElement?.tagName ?? '';
          return ['P', 'SUMMARY'].includes(parent) || el.classList.contains('sr-only');
        });
        if (skip) continue;
        expect(box.height, `${path}: "${text}" is ${box.height}px tall`).toBeGreaterThanOrEqual(40);
      }
    }
  });
});
