import { Tooltip, tv } from '@heroui/react';
import { useRef } from 'react';

const handle = tv({
  slots: {
    base: 'group relative z-20 shrink-0 touch-none',
    line: 'absolute rounded-full bg-transparent transition-colors group-hover:bg-primary group-active:bg-primary',
  },
  variants: {
    orientation: {
      vertical: { base: 'w-[5px] cursor-col-resize', line: 'inset-y-0 left-1/2 w-px -translate-x-1/2' },
      horizontal: { base: 'h-[5px] cursor-row-resize', line: 'inset-x-0 top-1/2 h-px -translate-y-1/2' },
    },
  },
  defaultVariants: { orientation: 'vertical' },
});

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export type ResizerProps = {
  /** Current size (width for a vertical handle, height for a horizontal one) of the panel it resizes. */
  size: number;
  min: number;
  max: number;
  /**
   * Where the panel sits relative to the handle: "before" means the panel is to the left of (or above) the handle, so
   * dragging away from the panel makes it bigger; "after" is the opposite.
   */
  panel: 'before' | 'after';
  orientation?: 'vertical' | 'horizontal';
  onChange: (size: number) => void;
  /** Double-click: back to the default size. */
  onReset: () => void;
  /** Names the panel for screen readers, e.g. "Branches". */
  label: string;
};

/**
 * A draggable divider between two sections (HeroUI has none). Drag to resize, double-click to reset, arrow keys to nudge.
 * Sizes are in pixels; the owner clamps them again if the window is smaller than they allow.
 */
export function Resizer({ size, min, max, panel, orientation = 'vertical', onChange, onReset, label }: ResizerProps) {
  const start = useRef<{ at: number; size: number } | null>(null);
  const { base, line } = handle({ orientation });
  const vertical = orientation === 'vertical';
  const sign = panel === 'before' ? 1 : -1;
  const hint = `Drag to resize · double-click to reset`;
  return (
    <Tooltip content={hint} placement={vertical ? 'right' : 'top'} delay={900} closeDelay={0}>
      <div
        role="separator"
        aria-label={`Resize ${label}`}
        aria-orientation={vertical ? 'vertical' : 'horizontal'}
        aria-valuenow={Math.round(size)}
        aria-valuemin={min}
        aria-valuemax={max}
        tabIndex={0}
        className={base()}
        onPointerDown={(e) => {
          e.preventDefault();
          start.current = { at: vertical ? e.clientX : e.clientY, size };
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            // Without capture the drag still works while the pointer stays over the handle.
          }
        }}
        onPointerMove={(e) => {
          if (!start.current) return;
          const delta = (vertical ? e.clientX : e.clientY) - start.current.at;
          onChange(clamp(start.current.size + sign * delta, min, max));
        }}
        onPointerUp={(e) => {
          start.current = null;
          try {
            e.currentTarget.releasePointerCapture(e.pointerId);
          } catch {
            // Nothing was captured.
          }
        }}
        onPointerCancel={() => {
          start.current = null;
        }}
        onDoubleClick={onReset}
        onKeyDown={(e) => {
          const grow = vertical ? 'ArrowRight' : 'ArrowDown';
          const shrink = vertical ? 'ArrowLeft' : 'ArrowUp';
          if (e.key !== grow && e.key !== shrink) return;
          e.preventDefault();
          const step = e.shiftKey ? 48 : 12;
          onChange(clamp(size + sign * (e.key === grow ? step : -step), min, max));
        }}
      >
        <div className={line()} />
      </div>
    </Tooltip>
  );
}
