'use client';

import { Delete } from 'lucide-react';
import * as React from 'react';
import { haptic } from '@/lib/haptics';
import { t } from '@/lib/t';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'del'] as const;

/**
 * The big keypad from spec §6.4. On a phone this replaces the OS keyboard for
 * amounts: the targets are far larger, the decimal point is always in the same
 * place, and the sheet never gets shoved off-screen by the keyboard opening.
 *
 * It edits the same string the text input holds, so both paths stay in sync and
 * the field remains a real, labelled input for assistive technology.
 */
export function NumericKeypad({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const press = (key: (typeof KEYS)[number]): void => {
    haptic('tap');

    if (key === 'del') {
      onChange(value.slice(0, -1));
      return;
    }
    if (key === '.') {
      if (value.includes('.')) return;
      onChange(value === '' ? '0.' : `${value}.`);
      return;
    }
    // Two decimal places is all poisha has.
    const [, fraction] = value.split('.');
    if (fraction !== undefined && fraction.length >= 2) return;
    if (value === '0') {
      onChange(key);
      return;
    }
    onChange(value + key);
  };

  return (
    <div
      className="grid grid-cols-3 gap-2"
      role="group"
      aria-label={t('keypad.label', 'সংখ্যা প্যাড')}
    >
      {KEYS.map((key) => (
        <button
          key={key}
          type="button"
          aria-label={key === 'del' ? t('common.delete', 'মুছুন') : key}
          onClick={() => press(key)}
          className="press bg-greenbar text-ink flex h-14 select-none items-center justify-center rounded-xl text-xl font-medium tabular-nums"
        >
          {key === 'del' ? <Delete className="h-5 w-5" aria-hidden /> : key}
        </button>
      ))}
    </div>
  );
}
