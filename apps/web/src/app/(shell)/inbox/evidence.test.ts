import { describe, expect, it } from 'vitest';
import { locateEvidence, originOf } from './evidence';

/** The plain runs plus the quoted runs must reconstitute the body exactly. */
function rebuild(body: string, evidence: Record<string, string>): string {
  return locateEvidence(body, evidence)
    .segments.map((segment) => segment.text)
    .join('');
}

describe('locateEvidence', () => {
  const BANK_SMS =
    'Dear Customer, your A/C **4521 is credited by BDT 12,500.00 on 07/08/2026. Bal BDT 48,300.00';

  it('never loses or invents a character of the body', () => {
    expect(
      rebuild(BANK_SMS, {
        amountMinor: 'BDT 12,500.00',
        direction: 'credited',
        date: '07/08/2026',
        balanceMinor: 'BDT 48,300.00',
        accountHint: 'A/C **4521',
      }),
    ).toBe(BANK_SMS);
  });

  it('highlights each field over the words it was actually read from', () => {
    const { segments, unlocated } = locateEvidence(BANK_SMS, {
      amountMinor: 'BDT 12,500.00',
      direction: 'credited',
      date: '07/08/2026',
    });
    const marks = segments.filter((s) => s.kind === 'evidence');
    expect(marks.map((s) => [s.field, s.text])).toEqual([
      ['direction', 'credited'],
      ['amountMinor', 'BDT 12,500.00'],
      ['date', '07/08/2026'],
    ]);
    expect(unlocated).toEqual([]);
  });

  /* The amount and the balance are both "BDT ..." and the amount is placed
   * first; the balance must land on its own occurrence, not steal the amount's. */
  it('gives two similar figures two different homes', () => {
    const { segments } = locateEvidence(BANK_SMS, {
      amountMinor: 'BDT 12,500.00',
      balanceMinor: 'BDT 48,300.00',
    });
    const marks = segments.filter((s) => s.kind === 'evidence');
    expect(marks).toHaveLength(2);
    expect(BANK_SMS.indexOf('BDT 12,500.00')).toBeLessThan(BANK_SMS.indexOf('BDT 48,300.00'));
  });

  it('does not let a short span sit inside a longer one', () => {
    // "500.00" occurs only inside the amount span, which is placed first.
    const { segments, unlocated } = locateEvidence('paid BDT 12,500.00 today', {
      amountMinor: 'BDT 12,500.00',
      balanceMinor: '500.00',
    });
    expect(segments.filter((s) => s.kind === 'evidence')).toHaveLength(1);
    expect(unlocated).toEqual([{ field: 'balanceMinor', text: '500.00' }]);
  });

  it('reports a quotation that is not in the body rather than guessing at one', () => {
    const { segments, unlocated } = locateEvidence('nothing useful here', {
      amountMinor: 'BDT 900',
    });
    expect(segments).toEqual([{ kind: 'text', text: 'nothing useful here' }]);
    expect(unlocated).toEqual([{ field: 'amountMinor', text: 'BDT 900' }]);
  });

  it('keeps Bengali digits exactly as the bank sent them', () => {
    const body = 'আপনার হিসাব থেকে ৳১,২৫০.৫০ উত্তোলন হয়েছে';
    const { segments } = locateEvidence(body, {
      amountMinor: '৳১,২৫০.৫০',
      direction: 'উত্তোলন',
    });
    expect(segments.filter((s) => s.kind === 'evidence').map((s) => s.text)).toEqual([
      '৳১,২৫০.৫০',
      'উত্তোলন',
    ]);
    expect(rebuild(body, { amountMinor: '৳১,২৫০.৫০', direction: 'উত্তোলন' })).toBe(body);
  });

  it('leaves a message with no evidence entirely plain', () => {
    expect(locateEvidence('hello', {})).toEqual({
      segments: [{ kind: 'text', text: 'hello' }],
      unlocated: [],
    });
    expect(locateEvidence('', {}).segments).toEqual([]);
  });

  it('survives evidence for a field it has never heard of', () => {
    const { segments } = locateEvidence('ref XYZ-9', { referenceNo: 'XYZ-9' });
    expect(segments.filter((s) => s.kind === 'evidence')).toEqual([
      { kind: 'evidence', field: 'referenceNo', text: 'XYZ-9' },
    ]);
  });
});

describe('originOf', () => {
  it('tells a quotation from a guess from an absence', () => {
    expect(originOf('2026-08-07', 'date', { date: '07/08/2026' })).toBe('read');
    expect(originOf('2026-08-07', 'date', {})).toBe('guessed');
    expect(originOf(null, 'date', {})).toBe('missing');
    expect(originOf(0, 'amountMinor', {})).toBe('guessed');
  });
});
