import { Button, tv, type ButtonProps } from '@heroui/react';
import type { ReactNode } from 'react';
import { Hint } from './Hint';

const iconButton = tv({
  base: 'shrink-0',
  variants: {
    size: {
      sm: 'h-6 w-6 min-w-6 rounded-small',
      md: 'h-8 w-8 min-w-8 rounded-medium',
    },
  },
  defaultVariants: { size: 'sm' },
});

export type IconButtonProps = Omit<ButtonProps, 'isIconOnly' | 'children' | 'size' | 'aria-label'> & {
  /** What the button does: its accessible name, and the hint on hover. */
  label: string;
  /** Keys shown after the label, e.g. "⌘K". */
  keys?: string;
  size?: 'sm' | 'md';
  children: ReactNode;
};

/**
 * A small icon-only button with a tooltip: HeroUI's `Button isIconOnly` plus the hint a `title` would have shown.
 * For toolbars, rows and headers where the icon is the whole button.
 */
export function IconButton({ label, keys, size = 'sm', className, children, variant = 'light', ...props }: IconButtonProps) {
  return (
    <Hint label={label} keys={keys}>
      <Button isIconOnly aria-label={label} variant={variant} disableAnimation className={iconButton({ size, className })} {...props}>
        {children}
      </Button>
    </Hint>
  );
}
