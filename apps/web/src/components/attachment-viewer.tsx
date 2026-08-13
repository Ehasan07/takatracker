'use client';

import { useQuery } from '@tanstack/react-query';
import { Download, FileText, Paperclip, TriangleAlert } from 'lucide-react';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import { api, ApiError, API_BASE } from '@/lib/api';
import { fmtNumber } from '@/lib/format';
import { haptic } from '@/lib/haptics';
import { cn } from '@/lib/utils';

/**
 * Reading a stored receipt.
 *
 * Three things about this endpoint shape the component:
 *
 *  1. **The bytes are behind the session.** `GET /v1/attachments/:id` is
 *     JWT-guarded. A bare `<img src="/api/v1/attachments/:id">` would usually
 *     work — the proxy is same-origin, so the httpOnly access cookie rides
 *     along — but it breaks silently the moment that fifteen-minute token
 *     expires: an `<img>` cannot retry a 401 through the refresh endpoint, so
 *     the user gets a broken image where their receipt should be. Fetching
 *     gives us the retry, a real error message, and a blob URL we own.
 *
 *  2. **A blob URL has to be revoked.** It pins the whole file in memory until
 *     the document is discarded. A ledger that shows a receipt on every row
 *     would hold every photo it has ever rendered, so every URL created here is
 *     revoked when the id changes or the component unmounts.
 *
 *  3. **A PDF cannot be previewed.** The API sends `Content-Disposition:
 *     attachment` on purpose — an inline PDF renders as a top-level document on
 *     the API origin, where the access token lives, and a PDF can run script.
 *     So a PDF gets a file card and a download button, and we do not pretend
 *     there is a preview behind it.
 */

export interface AttachmentMeta {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** Hex SHA-256 of the bytes. */
  sha256: string;
  createdByUserId: string | null;
  createdAt: string;
}

/** What `POST /v1/attachments` answers with. */
export interface UploadedAttachment extends AttachmentMeta {
  /** An earlier live attachment in this workspace holding the same bytes. */
  duplicateOfId: string | null;
}

/** Five mebibytes — the API's cap (apps/api/src/attachments/attachments.service.ts). */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/**
 * `image/*` rather than the exact server allowlist, so a phone offers its
 * camera and its gallery. The server sniffs the magic bytes anyway and refuses
 * anything that is not JPEG, PNG, WebP, HEIC or PDF with a 415.
 */
export const ATTACHMENT_ACCEPT = 'image/*,application/pdf';

export const isPdfAttachment = (mimeType: string): boolean => mimeType === 'application/pdf';

export const attachmentKeys = {
  all: ['attachments'] as const,
  meta: (id: string) => ['attachments', 'meta', id] as const,
};

/** The row without the bytes. Goes through `api()`, so 401s refresh and retry. */
export function fetchAttachmentMeta(id: string): Promise<AttachmentMeta> {
  return api<AttachmentMeta>(`/attachments/${id}/meta`);
}

/** Bengali file size. Truncated, never rounded — ESLint bans `Math.round`. */
export function formatBytes(bytes: number): string {
  const bn = (value: string): string => fmtNumber(value);
  if (bytes < 1024) return `${bn(String(bytes))} বাইট`;
  if (bytes < 1024 * 1024) return `${bn(String(Math.trunc(bytes / 1024)))} কিলোবাইট`;
  // One decimal place, built from integers so no float formatting is involved.
  const tenths = Math.trunc((bytes * 10) / (1024 * 1024));
  return `${bn(`${Math.trunc(tenths / 10)}.${tenths % 10}`)} মেগাবাইট`;
}

/**
 * Force a session rotation through `lib/api`'s own helper.
 *
 * `api()` refreshes an expired access token on any 401 and de-duplicates
 * concurrent refreshes. Posting to `/auth/refresh` from here instead would be a
 * second, undeduplicated rotation, and refresh tokens rotate with reuse
 * detection (apps/api/src/auth/auth.service.ts) — two in flight at once look
 * like a replay and revoke the whole family, logging the user out. So the nudge
 * is an ordinary read that happens to travel the shared path.
 */
export async function renewSession(): Promise<void> {
  await api<unknown>('/accounts').catch(() => undefined);
}

/** The bytes, as a Blob. Retries once through a refreshed session on a 401. */
export async function fetchAttachmentBytes(id: string, signal?: AbortSignal): Promise<Blob> {
  const get = (): Promise<Response> =>
    fetch(`${API_BASE}/attachments/${id}`, {
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
    });

  let res = await get();
  if (res.status === 401) {
    await renewSession();
    res = await get();
  }

  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new ApiError(res.status, payload?.message ?? 'ফাইলটি আনা যায়নি');
  }
  return res.blob();
}

interface BlobUrlState {
  url: string | null;
  loading: boolean;
  error: string | null;
}

