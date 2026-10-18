import { useEffect, useRef, useState } from 'react';
import { Button, Chip, Drawer, DrawerBody, DrawerContent, DrawerHeader, Spinner } from '@heroui/react';
import type { Job } from '../shared/pipeline/types.ts';
import { teamOrigin } from '../team/connect.ts';
import { sentence } from '../team/rest.ts';
import { pipelineApi } from './api.ts';
import { JOB_LABEL, JOB_STATE_LABEL, JOB_TONE, durationText, jobActive } from './core.ts';
import { usePipeline } from './store.ts';

/** A job's log, read in pieces while it runs. The text is a build's own output: drawn as text, never as markup. */
export function JobDrawer({ job, onClose }: { job: Job; onClose: () => void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const next = useRef(0);
  const end = useRef<HTMLDivElement>(null);
  const live = usePipeline((s) => s.jobs.find((j) => j.id === job.id)) ?? job;

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    next.current = 0;
    setText('');
    setDone(false);
    const poll = async () => {
      try {
        const chunk = await pipelineApi.jobLog(teamOrigin(), job.id, next.current);
        if (!alive) return;
        if (chunk.text) setText((t) => t + chunk.text);
        next.current = chunk.next;
        setError(null);
        if (chunk.done) {
          setDone(true);
          return;
        }
      } catch (e) {
        if (!alive) return;
        setError(sentence(e));
      }
      timer = setTimeout(() => void poll(), 1500);
    };
    void poll();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [job.id]);

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [text]);

  const running = jobActive(live);
  return (
    <Drawer isOpen onOpenChange={(open) => !open && onClose()} placement="right" size="lg">
      <DrawerContent>
        <DrawerHeader className="flex flex-wrap items-center gap-2 pe-10 text-medium font-semibold">
          <span>{JOB_LABEL[job.kind]}</span>
          <Chip size="sm" variant="flat" color={JOB_TONE[live.state]}>
            {JOB_STATE_LABEL[live.state]}
          </Chip>
          {live.summary?.durationMs ? <span className="text-small font-normal text-foreground-500">{durationText(live.summary.durationMs)}</span> : null}
        </DrawerHeader>
        <DrawerBody className="gap-3 pb-6">
          {live.summary?.text ? <p className="text-small text-foreground-600">{live.summary.text}</p> : null}
          {live.links.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {live.links.map((l) => (
                <Chip key={l.url} size="sm" variant="flat">
                  {l.label}
                </Chip>
              ))}
            </div>
          )}
          <pre className="min-h-40 flex-1 overflow-auto whitespace-pre-wrap break-all rounded-medium bg-default-100 p-3 font-mono text-tiny leading-5" aria-label="Job log" aria-live="polite">
            {text || (done ? 'This job wrote no log.' : '')}
          </pre>
          <div ref={end} />
          {error && <p className="text-tiny text-danger">{error}</p>}
          <div className="flex items-center gap-2 text-tiny text-foreground-500">
            {running && !done ? (
              <>
                <Spinner size="sm" /> Following the log…
              </>
            ) : (
              <span>That is the whole log.</span>
            )}
            <span className="flex-1" />
            {running && (
              <Button size="sm" variant="flat" color="danger" onPress={() => void usePipeline.getState().cancelJob(job.id)}>
                Cancel job
              </Button>
            )}
          </div>
        </DrawerBody>
      </DrawerContent>
    </Drawer>
  );
}
