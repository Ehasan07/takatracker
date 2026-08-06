'use client';

/**
 * Offline write queue (spec §5). Mutations made without a connection are parked
 * in IndexedDB and replayed in order when the browser comes back. Mobile uses
 * the same protocol against SQLite — the shapes are deliberately identical.
 */

const DB_NAME = 'hishab-offline';
const STORE = 'mutations';
const DB_VERSION = 1;

export interface QueuedMutation {
  id?: number;
  path: string;
  method: string;
  body?: unknown;
  queuedAt: number;
}

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

export async function enqueueMutation(
  mutation: Omit<QueuedMutation, 'queuedAt' | 'id'>,
): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).add({ ...mutation, queuedAt: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  notifyChange();
}

export async function listQueued(): Promise<QueuedMutation[]> {
  if (typeof indexedDB === 'undefined') return [];
  const db = await openDb();
  const items = await new Promise<QueuedMutation[]>((resolve, reject) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    request.onsuccess = () => resolve(request.result as QueuedMutation[]);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return items.sort((a, b) => a.queuedAt - b.queuedAt);
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

/** Replay queued mutations oldest first. Stops at the first network failure. */
export async function flushQueue(): Promise<{ sent: number; remaining: number }> {
  const queued = await listQueued();
  let sent = 0;

  for (const mutation of queued) {
    try {
      const res = await fetch(`/api/v1${mutation.path}`, {
        method: mutation.method,
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: mutation.body === undefined ? undefined : JSON.stringify(mutation.body),
      });
      // A rejected mutation is dropped rather than retried forever; a network
      // failure keeps it queued.
      if (res.ok || (res.status >= 400 && res.status < 500)) {
        if (mutation.id !== undefined) await removeQueued(mutation.id);
        sent += 1;
      } else {
        break;
      }
    } catch {
      break;
    }
  }

  return { sent, remaining: (await listQueued()).length };
}

const listeners = new Set<() => void>();

function notifyChange(): void {
  for (const listener of listeners) listener();
}

export function onQueueChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
