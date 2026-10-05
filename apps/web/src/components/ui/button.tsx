'use client';

import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'press inline-flex items-center justify-center gap-2 rounded-[14px] text-sm font-semibold disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 select-none',
  {
    variants: {
      variant: {
        /* The mark's green. A primary button is the product speaking; the
           money colours stay on amounts, and an amount is never only a colour.
           The darker lip under it is the one bit of depth in the system — it
           reads as something to press without a drop shadow's blur. */
        primary:
          'bg-brand text-brand-contrast shadow-[0_3px_0_var(--hishab-brand-strong)] hover:bg-brand-soft',
        danger: 'bg-expense text-white hover:opacity-90',
        outline:
          'border-[1.5px] border-rule bg-surface text-ink hover:border-ink-muted hover:bg-greenbar',
        ghost: 'text-ink hover:bg-brand-tint',
      },
      size: {
        // 44px minimum touch target everywhere (spec §5, §10).
        default: 'min-h-11 px-5 py-2',
        sm: 'min-h-11 px-3.5 text-sm',
        icon: 'h-11 w-11',
        block: 'min-h-13 w-full rounded-2xl px-5 text-base font-bold',
      },
    },
    defaultVariants: { variant: 'primary', size: 'default' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp className={cn(buttonVariants({ variant, size }), className)} ref={ref} {...props} />
    );
  },
);
Button.displayName = 'Button';

export { buttonVariants };
