import { describe, expect, it } from 'vitest';
import { isUsableShape, messageShape } from './message-shape.js';

describe('messageShape', () => {
  it('folds two instances of one alert to one shape', () => {
    const first = 'Your A/C **4521 is debited BDT 1,250.50 on 09-08-26. Avl Bal BDT 12,430.00';
    const second = 'Your A/C **4521 is debited BDT 437.77 on 21-08-26. Avl Bal BDT 70,453.73';
    expect(messageShape(first)).toBe(messageShape(second));
  });

  it('keeps a purchase alert and a balance alert apart', () => {
    const purchase = 'Your Card 714043 at DOMINOS for BDT 437.77';
    const balance = 'Your A/C balance is BDT 5,005.04 as of today';
    expect(messageShape(purchase)).not.toBe(messageShape(balance));
  });

  it('folds every OTP from one sender together', () => {
    expect(messageShape('7940 is your One Time Password (OTP) for SIVR service.')).toBe(
      messageShape('1123 is your One Time Password (OTP) for SIVR service.'),
    );
  });

  it('reads Bengali numerals as numerals', () => {
    expect(messageShape('আপনার হিসাবে ৫০০ টাকা জমা হয়েছে')).toBe(
      messageShape('আপনার হিসাবে ১২৩৪ টাকা জমা হয়েছে'),
    );
  });

  it('does not fold a message that names a number into one that does not', () => {
    /* The presence of a figure is part of the form even when its value is not. */
    expect(messageShape('Card #0570 purchase')).not.toBe(messageShape('Card purchase'));
  });

  it('stops at 160 characters, where the variation lives', () => {
    const stem = 'Dear customer your payment has been received thank you for banking with us ';
    const a = `${stem}${'x'.repeat(200)}`;
    const b = `${stem}${'y'.repeat(200)}`;
    expect(messageShape(a).length).toBeLessThanOrEqual(160);
    /* Different tails, one shape — a person deciding "this is not mine" is not
       deciding it about a session token. */
    expect(messageShape(`${stem}session abcdef`).slice(0, 60)).toBe(
      messageShape(`${stem}session 123456`).slice(0, 60),
    );
    expect(a).not.toBe(b);
  });
});

describe('isUsableShape', () => {
  it('refuses a shape that is every message', () => {
    expect(isUsableShape(messageShape('550 1,250.50'))).toBe(false);
    expect(isUsableShape(messageShape('OK'))).toBe(false);
  });

  it('accepts a real sentence', () => {
    expect(isUsableShape(messageShape('Your A/C **4521 is debited BDT 1,250.50 on 09-08-26'))).toBe(
      true,
    );
  });
});
