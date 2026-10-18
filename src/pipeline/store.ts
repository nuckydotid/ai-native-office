import { create } from 'zustand';
import { teamOrigin } from '../team/connect.ts';
import { sentence } from '../team/rest.ts';
import { useBoard } from '../board/store.ts';
import type { Artifact, AuditEvent, Environment, Job, JobKind, PipelineStage, Rollout } from '../shared/pipeline/types.ts';
import { pipelineApi } from './api.ts';
import type { AskKind, GateAnswer, PipelineInfo } from './api.ts';
import { jobActive, rolloutActive } from './core.ts';

interface PipelineState {
  /** Whether the web service has the delivery pipeline on. `null` until the first answer. */
  connected: boolean | null;
  info: PipelineInfo | null;
  artifacts: Artifact[];
  jobs: Job[];
  rollouts: Rollout[];
  audit: AuditEvent[];
  /** What each ticket's gate says right now, by ticket id. */
  gates: Record<string, GateAnswer>;
  /** The ticket open in the stage panel (kept when a ticket moves on, so the next stage opens on it). */
  selected: string | null;
  loading: boolean;
  error: string | null;
  /** What is in flight, for button spinners: `job:unit`, `decide:<id>`, `advance`, `ask:spec`… */
  busy: string[];

  select(ticket: string | null): void;
  clearError(): void;
  /** Reads artifacts, jobs, rollouts and the pipeline's own state again. Cheap; a later answer replaces an earlier one. */
  load(): Promise<void>;
  loadGate(ticket: string): Promise<void>;
  loadAudit(): Promise<void>;
  decide(id: string, decision: 'accepted' | 'rejected'): Promise<void>;
  acceptNoUi(ticket: string): Promise<void>;
  advance(ticket: string, to: PipelineStage): Promise<void>;
  startJob(ticket: string, kind: JobKind): Promise<void>;
  cancelJob(id: string): Promise<void>;
  startRollout(ticket: string, service: Environment): Promise<void>;
  stepRollout(id: string): Promise<void>;
  rollback(id: string): Promise<void>;
  ask(ticket: string, ask: AskKind, room: string, session?: string, note?: string): Promise<void>;
  reset(): void;
}

let latest = 0;

export const usePipeline = create<PipelineState>((set, get) => {
  /** Runs one change, shows its refusal in plain words, and reads everything again (the server is the truth). */
  const act = async (key: string, run: (origin: string) => Promise<unknown>, after?: () => void) => {
    set((s) => ({ busy: [...s.busy, key], error: null }));
    try {
      await run(teamOrigin());
      after?.();
    } catch (e) {
      set({ error: sentence(e) });
    } finally {
      set((s) => ({ busy: s.busy.filter((k, i) => !(k === key && i === s.busy.indexOf(key))) }));
    }
    await get().load();
    const { selected } = get();
    if (selected) await get().loadGate(selected);
  };

  return {
    connected: null,
    info: null,
    artifacts: [],
    jobs: [],
    rollouts: [],
    audit: [],
    gates: {},
    selected: null,
    loading: false,
    error: null,
    busy: [],

    select: (ticket) => {
      set({ selected: ticket, error: null });
      if (ticket) void get().loadGate(ticket);
    },
    clearError: () => set({ error: null }),

    async load() {
      const mine = ++latest;
      const origin = teamOrigin();
      set({ loading: get().connected === null });
      try {
        const [info, artifacts, jobs, rollouts] = await Promise.all([pipelineApi.info(origin), pipelineApi.artifacts(origin), pipelineApi.jobs(origin), pipelineApi.rollouts(origin)]);
        if (mine === latest) set({ connected: true, info, artifacts, jobs, rollouts, loading: false });
      } catch (e) {
        // A server without the pipeline has no such doors; a server that is busy answers with a sentence, which the panel shows.
        if (mine === latest) set({ connected: get().connected === true ? true : false, loading: false, error: get().connected === true ? sentence(e) : null });
      }
    },

    async loadGate(ticket) {
      try {
        const answer = await pipelineApi.gate(teamOrigin(), ticket);
        set((s) => ({ gates: { ...s.gates, [ticket]: answer } }));
      } catch {
        // The ticket is not in the pipeline (a ticket made before it): there is no gate to show.
        set((s) => {
          const { [ticket]: _gone, ...rest } = s.gates;
          return { gates: rest };
        });
      }
    },

    async loadAudit() {
      try {
        set({ audit: await pipelineApi.audit(teamOrigin(), 200) });
      } catch (e) {
        set({ error: sentence(e) });
      }
    },

    decide: (id, decision) => act(`decide:${id}`, (o) => pipelineApi.decide(o, id, decision)),
    acceptNoUi: (ticket) => act('noui', (o) => pipelineApi.noUi(o, ticket)),
    advance: (ticket, to) =>
      act('advance', (o) => pipelineApi.advance(o, ticket, to), () => {
        // The ticket's stage (and status) changed: the board reads it again.
        const project = useBoard.getState().project;
        if (project) void useBoard.getState().load(project);
      }),
    startJob: (ticket, kind) => act(`job:${kind}`, (o) => pipelineApi.startJob(o, ticket, kind)),
    cancelJob: (id) => act(`cancel:${id}`, (o) => pipelineApi.cancelJob(o, id)),
    startRollout: (ticket, service) => act(`rollout:${service}`, (o) => pipelineApi.startRollout(o, ticket, service)),
    stepRollout: (id) => act(`step:${id}`, (o) => pipelineApi.stepRollout(o, id)),
    rollback: (id) => act(`rollback:${id}`, (o) => pipelineApi.rollback(o, id)),
    ask: (ticket, ask, room, session, note) => act(`ask:${ask}`, (o) => pipelineApi.ask(o, { ticket, ask, room, ...(session ? { session } : {}), ...(note ? { note } : {}) })),

    reset() {
      latest++;
      set({ connected: null, info: null, artifacts: [], jobs: [], rollouts: [], audit: [], gates: {}, selected: null, loading: false, error: null, busy: [] });
    },
  };
});

/** Whether anything is still moving: a job running or a rollout on its way. The panel polls while this is true. */
export const useWorking = (): boolean => usePipeline((s) => s.jobs.some(jobActive) || s.rollouts.some(rolloutActive));
