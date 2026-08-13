import { describe, expect, it } from 'vitest';
import { firstNameOf } from './account-menu';

/**
 * Which part of a name to greet somebody by.
 *
 * A full legal name reads like a summons, so the greeting uses one word — but
 * the naive "first word" greeted `S M MEJBA UL HAQUE` as **S**, which is not a
 * name, it is a letter. Bangladeshi names carry initials and honorifics
 * constantly, so the first word is very often neither.
 */
describe('firstNameOf', () => {
  it('greets somebody by their name and not by an initial', () => {
    expect(firstNameOf('S M MEJBA UL HAQUE')).toBe('MEJBA');
    expect(firstNameOf('S.M.Ehasanul Haque')).toBe('S.M.Ehasanul');
    expect(firstNameOf('A K M Rahman')).toBe('Rahman');
  });

  it('skips the honorific people write in front of their name', () => {
    expect(firstNameOf('Md. Karim')).toBe('Karim');
    expect(firstNameOf('Mst. Rahima Begum')).toBe('Rahima');
    expect(firstNameOf('Dr Nasrin')).toBe('Nasrin');
  });

  it('leaves an ordinary name alone', () => {
    expect(firstNameOf('করিম উদ্দিন')).toBe('করিম');
    expect(firstNameOf('Shawon')).toBe('Shawon');
    expect(firstNameOf('  Rahim   Ahmed  ')).toBe('Rahim');
  });

  it('keeps the whole thing when there is nothing but initials', () => {
    /* Greeting somebody by one arbitrary letter of their own name is worse
       than greeting them by all of them. */
    expect(firstNameOf('S M K')).toBe('S M K');
    expect(firstNameOf('S')).toBe('S');
  });

  it('is empty for an empty name rather than throwing', () => {
    expect(firstNameOf('')).toBe('');
    expect(firstNameOf('   ')).toBe('');
  });
});
