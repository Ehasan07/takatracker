import { describe, expect, it } from 'vitest';
import { toAsciiDigits } from '@hishab/shared';
import {
  bodyHashOf,
  createRegistry,
  genericParser,
  REVIEW_THRESHOLD,
  scoreConfidence,
  sha256Hex,
  type MessageParser,
  type ParseResult,
  type RawMessage,
} from './ingestion.js';

/**
 * The messages below are written the way Bangladeshi alerts actually read, and
 * every expected figure is one a person can check by hand: poisha are integers,
 * so ৳12,500.00 is 1,250,000 and the comment beside each number says it in taka.
 *
 * Nothing here is a real bank's format. Real formats arrive with real samples
 * in M8; these exercise the generic reader, which has to cope with a message it
 * has never seen and say honestly how much of it it understood.
 */

const sms = (body: string, extra: Partial<RawMessage> = {}): RawMessage => ({
  channel: 'SMS',
  body,
  ...extra,
});

const parse = (body: string, extra?: Partial<RawMessage>): ParseResult =>
  genericParser.parse(sms(body, extra)) as ParseResult;

describe('the normalisation the parser relies on', () => {
  it('maps Bengali digits one character to one character', () => {
    /* The whole evidence mechanism rests on this: the parser matches against the
     * ASCII-digit copy and slices the *original* at the same indices. If the two
     * strings ever differed in length, every evidence span would point at the
     * wrong text and the review screen would show its working for a different
     * number than the one it read. */
    const body = 'প্রিয় গ্রাহক, ৳১,২৫০.৫০ উত্তোলন — ০৭-০৮-২০২৬';
    expect(toAsciiDigits(body)).toHaveLength(body.length);
  });
});

describe('generic parser — an English credit alert', () => {
  const body =
    'Your A/C **4521 has been credited by BDT 12,500.00 on 07/08/2026. ' +
    'Available Bal BDT 1,32,400.55. TrxID 9F2K1A';
  const result = parse(body);

  it('reads the amount, not the balance and not the reference', () => {
    expect(result.fields.amountMinor).toBe(1_250_000); // ৳12,500.00
    expect(result.evidence.amountMinor).toBe('BDT 12,500.00');
  });

  it('reads the closing balance separately', () => {
    expect(result.fields.balanceMinor).toBe(13_240_055); // ৳1,32,400.55
  });

  it('reads the direction from the word that says it', () => {
    expect(result.fields.direction).toBe('IN');
    expect(result.evidence.direction).toBe('credited');
  });

  it('reads 07/08/2026 as 7 August, the way dates are written here', () => {
    expect(result.fields.date).toBe('2026-08-07');
    expect(result.evidence.date).toBe('07/08/2026');
  });

  it('keeps only the account tail', () => {
    expect(result.fields.accountHint).toBe('4521');
    expect(result.evidence.accountHint).toBe('A/C **4521');
  });

  it('takes the tail of a number masked in the middle, not its head', () => {
    /* City Bank writes `A/C: 1422***8001`. Stopping at the first star read
       `1422` — the head of the number — and reported it as the tail, which
       against an account filed under 8001 is not a near miss but a different
       account. */
    const masked = genericParser.parse({
      body: '18-Aug-2026 Tk. 19,950 Deposit Tk. 42,603 Balance A/C: 1422***8001',
    });
    expect(masked.fields.accountHint).toBe('8001');
    expect(masked.evidence.accountHint).toBe('A/C: 1422***8001');
  });

  it('is confident, because it guessed nothing', () => {
    expect(result.confidence).toBe(98);
    expect(result.confidence).toBeGreaterThanOrEqual(REVIEW_THRESHOLD);
  });
});

describe('generic parser — a Bengali withdrawal alert', () => {
  const body =
    'প্রিয় গ্রাহক, আপনার হিসাব থেকে ৳১,২৫০.৫০ উত্তোলন করা হয়েছে। ' +
    'ব্যালেন্স ৳৯,৭৪৯.৫০। তারিখ ০৭-০৮-২০২৬';
  const result = parse(body);

  it('reads Bengali digits as money', () => {
    expect(result.fields.amountMinor).toBe(125_050); // ৳1,250.50
    expect(result.fields.balanceMinor).toBe(974_950); // ৳9,749.50
  });

  it('shows the evidence in the digits the bank actually sent', () => {
    // Not "৳1,250.50". The person checking this has to recognise their own SMS.
    expect(result.evidence.amountMinor).toBe('৳১,২৫০.৫০');
  });

  it('reads উত্তোলন as money going out', () => {
    expect(result.fields.direction).toBe('OUT');
    expect(result.evidence.direction).toBe('উত্তোলন');
  });

  it('reads a Bengali-digit date', () => {
    expect(result.fields.date).toBe('2026-08-07');
    expect(result.evidence.date).toBe('০৭-০৮-২০২৬');
  });

  it('scores it high', () => {
    expect(result.confidence).toBe(93);
  });
});

