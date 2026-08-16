import { describe, expect, it } from 'vitest';
import { currencyForAmount, findCurrencyAmounts } from './currency.js';
import { normaliseMessage } from './normalise.js';

/**
 * The message this whole module was written for, byte for byte as the owner's
 * bank sent it.
 *
 * It went into the review queue as ৳4.60 — a subscription that actually cost
 * about ৳560, filed at a hundred and twentieth of its size, with nothing on the
 * screen saying dollars anywhere. Every assertion below is about that one
 * failure, so if this file ever goes quiet the bug is back.
 */
const OPENAI_SMS =
  'USD 4.6 transacted at OPENAI *CHATGPT SUBSCR on 16/08/26 [10:33:37 PM BST] ' +
  'using Card#***0492. Available balance: USD 538.24. Helpline 16221.';

describe('the dollar charge that was filed as taka', () => {
  it('reads the currency as USD and the amount as 4.60 in dollar cents', () => {
    /* 460, not 4.6 and emphatically not 460 poisha: the units are the
       dollar's, because a hundred cents make one and that is what
       `parseMoneyToMinor` was given the code for. */
    const found = currencyForAmount(OPENAI_SMS, '4.6');

    expect(found).not.toBeNull();
    expect(found?.currency).toBe('USD');
    expect(found?.amountMinor).toBe(460);
    expect(found?.currency).not.toBe('BDT');
  });

  it('quotes the code with the figure, so the review screen can show its working', () => {
    expect(currencyForAmount(OPENAI_SMS, '4.6')?.text).toBe('USD 4.6');
  });

  it('does not take the closing balance for the charge', () => {
    /* `Available balance: USD 538.24` carries the same code as the movement and
       is a hundred times larger. Reading it would file the whole account as one
       purchase at OpenAI. */
    const all = findCurrencyAmounts(OPENAI_SMS);
    expect(all).toHaveLength(1);
    expect(all[0]?.amountMinor).toBe(460);
  });

  it('does not let the normaliser fold the dollars into taka', () => {
    const msg = normaliseMessage(OPENAI_SMS);
    expect(msg.currency).toBe('USD');
    expect(msg.normalised).toContain('USD 4.6');
    expect(msg.normalised).not.toContain('BDT');
  });
});

describe('findCurrencyAmounts', () => {
  it('reads a code written after the figure', () => {
    expect(findCurrencyAmounts('Charged 25.00 EUR at a shop')[0]).toMatchObject({
      currency: 'EUR',
      amountMinor: 2500,
      text: '25.00 EUR',
    });
  });

  it('reads a code glued to the figure', () => {
    expect(findCurrencyAmounts('BDT10,000.00 withdrawn fm Card#0570')[0]).toMatchObject({
      currency: 'BDT',
      amountMinor: 1_000_000,
    });
  });

  it("respects a currency's own minor units rather than assuming a hundred", () => {
    /* A yen has no minor unit and a dinar has a thousand fils. Multiplying
       either by 100 is wrong by two or three orders of magnitude, and wrong in
       the direction that looks plausible on a screen. */
    expect(findCurrencyAmounts('Paid JPY 500 at a station')[0]?.amountMinor).toBe(500);
    expect(findCurrencyAmounts('Paid KWD 4.6 at a shop')[0]?.amountMinor).toBe(4600);
  });

  it('reads Bengali numerals and quotes them as the bank wrote them', () => {
    const found = findCurrencyAmounts('USD ৪.৬ কাটা হয়েছে')[0];
    expect(found?.currency).toBe('USD');
    expect(found?.amountMinor).toBe(460);
    // The person checking the draft has to see their own message, not ours.
    expect(found?.text).toBe('USD ৪.৬');
  });

  it('leaves three capitals that are not money alone', () => {
    // `REF` and `TXN` are not ISO 4217, however capitalised they are.
    expect(findCurrencyAmounts('Credited. REF 12345 TXN 90210')).toEqual([]);
  });

  it('does not read an ordinary lower-case word as a currency', () => {
    /* ALL, TOP, TRY, CUP and BOB are all real ISO codes. Case-insensitive
       matching would turn "try 5 times" into five Turkish lira. */
    expect(findCurrencyAmounts('try 5 times, top 10 offers, all 3 of them')).toEqual([]);
  });

  it('skips a fee, which is an amount but never the amount', () => {
    expect(findCurrencyAmounts('Sent money. Fee USD 0.50')).toEqual([]);
  });
});

