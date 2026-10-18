import type { ReactNode } from 'react';
import { Link } from '@heroui/react';

/** A small underlined text action ("Stop", "Cancel", "Show details"): HeroUI's `Link` rendered as a button. */
export function TextButton({ onPress, children, isDisabled }: { onPress: () => void; children: ReactNode; isDisabled?: boolean }) {
  return (
    <Link as="button" type="button" size="sm" color="foreground" underline="always" isDisabled={isDisabled} onPress={onPress}>
      {children}
    </Link>
  );
}
