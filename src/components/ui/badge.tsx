import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary/10 text-primary',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        destructive: 'border-transparent bg-destructive/10 text-destructive',
        outline: 'text-foreground',
        success: 'border-transparent bg-emerald-50 text-emerald-700',
        warning: 'border-transparent bg-amber-50 text-amber-700',
        info: 'border-transparent bg-blue-50 text-blue-700',
        // Lead-stage hues. Each pipeline stage owns one so a stage is
        // identifiable by colour alone -- see AGENTS.md 9.8.
        sky: 'border-transparent bg-sky-50 text-sky-700',
        cyan: 'border-transparent bg-cyan-50 text-cyan-700',
        teal: 'border-transparent bg-teal-50 text-teal-700',
        indigo: 'border-transparent bg-indigo-50 text-indigo-700',
        violet: 'border-transparent bg-violet-50 text-violet-700',
        orange: 'border-transparent bg-orange-50 text-orange-700',
        yellow: 'border-transparent bg-yellow-50 text-yellow-800',
        rose: 'border-transparent bg-rose-50 text-rose-700',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof badgeVariants>) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

/** The badge colours anything in the app may ask for by name. */
export type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>['variant']>;

export { Badge, badgeVariants };
