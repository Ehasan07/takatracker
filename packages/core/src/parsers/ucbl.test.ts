import { describe, expect, it } from 'vitest';
import { createRegistry } from '../ingestion.js';
import { ucblParser } from './ucbl.js';

/**
 * The UCB parser, against messages the owner's own phone actually received.
 *
 * Every string below is a real alert with nothing edited but the account
 * numbers. That is the point: a parser tested against messages somebody wrote
 * to suit the parser passes forever and fails in production the first week.
 */

const ATM =
  'BDT10,000.00 withdrawn fm Card#0570 (CL ID:1471642) on 14/08/26 19:01 at UCBL ATM. Avl Bal:2004.96. Use UCB Cash Recycler to deposit 24/7. For query: 16419';

const SALARY =
  'Your A/C (***5650) has been credited BDT 5,000.00 for SALARY CREDIT. Avl Bal: BDT 6,504.96 @ 05:18 PM. For query: 16419';

const DEBIT =
  'Your A/C (***5650) has been debited BDT 3,400.00 for ONLINE PURCHASE. Avl Bal: BDT 2,104.96 @ 11:02 AM. For query: 16419';

const msg = (body: string) => ({ channel: 'SMS' as const, body, receivedOn: '2026-08-15' });

describe('the UCB parser', () => {
  it('reads a cash withdrawal completely', () => {
    const result = ucblParser.parse(msg(ATM));

    expect(result?.fields.amountMinor).toBe(1_000_000);
    expect(result?.fields.direction).toBe('OUT');
    /* Day first, two-digit year: 14/08/26 is the fourteenth of August. Reading
       it as the eighth of the fourteenth month, or as 1926, are the two ways
       this goes wrong. */
    expect(result?.fields.date).toBe('2026-08-14');
    expect(result?.fields.balanceMinor).toBe(200_496);
    expect(result?.fields.accountHint).toBe('0570');
    expect(result?.fields.payee).toContain('UCBL ATM');
  });

  it('is not fooled by the advert at the end of the withdrawal alert', () => {
    /* The ATM message ends "Use UCB Cash Recycler to deposit 24/7". A keyword
       search that looks for `deposit` anywhere files a cash withdrawal as
       income — and the person's month then reads ৳20,000 out. */
    expect(ucblParser.parse(msg(ATM))?.fields.direction).toBe('OUT');
  });

  it('reads a salary credit, and takes the reason over the place', () => {
    const result = ucblParser.parse(msg(SALARY));

    expect(result?.fields.amountMinor).toBe(500_000);
    expect(result?.fields.direction).toBe('IN');
    expect(result?.fields.balanceMinor).toBe(650_496);
    expect(result?.fields.accountHint).toBe('5650');
    expect(result?.fields.payee).toBe('SALARY CREDIT');
  });

  it('falls back to the day it arrived when the message carries only a time', () => {
    /* The salary alert says `@ 05:18 PM` and never names a day. The arrival
       date is the right guess — and it is kept out of `evidence` on purpose, so
       the confidence score knows it was guessed. */
    const result = ucblParser.parse(msg(SALARY));
    expect(result?.fields.date).toBe('2026-08-15');
    expect(result?.evidence.date).toBeUndefined();
  });

  it('reads a debit', () => {
    const result = ucblParser.parse(msg(DEBIT));
    expect(result?.fields.direction).toBe('OUT');
    expect(result?.fields.amountMinor).toBe(340_000);
    expect(result?.fields.payee).toBe('ONLINE PURCHASE');
  });

  it('is certain about the alert that carries a date, and honest about the ones that do not', () => {
    /* `scoreConfidence` caps anything at 40 unless the direction *and* the date
       were both read from the message rather than guessed. That rule is not
       this parser's to bend: the salary and debit alerts genuinely do not name
       a day, so a draft built from them is standing on an assumption about
       when it happened, and the score should say so.

       The withdrawal alert does name one, and scores accordingly. */
    expect(ucblParser.parse(msg(ATM))?.confidence ?? 0).toBeGreaterThanOrEqual(80);

    for (const body of [SALARY, DEBIT]) {
      const result = ucblParser.parse(msg(body));
      /* Capped, but everything else is filled in — which is the part that saves
         the person typing. */
      expect(result?.confidence).toBe(40);
      expect(result?.fields.amountMinor).toBeGreaterThan(0);
      expect(result?.fields.direction).toBeDefined();
      expect(result?.fields.payee).toBeDefined();
      expect(result?.fields.balanceMinor).toBeDefined();
    }
  });

  it('claims only what is its own', () => {
    expect(ucblParser.matches(msg(ATM))).toBe(true);
    expect(ucblParser.matches(msg('Your bKash Account balance is Tk 500.00'))).toBe(false);
    expect(ucblParser.matches(msg('Your one-time code is 847213'))).toBe(false);
  });

  it('hands back a message it recognises but cannot read', () => {
    /* A balance enquiry from the same bank: the hotline matches, there is no
       transaction. Returning null passes it to the generic parser instead of
       producing a confident draft for money that never moved. */
    const enquiry = 'Dear customer, your request has been received. For query: 16419';
    expect(ucblParser.matches(msg(enquiry))).toBe(true);
    expect(ucblParser.parse(msg(enquiry))).toBeNull();
  });

  it('wins over the generic parser when it is in the registry', () => {
    const registry = createRegistry([ucblParser]);
    const result = registry.parse(msg(ATM));
    expect(result.parserName).toBe('bd.ucbl');
    expect(result.fields.direction).toBe('OUT');
  });
});