/**
 * The taka's own spellings.
 *
 * None of them is an ISO code, all of them are on real messages, and the answer
 * only looks uninteresting because the books are usually in taka too. They are
 * not always: a workspace kept in dollars that reads `Tk 500` as an unmarked
 * figure books ৳500 as $500, which is this file's original bug pointed the other
 * way and a hundred and twentyfold in the flattering direction.
 */
describe('the taka, spelled every way a bank spells it', () => {
  const takaIn = (body: string): number | undefined => {
    const found = findCurrencyAmounts(body)[0];
    expect(found?.currency).toBe('BDT');
    return found?.amountMinor;
  };

  it('reads the word spelled out, however it is capitalised', () => {
    expect(takaIn('Taka 5,000 debited')).toBe(500_000);
    expect(takaIn('TAKA 5,000 debited')).toBe(500_000);
    expect(takaIn('taka 5,000 debited')).toBe(500_000);
  });

  it('reads টাকা in a message with no Latin character in it', () => {
    /* bKash and Nagad send these. `\b` never fires beside a Bengali letter, so
       this only works because the Bengali marker has its own expression. */
    expect(takaIn('৫০০ টাকা কাটা হয়েছে')).toBe(50_000);
    expect(takaIn('আপনার অ্যাকাউন্টে ১,২৫০.৫০ টাকা জমা হয়েছে')).toBe(125_050);
  });

  it('reads BDT with a trailing full stop', () => {
    expect(takaIn('BDT. 1,000.00 debited')).toBe(100_000);
  });

  it('reads Tk, TK, tk and the symbol', () => {
    expect(takaIn('Tk 500 debited')).toBe(50_000);
    expect(takaIn('TK.500 debited')).toBe(50_000);
    expect(takaIn('tk 500 debited')).toBe(50_000);
    expect(takaIn('৳500 debited')).toBe(50_000);
  });

  it('does not swallow a word that merely contains a marker', () => {
    // Takaful is insurance, and a category name in this product.
    expect(findCurrencyAmounts('Takaful premium 5,000 paid')).toEqual([]);
    expect(findCurrencyAmounts('TKS 500 times over')).toEqual([]);
  });

  it('counts BDT once, not twice, when both readers see it', () => {
    // `BDT 500` is an ISO code to one pass and a taka marker to another.
    expect(findCurrencyAmounts('BDT 500 debited')).toHaveLength(1);
  });
});

describe('currencyForAmount', () => {
  it('ties the answer to the figure the parser already read', () => {
    /* Two capitalised codes beside two numbers, one of them a reference. The
       parser picked the money; this only says what units it was in. */
    const body = 'BDT 5,000.00 credited to your A/C. Ref SAR 12345';
    expect(currencyForAmount(body, 'BDT 5,000.00')?.currency).toBe('BDT');
    expect(currencyForAmount(body, '5,000.00')?.currency).toBe('BDT');
  });

  it('says nothing when the two readers disagree on the figure', () => {
    // Better a draft that behaves as it always did than one that acquires a
    // currency nobody read.
    expect(currencyForAmount('USD 4.6 charged, ref 99', '77')).toBeNull();
  });

  it('matches a Bengali figure against the same amount in ASCII', () => {
    expect(currencyForAmount('USD ৪.৬ কাটা হয়েছে', '৪.৬')?.amountMinor).toBe(460);
  });
});
