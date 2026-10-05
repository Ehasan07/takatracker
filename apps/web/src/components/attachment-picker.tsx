'use client';

import { Camera, Paperclip, RotateCw, X } from '@/components/icons';
import * as React from 'react';
import {
  ATTACHMENT_ACCEPT,
  AttachmentViewer,
  MAX_ATTACHMENT_BYTES,
  formatBytes,
  renewSession,
  type AttachmentMeta,
  type UploadedAttachment,
} from '@/components/attachment-viewer';
import { Button } from '@/components/ui/button';
import { ApiError, API_BASE } from '@/lib/api';
import { t } from '@/lib/t';
import { fmtNumber } from '@/lib/format';
import { haptic } from '@/lib/haptics';
import { cn } from '@/lib/utils';

/**
 * Attaching a receipt.
 *
 * The upload is raw bytes with the name in a query parameter — not multipart;
 * the API refuses a multipart envelope with its own message. It goes through
 * `XMLHttpRequest` rather than `fetch` for one reason: `fetch` cannot report
 * upload progress, and a five-megabyte photograph over a Bangladeshi mobile
 * connection is long enough that a button which merely says "wait" reads as
 * broken.
 *
 * Everything the user sees here is in Bengali, including the failures, which is
 * why the server's own messages are preferred over anything invented locally —
 * `attachments.service.ts` already answers 413 and 415 in Bengali.
 */

const bn = (value: number | string): string => fmtNumber(String(value));

const TOO_LARGE = `ফাইলটি খুব বড় — সর্বোচ্চ ${bn(
  MAX_ATTACHMENT_BYTES / (1024 * 1024),
)} মেগাবাইট পর্যন্ত ছবি বা পিডিএফ দেওয়া যায়`;

const WRONG_TYPE = t(
  'attach.badType',
  'শুধু ছবি (JPEG, PNG, WebP, HEIC) অথবা পিডিএফ ফাইল দেওয়া যায়',
);

/**
 * A locally detectable refusal, so an obviously wrong file never leaves the
 * phone. Anything this cannot judge — an empty `file.type`, which is what
 * several Android pickers report for HEIC — is sent, and the server's
 * magic-byte sniff has the final say.
 */
function localRejection(file: File): string | null {
  if (file.size > MAX_ATTACHMENT_BYTES) return TOO_LARGE;
  if (file.size === 0) return t('attach.empty', 'ফাইলটি খালি — আবার চেষ্টা করুন');
  if (file.type && !file.type.startsWith('image/') && file.type !== 'application/pdf') {
    return WRONG_TYPE;
  }
  return null;
}

/**
 * Upload one file. Resolves with the stored row.
 *
 * `Content-Type` carries what the browser believes the file is; the API reads
 * it only to reject a multipart envelope and decides the real type from the
 * first bytes. An empty `file.type` therefore has to become something — and
 * `application/octet-stream` is the honest answer, not a guessed image type.
 */