const IDLE: BlobUrlState = { url: null, loading: false, error: null };

/**
 * An object URL for an attachment's bytes, revoked on unmount and whenever the
 * id changes. Pass `enabled: false` to hold off — a PDF has nothing to preview,
 * so it never pays for the download until the user asks for it.
 */
export function useAttachmentUrl(id: string | null, enabled = true): BlobUrlState {
  const [state, setState] = React.useState<BlobUrlState>(IDLE);

  React.useEffect(() => {
    if (!id || !enabled) {
      setState(IDLE);
      return;
    }

    let objectUrl: string | null = null;
    let cancelled = false;
    const controller = new AbortController();

    setState({ url: null, loading: true, error: null });

    fetchAttachmentBytes(id, controller.signal)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ url: objectUrl, loading: false, error: null });
      })
      .catch((err: unknown) => {
        if (cancelled || controller.signal.aborted) return;
        setState({
          url: null,
          loading: false,
          error: err instanceof Error ? err.message : 'ফাইলটি আনা যায়নি',
        });
      });

    return () => {
      cancelled = true;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id, enabled]);

  return state;
}

/**
 * Save the file to the user's device.
 *
 * The bytes are fetched rather than linked because the endpoint needs the
 * session; the temporary URL is released on a timer because revoking it in the
 * same tick cancels the download in Safari.
 */
export async function downloadAttachment(id: string, filename: string): Promise<void> {
  const blob = await fetchAttachmentBytes(id);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename || 'attachment';
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * "This row has receipts", without downloading any of them.
 *
 * A ledger page holds fifty rows; fetching a photograph for each one to draw a
 * thumbnail nobody asked for would cost tens of megabytes on a phone. The row
 * gets a paperclip and a count, and the images load when the row is opened.
 */
export function AttachmentBadge({ count, className }: { count: number; className?: string }) {
  if (count <= 0) return null;
  return (
    <span
      className={cn('text-ink-muted inline-flex shrink-0 items-center gap-0.5 text-xs', className)}
      title={`${fmtNumber(String(count))}টি সংযুক্তি`}
    >
      <Paperclip className="h-3 w-3" aria-hidden />
      <span aria-label={`${fmtNumber(String(count))}টি সংযুক্তি`}>{fmtNumber(String(count))}</span>
    </span>
  );
}

function FileCard({
  meta,
  note,
  className,
}: {
  meta: AttachmentMeta;
  note?: string;
  className?: string;
}) {
  return (
    <div className={cn('rounded-card border-rule bg-greenbar border p-4', className)}>
      <div className="flex items-center gap-3">
        <FileText className="text-ink-muted h-8 w-8 shrink-0" aria-hidden />
        <div className="min-w-0">
          <p className="text-ink truncate text-sm font-medium">{meta.filename}</p>
          <p className="text-ink-muted text-xs">
            {isPdfAttachment(meta.mimeType) ? 'পিডিএফ' : meta.mimeType} ·{' '}
            {formatBytes(meta.sizeBytes)}
          </p>
        </div>
      </div>
      {note ? <p className="text-ink-muted mt-3 text-xs">{note}</p> : null}
    </div>
  );
}

/** The square thumbnail. An image shows itself; anything else shows a document icon. */
function Thumbnail({ meta, size }: { meta: AttachmentMeta; size: 'sm' | 'md' }) {
  const pdf = isPdfAttachment(meta.mimeType);
  const { url, loading, error } = useAttachmentUrl(meta.id, !pdf);
  const [decodeFailed, setDecodeFailed] = React.useState(false);

  // Reset when the row changes underneath us, or a good image inherits a failure.
  React.useEffect(() => setDecodeFailed(false), [meta.id]);

  const box = size === 'sm' ? 'h-11 w-11' : 'h-16 w-16';

  if (pdf || decodeFailed || error) {
    return (
      <span
        className={cn(
          'border-rule bg-greenbar text-ink-muted flex items-center justify-center rounded-md border',
          box,
        )}
        aria-hidden
      >
        {error ? <TriangleAlert className="h-5 w-5" /> : <FileText className="h-5 w-5" />}
      </span>
    );
  }

  if (loading || !url) {
    return <span className={cn('bg-greenbar animate-pulse rounded-md', box)} aria-hidden />;
  }

  /* A plain <img>, not next/image: the source is a blob URL that exists only in
     this tab, so there is nothing for an image optimiser to fetch or cache. */
  return (
    <img
      src={url}
      alt=""
      onError={() => setDecodeFailed(true)}
      className={cn('border-rule rounded-md border object-cover', box)}
    />
  );
}

export interface AttachmentViewerProps {
  id: string;
  /** Skips the meta request when the caller already has the row. */
  meta?: AttachmentMeta;
  size?: 'sm' | 'md';
  className?: string;
}

/**
 * One receipt: a thumbnail that opens the full-size file in a sheet, with a
 * download action. Images render inline; PDFs get a card that says why they do
 * not.
 */
export function AttachmentViewer({
  id,
  meta: given,
  size = 'md',
  className,
}: AttachmentViewerProps) {
  const [open, setOpen] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);

  const metaQuery = useQuery({
    queryKey: attachmentKeys.meta(id),
    queryFn: () => fetchAttachmentMeta(id),
    enabled: given === undefined,
    // An attachment row is immutable once written; there is nothing to re-read.
    staleTime: Infinity,
  });

  const meta = given ?? metaQuery.data;

  if (!meta) {
    const box = size === 'sm' ? 'h-11 w-11' : 'h-16 w-16';
    return metaQuery.isError ? (
      <span
        className={cn(
          'border-rule text-ink-muted flex items-center justify-center rounded-md border border-dashed',
          box,
          className,
        )}
        title="ফাইলটি পাওয়া যায়নি"
      >
        <TriangleAlert className="h-5 w-5" aria-hidden />
        <span className="sr-only">ফাইলটি পাওয়া যায়নি</span>
      </span>
    ) : (
      <span className={cn('bg-greenbar animate-pulse rounded-md', box, className)} aria-hidden />
    );
  }

  const save = (): void => {
    setSaveError(null);
    setSaving(true);
    downloadAttachment(meta.id, meta.filename)
      .catch((err: unknown) =>
        setSaveError(err instanceof Error ? err.message : 'ডাউনলোড করা যায়নি'),
      )
      .finally(() => setSaving(false));
  };

  return (
    <>
      <button
        type="button"
        onClick={() => {
          haptic('tap');
          setOpen(true);
        }}
        aria-label={`দেখুন: ${meta.filename}`}
        className={cn('press touch-target flex items-center justify-center rounded-md', className)}
      >
        <Thumbnail meta={meta} size={size} />
      </button>

      <Sheet open={open} onOpenChange={setOpen} title="সংযুক্তি" description={meta.filename}>
        <div className="flex flex-col gap-4">
          <FullSize meta={meta} />

          <dl className="text-ink-muted grid grid-cols-2 gap-2 text-xs">
            <div>
              <dt>আকার</dt>
              <dd className="text-ink">{formatBytes(meta.sizeBytes)}</dd>
            </div>
            <div>
              <dt>ধরন</dt>
              <dd className="text-ink break-all">{meta.mimeType}</dd>
            </div>
          </dl>

          {saveError ? (
            <p role="alert" className="bg-expense/10 text-expense rounded-md px-3 py-2 text-sm">
              {saveError}
            </p>
          ) : null}

          <Button variant="outline" size="block" disabled={saving} onClick={save}>
            <Download className="h-4 w-4" aria-hidden />
            {saving ? 'নেওয়া হচ্ছে…' : 'ডাউনলোড করুন'}
          </Button>
        </div>
      </Sheet>
    </>
  );
}

