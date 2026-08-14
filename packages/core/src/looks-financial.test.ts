import { describe, expect, it } from 'vitest';
import { looksFinancial } from './ingestion.js';

/**
 * The gate between "keep this message" and "put a decision in front of somebody".
 *
 * Everything is kept either way — this only decides whether a draft is raised.
 * The rule is deliberately wide: a currency marker or any digit at all. It was
 * narrower once and the first real test broke it, so what these cases pin down
 * is mostly that the wide reading stays wide.
 */
describe('looksFinancial', () => {
  it('recognises the money a Bangladeshi phone actually receives', () => {
    const real = [
      'Your A/C **1234 is debited BDT 1,500.00 on 14-AUG-26. Bal BDT 22,340.50',
      'You have received Tk 500.00 from 01711111111. Ref: rent. Balance Tk 1,234.00',
      'Payment of USD 49.00 to GITHUB was approved on your card ending 8821',
      'বিকাশে ৳2,000 এসেছে',
      'Recharge successful. Amount 500.00 BDT. TrxID 9KJ21LMN',
      'Cash out Tk 3,000 charge Tk 55.50',
    ];
    for (const message of real) {
      expect(looksFinancial(message), message).toBe(true);
    }
  });

  it('knows the words people use, not only the ones banks use', () => {
    /* Found the first time the owner tested with their own words rather than a
       bank's: `500 taka twst` raised no draft, because the rule knew `BDT` and
       `Tk` and not the word everybody actually says. */
    const human = [
      '500 taka twst',
      '৫০০ টাকা পাঠালাম',
      'Taka 250 for the rickshaw',
      '500 tk sent',
      'ভাড়া 1200 দিলাম',
    ];
    for (const message of human) {
      expect(looksFinancial(message), message).toBe(true);
    }
  });

  it('raises a draft for anything with a digit in it, by design', () => {
    /* These are not money and they still count. A one-time code dismissed in a
       tap is a smaller loss than a bank format nobody thought of that never
       reaches the books — so the rule leans this way on purpose, and this test
       says so out loud rather than leaving it to look like a bug. */
    expect(looksFinancial('Your one-time code is 847213')).toBe(true);
    expect(looksFinancial('Your appointment is on 14/08/2026')).toBe(true);
  });

  it('still says no to a message with no number and no currency in it', () => {
    /* The only things left out: pure prose. Rare in an SMS, which is why the
       queue now fills up — see the note on `MONEY_MARKERS`. */
    expect(looksFinancial('আমি বাসায় পৌঁছে গেছি')).toBe(false);
    expect(looksFinancial('Call me when you are free')).toBe(false);
    expect(looksFinancial('Thank you for shopping with us')).toBe(false);
  });

  it('counts a currency word even with no figure beside it', () => {
    expect(looksFinancial('Your BDT statement is ready')).toBe(true);
    expect(looksFinancial('টাকা পাঠিয়ে দিয়েছি')).toBe(true);
  });
});
