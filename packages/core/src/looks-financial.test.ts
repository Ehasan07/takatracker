import { describe, expect, it } from 'vitest';
import { looksFinancial } from './ingestion.js';

/**
 * The gate between "keep this message" and "put a decision in front of somebody".
 *
 * Everything is kept either way — this only decides whether a draft is raised.
 * The cost of the two mistakes is not symmetric: a false positive is a draft
 * dismissed in a tap, a false negative is a transaction that never reaches the
 * books and that nobody knows to go looking for. The cases below are chosen to
 * hold that asymmetry in place.
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

  it('leaves alone the messages that only look numeric', () => {
    /* Each of these carries digits and none of them carries money. A rule that
       fired on "has a number" would raise a draft for every one — which is the
       rule this replaced. */
    const noise = [
      'Your one-time code is 847213. Do not share it with anyone.',
      'Call me back on 01711111111 when you are free',
      'Your appointment is on 14/08/2026 at 5:30 PM',
      'Order 88213 has been shipped and arrives Thursday',
      'আপনার প্যাকেজ ৩ দিনে পৌঁছাবে',
    ];
    for (const message of noise) {
      expect(looksFinancial(message), message).toBe(false);
    }
  });

  it('does not read Tk inside an ordinary word', () => {
    /* `\\bTk\\b` alone would fire on a surname; the rule wants a number after
       it, because `Tk` in a bank message is always followed by one. */
    expect(looksFinancial('Atkinson called about the meeting')).toBe(false);
    expect(looksFinancial('TK Group is hiring')).toBe(false);
    expect(looksFinancial('Tk 500 sent')).toBe(true);
  });

  it('is not fooled by a bare integer, and is not fussy about case', () => {
    expect(looksFinancial('500')).toBe(false);
    expect(looksFinancial('bdt 500')).toBe(true);
    expect(looksFinancial('usd 49')).toBe(true);
  });
});