/** The body of the sheet: the picture, or an honest explanation of its absence. */
function FullSize({ meta }: { meta: AttachmentMeta }) {
  const pdf = isPdfAttachment(meta.mimeType);
  const { url, loading, error } = useAttachmentUrl(meta.id, !pdf);
  const [decodeFailed, setDecodeFailed] = React.useState(false);

  React.useEffect(() => setDecodeFailed(false), [meta.id]);

  if (pdf) {
    return (
      <FileCard
        meta={meta}
        note="নিরাপত্তার কারণে পিডিএফ এখানে খুলে দেখানো হয় না। ডাউনলোড করে আপনার ফোন বা কম্পিউটারে দেখুন।"
      />
    );
  }

  if (loading) {
    return <div className="bg-greenbar h-64 w-full animate-pulse rounded-md" aria-hidden />;
  }

  if (error) {
    return (
      <div
        role="alert"
        className="rounded-card border-rule flex flex-col items-center gap-2 border border-dashed p-6 text-center"
      >
        <TriangleAlert className="text-expense h-6 w-6" aria-hidden />
        <p className="text-ink text-sm">{error}</p>
      </div>
    );
  }

  /* HEIC is what every iPhone writes and what no browser except Safari can
   * decode. The download still works, so say that rather than showing a broken
   * image icon. */
  if (decodeFailed || !url) {
    return (
      <FileCard
        meta={meta}
        note="এই ছবিটি এই ব্রাউজারে দেখানো যাচ্ছে না — সম্ভবত ফরম্যাটটি (যেমন HEIC) সমর্থিত নয়। ডাউনলোড করে দেখুন।"
      />
    );
  }

  return (
    <img
      src={url}
      alt={meta.filename}
      onError={() => setDecodeFailed(true)}
      className="border-rule mx-auto max-h-[60dvh] w-full rounded-md border object-contain"
    />
  );
}