export function uploadAttachment(
  file: File,
  onProgress: (percent: number) => void,
  signal?: AbortSignal,
): Promise<UploadedAttachment> {
  const send = (): Promise<UploadedAttachment> =>
    new Promise<UploadedAttachment>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API_BASE}/attachments?filename=${encodeURIComponent(file.name)}`);
      xhr.responseType = 'json';
      xhr.withCredentials = true;
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');

      const onAbort = (): void => xhr.abort();
      signal?.addEventListener('abort', onAbort);
      const done = (): void => signal?.removeEventListener('abort', onAbort);

      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable || event.total === 0) return;
        // Truncated: a progress bar must never claim 100% before the bytes land.
        onProgress(Math.min(99, Math.trunc((event.loaded * 100) / event.total)));
      };

      xhr.onload = () => {
        done();
        const payload = xhr.response as
          (UploadedAttachment & { message?: string }) | null | undefined;
        if (xhr.status >= 200 && xhr.status < 300 && payload?.id) {
          onProgress(100);
          resolve(payload);
          return;
        }
        reject(new ApiError(xhr.status, payload?.message ?? `আপলোড ব্যর্থ (${bn(xhr.status)})`));
      };

      xhr.onerror = () => {
        done();
        reject(new ApiError(0, t('attach.offline', 'সংযোগ পাওয়া যাচ্ছে না')));
      };
      xhr.onabort = () => {
        done();
        reject(new DOMException(t('attach.cancelled', 'বাতিল করা হয়েছে'), 'AbortError'));
      };

      xhr.send(file);
    });

  return send().catch(async (err: unknown) => {
    // The fifteen-minute access token expired between opening the sheet and
    // choosing a photo. Rotate once through the shared helper and try again.
    if (err instanceof ApiError && err.status === 401) {
      await renewSession();
      return send();
    }
    throw err;
  });
}

/** A file on its way up, or one that did not make it. */
interface PendingUpload {
  key: string;
  file: File;
  /** Object URL of the local file, so the thumbnail appears before the upload finishes. */
  previewUrl: string | null;
  percent: number;
  error: string | null;
  controller: AbortController;
}

export interface AttachmentPickerProps {
  /** Attachment ids currently on the record. */
  value: string[];
  onChange: (ids: string[]) => void;
  /**
   * Called for every successful upload, so the parent can delete the orphaned
   * bytes if the user abandons the form without saving.
   */
  onUploaded?: (attachment: UploadedAttachment) => void;
  /** Ids the parent already has rows for — saves a meta request each. */
  metaById?: Record<string, AttachmentMeta>;
  max?: number;
  disabled?: boolean;
  className?: string;
}

/**
 * Pick or photograph receipts, see them, remove them before saving.
 *
 * Two buttons on a phone rather than one. `capture="environment"` is what makes
 * a phone open the camera straight away, but on iOS Safari it *replaces* the
 * picker rather than adding to it — a single capture input would leave someone
 * with a receipt already in their photo library no way to reach it. So the
 * camera input carries `capture` and the file input does not, and a mouse only
 * ever sees the second one.
 */
export function AttachmentPicker({
  value,
  onChange,
  onUploaded,
  metaById,
  max = 10,
  disabled = false,
  className,
}: AttachmentPickerProps) {
  const [pending, setPending] = React.useState<PendingUpload[]>([]);
  const [notice, setNotice] = React.useState<string | null>(null);
  const cameraRef = React.useRef<HTMLInputElement>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  /* `value` and `onUploaded` are read inside an async upload that outlives the
   * render it started in; refs keep it working off the current values instead
   * of the ones captured when the user tapped. */
  const valueRef = React.useRef(value);
  valueRef.current = value;
  const onChangeRef = React.useRef(onChange);
  onChangeRef.current = onChange;
  const onUploadedRef = React.useRef(onUploaded);
  onUploadedRef.current = onUploaded;

  /* Local previews are object URLs too, and leak exactly the same way. The
   * cleanup runs on unmount only — an effect that re-ran on every change would
   * revoke URLs that are still on screen — so it reads the list through a ref
   * rather than through the closure it was created in, which would still be
   * holding the empty array from the first render. */
  const pendingRef = React.useRef(pending);
  pendingRef.current = pending;
  React.useEffect(() => {
    return () => {
      for (const item of pendingRef.current) {
        item.controller.abort();
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      }
    };
  }, []);

  const dropPending = React.useCallback((key: string, revoke: boolean): void => {
    setPending((list) => {
      const hit = list.find((p) => p.key === key);
      if (hit && revoke && hit.previewUrl) URL.revokeObjectURL(hit.previewUrl);
      return list.filter((p) => p.key !== key);
    });
  }, []);

  const start = React.useCallback(
    (item: PendingUpload): void => {
      const bump = (percent: number): void =>
        setPending((list) => list.map((p) => (p.key === item.key ? { ...p, percent } : p)));

      uploadAttachment(item.file, bump, item.controller.signal)
        .then((uploaded) => {
          haptic('success');
          dropPending(item.key, true);
          onUploadedRef.current?.(uploaded);
          if (!valueRef.current.includes(uploaded.id)) {
            onChangeRef.current([...valueRef.current, uploaded.id]);
          }
          if (uploaded.duplicateOfId) {
            setNotice(t('attach.duplicate', 'এই রসিদটি আগেও একবার যোগ করা হয়েছিল।'));
          }
        })
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === 'AbortError') {
            dropPending(item.key, true);
            return;
          }
          haptic('warn');
          const message =
            err instanceof Error ? err.message : t('attach.failed', 'আপলোড করা যায়নি');
          setPending((list) =>
            list.map((p) => (p.key === item.key ? { ...p, error: message, percent: 0 } : p)),
          );
        });
    },
    [dropPending],
  );

  const accept = React.useCallback(
    (files: FileList | null): void => {
      if (!files || files.length === 0) return;
      setNotice(null);

      const room = max - value.length - pending.length;
      if (room <= 0) {
        setNotice(`সর্বোচ্চ ${bn(max)}টি ফাইল যোগ করা যায়।`);
        return;
      }

      const chosen = [...files].slice(0, room);
      if (chosen.length < files.length) {
        setNotice(
          `সর্বোচ্চ ${bn(max)}টি ফাইল যোগ করা যায় — প্রথম ${bn(chosen.length)}টি নেওয়া হলো।`,
        );
      }

      const items: PendingUpload[] = chosen.map((file, index) => ({
        key: `${Date.now()}-${index}-${file.name}`,
        file,
        previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
        percent: 0,
        error: localRejection(file),
        controller: new AbortController(),
      }));

      setPending((list) => [...list, ...items]);
      for (const item of items) if (!item.error) start(item);
    },
    [max, pending.length, start, value.length],
  );

  const retry = (item: PendingUpload): void => {
    const fresh: PendingUpload = {
      ...item,
      error: null,
      percent: 0,
      controller: new AbortController(),
    };
    setPending((list) => list.map((p) => (p.key === item.key ? fresh : p)));
    if (localRejection(fresh.file)) return;
    start(fresh);
  };

  const remove = (id: string): void => {
    haptic('tap');
    onChange(value.filter((existing) => existing !== id));
  };

  const full = value.length + pending.length >= max;

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <input
        ref={cameraRef}
        type="file"
        accept={ATTACHMENT_ACCEPT}
        capture="environment"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          accept(e.target.files);
          e.target.value = '';
        }}
      />
      <input
        ref={fileRef}
        type="file"
        accept={ATTACHMENT_ACCEPT}
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          accept(e.target.files);
          e.target.value = '';
        }}
      />

      {value.length > 0 || pending.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {value.map((id) => (
            <li key={id} className="relative">
              <AttachmentViewer id={id} meta={metaById?.[id]} />
              {!disabled ? (
                <button
                  type="button"
                  onClick={() => remove(id)}
                  aria-label={t('attach.remove', 'সংযুক্তি সরান')}
                  className="press bg-ink text-paper absolute -right-1.5 -top-1.5 flex h-6 w-6 items-center justify-center rounded-full shadow"
                >
                  <X className="h-3.5 w-3.5" aria-hidden />
                </button>
              ) : null}
            </li>
          ))}

          {pending.map((item) => (
            <li
              key={item.key}
              className="border-rule bg-surface flex w-full items-center gap-3 rounded-xl border p-2 sm:w-auto"
            >
              {item.previewUrl ? (
                /* The local file, not a round trip: the thumbnail is there the
                   instant the camera closes. */
                <img
                  src={item.previewUrl}
                  alt=""
                  className="border-rule h-11 w-11 shrink-0 rounded-xl border object-cover"
                />
              ) : (
                <span
                  className="bg-greenbar text-ink-muted flex h-11 w-11 shrink-0 items-center justify-center rounded-xl"
                  aria-hidden
                >
                  <Paperclip className="h-4 w-4" />
                </span>
              )}

              <div className="min-w-0 flex-1">
                <p className="text-ink truncate text-xs">{item.file.name}</p>
                {item.error ? (
                  <p role="alert" className="text-expense text-xs">
                    {item.error}
                  </p>
                ) : (
                  <>
                    <div
                      role="progressbar"
                      aria-label={`${item.file.name} আপলোড হচ্ছে`}
                      aria-valuenow={item.percent}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      className="bg-greenbar border-rule mt-1 h-1.5 w-full overflow-hidden rounded-full border"
                    >
                      <div className="bg-income h-full" style={{ width: `${item.percent}%` }} />
                    </div>
                    <p className="text-ink-muted mt-0.5 text-[11px]">
                      {bn(item.percent)}% · {formatBytes(item.file.size)}
                    </p>
                  </>
                )}
              </div>

              {item.error ? (
                <button
                  type="button"
                  onClick={() => retry(item)}
                  aria-label={t('attach.retry', 'আবার চেষ্টা করুন')}
                  className="press touch-target text-ink-muted hover:bg-greenbar flex items-center justify-center rounded-xl"
                >
                  <RotateCw className="h-4 w-4" aria-hidden />
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  item.controller.abort();
                  dropPending(item.key, true);
                }}
                aria-label={
                  item.error
                    ? t('quantity.remove', 'বাদ দিন')
                    : t('attach.cancel', 'আপলোড বাতিল করুন')
                }
                className="press touch-target text-ink-muted hover:bg-greenbar flex items-center justify-center rounded-xl"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {notice ? (
        <p role="status" className="text-ink-muted text-xs">
          {notice}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {/* Camera first on a touch device — a receipt is usually still on the
            table, not already in the gallery. Hidden on a mouse, where
            `capture` means nothing. */}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || full}
          onClick={() => cameraRef.current?.click()}
          className="md:hidden"
        >
          <Camera className="h-4 w-4" aria-hidden />
          ছবি তুলুন
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || full}
          onClick={() => fileRef.current?.click()}
        >
          <Paperclip className="h-4 w-4" aria-hidden />
          রসিদ যোগ করুন
        </Button>
      </div>

      <p className="text-ink-muted text-xs">
        ছবি (JPEG, PNG, WebP, HEIC) অথবা পিডিএফ, প্রতিটি সর্বোচ্চ{' '}
        {bn(MAX_ATTACHMENT_BYTES / (1024 * 1024))} মেগাবাইট।
      </p>
    </div>
  );
}
