'use client';

import * as React from 'react';
import { haptic } from '@/lib/haptics';
import { cn } from '@/lib/utils';

/** Drag at least this far before the action fires on release. */
const COMMIT_AT = 150;

export interface SwipeAction {
  label: string;
  icon: React.ReactNode;
  /** Tailwind background class for the revealed panel. */
  className: string;
  onAction: () => void;
}

/**
 * A list row with iOS-style swipe actions, driven by pointer events so it works
 * with a finger, a stylus and a mouse alike (spec §5).
 *
 * Every action is also reachable from the buttons the row renders normally, so
 * the gesture is an accelerator and never the only way to do something.
 */
export function SwipeRow({
  left,
  right,
  children,
  className,
  /** Gestures are for fingers. On a mouse the row's buttons are the interface. */
  enabled = true,
}: {
  left?: SwipeAction;
  right?: SwipeAction;
  children: React.ReactNode;
  className?: string;
  enabled?: boolean;
}) {
  const [offset, setOffset] = React.useState(0);
  const [dragging, setDragging] = React.useState(false);
  const start = React.useRef<{ x: number; y: number } | null>(null);
  const locked = React.useRef<'h' | 'v' | null>(null);
  const armed = React.useRef(false);

  const reset = (): void => {
    setOffset(0);
    setDragging(false);
    start.current = null;
    locked.current = null;
    armed.current = false;
  };

  const onPointerDown = (e: React.PointerEvent): void => {
    if (!enabled) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    start.current = { x: e.clientX, y: e.clientY };
    locked.current = null;
    armed.current = false;
  };

  const onPointerMove = (e: React.PointerEvent): void => {
    if (!enabled || !start.current) return;
    const dx = e.clientX - start.current.x;
    const dy = e.clientY - start.current.y;

    // Decide once whether this is a scroll or a swipe, then stick with it.
    if (locked.current === null) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      locked.current = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
      if (locked.current === 'h') {
        setDragging(true);
        e.currentTarget.setPointerCapture(e.pointerId);
      }
    }
    if (locked.current !== 'h') return;

    const clamped = dx > 0 ? (right ? Math.min(dx, 200) : 0) : left ? Math.max(dx, -200) : 0;
    setOffset(clamped);

    if (!armed.current && Math.abs(clamped) >= COMMIT_AT) {
      armed.current = true;
      haptic('select');
    } else if (armed.current && Math.abs(clamped) < COMMIT_AT) {
      armed.current = false;
    }
  };

  const onPointerUp = (): void => {
    if (locked.current !== 'h') {
      reset();
      return;
    }
    const distance = Math.abs(offset);
    const action = offset > 0 ? right : left;

    if (action && distance >= COMMIT_AT) {
      haptic('success');
      action.onAction();
    }
    reset();
  };

  const revealed = offset > 0 ? right : offset < 0 ? left : null;

  return (
    <div className={cn('relative overflow-hidden', className)}>
      {revealed ? (
        <div
          aria-hidden
          className={cn(
            'absolute inset-0 flex items-center px-4 text-sm font-medium text-white',
            offset > 0 ? 'justify-start' : 'justify-end',
            revealed.className,
          )}
        >
          <span className="flex items-center gap-2">
            {revealed.icon}
            {Math.abs(offset) >= COMMIT_AT ? revealed.label : null}
          </span>
        </div>
      ) : null}

      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={reset}
        style={{
          transform: `translateX(${offset}px)`,
          transition: dragging ? 'none' : 'transform 200ms cubic-bezier(0.2, 0, 0, 1)',
          touchAction: 'pan-y',
        }}
        className="bg-surface relative"
      >
        {children}
      </div>
    </div>
  );
}
