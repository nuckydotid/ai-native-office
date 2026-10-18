import { useMemo, useState } from 'react';
import { Button, Chip, tv } from '@heroui/react';
import { collapseDiff, diffLines, diffStat, type DiffLine } from './code-diff.ts';
import { ChevronDown, ChevronRight } from './lucide';

const row = tv({
  base: 'flex min-w-0 font-mono text-tiny leading-5',
  variants: {
    kind: {
      same: 'text-foreground-600',
      add: 'bg-success/10 text-foreground',
      remove: 'bg-danger/10 text-foreground',
      gap: 'bg-default-100 text-foreground-400',
    },
  },
});

export type CodeDiffProps = {
  /** The file's path, shown in the header. */
  path: string;
  /** What the trunk has now (`null` for a new file) and what the change set writes (`''` for a delete). */
  before: string | null;
  after: string;
  /** Starts open. A change set shows its first file open and the rest closed. */
  defaultOpen?: boolean;
  /** Lines of context around each change. */
  context?: number;
  className?: string;
};

/**
 * One changed file as a line diff: a header with the path and what changed, and the changed lines with a few around them. HeroUI has
 * no diff view, so this is built on its `Button` and `Chip`. The text is drawn as text, never as markup.
 */
export function CodeDiff({ path, before, after, defaultOpen = false, context = 3, className }: CodeDiffProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [all, setAll] = useState(false);
  const lines = useMemo(() => diffLines(before, after), [before, after]);
  const stat = useMemo(() => diffStat(lines), [lines]);
  const shown = useMemo(() => (all ? lines : collapseDiff(lines, context)), [all, lines, context]);
  const fresh = before === null;
  const removed = after === '';
  return (
    <div className={`flex min-w-0 flex-col overflow-hidden rounded-medium bg-default-50 ${className ?? ''}`}>
      <Button
        variant="light"
        radius="none"
        className="h-8 min-h-8 justify-start gap-2 px-2"
        onPress={() => setOpen((v) => !v)}
        aria-expanded={open}
        startContent={open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      >
        <span className="min-w-0 flex-1 truncate text-start font-mono text-tiny">{path}</span>
        {fresh && (
          <Chip size="sm" variant="flat" color="success" classNames={{ base: 'h-4', content: 'px-1 text-tiny' }}>
            new
          </Chip>
        )}
        {removed && (
          <Chip size="sm" variant="flat" color="danger" classNames={{ base: 'h-4', content: 'px-1 text-tiny' }}>
            deleted
          </Chip>
        )}
        <span className="shrink-0 font-mono text-tiny text-success">+{stat.added}</span>
        <span className="shrink-0 font-mono text-tiny text-danger">−{stat.removed}</span>
      </Button>
      {open && (
        <div className="max-h-96 overflow-auto pb-1" role="group" aria-label={`Changes to ${path}`}>
          {shown.length === 0 && <p className="px-3 py-2 text-tiny text-foreground-500">No lines changed.</p>}
          {shown.map((l, i) =>
            l.kind === 'gap' ? (
              <div key={`gap-${i}`} className={row({ kind: 'gap' })}>
                <span className="w-16 shrink-0" />
                <Button size="sm" variant="light" className="h-5 min-h-5 px-1 text-tiny" onPress={() => setAll(true)}>
                  Show {l.hidden} unchanged {l.hidden === 1 ? 'line' : 'lines'}
                </Button>
              </div>
            ) : (
              <Line key={`${i}-${l.before ?? ''}-${l.after ?? ''}`} line={l} />
            ),
          )}
        </div>
      )}
    </div>
  );
}

function Line({ line }: { line: DiffLine }) {
  const mark = line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' ';
  return (
    <div className={row({ kind: line.kind })}>
      <span className="w-8 shrink-0 select-none pe-1 text-end text-foreground-300">{line.before ?? ''}</span>
      <span className="w-8 shrink-0 select-none pe-1 text-end text-foreground-300">{line.after ?? ''}</span>
      <span className="w-4 shrink-0 select-none text-center text-foreground-400">{mark}</span>
      <span className="min-w-0 whitespace-pre-wrap break-all pe-2">{line.text || ' '}</span>
    </div>
  );
}