describe('generic parser — a Bengali deposit alert', () => {
  const body = 'নগদ: আপনার অ্যাকাউন্টে ৳২,০০০.০০ জমা হয়েছে। ব্যালেন্স ৳৭,০০০.০০। ০৯/০৮/২০২৬ ১০:৩০';
  const result = parse(body);

  it('reads জমা as money coming in', () => {
    expect(result.fields.direction).toBe('IN');
    expect(result.evidence.direction).toBe('জমা');
  });

  it('does not mistake the clock for money', () => {
    expect(result.fields.amountMinor).toBe(200_000); // ৳2,000.00
    expect(result.fields.date).toBe('2026-08-09');
  });
});

describe('generic parser — amounts', () => {
  it('handles lakh-crore commas', () => {
    const result = parse('BDT 1,23,456.78 debited');
    expect(result.fields.amountMinor).toBe(12_345_678); // ৳1,23,456.78
  });

  it('handles plain thousands commas', () => {
    expect(parse('Tk 5,000 debited').fields.amountMinor).toBe(500_000); // ৳5,000
  });

  it('handles Bengali digits with no decimals', () => {
    expect(parse('৳৫,০০০ জমা').fields.amountMinor).toBe(500_000); // ৳5,000
  });

  it('never mistakes a phone number for a sum', () => {
    const result = parse('Cash In from 01712345678 Tk 300.00');
    expect(result.fields.amountMinor).toBe(30_000); // ৳300.00
  });

  it('leaves a fee alone and takes the real amount', () => {
    // "Fee" before the number is how these are written; the transaction is the
    // other figure.
    const result = parse('Fee Tk 5.00. Tk 1,000.00 debited on 07/08/2026');
    expect(result.fields.amountMinor).toBe(100_000); // ৳1,000.00
  });

  it('takes a labelled bare number when nothing carries a currency mark', () => {
    const result = parse('Purchase successful. Amount 450.00 on 07/08/2026');
    expect(result.fields.amountMinor).toBe(45_000); // ৳450.00
    expect(result.evidence.amountMinor).toBe('450.00');
  });
});

describe('generic parser — when there is nothing to read', () => {
  it('invents no figure and claims no confidence', () => {
    const result = parse('Dear customer, your PIN change request was successful.');
    expect(result.fields.amountMinor).toBeUndefined();
    expect(result.confidence).toBe(0);
  });

  it('will not book a balance enquiry as a payment', () => {
    /* The only number in the message is the balance. A parser that returned it
     * as an amount would credit somebody ৳5,000 they never received. */
    const result = parse('Your A/C balance is BDT 5,000.00');
    expect(result.fields.balanceMinor).toBe(500_000); // ৳5,000.00
    expect(result.fields.amountMinor).toBeUndefined();
    expect(result.confidence).toBe(0);
  });
});

describe('generic parser — the honesty cap', () => {
  it('caps a message with no date at 40, however clear the rest is', () => {
    const result = parse('BDT 1,23,456.78 debited');
    expect(result.fields.date).toBeUndefined();
    expect(result.confidence).toBeLessThanOrEqual(40);
  });

  it('caps a message with no direction at 40', () => {
    const result = parse('BDT 500.00 on 07/08/2026');
    expect(result.fields.direction).toBeUndefined();
    expect(result.confidence).toBeLessThanOrEqual(40);
  });

  it('fills the date from the day it arrived, but does not call that reading it', () => {
    const result = parse('BDT 500.00 debited', { receivedOn: '2026-08-09' });
    expect(result.fields.date).toBe('2026-08-09');
    // No evidence entry: the message never said so.
    expect(result.evidence.date).toBeUndefined();
    expect(result.confidence).toBeLessThanOrEqual(40);
  });
});

