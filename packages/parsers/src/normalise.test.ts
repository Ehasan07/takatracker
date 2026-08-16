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

  it('unifies the taka spelled out, however it is capitalised', () => {
    /* `Taka 5,000 debited` is a real message from a real bank. The figure was
       always found; the currency was not, so nothing downstream could tell it
       from a bare number. */
    expect(normaliseMessage('Taka 5,000 debited').normalised).toBe('BDT 5,000 debited');
    expect(normaliseMessage('TAKA 5,000 debited').normalised).toBe('BDT 5,000 debited');
    expect(normaliseMessage('taka 5,000 debited').normalised).toBe('BDT 5,000 debited');
  });

  it('unifies BDT with a trailing full stop', () => {
    expect(normaliseMessage('BDT. 1000 debited').normalised).toBe('BDT 1000 debited');
  });

  it('unifies টাকা, which no ASCII word boundary can reach', () => {
    /* bKash and Nagad send messages with no Latin character in them at all.
       `\b` never fires beside a Bengali letter, so this needs its own
       expression — folded into the Latin alternation it would silently never
       match, and the message would carry no recognised marker. */
    expect(normaliseMessage('৫০০ টাকা কাটা হয়েছে').normalised).toContain('BDT');
    expect(normaliseMessage('৫০০ টাকা কাটা হয়েছে').currency).toBe('BDT');
  });

  it('leaves a word that merely contains a marker alone', () => {
    // Takaful is insurance, and a category name in this product.
    expect(normaliseMessage('Takaful premium 5,000').normalised).toBe('Takaful premium 5,000');
    expect(normaliseMessage('TKS for the update').normalised).toBe('TKS for the update');
  });

  it('keeps the raw text untouched for display', () => {
    const msg = normaliseMessage('৳ ১,২৩৪');
    expect(msg.raw).toBe('৳ ১,২৩৪');
  });

  it('says which currency the message named, and nothing when it named none', () => {
    expect(normaliseMessage('Cash Out Tk 500').currency).toBe('BDT');
    expect(normaliseMessage('BDT 5,000.00 credited').currency).toBe('BDT');
    expect(normaliseMessage('USD 4.6 transacted at OPENAI').currency).toBe('USD');
    // A bare figure names nothing, and saying "BDT" for it would be a guess.
    expect(normaliseMessage('500 debited from your account').currency).toBeNull();
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
