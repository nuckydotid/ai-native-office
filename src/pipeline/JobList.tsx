import { useState } from 'react';
import { Button, Chip } from '@heroui/react';
import type { Job, JobKind } from '../shared/pipeline/types.ts';
import { Hint } from '../ui';
import { Play, RefreshCw, ScrollText } from '../ui/lucide';
import { JOB_LABEL, JOB_STATE_LABEL, JOB_TONE, durationText, jobActive } from './core.ts';
import { JobDrawer } from './JobDrawer.tsx';
import { usePipeline } from './store.ts';

/** What a finished job found, in a few words: tests passed and failed, coverage, the worst finding of a scan. */
function summaryText(job: Job): string {
  const s = job.summary;
  if (!s) return '';
  const parts: string[] = [];
  if (typeof s.passed === 'number') parts.push(`${s.passed} passed`);
  if (s.failed) parts.push(`${s.failed} failed`);
  if (typeof s.coveragePct === 'number') parts.push(`${s.coveragePct}% covered`);
  if (s.scanSeverity) parts.push(`worst finding: ${s.scanSeverity.toLowerCase()}`);
  return parts.join(' · ');
}

/**
 * The jobs a stage starts, one row each: the newest run on the accepted change set, its result, a button to run it (again) and a
 * button for its log. A job costs real build minutes, so it starts only when a person presses its button.
 */
export function JobList({ ticket, kinds, latest, blocked }: { ticket: string; kinds: JobKind[]; latest: (kind: JobKind) => Job | undefined; blocked: (kind: JobKind) => string | null }) {
  const [log, setLog] = useState<Job | null>(null);
  const busy = usePipeline((s) => s.busy);
  return (
    <div className="flex flex-col gap-1.5">
      {kinds.map((kind) => {
        const job = latest(kind);
        const running = !!job && jobActive(job);
        const starting = busy.includes(`job:${kind}`);
        const detail = job ? summaryText(job) : '';
        const why = blocked(kind);
        const ready = why === null;
        return (
          <div key={kind} className="flex min-w-0 items-center gap-2 rounded-medium bg-default-50 px-3 py-2">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex items-center gap-1.5 text-small font-medium">
                {JOB_LABEL[kind]}
                {job ? (
                  <Chip size="sm" variant="flat" color={JOB_TONE[job.state]} classNames={{ base: 'h-5', content: 'px-1 text-tiny' }}>
                    {JOB_STATE_LABEL[job.state]}
                  </Chip>
                ) : (
                  <Chip size="sm" variant="flat" classNames={{ base: 'h-5', content: 'px-1 text-tiny' }}>
                    Not run
                  </Chip>
                )}
              </span>
              <span className="truncate text-tiny text-foreground-500">{detail || (running ? 'Working on it…' : job?.summary?.durationMs ? durationText(job.summary.durationMs) : job ? 'Finished.' : ready ? 'Starts when you press Run.' : why)}</span>
            </div>
            {job && (
              <Hint label="Read the log">
                <Button isIconOnly size="sm" variant="light" aria-label={`${JOB_LABEL[kind]} log`} onPress={() => setLog(job)}>
                  <ScrollText size={15} />
                </Button>
              </Hint>
            )}
            <Hint label={why ?? ''} isHidden={ready}>
              <Button
                size="sm"
                variant="flat"
                color="primary"
                isDisabled={!ready || running}
                isLoading={starting || running}
                startContent={!starting && !running ? job ? <RefreshCw size={14} /> : <Play size={14} /> : undefined}
                onPress={() => void usePipeline.getState().startJob(ticket, kind)}
              >
                {running ? 'Running' : job ? 'Run again' : 'Run'}
              </Button>
            </Hint>
          </div>
        );
      })}
      {log && <JobDrawer job={log} onClose={() => setLog(null)} />}
    </div>
  );
}
