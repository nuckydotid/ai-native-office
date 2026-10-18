import { Tooltip, type TooltipProps } from '@heroui/react';
import type { ReactNode } from 'react';

export type HintProps = Omit<TooltipProps, 'children' | 'content'> & {
  /** The words in the tooltip. */
  label: ReactNode;
  /** Keys shown after the label, e.g. "⌘K". */
  keys?: string;
  children: ReactNode;
  /** Turns the hint off, e.g. while a menu is open. */
  isHidden?: boolean;
};

/**
 * A HeroUI Tooltip for anything, including a disabled button or a dropdown trigger: it hangs on a wrapper, because a disabled
 * control gets no pointer events and a trigger already uses its own. Short delay, no linger.
 */
export function Hint({ label, keys, children, isHidden, placement = 'bottom', delay = 500, closeDelay = 0, ...props }: HintProps) {
  return (
    <Tooltip content={keys ? <span>{label} <span className="text-foreground-400">{keys}</span></span> : label} placement={placement} delay={delay} closeDelay={closeDelay} isDisabled={isHidden} {...props}>
      <span className="inline-flex">{children}</span>
    </Tooltip>
  );
}
