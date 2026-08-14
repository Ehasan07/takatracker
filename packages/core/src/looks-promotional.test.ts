import { describe, expect, it } from 'vitest';
import { looksPromotional } from './ingestion.js';

/**
 * Telling an advertisement from a transaction.
 *
 * Banks send both from the same shortcode, and the advertisement usually has
 * *more* figures in it than the alert — so a rule that only asks "is there an
 * amount here" picks one of them and files money that never moved.
 *
 * The messages below are real, and the first one is why this exists.
 */

const ADVERT =
  'সিটিটাচ থেকে যেকোন বিকাশ নম্বরে ২টাকা বার ১৫০০ টাকা অ্যাড মানি করলেই পাবেন ৫০ টাকা বোনাস ও স্বপ্ন-এর ১০০ টাকার কুপন।শুধুমাত্র আজকের জন্য।';

describe('looksPromotional', () => {
  it('recognises the advert that started this', () => {
    /* Four amounts, no transaction. Whichever one a parser picked was wrong. */
    expect(looksPromotional(ADVERT)).toBe(true);
  });

  it('recognises the usual English shapes too', () => {
    const adverts = [
      'Get 20% discount on your next purchase. T&C apply.',
      'Win a trip to Cox’s Bazar! Offer valid till 31 August.',
      'Enjoy BDT 100 cashback on your first order. Terms apply.',
    ];
    for (const message of adverts) {
      expect(looksPromotional(message), message).toBe(true);
    }
  });

  it('leaves a real transaction alone, even when it uses the same words', () => {
    /* This is the half that keeps the rule from eating money. A cashback that
       actually landed is a transaction, and it carries the thing an advert
       never has: evidence that something happened. */
    const real = [
      'আপনার একাউন্টে ৳50 ক্যাশব্যাক জমা হয়েছে। ব্যালেন্স ৳1,250.00',
      'BDT 100.00 cashback credited. Avl Bal: BDT 5,300.00. For query: 16419',
      'Bonus Tk 50 added. TrxID 9KJ21LMN. Balance Tk 780.00',
    ];
    for (const message of real) {
      expect(looksPromotional(message), message).toBe(false);
    }
  });

  it('says nothing about ordinary alerts, which is most of them', () => {
    const alerts = [
      'BDT10,000.00 withdrawn fm Card#0570 on 14/08/26 at UCBL ATM. Avl Bal:2004.96',
      'Your A/C (***5650) has been credited BDT 5,000.00 for SALARY CREDIT.',
      'You have received Tk 500.00 from 01711111111',
    ];
    for (const message of alerts) {
      expect(looksPromotional(message), message).toBe(false);
    }
  });
});
