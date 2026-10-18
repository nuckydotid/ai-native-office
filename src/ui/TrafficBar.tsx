import { tv } from '@heroui/react';

export interface TrafficSegment {
  id: string;
  /** The revision or the group: `northwind-portal-00012`. */
  label: string;
  /** 0 to 100. */
  percent: number;
  color?: 'default' | 'primary' | 'success' | 'warning' | 'danger';
}

const part = tv({
  base: 'h-full transition-all',
  variants: {
    color: { default: 'bg-default-300', primary: 'bg-primary', success: 'bg-success', warning: 'bg-warning', danger: 'bg-danger' },
  },
  defaultVariants: { color: 'default' },
});

const swatch = tv({
  base: 'h-2 w-2 shrink-0 rounded-full',
  variants: { color: { default: 'bg-default-300', primary: 'bg-primary', success: 'bg-success', warning: 'bg-warning', danger: 'bg-danger' } },
  defaultVariants: { color: 'default' },
});

export type TrafficBarProps = {
  segments: TrafficSegment[];
  /** Names the bar for screen readers. */
  label: string;
  className?: string;
};

/**
 * How traffic is split between revisions: one bar in parts, with the legend under it. HeroUI's `Progress` shows a single value, so
 * this is the same bar with several. The split is also said in words, since color alone says nothing to a screen reader.
 */
export function TrafficBar({ segments, label, className }: TrafficBarProps) {
  const shown = segments.filter((s) => s.percent > 0);
  const words = shown.map((s) => `${s.percent}% ${s.label}`).join(', ');
  return (
    <div className={`flex min-w-0 flex-col gap-1.5 ${className ?? ''}`}>
      <div role="img" aria-label={`${label}: ${words || 'no traffic'}`} className="flex h-2 w-full overflow-hidden rounded-full bg-default-100">
        {shown.map((s) => (
          <div key={s.id} className={part({ color: s.color })} style={{ width: `${Math.min(100, s.percent)}%` }} />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-3 gap-y-0.5">
        {segments.map((s) => (
          <li key={s.id} className="flex min-w-0 items-center gap-1.5 text-tiny text-foreground-500">
            <span className={swatch({ color: s.color })} aria-hidden />
            <span className="truncate font-mono">{s.label}</span>
            <span className="font-medium text-foreground">{s.percent}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
