'use client';

/**
 * Offline write queue (spec §5). Mutations made without a connection are parked
 * in IndexedDB and replayed in order when the browser comes back. Mobile uses
 * the same protocol against SQLite — the shapes are deliberately identical.
 *
 * Two rules, both about whose money a row is:
 *
 *   1. IndexedDB is scoped to the origin, never to the session. On a shared
 *      family phone the next person to sign in inherits the same database, so
 *      every row records the user and workspace it was written under and the
 *      flush refuses to replay a row the current session does not own. Without
 *      that stamp the flush posts one person's transaction into another
 *      person's double-entry ledger, under that other person's cookie.
 *   2. A row is deleted only once the server has confirmed the write landed.
 *      Anything else is kept and shown. Someone who watched the app accept
 *      their transaction must either see it reach the books or be told it did
 *      not — never be told "synced" over a write that was thrown away.
 */

const DB_NAME = 'hishab-offline';
const STORE = 'mutations';
/**
 * Not bumped for the owner stamp and the failure columns. IndexedDB stores
 * structured clones rather than a schema: the object store is unchanged, so a
 * version bump would buy nothing and could leave an upgrade `blocked` behind a
 * tab still holding a connection. Rows written before the stamp existed are
 * normalised on read instead, into an unknown owner — which is never replayed.
 */
const DB_VERSION = 1;

/** Where the signed-in identity is mirrored. See `setSessionOwner`. */
const OWNER_KEY = 'hishab.queue-owner';

/**
 * Same-origin proxy prefix, the same one `lib/api.ts` uses. Duplicated rather
 * than imported: `api.ts` imports this module, and an import cycle between the
 * two is a worse thing to own than a repeated string.
 */
const API_ROOT = '/api/v1';

/** Retry delays after a transient failure, in ms, indexed by attempt count. */
const BACKOFF_MS = [5_000, 15_000, 60_000, 300_000, 900_000];

/**
 * 4xx codes that are *not* a refusal of the write. The server is asking the
 * caller to come back later. A 401 in particular means the 15-minute access
 * cookie expired: signing in again fixes it, discarding the row loses money.
 */
const TRANSIENT_STATUSES = new Set([401, 408, 425, 429]);

/** Who a queued row belongs to. Both halves matter — one user, one workspace. */
export interface SessionOwner {
  userId: string;
  workspaceId: string;
}

export type QueueStatus = 'pending' | 'failed';

export interface QueuedMutation {
  id?: number;
  path: string;
  method: string;
  body?: unknown;
  queuedAt: number;
  /** Who was signed in when this was written. `null` only for pre-stamp rows. */
  ownerUserId: string | null;
  ownerWorkspaceId: string | null;
  status: QueueStatus;
  attempts: number;
  /** Epoch ms before which a backed-off row must not be retried. */
  nextAttemptAt: number;
  /** The server's own Bengali sentence, kept verbatim for the UI. */
  failureMessage?: string;
  failureStatus?: number;
}

/** What a caller supplies; every other column is the queue's business. */
export interface MutationInput {
  path: string;
  method: string;
  body?: unknown;
}

export interface QueueCounts {
  /** Mine, waiting for the network. */
  pending: number;
  /** Mine, refused by the server — waiting for me to decide. */
  failed: number;
  /** Someone else's, held until they sign back in on this browser. */
  held: number;
}

export interface FlushResult {
  sent: number;
  /** Rows seen in a failed state during this pass. */
  failed: number;
  /** Rows skipped because they belong to another session. */
  held: number;
  remaining: number;
}

// --- session identity ------------------------------------------------------

let currentOwner: SessionOwner | null = null;

/**
 * The shell hands the signed-in identity down here because `enqueueMutation`
 * runs inside `api()`, which has no React context to read it from.
 *
 * Mirrored into localStorage because the queue is busiest exactly when
 * `/auth/me` cannot be fetched — a cold start with no connection — and a row
 * stamped with nobody can never be delivered to anybody.
 */
export function setSessionOwner(owner: SessionOwner): void {
  currentOwner = owner;
  try {
    localStorage.setItem(OWNER_KEY, JSON.stringify(owner));
  } catch {
    // Private mode or a full quota. The in-memory copy still covers this tab.
  }
}

