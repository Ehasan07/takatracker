'use client';

/**
 * The wire for this screen.
 *
 * Two calls cannot go through the shared `api()` helper, which always sends and
 * parses JSON:
 *
 *  - the preview **uploads raw text** (`text/csv`), because that is what
 *    `/v1/import/preview` takes;
 *  - the exports **download a file**, not a document.
 *
 * Both still hit the same-origin `/api/v1` proxy with `credentials:
 * 'same-origin'`, so the session cookie rides along as it does everywhere else,
 * and both retry once behind a token refresh exactly as `api()` does — an
 * export is precisely the sort of thing somebody does after leaving a tab open
 * all afternoon.
 */

import type { QueryClient } from '@tanstack/react-query';
import type { ColumnMapping, DatePreference, ParsedRow } from '@hishab/core';
import { api, ApiError, API_BASE } from '@/lib/api';
import type { CommitResult, ImportBatchView, ImportPreview, RevertResult } from './types';

/** `MAX_IMPORT_BYTES` in `apps/api/src/import/import.service.ts`. */
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
/** `MAX_COMMIT_ROWS`, ditto. Rows beyond this need the file split. */
export const MAX_COMMIT_ROWS = 2_000;

/* -------------------------------------------------------------------------
 * CSV out — our own copy of the BOM and the formula guard
 *
 * `(shell)/loans/exports.ts` has the same two tricks. It is deliberately
 * duplicated rather than imported: one feature folder reaching into another's
 * internals is how a "shared" module gets born by accident. (The *parsing* side
 * is the opposite case and now comes from `@hishab/core`, because the server
 * runs that one too.)
 * ---------------------------------------------------------------------- */

/** Quote every cell, and neuter the leading characters Excel reads as a formula. */
function cell(value: string): string {
  // A leading '-' before a digit is a negative number, not a formula; anything
  // else after it is (`-2+cmd|…`). Guarding it blindly would turn every debit
  // in the file into text.
  const dangerous = /^[=+@\t\r]/.test(value) || /^-(?!\d)/.test(value);
  return `"${(dangerous ? `'${value}` : value).replace(/"/g, '""')}"`;
}

export function toCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => row.map(cell).join(',')).join('\r\n');
}

/** Strip the characters a filesystem will not take. */
function safeName(filename: string): string {
  return filename.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '-');
}

function saveBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = safeName(filename);
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoke on the next tick; Safari needs the URL to survive the click.
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** U+FEFF. Without it Excel decodes the file as ANSI and Bengali turns to rubbish. */
const BOM = '\uFEFF';

export function downloadCsv(filename: string, rows: readonly (readonly string[])[]): void {
  saveBlob(filename, new Blob([BOM, toCsv(rows)], { type: 'text/csv;charset=utf-8;' }));
}

/**
 * Integer poisha as a plain decimal string, so Excel treats the column as
 * numbers. No float arithmetic: the fraction is taken with integer maths.
 */
