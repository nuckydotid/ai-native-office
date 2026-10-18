import type { ReactNode } from 'react';
import { tv } from '@heroui/react';
import { Circle, CircleCheck, CircleX, LoaderCircle } from './lucide';

export type TimelineStatus = 'done' | 'active' | 'todo' | 'failed';

export interface TimelineItem {
  id: string;
  label: ReactNode;
  /** One quiet line under the label: why it is not done, what it measured. */
  detail?: ReactNode;
  status: TimelineStatus;
  /** Something at the end of the line: a time, a chip, a button. */
  end?: ReactNode;
}

const mark = tv({
  base: 'mt-0.5 shrink-0',
  variants: {
    status: { done: 'text-success', active: 'animate-spin text-primary', todo: 'text-foreground-300', failed: 'text-danger' },
  },
});

const label = tv({
  base: 'text-small',
  variants: { status: { done: 'text-foreground', active: 'font-medium text-foreground', todo: 'text-foreground-500', failed: 'font-medium text-danger' } },
});

export type StatusTimelineProps = {
  items: TimelineItem[];
  /** Names the list for screen readers. */
  'aria-label': string;
  className?: string;
};

const ICON = { done: CircleCheck, active: LoaderCircle, todo: Circle, failed: CircleX } as const;
const WORD = { done: 'Done', active: 'In progress', todo: 'Not yet', failed: 'Failed' } as const;

/**
 * Steps in order, each with a state: done, in progress, not yet, or failed. HeroUI has no timeline, so this is a list of icons and
 * words; the state is also said in text for screen readers, never by color alone. The gate checklist, a rollout's steps and a
 * ticket's route all use it.
 */
export function StatusTimeline({ items, className, ...rest }: StatusTimelineProps) {
  return (
    <ol aria-label={rest['aria-label']} className={`flex flex-col gap-2 ${className ?? ''}`}>
      {items.map((item) => {
        const Icon = ICON[item.status];
        return (
          <li key={item.id} className="flex min-w-0 items-start gap-2">
            <Icon size={16} className={mark({ status: item.status })} aria-hidden />
            <span className="sr-only">{WORD[item.status]}:</span>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className={label({ status: item.status })}>{item.label}</span>
              {item.detail ? <span className="text-tiny text-foreground-500">{item.detail}</span> : null}
            </div>
            {item.end ? <div className="shrink-0">{item.end}</div> : null}
          </li>
        );
      })}
    </ol>
  );
}
