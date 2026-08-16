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
import type { DuplicateReport, StatementPreview } from './statement-types';
import type { CommitResult, ImportBatchView, ImportPreview, RevertResult } from './types';

/** `MAX_IMPORT_BYTES` in `apps/api/src/import/import.service.ts`. */
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
/**
 * `MAX_STATEMENT_BYTES`, the statement door's larger cap.
 *
 * A PDF of twenty transactions carries a logo, embedded fonts and a page of
 * terms, and is routinely bigger than a year of the same data as text.
 */
export const MAX_STATEMENT_BYTES = 8 * 1024 * 1024;
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

/**
 * The bytes, untouched.
 *
 * A PDF or a workbook decoded as text is rubbish, and the server decides the
 * format from the first few bytes — so the browser must not interpret them on
 * the way. `File` is already a `Blob`; this only exists because `fetch` wants
 * something it can send twice on a retry.
 */
export async function readFileAsBytes(file: File): Promise<ArrayBuffer> {
  try {
    return await file.arrayBuffer();
  } catch {
    throw new ApiError(0, 'ফাইলটি পড়া যায়নি');
  }
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

/**
 * `POST /v1/import/statement` — the file's raw bytes as the body.
 *
 * `application/octet-stream` on purpose. The server reads the format from the
 * first bytes rather than from what we claim, which is the only thing that
 * survives a browser sending `application/octet-stream` for a `.xlsx` (it
 * often does) or a person renaming a file.
 *
 * `accountId` is sent when it is known, because it narrows the duplicate check
 * to the account the statement is actually for. Without it every account is
 * compared against and the response says so.
 */
export async function postStatement(
  filename: string,
  bytes: ArrayBuffer,
  options: { accountId?: string; datePreference?: DatePreference; sheet?: string } = {},
): Promise<StatementPreview> {
  const search = new URLSearchParams({ filename });
  if (options.accountId) search.set('accountId', options.accountId);
  if (options.datePreference) search.set('datePreference', options.datePreference);
  if (options.sheet) search.set('sheet', options.sheet);

  const res = await rawFetch(`/import/statement?${search.toString()}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', accept: 'application/json' },
    body: bytes,
  });
  if (!res.ok) throw await failureOf(res, 'ফাইলটি পড়া যায়নি');

  const payload = (await res.json()) as StatementPreview;
  return {
    ...payload,
    grid: payload.grid ?? [],
    headers: payload.headers ?? [],
    mapping: payload.mapping ?? {},
    preamble: payload.preamble ?? [],
    sheetNames: payload.sheetNames ?? [],
    errors: payload.errors ?? [],
    duplicates: payload.duplicates ?? {
      scope: 'ALL_ACCOUNTS',
      accountId: null,
      rows: [],
      flaggedRows: 0,
    },
  };
}

/**
 * `POST /v1/import/statement/duplicates` — the same question, asked again.
 *
 * The answer depends on the account, and the account is usually chosen after
 * the file has been read. Rows and not the file: eight megabytes do not need to
 * go up the wire a second time to re-run one query.
 */
export async function postDuplicateCheck(input: {
  accountId: string | null;
  rows: { lineNumber: number; date: string; amountMinor: number }[];
}): Promise<DuplicateReport> {
  return api<DuplicateReport>('/import/statement/duplicates', {
    method: 'POST',
    body: { accountId: input.accountId, rows: input.rows },
  });
}

/** A row as the commit endpoint takes it, plus the two decisions a person made. */
export type CommitRow = ParsedRow & {
  /**
   * The category picked on the review screen. Beats `categoryName`, which is a
   * text match and cannot tell two categories with the same name apart.
   */
  categoryId?: string | null;
  /**
   * "I was shown this might already be in the books and I want it anyway."
   *
   * Only ever true on a row somebody pressed approve on after seeing what it
   * matched. Without it the server skips a row it recognises, which is the
   * right default for a file nobody has looked at line by line.
   */
  acceptDuplicate?: boolean;
};

export interface CommitInput {
  filename: string;
  fileHash: string;
  accountId: string;
  mapping: ColumnMapping;
  datePreference: DatePreference;
  rows: CommitRow[];
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
