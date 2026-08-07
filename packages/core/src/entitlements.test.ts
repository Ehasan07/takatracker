import { describe, expect, it } from 'vitest';
import {
  can,
  DEFAULT_PLANS,
  describeBreach,
  entitlementsFromJson,
  entitlementsToJson,
  FEATURE_KEYS,
  findPlan,
  isWithinLimit,
  limitFor,
  remaining,
  resolveEntitlements,
  type PlanFeatureRow,
} from './entitlements.js';

const asRows = (code: string): PlanFeatureRow[] =>
  Object.entries(findPlan(code)!.features).map(([featureKey, limitValue]) => ({
    featureKey,
    limitValue,
  }));

const FREE = resolveEntitlements(asRows('FREE'));
const PRO = resolveEntitlements(asRows('PRO'));

describe('plan catalogue', () => {
  it('defines every feature key on every plan', () => {
    for (const plan of DEFAULT_PLANS) {
      for (const key of FEATURE_KEYS) {
        expect(Object.keys(plan.features), `${plan.code} is missing ${key}`).toContain(key);
      }
    }
  });

  it('never enables the SMS channel on a public plan', () => {
    // v3 §B2: the store build ships without SMS, so no public tier may unlock it.
    for (const plan of DEFAULT_PLANS.filter((p) => p.isPublic)) {
      expect(plan.features['sms.channel'], `${plan.code} must not enable SMS`).toBe(0);
    }
  });

  it('prices in integer poisha', () => {
    for (const plan of DEFAULT_PLANS) {
      expect(Number.isInteger(plan.priceMinor)).toBe(true);
    }
  });
});

describe('limits', () => {
  it('reads a numeric ceiling', () => {
    expect(limitFor(FREE, 'accounts.max')).toBe(5);
  });

  it('treats null as unlimited', () => {
    expect(limitFor(PRO, 'accounts.max')).toBeNull();
    expect(remaining(PRO, 'accounts.max', 9999)).toBe(Infinity);
    expect(isWithinLimit(PRO, 'accounts.max', 9999)).toBe(true);
  });

  it('counts headroom and never goes negative', () => {
    expect(remaining(FREE, 'accounts.max', 2)).toBe(3);
    expect(remaining(FREE, 'accounts.max', 5)).toBe(0);
    expect(remaining(FREE, 'accounts.max', 99)).toBe(0);
  });

  it('allows the last unit and refuses the one after it', () => {
    expect(isWithinLimit(FREE, 'accounts.max', 4)).toBe(true);
    expect(isWithinLimit(FREE, 'accounts.max', 5)).toBe(false);
  });

  it('honours a requested batch size', () => {
    expect(isWithinLimit(FREE, 'accounts.max', 3, 2)).toBe(true);
    expect(isWithinLimit(FREE, 'accounts.max', 3, 3)).toBe(false);
  });
});

describe('flags', () => {
  it('is off at zero and on otherwise', () => {
    expect(can(FREE, 'export.enabled')).toBe(false);
    expect(can(PRO, 'export.enabled')).toBe(true);
  });

  it('treats a zero limit as the feature being switched off', () => {
    // "0 mailbox connections" is a different statement from "unlimited".
    expect(can(FREE, 'email.connections.max')).toBe(false);
    expect(can(PRO, 'email.connections.max')).toBe(true);
  });
});

describe('overrides', () => {
  const now = new Date('2026-08-08T00:00:00Z');

  it('beat the plan', () => {
    const e = resolveEntitlements(
      asRows('FREE'),
      [{ featureKey: 'accounts.max', limitValue: 50 }],
      now,
    );
    expect(limitFor(e, 'accounts.max')).toBe(50);
  });

  it('can grant an owner-only feature the plans never include', () => {
    const e = resolveEntitlements(
      asRows('PRO'),
      [{ featureKey: 'sms.channel', limitValue: 1 }],
      now,
    );
    expect(can(e, 'sms.channel')).toBe(true);
  });

  it('lapse on their own once expired', () => {
    const expired = resolveEntitlements(
      asRows('FREE'),
      [{ featureKey: 'accounts.max', limitValue: 50, expiresAt: new Date('2026-08-07T00:00:00Z') }],
      now,
    );
    expect(limitFor(expired, 'accounts.max')).toBe(5);

    const live = resolveEntitlements(
      asRows('FREE'),
      [{ featureKey: 'accounts.max', limitValue: 50, expiresAt: new Date('2026-09-01T00:00:00Z') }],
      now,
    );
    expect(limitFor(live, 'accounts.max')).toBe(50);
  });

  it('ignores keys it does not recognise', () => {
    const e = resolveEntitlements(asRows('FREE'), [
      { featureKey: 'not.a.real.feature', limitValue: 1 },
    ]);
    expect(limitFor(e, 'accounts.max')).toBe(5);
  });
});

describe('fallback', () => {
  it('gives a workspace with no plan the free tier, not everything', () => {
    const none = resolveEntitlements([]);
    expect(limitFor(none, 'accounts.max')).toBe(5);
    expect(can(none, 'export.enabled')).toBe(false);
  });
});

describe('breach payload', () => {
  it('carries the key, the limit and the usage', () => {
    expect(describeBreach(FREE, 'accounts.max', 5)).toEqual({
      featureKey: 'accounts.max',
      label: 'অ্যাকাউন্ট',
      limit: 5,
      used: 5,
    });
  });

  it('is null when the feature is unlimited', () => {
    expect(describeBreach(PRO, 'accounts.max', 9999)).toBeNull();
  });
});

describe('serialisation', () => {
  it('round-trips through JSON for the client', () => {
    const json = entitlementsToJson(FREE);
    expect(json['accounts.max']).toBe(5);
    const back = entitlementsFromJson(json);
    for (const key of FEATURE_KEYS) expect(limitFor(back, key)).toBe(limitFor(FREE, key));
  });
});
