import { describe, expect, it } from 'vitest';
import { normaliseEmail, personIdentityKeys, sameIdentity } from './identity.js';

describe('what makes two records the same person', () => {
  it('folds every spelling of one mobile into one key', () => {
    /* The four ways the same number is written in Bangladesh. If these did not
       collide, adding somebody to a trip would make a second copy of a person
       who already owed money. */
    const written = ['01712345678', '+8801712345678', '8801712345678', '01712-345678'];
    const keys = written.map((phone) => personIdentityKeys({ phone }).phoneKey);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe('01712345678');
  });

  it('refuses to make an identity out of something that is not a mobile', () => {
    /* A landline, an extension, a half-typed number. A wrong match merges two
       people's money silently, which is far worse than no match. */
    for (const phone of ['0212345', '12345', 'later', '', '019']) {
      expect(personIdentityKeys({ phone }).phoneKey).toBeNull();
    }
  });

  it('takes an email as the second key, shape-checked', () => {
    expect(personIdentityKeys({ email: '  Karim@Example.COM ' }).email).toBe('karim@example.com');
    /* "karim" typed into the wrong box must not become an identity that the
       next person typing "karim" collides with. */
    expect(normaliseEmail('karim')).toBeNull();
    expect(normaliseEmail('karim@')).toBeNull();
  });

  it('matches on either key, and not on neither', () => {
    const karim = personIdentityKeys({ phone: '01712345678', email: 'karim@example.com' });
    expect(sameIdentity(karim, personIdentityKeys({ phone: '+8801712345678' }))).toBe(true);
    expect(sameIdentity(karim, personIdentityKeys({ email: 'KARIM@example.com' }))).toBe(true);
    expect(sameIdentity(karim, personIdentityKeys({ phone: '01912345678' }))).toBe(false);
    /* Two people with no number and no address are two people, whatever they
       are called. */
    expect(sameIdentity(personIdentityKeys({}), personIdentityKeys({}))).toBe(false);
  });
});
