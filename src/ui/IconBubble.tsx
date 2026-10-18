import type { ReactNode } from 'react';
import { tv, type VariantProps } from '@heroui/react';

/**
 * A round-cornered tile that holds an icon, tinted with one of the theme colors. HeroUI has no such component, so it
 * follows HeroUI's own pattern: `tv` variants named `color` and `size`, theme tokens only, and a `className` escape.
 */
const iconBubble = tv({
  base: 'flex shrink-0 items-center justify-center',
  variants: {
    color: {
      default: 'bg-default/40 text-default-600',
      primary: 'bg-primary/15 text-primary',
      secondary: 'bg-secondary/15 text-secondary',
      success: 'bg-success/15 text-success',
      warning: 'bg-warning/20 text-warning-600',
      danger: 'bg-danger/15 text-danger',
    },
    size: {
      sm: 'h-7 w-7 rounded-small',
      md: 'h-9 w-9 rounded-medium',
      lg: 'h-12 w-12 rounded-large',
    },
  },
  defaultVariants: { color: 'primary', size: 'md' },
});

export type IconBubbleProps = VariantProps<typeof iconBubble> & { children: ReactNode; className?: string };

export function IconBubble({ color, size, className, children }: IconBubbleProps) {
  return <span className={iconBubble({ color, size, className })}>{children}</span>;
}
