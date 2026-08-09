'use client';

/**
 * Downloading the current view as CSV.
 *
 * `GET /v1/export/transactions?from=&to=` is behind `JwtAuthGuard`, so it
 * cannot be an `<a href>`: a bare link carries no credentials the day this app
 * stops using cookies, cannot read the filename off the response, and cannot
 * report a failure — the user would get an HTML error page saved as `.csv`.
 * The file is fetched, checked, and handed to the browser as a blob instead.
 *
 * This duplicates `(shell)/import/transport.ts` and `(shell)/loans/exports.ts`
 * on purpose. One feature folder reaching into another's internals is how a
 * "shared" module gets born by accident; three short copies of `saveBlob` cost
 * less than that coupling.
 */

import { ApiError, API_BASE } from '@/lib/api';

/** U+FEFF. Without it Excel decodes the file as ANSI and Bengali turns to rubbish. */
const BOM = '\uFEFF';

function saveBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '-');
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoke on the next tick; Safari needs the URL to survive the click.
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** The one refresh retry `api()` performs — an export is what somebody does
 *  after leaving a tab open all afternoon, which is exactly when the 15-minute
 *  access token has expired. */
async function refreshOnce(): Promise<boolean> {
  const res = await fetch(`${API_BASE}/auth/refresh`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }).catch(() => null);
  return res?.ok ?? false;
}

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

/** Fetch a file through the same-origin proxy and save it. */
async function downloadFile(path: string, fallbackName: string): Promise<void> {
  const send = (): Promise<Response> =>
    fetch(`${API_BASE}${path}`, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { accept: '*/*' },
    });

  let res: Response;
  try {
    res = await send();
  } catch {
    throw new ApiError(0, 'সংযোগ পাওয়া যাচ্ছে না');
  }
  if (res.status === 401 && (await refreshOnce())) res = await send();

  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new ApiError(res.status, detail?.message ?? `ফাইল নামানো যায়নি (${res.status})`);
  }

  const name = filenameFromDisposition(res.headers.get('content-disposition'), fallbackName);
  const text = await res.text();
  // The API writes the BOM itself; add one only if something in between ate it.
  saveBlob(
    name,
    new Blob([text.startsWith(BOM) ? text : BOM + text], {
      type: 'text/csv;charset=utf-8;',
    }),
  );
}

/** The transactions behind the report, for exactly the period on screen. */
export function downloadTransactionsCsv(period: { from: string; to: string }): Promise<void> {
  const search = new URLSearchParams({ from: period.from, to: period.to });
  return downloadFile(
    `/export/transactions?${search.toString()}`,
    `hishab-${period.from}-${period.to}.csv`,
  );
}
