import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Alert, Button, Chip, Spinner } from '@heroui/react';
import { stageLabel, STAGE_HINT, WORK_STAGES, type WorkStage } from '../flow.ts';
import { PRIORITY_META } from '../board/core.ts';
import type { Issue } from '../shared/board/types.ts';
import type { JobKind, PipelineStage } from '../shared/pipeline/types.ts';
import { stageIndex } from '../shared/pipeline/types.ts';
import { PAGE_ROOM, roomIdOfPage } from '../shared/workspace/layout.ts';
import { useOffice } from '../office/store.ts';
import { Hint } from '../ui';
import { Bot, ChevronLeft, Pencil, Sparkles } from '../ui/lucide';
import { ArtifactCard } from './ArtifactView.tsx';
import { ASKS, JOBS, KINDS, artifactsOf, currentArtifact, jobOn } from './core.ts';
import { GateChecklist } from './GateChecklist.tsx';
import { JobList } from './JobList.tsx';
import { RolloutView } from './RolloutView.tsx';
import { usePipeline } from './store.ts';

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-baseline gap-2">
        <h3 className="text-small font-semibold">{title}</h3>
        {hint ? <span className="truncate text-tiny text-foreground-400">{hint}</span> : null}
      </div>
      {children}
    </section>
  );
}

/** Where the ticket has been and where it is going: the six stages in a row, the current one lit. */
function RouteTrack({ stage }: { stage: PipelineStage }) {
  const at = stageIndex(stage);
  return (
    <ol className="flex flex-wrap gap-1" aria-label="Route through the pipeline">
      {WORK_STAGES.map((s) => (
        <li key={s}>
          <Chip size="sm" variant={s === stage ? 'solid' : 'flat'} color={s === stage ? 'primary' : stageIndex(s) < at ? 'success' : 'default'} aria-current={s === stage ? 'step' : undefined}>
            {stageLabel(s)}
          </Chip>
        </li>
      ))}
    </ol>
  );
}

/**
 * One ticket in one stage: ask the colleague for this stage's artifact, accept or reject what comes back, run the jobs, and move on
 * when the gate says so. Agents propose; every button that changes something or spends something is a person's.
 */
