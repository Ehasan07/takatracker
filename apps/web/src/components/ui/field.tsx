'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/* 44px tall on touch, tighter on a mouse — a desktop form full of phone-sized
   controls reads as a mobile site blown up. `md:` is the pointer proxy that
   Tailwind can express statically. */
const controlClasses =
  'min-h-11 md:min-h-10 w-full rounded-xl border-[1.5px] border-rule bg-surface px-3.5 py-2 md:py-1.5 text-base md:text-sm text-ink placeholder:text-ink-muted transition-colors hover:border-ink-muted focus:border-brand focus-visible:outline-2 focus-visible:outline-offset-1 disabled:opacity-50';

export const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<'input'>>(
  ({ className, ...props }, ref) => (
    <input ref={ref} className={cn(controlClasses, className)} {...props} />
  ),
);
Input.displayName = 'Input';

export const Select = React.forwardRef<HTMLSelectElement, React.ComponentProps<'select'>>(
  ({ className, ...props }, ref) => (
    <select ref={ref} className={cn(controlClasses, 'cursor-pointer', className)} {...props} />
  ),
);
Select.displayName = 'Select';

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<'textarea'>>(
  ({ className, ...props }, ref) => (
    <textarea ref={ref} className={cn(controlClasses, 'min-h-20', className)} {...props} />
  ),
);
Textarea.displayName = 'Textarea';

export function Field({
  label,
  htmlFor,
  error,
  children,
  className,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={htmlFor} className="text-ink text-sm font-semibold">
        {label}
      </label>
      {children}
      {error ? (
        // Colour is never the only signal: the text says what is wrong too.
        <p role="alert" className="text-expense text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}