describe('generic parser — direction words that look like each other', () => {
  it('does not read "debit card" as money going out', () => {
    const result = parse('Your debit card **4521 has been credited by BDT 200.00 on 07/08/2026');
    expect(result.fields.direction).toBe('IN');
  });

  it('reads "payment received" as money coming in', () => {
    expect(parse('Payment received BDT 900.00 on 07/08/2026').fields.direction).toBe('IN');
  });

  it('reads a bare "payment to" as money going out', () => {
    expect(parse('Payment to BADHON STORE Tk 350.00 on 07/08/2026').fields.direction).toBe('OUT');
  });
});

describe('generic parser — payee', () => {
  it('reads a merchant name and stops before the amount', () => {
    const result = parse('Payment to BADHON STORE Tk 350.00 on 07/08/2026');
    expect(result.fields.payee).toBe('BADHON STORE');
    expect(result.fields.amountMinor).toBe(35_000); // ৳350.00
  });

  it('does not turn ordinary sentence text into a payee', () => {
    const result = parse('BDT 200.00 has been credited to your account on 07/08/2026');
    expect(result.fields.payee).toBeUndefined();
  });
});

describe('scoreConfidence', () => {
  it('is zero without an amount, whatever else was read', () => {
    expect(
      scoreConfidence(
        { direction: 'IN', date: '2026-08-07' },
        { direction: 'credited', date: '07/08/2026' },
      ),
    ).toBe(0);
  });

  it('rewards a marked amount over a bare number', () => {
    const marked = scoreConfidence(
      { amountMinor: 100, direction: 'IN', date: '2026-08-07' },
      { amountMinor: 'BDT 1.00', direction: 'credited', date: '07/08/2026' },
    );
    const bare = scoreConfidence(
      { amountMinor: 100, direction: 'IN', date: '2026-08-07' },
      { amountMinor: '1.00', direction: 'credited', date: '07/08/2026' },
    );
    expect(marked).toBe(85);
    expect(bare).toBe(70);
    // Amount, direction and date all read is exactly what clears the threshold.
    expect(marked).toBeGreaterThanOrEqual(REVIEW_THRESHOLD);
    expect(bare).toBeLessThan(REVIEW_THRESHOLD);
  });

  it('caps at 40 when a field is present but was never read', () => {
    // A date filled in from the arrival time has no evidence entry.
    expect(
      scoreConfidence(
        { amountMinor: 100, direction: 'IN', date: '2026-08-07', balanceMinor: 5, payee: 'X' },
        { amountMinor: 'BDT 1.00', direction: 'credited', balanceMinor: 'Bal 0.05', payee: 'X' },
      ),
    ).toBe(40);
  });

  it('never exceeds 100', () => {
    expect(
      scoreConfidence(
        {
          amountMinor: 100,
          direction: 'OUT',
          date: '2026-08-07',
          balanceMinor: 5,
          payee: 'X',
          accountHint: '4521',
        },
        {
          amountMinor: 'BDT 1.00',
          direction: 'debited',
          date: '07/08/2026',
          balanceMinor: 'Bal 0.05',
          payee: 'X',
          accountHint: '**4521',
        },
      ),
    ).toBe(100);
  });
});

