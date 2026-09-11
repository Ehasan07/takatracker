'use client';

import { api, ApiError, API_BASE } from '@/lib/api';
import type { PartyDueReport } from './types';

export const partyDueKeys = {
  report: () => ['reports', 'party-dues'] as const,
};

export function fetchPartyDues(): Promise<PartyDueReport> {
  return api<PartyDueReport>('/reports/party-dues');
}

/**
 * The workbook.
 *
 * Not an `<a href>`: the route is behind `JwtAuthGuard`, a bare link carries no
 * credentials the day this app stops using cookies, cannot read the filename
 * off the response, and turns a 402 into an HTML error page saved as `.xlsx`.
 *
 * A third copy of `saveBlob` rather than a shared module, for the reason
 * `(shell)/reports/exports.ts` gives on its own copy: one feature folder
 * reaching into another's internals costs more than the duplication does. This
 * one differs where it matters — the body is binary, so it is read as a blob
 * rather than as text, and there is no BOM to worry about.
 */
export async function downloadPartyDuesXlsx(asOf: string): Promise<void> {
  const path = '/reports/party-dues.xlsx';
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

  /* The one refresh retry `api()` performs. A download is what somebody does
     after leaving a tab open all afternoon, which is exactly when the
     fifteen-minute access token has expired. */
  if (res.status === 401) {
    const refreshed = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }).catch(() => null);
    if (refreshed?.ok) res = await send();
  }

  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new ApiError(res.status, detail?.message ?? `ফাইল নামানো যায়নি (${res.status})`);
  }

  const name = filenameFrom(res.headers.get('content-disposition'), `party-dues-${asOf}.xlsx`);
  saveBlob(name, await res.blob());
}

function filenameFrom(header: string | null, fallback: string): string {
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
