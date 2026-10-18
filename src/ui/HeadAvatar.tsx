import { Avatar, tv, type VariantProps } from '@heroui/react';
import { headUrl, safeLook } from '../pixel/avatar';
import type { Appearance } from '../shared/workspace/types';

// Avatar sizes are whole multiples of the 12-pixel head: 24, 36 and 48 px are 2x, 3x and 4x, so the pixel art is never smeared.
const headAvatar = tv({
  base: 'shrink-0 bg-default-100',
  variants: {
    size: {
      sm: 'h-6 w-6 min-w-6',
      md: 'h-9 w-9 min-w-9',
      lg: 'h-12 w-12 min-w-12',
    },
  },
  defaultVariants: { size: 'md' },
});

const PIXELS = { sm: 24, md: 36, lg: 48 } as const;

export type HeadAvatarProps = VariantProps<typeof headAvatar> & {
  /** The person's (or agent's) pixel look. A missing or invalid one is replaced by a look made from `name`. */
  look?: unknown;
  name: string;
  className?: string;
};

/**
 * A person's or agent's pixel-art head, drawn in code from their look. HeroUI's `Avatar` shows it (with initials if the picture
 * can't be made), at sizes that keep every art pixel a clean square.
 */
export function HeadAvatar({ look, name, size = 'md', className }: HeadAvatarProps) {
  const appearance: Appearance = safeLook(look, name);
  return (
    <Avatar
      name={name}
      src={headUrl(appearance, PIXELS[size ?? 'md'])}
      radius="md"
      ignoreFallback
      disableAnimation
      classNames={{ base: headAvatar({ size, className }), img: 'wts-pixel' }}
    />
  );
}
