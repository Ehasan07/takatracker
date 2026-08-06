'use client';

import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2',
  {
    variants: {
      variant: {
        primary: 'bg-income text-white hover:opacity-90',
        danger: 'bg-expense text-white hover:opacity-90',
        outline: 'border border-rule bg-surface text-ink hover:bg-greenbar',
        ghost: 'text-ink hover:bg-greenbar',
      },
      size: {
        // 44px minimum touch target everywhere (spec §5, §10).
        default: 'min-h-11 px-4 py-2',
        sm: 'min-h-11 px-3 text-sm',
        icon: 'h-11 w-11',
        block: 'min-h-12 w-full px-4 text-base',
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
