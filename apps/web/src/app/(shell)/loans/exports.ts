'use client';

/**
 * The four export actions, all client-side and honest about what they do:
 *
 *   প্রিন্ট / পিডিএফ  window.print() against ./print.css. The browser's own
 *                     "Save as PDF" is the PDF generator; we do not pretend to
 *                     have written one.
 *   এক্সেল            a real .csv with a UTF-8 BOM, so Excel shows Bengali
 *                     instead of mojibake. Not a fake .xlsx.
 *   শেয়ার             navigator.share when the browser has it, clipboard
 *                     otherwise, and a Bengali message when it has neither.
 */

/** Quote every cell, and neuter the leading characters Excel reads as a formula. */
function cell(value: string): string {
  const safe = /^[=+@]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function toCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => row.map(cell).join(',')).join('\r\n');
}

export function downloadCsv(filename: string, rows: readonly (readonly string[])[]): void {
  // The BOM is the whole trick: without it Excel decodes the file as ANSI and
  // every Bengali character turns to rubbish.
  const blob = new Blob(['\uFEFF', toCsv(rows)], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  // A counterparty's name ends up in the filename; keep it a legal one.
  link.download = filename.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '-');
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoke on the next tick; Safari needs the URL to survive the click.
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** A frame for the print stylesheet to settle before the dialog steals the thread. */
export function printThisPage(): void {
  window.setTimeout(() => window.print(), 50);
}

export type ShareResult = 'shared' | 'copied' | 'cancelled' | 'failed';

export async function shareOrCopy(payload: { title: string; text: string }): Promise<ShareResult> {
  const nav: Navigator | undefined = typeof navigator === 'undefined' ? undefined : navigator;

  if (nav && typeof nav.share === 'function') {
    try {
      await nav.share(payload);
      return 'shared';
    } catch (err) {
      // The user closing the share sheet is not a failure.
      if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled';
      // Anything else (desktop Safari refusing, insecure context) falls through
      // to the clipboard rather than throwing at the caller.
    }
  }

  try {
    if (nav && typeof nav.clipboard?.writeText === 'function') {
      await nav.clipboard.writeText(payload.text);
      return 'copied';
    }
  } catch {
    // Clipboard permission denied — fall through.
  }

  return 'failed';
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
