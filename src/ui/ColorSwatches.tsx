// ui-check-ignore-file: the swatches show a character's own colors, which are data (shared/workspace/looks.ts), not app styling
import { RadioGroup, VisuallyHidden, tv, useRadio, type RadioProps, type VariantProps } from '@heroui/react';

const swatch = tv({
  slots: {
    base: 'group relative inline-flex cursor-pointer items-center justify-center rounded-full tap-highlight-transparent outline-none',
    dot: 'block rounded-full shadow-small transition-transform group-data-[hover=true]:scale-110 group-data-[focus-visible=true]:ring-2 group-data-[focus-visible=true]:ring-focus group-data-[focus-visible=true]:ring-offset-2 group-data-[focus-visible=true]:ring-offset-content1 group-data-[selected=true]:ring-2 group-data-[selected=true]:ring-primary group-data-[selected=true]:ring-offset-2 group-data-[selected=true]:ring-offset-content1',
  },
  variants: {
    size: {
      sm: { dot: 'h-5 w-5' },
      md: { dot: 'h-7 w-7' },
    },
    isDisabled: { true: { base: 'pointer-events-none opacity-disabled' } },
  },
  defaultVariants: { size: 'md' },
});

const HEX = /^#[0-9a-fA-F]{6}$/;

function Swatch({ paint, size, ...props }: RadioProps & { paint: string } & VariantProps<typeof swatch>) {
  // HeroUI puts data-selected, data-hover and data-focus-visible on the base; the styles above read them.
  const { Component, isDisabled, getBaseProps, getInputProps } = useRadio({ ...props });
  const slots = swatch({ size, isDisabled });
  return (
    <Component {...getBaseProps({ className: slots.base() })}>
      <VisuallyHidden>
        <input {...getInputProps()} />
      </VisuallyHidden>
      <span className={slots.dot()} style={{ backgroundColor: paint }} />
    </Component>
  );
}

export interface ColorSwatchesProps extends VariantProps<typeof swatch> {
  /** Names the group for screen readers ("Hair color"). */
  label: string;
  colors: readonly string[];
  /** The chosen color. One that isn't in `colors` (a hand-edited file) is shown first, so the choice is never invisible. */
  value: string;
  onValueChange: (color: string) => void;
  className?: string;
}

/**
 * A row of colors to pick from, built on HeroUI's `RadioGroup`: arrow keys move between them, one is chosen, and each is read
 * out as "<label> 3 of 13". The colors are `#rrggbb`; anything else is left out.
 */
export function ColorSwatches({ label, colors, value, onValueChange, size, className }: ColorSwatchesProps) {
  const list = (colors.includes(value) ? colors : [value, ...colors]).filter((c) => HEX.test(c));
  return (
    <RadioGroup aria-label={label} orientation="horizontal" value={value} onValueChange={onValueChange} className={className} classNames={{ wrapper: 'gap-2' }}>
      {list.map((color, i) => (
        <Swatch key={color} value={color} paint={color} size={size} aria-label={`${label} ${i + 1} of ${list.length}`} />
      ))}
    </RadioGroup>
  );
}
