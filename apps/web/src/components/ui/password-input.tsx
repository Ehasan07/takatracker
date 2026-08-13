'use client';

import { Eye, EyeOff } from 'lucide-react';
import * as React from 'react';
import { Input } from '@/components/ui/field';
import { t } from '@/lib/t';
import { cn } from '@/lib/utils';

/**
 * A password box you can look at.
 *
 * ## Why this is not a nicety
 *
 * Every one of these is filled on a phone keyboard, where the letter you just
 * typed is shown for a moment and then replaced by a dot — and where a Bengali
 * or hybrid keyboard, a long press, or a mis-hit is invisible until the form
 * comes back "ইমেইল/মোবাইল বা পাসওয়ার্ড ভুল". The person then cannot tell
 * whether they typed the wrong password or the right one badly, and the usual
 * next step is a password reset nobody needed.
 *
 * ## Why the default is hidden
 *
 * Shoulders. It reveals only while somebody deliberately holds it open, and
 * every field starts closed again on the next render of the screen.
 *
 * ## Why the toggle is a button and says what it does
 *
 * `aria-pressed` and a real label, so it is reachable by keyboard and readable
 * by a screen reader — an icon-only div would be a control that only a sighted
 * mouse user can find. It is also `tabIndex={-1}`: tabbing out of the password
 * field should go to the submit button, which is what somebody typing expects,
 * not to a decoration beside it.
 */
export function PasswordInput({
  id,
  name,
  value,
  onChange,
  autoComplete,
  required,
  autoFocus,
  placeholder,
  className,
  minLength,
  maxLength,
  'aria-describedby': describedBy,
}: {
  id: string;
  name?: string;
  value: string;
  onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  autoComplete?: string;
  required?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  className?: string;
  minLength?: number;
  maxLength?: number;
  /** Kept, because the reset screen points the box at its strength hint. */
  'aria-describedby'?: string;
}) {
  const [shown, setShown] = React.useState(false);

  return (
    <div className="relative">
      <Input
        id={id}
        name={name}
        type={shown ? 'text' : 'password'}
        autoComplete={autoComplete}
        required={required}
        autoFocus={autoFocus}
        placeholder={placeholder}
        minLength={minLength}
        maxLength={maxLength}
        aria-describedby={describedBy}
        value={value}
        onChange={onChange}
        /* Room for the button, so a long password does not run under it. */
        className={cn('pr-12', className)}
      />
      <button
        type="button"
        onClick={() => setShown((open) => !open)}
        aria-pressed={shown}
        aria-controls={id}
        /* "দেখান"/"লুকান", not "পাসওয়ার্ড দেখুন".
         *
         * The field's own label is "পাসওয়ার্ড", and a button whose name starts
         * with the same word makes "the password box" ambiguous — to a test
         * doing a substring match, and to somebody moving through the form
         * with a screen reader who hears two controls introduced the same way.
         * `aria-controls` already says which field it belongs to. */
        aria-label={shown ? t('password.hide', 'লুকান') : t('password.show', 'দেখান')}
        tabIndex={-1}
        className="press text-ink-muted hover:text-ink absolute right-1 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-md"
      >
        {shown ? (
          <EyeOff className="h-4 w-4" aria-hidden />
        ) : (
          <Eye className="h-4 w-4" aria-hidden />
        )}
      </button>
    </div>
  );
}