export function TicketWork({ issue, stage, onBack, onEdit, onMoved }: { issue: Issue; stage: WorkStage; onBack: () => void; onEdit: () => void; onMoved: (to: PipelineStage) => void }) {
  const { artifacts, jobs, rollouts, info, connected, busy, error } = usePipeline();
  const gate = usePipeline((s) => s.gates[issue.id]);
  const sessions = useOffice((s) => s.sessions);
  const role = useOffice((s) => s.role);
  const online = useOffice((s) => s.status.state === 'online');
  const owner = role === 'owner' || role === 'admin';
  const [asked, setAsked] = useState<{ ask: string; agent: string; count: number } | null>(null);

  const mine = useMemo(() => artifactsOf(artifacts, issue.id, KINDS[stage]), [artifacts, issue.id, stage]);
  // A draft that arrived since the person asked ends the wait; so does a minute and a half.
  useEffect(() => {
    if (!asked) return;
    if (mine.length > asked.count) setAsked(null);
    const timer = setTimeout(() => setAsked(null), 90_000);
    return () => clearTimeout(timer);
  }, [asked, mine.length]);

  // Waiting for a colleague: the server says when a draft arrives, but a missed message must not leave the list stale, so look now and then.
  useEffect(() => {
    if (!asked) return;
    const timer = setInterval(() => {
      void usePipeline.getState().load();
      const open = usePipeline.getState().selected;
      if (open) void usePipeline.getState().loadGate(open);
    }, 3000);
    return () => clearInterval(timer);
  }, [asked]);

  const piped = !!issue.pipeline;
  const set = artifacts.filter((a) => a.ticket === issue.id && a.kind === 'change_set' && a.state === 'accepted').at(-1);
  const latest = (kind: JobKind) => jobOn(jobs, issue.id, kind, set?.digest);
  const blocked = (kind: JobKind): string | null => {
    if (info?.killSwitch) return 'The pipeline is switched off for now.';
    if (!set) return 'Accept a change set first: there is nothing to run yet.';
    if (info && info.jobsLeftToday <= 0) return 'The demo’s jobs for today are used up. They come back tomorrow.';
    if (info && info.jobsLeftThisHour <= 0) return 'You have started enough jobs for this hour.';
    if (kind === 'release_build' && !(latest('unit')?.state === 'passed' && latest('e2e')?.state === 'passed')) return 'Pass the unit and end-to-end tests first.';
    if (kind === 'scan' && latest('release_build')?.state !== 'passed') return 'Build the release image first.';
    return null;
  };

  const room = roomIdOfPage(PAGE_ROOM[stage]);
  const session = sessions.find((s) => s.room === room && s.state === 'active' && !s.thread);
  const noDesign = stage === 'design' && !currentArtifact(artifacts, issue.id, 'design');
  const ticketRollouts = rollouts.filter((r) => r.ticket === issue.id);
  const staging = ticketRollouts.filter((r) => r.service === 'staging').at(-1);
  const production = ticketRollouts.filter((r) => r.service === 'production').at(-1);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex items-center gap-1">
          <Button size="sm" variant="light" className="-ms-2 h-7 min-h-7 px-2" startContent={<ChevronLeft size={14} />} onPress={onBack}>
            All tickets
          </Button>
          <span className="flex-1" />
          <Button size="sm" variant="flat" startContent={<Pencil size={13} />} onPress={onEdit}>
            Edit
          </Button>
        </div>
        <p className="text-medium font-semibold leading-6">
          <span className="me-1.5 font-mono text-small text-foreground-400">#{issue.key}</span>
          {issue.title}
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip size="sm" variant="flat" color={PRIORITY_META[issue.priority].color}>
            {PRIORITY_META[issue.priority].label}
          </Chip>
          {issue.points > 0 && (
            <Chip size="sm" variant="flat">
              {issue.points} points
            </Chip>
          )}
        </div>
        {issue.pipeline && <RouteTrack stage={issue.pipeline.stage} />}
      </div>

      {error && <Alert color="danger" variant="flat" hideIcon description={error} onClose={() => usePipeline.getState().clearError()} isClosable />}

      {connected === false && <Alert color="warning" variant="flat" hideIcon title="The delivery pipeline isn’t connected" description="This server runs without it, so there is nothing to draft, run or approve here." />}

      {connected !== false && !piped && (
        <Alert color="primary" variant="flat" hideIcon title="This ticket was made before the pipeline" description="It has no stages to walk through. Edit it, or make a new ticket to send through Plan, Design, Build, Test, Release and Deploy." />
      )}

      {connected !== false && piped && (
        <>
          <p className="text-tiny text-foreground-500">{STAGE_HINT[stage]}</p>

          <Section title="Ask a colleague" hint="Agents propose; you decide">
            <div className="flex flex-wrap items-center gap-2">
              {ASKS[stage].map((a) => (
                <Hint key={a.ask} label={online ? a.hint : 'The office is still opening.'}>
                  <Button
                    size="sm"
                    color="secondary"
                    variant="flat"
                    startContent={<Sparkles size={14} />}
                    isDisabled={!online || !!asked}
                    isLoading={busy.includes(`ask:${a.ask}`)}
                    onPress={() => {
                      void usePipeline
                        .getState()
                        .ask(issue.id, a.ask, room, session?.id)
                        .then(() => {
                          if (!usePipeline.getState().error) setAsked({ ask: a.ask, agent: a.agent, count: mine.length });
                        });
                    }}
                  >
                    {a.label}
                  </Button>
                </Hint>
              ))}
              {noDesign && (
                <Button size="sm" variant="flat" isLoading={busy.includes('noui')} onPress={() => void usePipeline.getState().acceptNoUi(issue.id)}>
                  No UI change
                </Button>
              )}
            </div>
            {asked && (
              <div className="flex items-center gap-2 text-tiny text-foreground-500">
                <Spinner size="sm" />
                <Bot size={12} /> {asked.agent} is drafting it. The answer appears in the chat, and the draft below.
              </div>
            )}
          </Section>

          <Section title="Drafts and decisions">
            {mine.length === 0 ? (
              <p className="rounded-medium bg-default-50 px-3 py-4 text-center text-tiny text-foreground-500">Nothing here yet. Ask a colleague above.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {mine.map((a) => (
                  <ArtifactCard key={a.id} artifact={a} canDecide />
                ))}
              </div>
            )}
          </Section>

          {JOBS[stage].length > 0 && (
            <Section title="Jobs" hint="Real work on Google Cloud; each run costs build minutes">
              <JobList ticket={issue.id} kinds={JOBS[stage]} latest={latest} blocked={blocked} />
            </Section>
          )}

          {stage === 'deploy' && (
            <Section title="Rollout" hint="Staging first, then production in steps">
              <div className="flex flex-col gap-2">
                {staging && <RolloutView rollout={staging} canAct={owner} nextPercent={undefined} />}
                {production && <RolloutView rollout={production} canAct={owner} nextPercent={production.plan[production.step + 1]} />}
                <div className="flex flex-wrap items-center gap-2">
                  {(!staging || staging.state === 'rolled_back') && (
                    <Hint label="Only an owner or an admin starts a rollout" isHidden={owner}>
                      <Button size="sm" color="primary" isDisabled={!owner} isLoading={busy.includes('rollout:staging')} onPress={() => void usePipeline.getState().startRollout(issue.id, 'staging')}>
                        Deploy to staging
                      </Button>
                    </Hint>
                  )}
                  {staging?.state === 'complete' && (!production || production.state === 'rolled_back') && (
                    <Hint label="Only an owner or an admin starts a rollout" isHidden={owner}>
                      <Button size="sm" color="primary" isDisabled={!owner} isLoading={busy.includes('rollout:production')} onPress={() => void usePipeline.getState().startRollout(issue.id, 'production')}>
                        Start the production rollout
                      </Button>
                    </Hint>
                  )}
                </div>
              </div>
            </Section>
          )}

          {gate ? (
            <GateChecklist
              stage={gate.stage}
              gate={gate.gate}
              busy={busy.includes('advance')}
              onAdvance={(to) => void usePipeline.getState().advance(issue.id, to).then(() => !usePipeline.getState().error && onMoved(to))}
              onBack={(to) => void usePipeline.getState().advance(issue.id, to).then(() => !usePipeline.getState().error && onMoved(to))}
            />
          ) : (
            <div className="flex items-center gap-2 text-tiny text-foreground-500">
              <Spinner size="sm" /> Checking what this stage needs…
            </div>
          )}
        </>
      )}
    </div>
  );
}
