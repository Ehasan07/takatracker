'use client';

/**
 * Short vibrations on the actions a native app would confirm physically.
 * Silently absent on iOS Safari and on desktop — never assume it fired.
 */
type Pattern = 'tap' | 'select' | 'success' | 'warn';

const PATTERNS: Record<Pattern, number | number[]> = {
  tap: 8,
  select: 12,
  success: [10, 40, 18],
  warn: [24, 60, 24],
};

export function haptic(pattern: Pattern = 'tap'): void {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  try {
    navigator.vibrate(PATTERNS[pattern]);
  } catch {
    // A vibration is never worth an exception.
  }
}
