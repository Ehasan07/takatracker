'use client';

/**
 * Where a live support session is remembered, and the only place that decides
 * whether one is in force.
 *
 * ## Why this is in `lib/` and not beside the admin console
 *
 * It used to live in `app/(shell)/admin/impersonation.ts`, next to the screens
 * that start and end a session, which was the right home while the envelope was
 * only ever *displayed*. It is no longer only displayed: `lib/api.ts` now sends
 * the token on every request, so the store has to be readable from outside the
 * admin folder without dragging an admin module into the request path — and
 * without the import cycle that `api.ts → app/(shell)/admin/… → api.ts` would
 * be. The hooks that only the console needs stayed behind; see
 * `app/(shell)/admin/impersonation.ts`, which re-exports this.
 *
 * ## Why `sessionStorage`
 *
 * The envelope contains a bearer token for somebody else's ledger.
 * `localStorage` would keep it on the disk of a shared support laptop until
 * something cleared it, long after it stopped working and long after anyone
 * remembered it was there. `sessionStorage` is scoped to the one tab and dies
 * with it, which matches the life of the thing: fifteen minutes, one operator,
 * one tab.
 *
 * It is never written into the `hishab_at` cookie. The API is explicit that
 * doing so would silently replace the operator's own session with the
 * customer's, so every later admin action would be attributed to the customer
 * and closing the banner would not undo it.
 */

export interface ImpersonationEnvelope {
  tokenType: string;
  accessToken: string;
  transport: string;
  /** Always `null`. The session cannot be refreshed, extended, or survive itself. */
  refreshToken: null;
  expiresIn: number;
  expiresAt: string;
  sessionId: string;
  impersonation: {
    workspace: { id: string; name: string; status: string };
    actingAs: { id: string; name: string; email: string; role: string };
    startedBy: { id: string; email: string };
    startedAt: string;
    reason: string;
  };
  banner: string;
}

const KEY = 'hishab_support_session';

/** `undefined` = not read from storage yet. `null` = read, and there is none. */
let current: ImpersonationEnvelope | null | undefined;
const listeners = new Set<() => void>();

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isEnvelope = (value: unknown): value is ImpersonationEnvelope => {
  if (!isObject(value)) return false;
  const imp = value.impersonation;
  if (!isObject(imp)) return false;
  return (
    typeof value.accessToken === 'string' &&
    typeof value.expiresAt === 'string' &&
    isObject(imp.workspace) &&
    isObject(imp.actingAs)
  );
};

function read(): ImpersonationEnvelope | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isEnvelope(parsed) ? parsed : null;
  } catch {
    /* Private mode, a quota error, a half-written value from a crashed tab —
     * none of them are worth taking the panel down for. No session, then. */
    return null;
  }
}

/**
 * Referentially stable, which `useSyncExternalStore` requires: re-parsing the
 * JSON on every render would hand React a new object each time and loop.
 */
export function supportSnapshot(): ImpersonationEnvelope | null {
  if (current === undefined) current = read();
  return current;
}

/** Nothing is impersonated on the server render, so the bar starts absent. */
export const supportServerSnapshot = (): ImpersonationEnvelope | null => null;

export function subscribeToSupportSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setSupportSession(envelope: ImpersonationEnvelope | null): void {
  current = envelope;
  try {
    if (envelope) window.sessionStorage.setItem(KEY, JSON.stringify(envelope));
    else window.sessionStorage.removeItem(KEY);
  } catch {
    // The bar still works for the life of this tab even if nothing persisted.
  }
  for (const listener of listeners) listener();
}

export const clearSupportSession = (): void => setSupportSession(null);

export const hasExpired = (envelope: ImpersonationEnvelope, now: number): boolean => {
  const at = Date.parse(envelope.expiresAt);
  return Number.isFinite(at) && at <= now;
};

/**
 * The session `lib/api.ts` acts on, or `null`.
 *
 * Distinct from `supportSnapshot()` on purpose: an expired envelope is still
 * *present*, and the bar goes on rendering it so the operator is told why the
 * screens stopped working rather than watching the banner vanish and the app
 * turn back into their own. But an expired token must not be attached to
 * another request — the API would 401 it, `api()` would take that as a signal
 * to end the session, and the operator would lose the explanation. So the
 * banner reads the envelope and the request path reads this.
 *
 * It does not clear anything. Clearing on read would make a getter that fires
 * during render mutate a store React is subscribed to, which is the shape of a
 * render loop.
 */
export function activeSupportSession(): ImpersonationEnvelope | null {
  const session = supportSnapshot();
  if (!session) return null;
  return hasExpired(session, Date.now()) ? null : session;
}

/** True while anything in this tab is acting as somebody else. */
export const isImpersonating = (): boolean => activeSupportSession() !== null;
