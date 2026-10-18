import { useEffect } from 'react';
import { Card, CardBody, Progress, Skeleton } from '@heroui/react';
import { usePipeline } from '../pipeline/store.ts';
import { useSync } from '../sync/store.ts';
import { activityLine, meters, newestFirst } from './activity.ts';

const when = (at: number) => new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Who did what in the pipeline, newest first, and how much of today’s budget is left. Everything a release is explained with. */
export function ActivityView({ visible }: { visible: boolean }) {
  const audit = usePipeline((s) => s.audit);
  const info = usePipeline((s) => s.info);
  const connected = usePipeline((s) => s.connected);
  const changes = useSync((s) => s.pipeline);

  useEffect(() => {
    if (!visible) return;
    void usePipeline.getState().load();
    void usePipeline.getState().loadAudit();
  }, [visible, changes]);

  return (
    <div className={`min-h-0 flex-1 overflow-y-auto p-4 ${visible ? '' : 'hidden'}`}>
      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        <div>
          <h2 className="text-large font-semibold">Activity</h2>
          <p className="text-small text-foreground-500">Every approval, job and rollout, and what is left of the demo’s budget today.</p>
        </div>

        {connected === false ? (
          <p className="rounded-medium bg-default-50 px-3 py-6 text-center text-small text-foreground-500">The delivery pipeline isn’t connected on this server, so there is no activity to show.</p>
        ) : (
          <>
            <section className="flex flex-col gap-2" aria-label="Budgets">
              <h3 className="text-medium font-semibold">Budgets</h3>
              {info === null ? (
                <Skeleton className="h-24 rounded-large" />
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  {meters(info).map((m) => (
                    <Card key={m.id} shadow="md">
                      <CardBody className="gap-2 p-4">
                        <div className="flex items-baseline justify-between gap-2">
                          <p className="text-small font-medium">{m.label}</p>
                          <p className="text-tiny text-foreground-500">{m.text}</p>
                        </div>
                        <Progress aria-label={m.label} size="sm" value={m.percent} color={m.low ? 'danger' : 'primary'} />
                      </CardBody>
                    </Card>
                  ))}
                  {info.killSwitch && <p className="text-small text-danger sm:col-span-2">The pipeline is switched off. Nothing new can start.</p>}
                </div>
              )}
            </section>

            <section className="flex flex-col gap-2" aria-label="Audit trail">
              <h3 className="text-medium font-semibold">Audit trail</h3>
              {audit.length === 0 ? (
                <p className="rounded-medium bg-default-50 px-3 py-6 text-center text-small text-foreground-500">Nothing has happened yet. Approvals, job starts and rollouts appear here.</p>
              ) : (
                <Card shadow="md">
                  <CardBody className="gap-0 p-2">
                    <ol className="flex flex-col">
                      {newestFirst(audit).map((e) => (
                        <li key={e.id} className="flex min-w-0 items-baseline gap-3 rounded-small px-2 py-1.5 hover:bg-default-50">
                          <span className="w-28 shrink-0 text-tiny text-foreground-400">{when(e.at)}</span>
                          <span className="min-w-0 flex-1 text-small">{activityLine(e)}</span>
                          <span className="shrink-0 font-mono text-tiny text-foreground-400">{e.action}</span>
                        </li>
                      ))}
                    </ol>
                  </CardBody>
                </Card>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
