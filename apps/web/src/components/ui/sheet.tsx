'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import * as React from 'react';
import { useIsDesktop, useKeyboardInset } from '@/hooks/use-device';
import { haptic } from '@/lib/haptics';
import { t } from '@/lib/t';
import { cn } from '@/lib/utils';

const DISMISS_AT = 110;

/**
 * Bottom sheet on phones, centred dialog from 768px up.
 *
 * On a phone it behaves the way a native sheet does: a grabber you can drag,
 * it follows your finger, it snaps back if you do not pull far enough, and it
 * lifts above the on-screen keyboard instead of being covered by it.
 */
export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}) {
  const isDesktop = useIsDesktop();
  const keyboardInset = useKeyboardInset();
  const [drag, setDrag] = React.useState(0);
  const startY = React.useRef<number | null>(null);
  const armed = React.useRef(false);

  React.useEffect(() => {
    if (!open) {
      setDrag(0);
      startY.current = null;
      armed.current = false;
    }
  }, [open]);

  const onPointerDown = (e: React.PointerEvent): void => {
    if (isDesktop) return;
    startY.current = e.clientY;
    armed.current = false;
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent): void => {
    if (startY.current === null) return;
    const dy = Math.max(0, e.clientY - startY.current);
    setDrag(dy);
    if (!armed.current && dy >= DISMISS_AT) {
      armed.current = true;
      haptic('select');
    }
  };

  const onPointerUp = (): void => {
    if (startY.current === null) return;
    const shouldClose = drag >= DISMISS_AT;
    startY.current = null;
    armed.current = false;
    if (shouldClose) onOpenChange(false);
    else setDrag(0);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="sheet-overlay fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content
          className={cn(
            'sheet-panel bg-surface text-ink fixed z-50 flex flex-col shadow-2xl',
            'inset-x-0 bottom-0 max-h-[92dvh] rounded-t-2xl',
            'md:inset-x-auto md:bottom-auto md:left-1/2 md:top-1/2 md:max-h-[85dvh] md:w-[32rem] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-2xl',
            className,
          )}
          style={{
            transform: drag > 0 ? `translateY(${drag}px)` : undefined,
            transition:
              startY.current === null ? 'transform 220ms cubic-bezier(0.2,0,0,1)' : 'none',
            // Lift clear of the on-screen keyboard rather than hiding under it.
            paddingBottom: keyboardInset ? `${keyboardInset}px` : 'env(safe-area-inset-bottom)',
          }}
        >
          {/* Grabber — the affordance that says "this can be dragged away". */}
          <div
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            className="no-select flex shrink-0 cursor-grab justify-center pb-1 pt-2.5 active:cursor-grabbing md:hidden"
            style={{ touchAction: 'none' }}
            aria-hidden
          >
            <div className="bg-rule h-1 w-10 rounded-full" />
          </div>

          <div className="border-rule bg-surface flex shrink-0 items-center justify-between border-b px-4 py-3">
            <div className="min-w-0">
              <Dialog.Title className="truncate text-lg font-semibold">{title}</Dialog.Title>
              {description ? (
                <Dialog.Description className="text-ink-muted truncate text-sm">
                  {description}
                </Dialog.Description>
              ) : (
                <Dialog.Description className="sr-only">{title}</Dialog.Description>
              )}
            </div>
            <Dialog.Close
              aria-label={t('common.close', 'বন্ধ করুন')}
              className="press touch-target hover:bg-greenbar -mr-2 flex items-center justify-center rounded-md"
            >
              <X className="h-5 w-5" aria-hidden />
            </Dialog.Close>
          </div>

          <div className="app-scroll min-h-0 flex-1 px-4 py-4">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
