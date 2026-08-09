/**
 * The `/v1/audit` contract, mirrored on the client.
 *
 * `before` and `after` are free-form JSON columns: every service writes its own
 * shape and older rows carry shapes nobody writes any more. So they are typed
 * as JSON and read defensively — a payload this screen has never seen must
 * render as best it can, never throw inside a render and take the log down.
 */

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export interface AuditEvent {
  id: string;
  action: string;
  entity: string | null;
  entityId: string | null;
  actor: { id: string; name: string } | null;
  /** USER | SYSTEM | SUPPORT | INTEGRATION — widened, since the enum can grow. */
  actorType: string;
  before: JsonObject | null;
  after: JsonObject | null;
  ip: string | null;
  /** ISO 8601, UTC. */
  createdAt: string;
}

export interface AuditPage {
  items: AuditEvent[];
  nextCursor: string | null;
}

/** One leg of a transaction's double entry, as `auditSnapshot` records it. */
export interface Leg {
  accountId: string | null;
  categoryId: string | null;
  direction: string | null;
  amountMinor: number | null;
}

export const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Anything that is not a plain object is not a diffable payload. */
function payload(value: unknown): JsonObject | null {
  return isJsonObject(value) ? value : null;
}

export function toEvent(raw: unknown, index: number): AuditEvent {
  const row = isJsonObject(raw) ? raw : {};
  const actor = isJsonObject(row.actor) ? row.actor : null;

  return {
    id: str(row.id) ?? `row-${index}`,
    action: str(row.action) ?? '',
    entity: str(row.entity),
    entityId: str(row.entityId),
    actor: actor ? { id: str(actor.id) ?? '', name: str(actor.name) ?? 'অজানা' } : null,
    actorType: str(row.actorType) ?? 'USER',
    before: payload(row.before),
    after: payload(row.after),
    ip: str(row.ip),
    createdAt: str(row.createdAt) ?? '',
  };
}

export function toPage(raw: unknown): AuditPage {
  const body = isJsonObject(raw) ? raw : {};
  const items = Array.isArray(body.items) ? body.items : [];
  return {
    items: items.map((item, i) => toEvent(item, i)),
    nextCursor: str(body.nextCursor),
  };
}

/** Structural equality, so a field that did not change is not shown as if it had. */
export function sameValue(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => sameValue(item, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((key) => sameValue(a[key], b[key]));
  }
  return false;
}

/**
 * Integer poisha or nothing. `formatMinor` throws on a non-integer, and a bad
 * number in an old audit row must not be able to blank the screen.
 */
export function minorOf(value: JsonValue | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.trunc(value);
}

export function readLegs(value: JsonValue | undefined): Leg[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const row = isJsonObject(entry) ? entry : {};
    return {
      accountId: str(row.accountId),
      categoryId: str(row.categoryId),
      direction: str(row.direction),
      amountMinor: minorOf(row.amountMinor),
    };
  });
}

export const legKey = (leg: Leg): string =>
  `${leg.accountId ?? ''}|${leg.categoryId ?? ''}|${leg.direction ?? ''}|${leg.amountMinor ?? ''}`;

export interface LegDiff {
  changed: { from: Leg; to: Leg }[];
  removed: Leg[];
  added: Leg[];
  unchanged: number;
}

/**
 * Which legs actually moved.
 *
 * An edit deletes every leg and writes them again, so a naive comparison calls
 * all of them new. Identical legs are cancelled out first; what is left is
 * paired up — same side and same amount means the account or the category
 * moved, same side and same account means the amount did — so the common case
 * ("৫০০ টাকা বাজার থেকে জ্বালানিতে গেছে") reads as one changed line rather
 * than as one deletion and one insertion.
 */
export function diffLegs(before: Leg[], after: Leg[]): LegDiff {
  const removed = [...before];
  const added = [...after];
  let unchanged = 0;

  for (let i = removed.length - 1; i >= 0; i -= 1) {
    const leg = removed[i];
    if (!leg) continue;
    const key = legKey(leg);
    const match = added.findIndex((candidate) => legKey(candidate) === key);
    if (match >= 0) {
      removed.splice(i, 1);
      added.splice(match, 1);
      unchanged += 1;
    }
  }

  const changed: { from: Leg; to: Leg }[] = [];
  const pairBy = (isPair: (a: Leg, b: Leg) => boolean): void => {
    const found: { from: Leg; to: Leg }[] = [];
    for (let i = removed.length - 1; i >= 0; i -= 1) {
      const leg = removed[i];
      if (!leg) continue;
      const match = added.findIndex((candidate) => isPair(leg, candidate));
      const to = match >= 0 ? added[match] : undefined;
      if (to) {
        found.push({ from: leg, to });
        removed.splice(i, 1);
        added.splice(match, 1);
      }
    }
    // The scan runs backwards so splicing cannot shift rows out from under it;
    // reversing each pass puts its pairs back in the order they were written.
    changed.push(...found.reverse());
  };

  pairBy((a, b) => a.direction === b.direction && a.amountMinor === b.amountMinor);
  pairBy((a, b) => a.direction === b.direction && a.accountId === b.accountId);

  return { changed, removed, added, unchanged };
}