export function minorToPlain(minor: number): string {
  const n = Number.isFinite(minor) ? Math.trunc(minor) : 0;
  const abs = Math.abs(n);
  return `${n < 0 ? '-' : ''}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/* -------------------------------------------------------------------------
 * Files in
 * ---------------------------------------------------------------------- */

export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new ApiError(0, 'ফাইলটি পড়া যায়নি'));
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.readAsText(file, 'utf-8');
  });
}

/* -------------------------------------------------------------------------
 * Raw fetch, with the one refresh retry `api()` performs
 * ---------------------------------------------------------------------- */

async function refreshOnce(): Promise<boolean> {
  const res = await fetch(`${API_BASE}/auth/refresh`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }).catch(() => null);
  return res?.ok ?? false;
}

async function rawFetch(path: string, init: RequestInit): Promise<Response> {
  const send = (): Promise<Response> =>
    fetch(`${API_BASE}${path}`, { ...init, credentials: 'same-origin' });

  let res: Response;
  try {
    res = await send();
  } catch {
    throw new ApiError(0, 'সংযোগ পাওয়া যাচ্ছে না');
  }

  if (res.status === 401 && (await refreshOnce())) res = await send();
  return res;
}

async function failureOf(res: Response, fallback: string): Promise<ApiError> {
  const detail = (await res.json().catch(() => null)) as { message?: string } | null;
  return new ApiError(res.status, detail?.message ?? fallback);
}

/* -------------------------------------------------------------------------
 * Files out
 * ---------------------------------------------------------------------- */

function filenameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (encoded?.[1]) {
    try {
      return decodeURIComponent(encoded[1]);
    } catch {
      /* fall through to the plain form */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain?.[1]?.trim() || fallback;
}

/**
 * Fetch a file and hand the browser a blob rather than pointing an `<a href>`
 * at the API: a link cannot report an error, cannot take the name from the
 * response, and would carry no Authorization header the day this app stops
 * using cookies.
 */
export async function downloadFile(path: string, fallbackName: string): Promise<void> {
  const res = await rawFetch(path, { method: 'GET', headers: { accept: '*/*' } });
  if (!res.ok) throw await failureOf(res, `ফাইল নামানো যায়নি (${res.status})`);

  const name = filenameFromDisposition(res.headers.get('content-disposition'), fallbackName);
  const type = res.headers.get('content-type') ?? '';
  const blob = await res.blob();

  // The API writes the BOM itself; add one only if some proxy stripped it.
  if (/csv|text\/plain/i.test(type) || name.toLowerCase().endsWith('.csv')) {
    const text = await blob.text();
    saveBlob(
      name,
      new Blob([text.startsWith(BOM) ? text : BOM + text], { type: 'text/csv;charset=utf-8;' }),
    );
    return;
  }

  saveBlob(name, blob);
}

export function exportTransactionsPath(params: {
  from?: string;
  to?: string;
  accountId?: string;
}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }
  const qs = search.toString();
  return `/export/transactions${qs ? `?${qs}` : ''}`;
}

/* -------------------------------------------------------------------------
 * Import endpoints
 * ---------------------------------------------------------------------- */

/**
 * `POST /v1/import/preview` — the file itself as the body.
 *
 * `datePreference` is sent only on the second pass, when the user has told us
 * our guess was wrong; leaving it off the first time is what lets the server
 * read the convention off the file and answer with `datePreferenceConfident`.
 */
export async function postPreview(
  filename: string,
  text: string,
  datePreference?: DatePreference,
): Promise<ImportPreview> {
  const search = new URLSearchParams({ filename });
  if (datePreference) search.set('datePreference', datePreference);

  const res = await rawFetch(`/import/preview?${search.toString()}`, {
    method: 'POST',
    headers: { 'content-type': 'text/csv;charset=utf-8', accept: 'application/json' },
    body: text,
  });
  if (!res.ok) throw await failureOf(res, 'ফাইলটি পড়া যায়নি');

  const payload = (await res.json()) as ImportPreview;
  return {
    ...payload,
    headers: payload.headers ?? [],
    mapping: payload.mapping ?? {},
    sample: payload.sample ?? [],
    errors: payload.errors ?? [],
  };
}

export interface CommitInput {
  filename: string;
  fileHash: string;
  accountId: string;
  mapping: ColumnMapping;
  datePreference: DatePreference;
  rows: ParsedRow[];
}

/** `POST /v1/import/commit`. The body is exactly what the schema accepts. */
export async function postCommit(input: CommitInput): Promise<CommitResult> {
  return api<CommitResult>('/import/commit', {
    method: 'POST',
    body: {
      filename: input.filename,
      fileHash: input.fileHash,
      accountId: input.accountId,
      mapping: input.mapping,
      datePreference: input.datePreference,
      rows: input.rows,
    },
  });
}

export async function fetchBatches(): Promise<ImportBatchView[]> {
  return (await api<ImportBatchView[]>('/import/batches')) ?? [];
}

export async function revertBatch(id: string): Promise<RevertResult> {
  return api<RevertResult>(`/import/batches/${id}/revert`, { method: 'POST', body: {} });
}

export const importKeys = {
  batches: ['import', 'batches'] as const,
};

/**
 * An import moves real money. The moment a batch lands — or is taken back —
 * every balance, every list and every report on the client is wrong, not just
 * this screen.
 */
export function invalidateAfterImport(queryClient: QueryClient): void {
  for (const key of [
    ['import'],
    ['accounts'],
    ['transactions'],
    ['summary'],
    ['reports'],
    ['entitlements'],
  ]) {
    void queryClient.invalidateQueries({ queryKey: key });
  }
}