describe('sha256Hex', () => {
  /* Published FIPS 180-4 vectors. A hash nobody can check against a reference is
   * a hash nobody should trust, and a mistyped round constant would otherwise
   * change every dedup key in the database without a single test failing. */
  it('matches the published vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('matches the two-block vector', () => {
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('hashes non-ASCII by its UTF-8 bytes, exactly as node and shasum do', () => {
    /* Checkable at a shell: `printf '৳' | shasum -a 256`. This is the test that
     * would catch a hand-rolled UTF-8 encoder disagreeing with everyone else's,
     * which would make the phone and the server dedupe differently. */
    expect(sha256Hex('৳')).toBe('b45846644c85cc65489337e42a9ae2f9e8dd5b022120205bdd79206966214e99');
    expect(sha256Hex('প্রিয়')).toBe(
      '75e558b833daca6793cb309a0bee2f9f523d6e5086c6b2796eb440e501e20393',
    );
  });
});

describe('bodyHashOf', () => {
  const body = 'Your A/C **4521 has been credited by BDT 12,500.00';

  it('is stable across the whitespace a retrying forwarder adds', () => {
    const base = bodyHashOf('SMS', '16247', body);
    expect(bodyHashOf('SMS', '16247', `${body} `)).toBe(base);
    expect(bodyHashOf('SMS', '16247', `  ${body}`)).toBe(base);
    expect(bodyHashOf('SMS', '16247', body.replace(/ /g, '\n'))).toBe(base);
    expect(bodyHashOf('SMS', '16247', body.replace('A/C', 'A/C\t'))).toBe(base);
  });

  it('is stable across case', () => {
    expect(bodyHashOf('SMS', '16247', body.toUpperCase())).toBe(bodyHashOf('SMS', '16247', body));
    expect(bodyHashOf('SMS', '16247', body)).toBe(bodyHashOf('sms', '16247', body));
  });

  it('changes when the money changes', () => {
    expect(bodyHashOf('SMS', '16247', body.replace('12,500', '12,600'))).not.toBe(
      bodyHashOf('SMS', '16247', body),
    );
  });

  it('separates the same text from different senders and channels', () => {
    expect(bodyHashOf('SMS', '16247', body)).not.toBe(bodyHashOf('SMS', '16248', body));
    expect(bodyHashOf('SMS', '16247', body)).not.toBe(bodyHashOf('EMAIL', '16247', body));
  });

  it('cannot be confused by moving text between the parts', () => {
    // The parts are joined with a newline, which normalisation collapses out of
    // each part, so "a" + "b c" can never hash the same as "a b" + "c".
    expect(bodyHashOf('SMS', 'bank', 'hello there')).not.toBe(
      bodyHashOf('SMS', 'bank hello', 'there'),
    );
  });

  it('treats a missing sender as an empty one, not as an absent field', () => {
    expect(bodyHashOf('SMS', null, body)).toBe(bodyHashOf('SMS', undefined, body));
    expect(bodyHashOf('SMS', null, body)).toBe(bodyHashOf('SMS', '   ', body));
  });
});

describe('the registry', () => {
  const highConfidence: ParseResult = {
    fields: { amountMinor: 100, direction: 'IN', date: '2026-08-07' },
    confidence: 99,
    evidence: { amountMinor: 'Tk 1.00' },
    parserName: 'test-bank',
  };

  const testBank: MessageParser = {
    name: 'test-bank',
    matches: (msg) => msg.sender === 'TESTBANK',
    parse: () => highConfidence,
  };

  it('puts the generic parser last', () => {
    const registry = createRegistry([testBank]);
    expect(registry.parsers.map((p) => p.name)).toEqual(['test-bank', 'generic']);
  });

  it('lets a specific parser win over the generic one', () => {
    const registry = createRegistry([testBank]);
    const result = registry.parse(
      sms('BDT 9,999.00 debited on 07/08/2026', { sender: 'TESTBANK' }),
    );
    // The generic parser would have read ৳9,999.00 going OUT. The bank's own
    // parser knows the format, so it wins outright.
    expect(result.parserName).toBe('test-bank');
    expect(result.fields.amountMinor).toBe(100);
  });

  it('falls back to generic when nothing matches the sender', () => {
    const registry = createRegistry([testBank]);
    const result = registry.parse(sms('BDT 9,999.00 debited on 07/08/2026', { sender: 'SOMEONE' }));
    expect(result.parserName).toBe('generic');
    expect(result.fields.amountMinor).toBe(999_900); // ৳9,999.00
  });

  it('falls through when a parser recognises the sender but not the message', () => {
    const shy: MessageParser = { name: 'shy', matches: () => true, parse: () => null };
    const registry = createRegistry([shy]);
    expect(registry.parse(sms('BDT 500.00 debited on 07/08/2026')).parserName).toBe('generic');
  });

  it('tries parsers in the order they were registered', () => {
    const first: MessageParser = {
      name: 'first',
      matches: () => true,
      parse: () => ({ ...highConfidence, parserName: 'first' }),
    };
    const second: MessageParser = {
      name: 'second',
      matches: () => true,
      parse: () => ({ ...highConfidence, parserName: 'second' }),
    };
    expect(createRegistry([first, second]).parse(sms('anything')).parserName).toBe('first');
  });

  it('ignores the generic parser if it is passed in, so it cannot shadow the rest', () => {
    const registry = createRegistry([genericParser, testBank]);
    expect(registry.parsers.map((p) => p.name)).toEqual(['test-bank', 'generic']);
    expect(registry.parse(sms('Tk 1.00 debited', { sender: 'TESTBANK' })).parserName).toBe(
      'test-bank',
    );
  });

  it('always returns something, even for an empty registry and an empty message', () => {
    const result = createRegistry().parse(sms(''));
    expect(result.parserName).toBe('generic');
    expect(result.confidence).toBe(0);
  });
});
