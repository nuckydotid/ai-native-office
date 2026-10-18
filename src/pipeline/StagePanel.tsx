import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, CardBody, Chip, Spinner } from '@heroui/react';
import { IssueDialog } from '../board/IssueDialog.tsx';
import { PRIORITY_META, assigneeName } from '../board/core.ts';
import { useBoard } from '../board/store.ts';
import { nextAction, STAGE_HINT, stageLabel, ticketStage, type PageId, type StageId, type WorkStage } from '../flow.ts';
import { useFlowData } from '../flowData.ts';
import type { Project } from '../project.ts';
import type { PipelineStage } from '../shared/pipeline/types.ts';
import { useSync } from '../sync/store.ts';
import { IconButton, Plus, RefreshCw, ZapIcon } from '../ui';
import { jobActive, rolloutActive } from './core.ts';
import { TicketWork } from './TicketWork.tsx';
import { usePipeline } from './store.ts';

/**
 * The left panel of every stage page (the office and its chat stay on the right): the tickets that are in this stage, and for the one
 * you open, everything its stage needs. The same panel serves all six stages; only the stage's artifacts, jobs and gate differ.
 */
export function StagePanel({ project, stage, onGo, onMoved }: { project: Project; stage: WorkStage; onGo: (stage: StageId, page: PageId, ticket?: string) => void; onMoved: (to: PipelineStage, ticket: string) => void }) {
  const { snapshot, loading, error } = useBoard();
  const selected = usePipeline((s) => s.selected);
  const pipelineError = usePipeline((s) => s.error);
  const connected = usePipeline((s) => s.connected);
  const working = usePipeline((s) => s.jobs.some(jobActive) || s.rollouts.some(rolloutActive));
  const [editing, setEditing] = useState<{ id: string | null } | null>(null);
  const flow = useFlowData();
  const next = useMemo(() => nextAction(flow), [flow]);

  useEffect(() => {
    void useBoard.getState().load(project.path);
  }, [project.path]);
  useEffect(() => {
    void usePipeline.getState().load();
    return () => usePipeline.getState().reset();
  }, [project.path]);

  // Someone changed the board or the pipeline (the server tells everyone in the office): read it again.
  const board = useSync((s) => s.board);
  const pipeline = useSync((s) => s.pipeline);
  useEffect(() => {
    if (board > 0) void useBoard.getState().load(project.path);
  }, [board, project.path]);
  useEffect(() => {
    if (pipeline === 0) return;
    void usePipeline.getState().load();
    const open = usePipeline.getState().selected;
    if (open) void usePipeline.getState().loadGate(open);
  }, [pipeline]);

  // A job is running or traffic is moving: look again every couple of seconds, and stop when it settles.
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => {
      void usePipeline.getState().load();
      const open = usePipeline.getState().selected;
      if (open) void usePipeline.getState().loadGate(open);
    }, 2500);
    return () => clearInterval(timer);
  }, [working]);

  const issues = snapshot?.issues ?? [];
  const here = issues.filter((i) => ticketStage({ status: i.status, stage: i.pipeline?.stage }) === stage);
  const open = selected ? issues.find((i) => i.id === selected) : undefined;
  // The open ticket is shown in the stage it is in. If it is somewhere else, the list is what this stage shows.
  const detail = open && ticketStage({ status: open.status, stage: open.pipeline?.stage }) === stage ? open : undefined;
  const editingIssue = editing?.id ? issues.find((i) => i.id === editing.id) : undefined;

  return (
    <aside className="flex w-full min-h-0 shrink-0 flex-col bg-content1 shadow-small sm:w-[26rem]" aria-label={stageLabel(stage)}>
      <div className="flex items-center gap-2 px-3 pb-2 pt-3">
        <h2 className="text-medium font-semibold">{stageLabel(stage)}</h2>
        <Chip size="sm" variant="flat">
          {here.length}
        </Chip>
        <span className="flex-1" />
        <IconButton
          label="Read the board again"
          isLoading={loading && snapshot !== null}
          onPress={() => {
            void useBoard.getState().load(project.path);
            void usePipeline.getState().load();
          }}
        >
          <RefreshCw size={15} />
        </IconButton>
        {stage === 'plan' && (
          <Button size="sm" color="primary" startContent={<Plus size={15} />} onPress={() => setEditing({ id: null })}>
            New ticket
          </Button>
        )}
      </div>

      {(error || (!detail && pipelineError)) && (
        <div className="px-3 pb-2">
          <Alert color="danger" variant="flat" hideIcon description={error ?? pipelineError} />
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        {loading && snapshot === null ? (
          <div className="flex items-center justify-center gap-2 py-10 text-small text-foreground-500">
            <Spinner size="sm" /> Reading the board…
          </div>
        ) : detail ? (
          <TicketWork
            issue={detail}
            stage={stage}
            onBack={() => usePipeline.getState().select(null)}
            onEdit={() => setEditing({ id: detail.id })}
            onMoved={(to) => onMoved(to, detail.id)}
          />
        ) : (
          <div className="flex flex-col gap-3">
            {!selected && (
              <Card shadow="sm">
                <CardBody className="flex-row items-center gap-3 p-3">
                  <ZapIcon size={16} className="shrink-0 text-primary" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-small font-medium">{next.title}</p>
                    <p className="text-tiny text-foreground-500">{next.detail}</p>
                  </div>
                  <Button size="sm" variant="flat" onPress={() => onGo(next.target.stage, next.target.page, next.target.ticket)}>
                    Go
                  </Button>
                </CardBody>
              </Card>
            )}
            {here.length === 0 ? (
              <p className="rounded-medium bg-default-50 px-3 py-6 text-center text-tiny text-foreground-500">
                {issues.length === 0 ? 'No tickets yet. Write the first one down in Plan.' : `Nothing is in ${stageLabel(stage)} right now. ${STAGE_HINT[stage]}`}
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {here.map((issue) => (
                  <Card key={issue.id} isPressable shadow="none" className="bg-default-50" onPress={() => usePipeline.getState().select(issue.id)}>
                    <div className="flex flex-col gap-2 p-3">
                      <p className="text-small font-medium leading-5">
                        {issue.key > 0 && <span className="me-1.5 font-mono text-tiny text-foreground-400">#{issue.key}</span>}
                        {issue.title}
                      </p>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Chip size="sm" variant="flat" color={PRIORITY_META[issue.priority].color}>
                          {PRIORITY_META[issue.priority].label}
                        </Chip>
                        {issue.points > 0 && (
                          <Chip size="sm" variant="flat">
                            {issue.points}
                          </Chip>
                        )}
                        {!issue.pipeline && (
                          <Chip size="sm" variant="flat" color="warning">
                            Not in the pipeline
                          </Chip>
                        )}
                      </div>
                      <span className="truncate text-tiny text-foreground-400">{assigneeName(snapshot?.people ?? [], issue.assignee) ?? 'Nobody'}</span>
                    </div>
                  </Card>
                ))}
              </div>
            )}
            {connected === false && issues.length > 0 && <p className="text-tiny text-foreground-400">The delivery pipeline isn’t connected on this server, so tickets can’t move between stages.</p>}
          </div>
        )}
      </div>

      {editing && <IssueDialog issue={editingIssue ?? null} initialStatus="todo" onClose={() => setEditing(null)} />}
    </aside>
  );
}