export function getSessionOwner(): SessionOwner | null {
  if (currentOwner) return currentOwner;
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(OWNER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SessionOwner>;
    if (typeof parsed.userId !== 'string' || typeof parsed.workspaceId !== 'string') return null;
    currentOwner = { userId: parsed.userId, workspaceId: parsed.workspaceId };
    return currentOwner;
  } catch {
    return null;
  }
}

/**
 * Called on sign-out. It forgets who this browser belonged to; it deliberately
 * does not touch the rows — see `flushQueue` for why an unclaimed row is kept.
 * Once the owner is forgotten nothing in the queue can match the next session,
 * so whoever signs in next cannot inherit a pending write.
 */
export function clearSessionOwner(): void {
  currentOwner = null;
  try {
    localStorage.removeItem(OWNER_KEY);
  } catch {
    // Nothing to clear is the same outcome as clearing it.
  }
}

function isOwnedBy(item: QueuedMutation, owner: SessionOwner | null): boolean {
  if (!owner || item.ownerUserId === null || item.ownerWorkspaceId === null) return false;
  return item.ownerUserId === owner.userId && item.ownerWorkspaceId === owner.workspaceId;
}

// --- storage ---------------------------------------------------------------

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Fill in the columns a row predating the owner stamp will not have. An
 * unknown owner stays unknown: guessing it is the whole bug.
 */
function normalize(row: QueuedMutation): QueuedMutation {
  return {
    ...row,
    ownerUserId: row.ownerUserId ?? null,
    ownerWorkspaceId: row.ownerWorkspaceId ?? null,
    status: row.status === 'failed' ? 'failed' : 'pending',
    attempts: row.attempts ?? 0,
    nextAttemptAt: row.nextAttemptAt ?? 0,
  };
}

export async function enqueueMutation(mutation: MutationInput): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  const owner = getSessionOwner();
  const row: Omit<QueuedMutation, 'id'> = {
    ...mutation,
    queuedAt: Date.now(),
    /* An unknown owner is stamped null rather than guessed. Such a row is held
     * and surfaced, never replayed: the worst case becomes a change the user
     * has to make again, not one that lands in a stranger's books. */
    ownerUserId: owner?.userId ?? null,
    ownerWorkspaceId: owner?.workspaceId ?? null,
    status: 'pending',
    attempts: 0,
    nextAttemptAt: 0,
  };

  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).add(row);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  notifyChange();
}

/** Every row on the device, oldest first, regardless of owner. */
export async function listQueued(): Promise<QueuedMutation[]> {
  if (typeof indexedDB === 'undefined') return [];
  const db = await openDb();
  const items = await new Promise<QueuedMutation[]>((resolve, reject) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    request.onsuccess = () => resolve((request.result as QueuedMutation[]).map(normalize));
    request.onerror = () => reject(request.error);
  });
  db.close();
  return items.sort((a, b) => a.queuedAt - b.queuedAt);
}

/**
 * Only the current session's failures. Another account's rows are counted for
 * the bar but never opened up: a shared phone should not show one household
 * member the amounts another one entered.
 */
export async function listFailed(): Promise<QueuedMutation[]> {
  const owner = getSessionOwner();
  return (await listQueued()).filter((item) => item.status === 'failed' && isOwnedBy(item, owner));
}

export async function countQueued(): Promise<QueueCounts> {
  const owner = getSessionOwner();
  const counts: QueueCounts = { pending: 0, failed: 0, held: 0 };
  for (const item of await listQueued()) {
    if (!isOwnedBy(item, owner)) counts.held += 1;
    else if (item.status === 'failed') counts.failed += 1;
    else counts.pending += 1;
  }
  return counts;
}

async function removeQueued(id: number): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  notifyChange();
}

/** Read-modify-write inside one transaction, so a concurrent flush cannot interleave. */
async function patchQueued(id: number, patch: Partial<QueuedMutation>): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const read = store.get(id);
    read.onsuccess = () => {
      const existing = read.result as QueuedMutation | undefined;
      if (existing) store.put({ ...normalize(existing), ...patch, id });
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  notifyChange();
}

/**
 * Discard a refusal on purpose. Ownership is re-checked here rather than
 * trusted from the caller: a delete is irreversible and this is the one place
 * queued money leaves the device without reaching the server.
 */
