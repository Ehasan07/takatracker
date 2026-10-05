'use client';

import * as React from 'react';

/**
 * Undo snackbar. A swipe is easy to trigger by accident, so a destructive
 * action gets a window to take it back rather than a confirmation dialog that
 * would slow down every deliberate delete.
 */
export function UndoToast({
  message,
  onUndo,
  onDismiss,
  seconds = 8,
}: {
  message: string;
  onUndo: () => void;
  onDismiss: () => void;
  seconds?: number;
}) {
  const [left, setLeft] = React.useState(seconds);

  React.useEffect(() => {
    setLeft(seconds);
    const tick = setInterval(() => setLeft((n) => n - 1), 1000);
    const done = setTimeout(onDismiss, seconds * 1000);
    return () => {
      clearInterval(tick);
      clearTimeout(done);
    };
  }, [seconds, onDismiss]);

  return (
    <div
      role="status"
      data-testid="undo-toast"
      className="toast-enter bg-ink text-paper fixed inset-x-3 z-40 flex items-center gap-3 rounded-lg px-4 py-3 text-sm shadow-xl md:inset-x-auto md:bottom-6 md:right-6 md:w-80"
      style={{ bottom: 'calc(5.5rem + env(safe-area-inset-bottom))' }}
    >
      <span className="min-w-0 flex-1 truncate">{message}</span>
      <span className="tabular-nums opacity-60">{Math.max(0, left)}</span>
      <button
        type="button"
        onClick={onUndo}
        className="press min-h-9 shrink-0 rounded-xl px-3 font-semibold underline"
      >
        ফিরিয়ে আনুন
      </button>
    </div>
  );
}
