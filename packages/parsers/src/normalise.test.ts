import { describe, expect, it } from 'vitest';
import {
  maskAccountNumbers,
  maskPhoneNumbers,
  normaliseMessage,
  redactForLlm,
} from './normalise.js';

describe('normaliseMessage', () => {
  it('collapses whitespace and newlines', () => {
    expect(normaliseMessage('Cash  Out\n Tk 500\t').normalised).toBe('Cash Out BDT 500');
  });

  it('converts Bengali digits to ASCII', () => {
    expect(normaliseMessage('৳ ১,২৩৪').normalised).toBe('BDT 1,234');
  });

  it('unifies currency markers', () => {
    expect(normaliseMessage('Tk.1000').normalised).toBe('BDT 1000');
    expect(normaliseMessage('BDT 1000').normalised).toBe('BDT 1000');
    expect(normaliseMessage('৳1000').normalised).toBe('BDT 1000');
  });

  it('keeps the raw text untouched for display', () => {
    const msg = normaliseMessage('৳ ১,২৩৪');
    expect(msg.raw).toBe('৳ ১,২৩৪');
  });
});

describe('redaction', () => {
  it('masks account numbers down to the last four', () => {
    expect(maskAccountNumbers('A/C 1234567890 debited')).toBe('A/C ****7890 debited');
  });

  it('masks Bangladeshi mobile numbers', () => {
    expect(maskPhoneNumbers('sent to 01712345678 ok')).toBe('sent to 01******678 ok');
  });

  it('leaves no full account or phone number in the LLM-facing copy', () => {
    const body = 'You have received Tk 500.00 from 01712345678. A/C 1234567890. TrxID ABC123';
    const redacted = redactForLlm(body);
    expect(redacted).not.toContain('01712345678');
    expect(redacted).not.toContain('1234567890');
  });
});
