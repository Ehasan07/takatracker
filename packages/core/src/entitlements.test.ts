import { describe, expect, it } from 'vitest';
import {
  can,
  DEFAULT_FEATURES,
  DEFAULT_PLANS,
  describeBreach,
  entitlementsFromJson,
  entitlementsToJson,
  FEATURE_KEYS,
  featureLabel,
  findPlan,
  isWithinLimit,
  KNOWN_FEATURE_KEYS,
  limitFor,
  remaining,
  resolveEntitlements,
  usagePeriodKey,
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

describe('feature defaults', () => {
  it('carries both languages, because the database column pair demands both', () => {
    for (const feature of DEFAULT_FEATURES) {
      expect(feature.label, `${feature.key} needs a Bengali label`).not.toBe('');
      expect(feature.labelEn, `${feature.key} needs an English label`).not.toBe('');
      // The Bengali one is what a user reads, so it must not be ASCII.
      expect(feature.label, `${feature.key} label must be Bengali`).not.toMatch(/^[\x20-\x7e]+$/);
    }
  });

  it('has a unique key and a stable order', () => {
    expect(new Set(FEATURE_KEYS).size).toBe(FEATURE_KEYS.length);
    const orders = DEFAULT_FEATURES.map((f) => f.sortOrder);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
  });

  it('gives every monthly ceiling a MONTHLY period', () => {
    // A meter for a per-month limit that buckets by LIFETIME never resets, and
    // the user would be locked out for good in their second month.
    for (const feature of DEFAULT_FEATURES.filter((f) => f.unit === 'per-month')) {
      expect(feature.period, `${feature.key}`).toBe('MONTHLY');
    }
  });

  it('keeps the narrow union pointing at features that really exist', () => {
    for (const key of KNOWN_FEATURE_KEYS) expect(FEATURE_KEYS).toContain(key);
  });

  it('labels an unknown key with the key rather than crashing', () => {
    expect(featureLabel('accounts.max')).toBe('অ্যাকাউন্ট');
    expect(featureLabel('custom.widgets.max')).toBe('custom.widgets.max');
    expect(featureLabel('custom.widgets.max', 'উইজেট')).toBe('উইজেট');
  });
});

describe('meter period keys', () => {
  // 2026-08-31T19:00Z is already 2026-09-01 in Dhaka (+06). A server that used
  // its own clock would post September's traffic into August's bucket.
  const lateAugustUtc = new Date('2026-08-31T19:00:00Z');

  it('buckets a month in the workspace timezone, not the server one', () => {
    expect(usagePeriodKey('MONTHLY', lateAugustUtc, 'Asia/Dhaka')).toBe('2026-09');
    expect(usagePeriodKey('MONTHLY', lateAugustUtc, 'UTC')).toBe('2026-08');
  });

  it('buckets a day the same way', () => {
    expect(usagePeriodKey('DAILY', lateAugustUtc, 'Asia/Dhaka')).toBe('2026-09-01');
    expect(usagePeriodKey('DAILY', lateAugustUtc, 'UTC')).toBe('2026-08-31');
  });

  it('collapses a lifetime meter to one bucket', () => {
    expect(usagePeriodKey('LIFETIME', lateAugustUtc, 'Asia/Dhaka')).toBe('lifetime');
    expect(usagePeriodKey('LIFETIME', new Date('2020-01-01T00:00:00Z'), 'UTC')).toBe('lifetime');
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

  /**
   * This used to assert the opposite — that an unrecognised key was dropped.
   * That behaviour is exactly what stopped a super admin from assembling a
   * Custom package without a deployment, and it is not a safety net worth
   * keeping: the row can only exist because `WorkspaceFeatureOverride
   * .featureKey` passed a foreign key into `Feature.key`, so the database has
   * already vouched for it. The old assertion, that the neighbouring key is
   * untouched, still holds.
   */
  it('carries a key this build has never heard of', () => {
    const e = resolveEntitlements(asRows('FREE'), [
      { featureKey: 'custom.widgets.max', limitValue: 7 },
    ]);
    expect(limitFor(e, 'custom.widgets.max')).toBe(7);
    expect(limitFor(e, 'accounts.max')).toBe(5);
  });

  it('reaches the client, so a runtime feature can be rendered', () => {
    const e = resolveEntitlements(asRows('FREE'), [
      { featureKey: 'custom.widgets.max', limitValue: 7 },
    ]);
    expect(entitlementsToJson(e)['custom.widgets.max']).toBe(7);
  });
});

describe('a feature nobody has sold you', () => {
  it('is off, not unlimited', () => {
    // The dangerous default. If an unknown key resolved to `null` the way a
    // missing entry once did, creating a feature in the admin screen would hand
    // it to every workspace at once, uncapped, before anyone priced it.
    const free = resolveEntitlements(asRows('FREE'));
    expect(limitFor(free, 'custom.widgets.max')).toBe(0);
    expect(can(free, 'custom.widgets.max')).toBe(false);
    expect(isWithinLimit(free, 'custom.widgets.max', 0)).toBe(false);
  });

  it('can still be asked to default to something else explicitly', () => {
    const free = resolveEntitlements(asRows('FREE'));
    expect(limitFor(free, 'custom.widgets.max', null)).toBeNull();
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