export async function discardQueued(id: number): Promise<void> {
  const owner = getSessionOwner();
  const item = (await listQueued()).find((row) => row.id === id);
  if (!item || !isOwnedBy(item, owner)) return;
  await removeQueued(id);
}

// --- replay ----------------------------------------------------------------

function backoffFor(attempts: number): number {
  return BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)] ?? 900_000;
}

function send(item: QueuedMutation): Promise<Response> {
  return fetch(`${API_ROOT}${item.path}`, {
    method: item.method,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: item.body === undefined ? undefined : JSON.stringify(item.body),
  });
}

/** Mirrors `api()`'s single rotation, without importing it and closing a cycle. */
async function refreshSession(): Promise<boolean> {
  try {
    const res = await fetch(`${API_ROOT}/auth/refresh`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** The API refuses in Bengali; show its sentence rather than a status code. */
async function refusalMessage(res: Response): Promise<string> {
  const payload = (await res.json().catch(() => null)) as { message?: string } | null;
  return payload?.message ?? `অনুরোধ ব্যর্থ (${res.status})`;
}

/**
 * Replay this session's queued mutations, oldest first.
 *
 * Ordering is preserved but a single refusal does not block the rest: a queued
 * row always addresses a server id (an offline create has no id to edit yet),
 * so two rows are never dependent on one another landing.
 */
export async function flushQueue(): Promise<FlushResult> {
  const owner = getSessionOwner();
  const queued = await listQueued();
  let sent = 0;
  let failed = 0;
  let held = 0;
  let refreshed = false;

  for (const item of queued) {
    if (item.id === undefined) continue;

    /* Not this session's row. Held: never replayed, never deleted.
     *
     * This is the answer to "what happens to an orphan". The person who queued
     * it still believes they made that entry, and on a shared family phone they
     * are very likely to sign back in on this same device — at which point the
     * row matches again and goes to their books, where it belongs. Deleting it
     * would destroy money they were told was saved; replaying it would post it
     * into whoever happens to be signed in now. Holding is the only option that
     * does neither, and the offline bar shows the count so it is not silent. */
    if (!isOwnedBy(item, owner)) {
      held += 1;
      continue;
    }

    // Already refused. It is waiting on the user, not on the network.
    if (item.status === 'failed') {
      failed += 1;
      continue;
    }

    // Still serving out the backoff from an earlier transient failure.
    if (item.nextAttemptAt > Date.now()) continue;

    let res: Response | null = null;
    try {
      res = await send(item);
      /* One rotation per flush. A 401 here is the short-lived access cookie
       * expiring mid-replay, exactly as `api()` handles it for live requests. */
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        if (await refreshSession()) res = await send(item);
      }
    } catch {
      res = null; // the connection went away again
    }

    if (res === null || res.status >= 500 || TRANSIENT_STATUSES.has(res.status)) {
      /* Transient: keep the row and back off. Whatever is wrong with the
       * network or the server applies to the rest of the queue too, so this
       * pass stops here rather than throwing the whole backlog at a server
       * that is already failing. */
      await patchQueued(item.id, {
        attempts: item.attempts + 1,
        nextAttemptAt: Date.now() + backoffFor(item.attempts),
      });
      break;
    }

    if (res.ok || res.status === 409) {
      /* 2xx: it landed. 409: it had already landed — the first attempt reached
       * the server and only the reply was lost. Re-posting would write the same
       * money a second time, so a duplicate is a success with nothing to send. */
      await removeQueued(item.id);
      sent += 1;
      continue;
    }

    /* Any other 4xx: the server understood the request and refused it — a
     * validation error, a plan limit, an account id that no longer exists. The
     * body cannot change on its own, so retrying earns the same refusal for
     * ever. The row stops being pending, keeps the server's own sentence, and
     * becomes something the user is told about and can discard deliberately. */
    await patchQueued(item.id, {
      status: 'failed',
      attempts: item.attempts + 1,
      failureStatus: res.status,
      failureMessage: await refusalMessage(res),
    });
    failed += 1;
  }

  return { sent, failed, held, remaining: (await listQueued()).length };
}

// --- change notification ---------------------------------------------------

const listeners = new Set<() => void>();

function notifyChange(): void {
  for (const listener of listeners) listener();
}

export function onQueueChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
