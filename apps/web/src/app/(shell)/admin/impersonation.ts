'use client';

import * as React from 'react';
import { isJsonObject, type ImpersonationEnvelope } from './types';

/**
 * Where a live support session is remembered.
 *
 * ## Why the client has to remember anything at all
 *
 * The token `POST /admin/tenants/:id/impersonate` returns carries no marker
 * inside it — `AdminImpersonationService` says as much in its TODO, and adding
 * `imp` / `impBy` claims needs edits to `auth/` that the API change did not
 * own. So there is nothing to decode: every word the support banner says is
 * read back out of the envelope the server handed over, and if this store is
 * empty the banner cannot exist. That is the honest failure mode — a banner
 * that inferred a session from anything else would be a guess about whose data
 * is on screen.
 *
 * ## Why `sessionStorage`
 *
 * The envelope contains a bearer token for somebody else's ledger. `localStorage`
 * would keep it on the disk of a shared support laptop until something cleared
 * it, long after it stopped working and long after anyone remembered it was
 * there. `sessionStorage` is scoped to the one tab and dies with it, which
 * matches the life of the thing: fifteen minutes, one operator, one tab.
 *
 * It is never written into the `hishab_at` cookie. The API is explicit that
 * doing so would silently replace the operator's own session with the
 * customer's, so every later admin action would be attributed to the customer
 * and closing the banner would not undo it.
 */
const KEY = 'hishab_support_session';

/** `undefined` = not read from storage yet. `null` = read, and there is none. */
let current: ImpersonationEnvelope | null | undefined;
const listeners = new Set<() => void>();

const isEnvelope = (value: unknown): value is ImpersonationEnvelope => {
  if (!isJsonObject(value)) return false;
  const imp = value.impersonation;
  if (!isJsonObject(imp)) return false;
  return (
    typeof value.accessToken === 'string' &&
    typeof value.expiresAt === 'string' &&
    isJsonObject(imp.workspace) &&
    isJsonObject(imp.actingAs)
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
function snapshot(): ImpersonationEnvelope | null {
  if (current === undefined) current = read();
  return current;
}

/** Nothing is impersonated on the server render, so the bar starts absent. */
const serverSnapshot = (): ImpersonationEnvelope | null => null;

function subscribe(listener: () => void): () => void {
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

export function useSupportSession(): ImpersonationEnvelope | null {
  return React.useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}

/**
 * A clock that only ticks while something is counting down.
 *
 * The support bar shows the time left on a fifteen-minute token, and a bar that
 * says "১৪ মিনিট বাকি" for the whole session is a bar nobody believes the
 * second time.
 */
export function useNow(active: boolean): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export const hasExpired = (envelope: ImpersonationEnvelope, now: number): boolean => {
  const at = Date.parse(envelope.expiresAt);
  return Number.isFinite(at) && at <= now;
};
