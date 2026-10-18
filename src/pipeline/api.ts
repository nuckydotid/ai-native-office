import type { Issue } from '../shared/board/types.ts';
import type { Gate } from '../shared/pipeline/gates.ts';
import type { Artifact, AuditEvent, Environment, Job, JobKind, PipelinePolicy, PipelineStage, Rollout } from '../shared/pipeline/types.ts';
import { teamRequest } from '../team/rest.ts';

/** What the pipeline will do right now and what is left of its budgets (the pipeline service owns the numbers). */
export interface PipelineInfo {
  driver: 'fake' | 'http';
  policy: PipelinePolicy;
  enabled: boolean;
  killSwitch: boolean;
  jobsLeftToday: number;
  jobsLeftThisHour: number;
  concurrent: number;
  maxConcurrent: number;
  rolloutsLeftToday: number;
  scansLeftToday: number;
}

export interface JobLogChunk {
  text: string;
  /** Where to continue from. */
  next: number;
  done: boolean;
}

export interface GateAnswer {
  stage: PipelineStage;
  gate: Gate;
}

/** The ids of the "Ask the …" buttons: each one is a different artifact for the ticket in front of the person. */
export type AskKind = 'spec' | 'design' | 'change_set' | 'tests' | 'release_pack' | 'rollout_report';

/** What the stage pages ask of the web service's delivery-pipeline doors: each call is one REST request. */
export const pipelineApi = {
  info: (origin: string) => teamRequest<PipelineInfo>(origin, '/pipeline/status'),
  setPolicy: (origin: string, policy: PipelinePolicy) => teamRequest<{ policy: PipelinePolicy }>(origin, '/pipeline/policy', { method: 'PUT', body: policy }),
  artifacts: async (origin: string) => (await teamRequest<{ artifacts: Artifact[] }>(origin, '/artifacts')).artifacts,
  decide: async (origin: string, id: string, decision: 'accepted' | 'rejected') =>
    (await teamRequest<{ artifact: Artifact }>(origin, `/artifacts/${encodeURIComponent(id)}/decide`, { method: 'POST', body: { decision } })).artifact,
  noUi: async (origin: string, ticket: string) => (await teamRequest<{ artifact: Artifact }>(origin, `/tickets/${encodeURIComponent(ticket)}/design/no-ui`, { method: 'POST', body: {} })).artifact,
  gate: (origin: string, ticket: string) => teamRequest<GateAnswer>(origin, `/tickets/${encodeURIComponent(ticket)}/gate`),
  advance: (origin: string, ticket: string, to: PipelineStage) =>
    teamRequest<GateAnswer & { issue: Issue }>(origin, `/tickets/${encodeURIComponent(ticket)}/advance`, { method: 'POST', body: { to } }),
  jobs: async (origin: string) => (await teamRequest<{ jobs: Job[] }>(origin, '/pipeline/jobs')).jobs,
  startJob: async (origin: string, ticket: string, kind: JobKind) => (await teamRequest<{ job: Job }>(origin, '/pipeline/jobs', { method: 'POST', body: { ticket, kind } })).job,
  cancelJob: async (origin: string, id: string) => (await teamRequest<{ job: Job }>(origin, `/pipeline/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: {} })).job,
  jobLog: (origin: string, id: string, from: number) => teamRequest<JobLogChunk>(origin, `/pipeline/jobs/${encodeURIComponent(id)}/log?from=${from}`),
  rollouts: async (origin: string) => (await teamRequest<{ rollouts: Rollout[] }>(origin, '/pipeline/rollouts')).rollouts,
  startRollout: async (origin: string, ticket: string, service: Environment) =>
    (await teamRequest<{ rollout: Rollout }>(origin, '/pipeline/rollouts', { method: 'POST', body: { ticket, service } })).rollout,
  stepRollout: async (origin: string, id: string) => (await teamRequest<{ rollout: Rollout }>(origin, `/pipeline/rollouts/${encodeURIComponent(id)}/step`, { method: 'POST', body: {} })).rollout,
  rollback: async (origin: string, id: string) => (await teamRequest<{ rollout: Rollout }>(origin, `/pipeline/rollouts/${encodeURIComponent(id)}/rollback`, { method: 'POST', body: {} })).rollout,
  audit: async (origin: string, limit = 100) => (await teamRequest<{ events: AuditEvent[] }>(origin, `/pipeline/audit?limit=${limit}`)).events,
  /** Asks an agent to draft one artifact; its answer lands in the room's conversation and, once saved, in the artifact list. */
  ask: (origin: string, body: { ticket: string; ask: AskKind; room: string; session?: string; note?: string }) =>
    teamRequest<{ ok: true; runId: string }>(origin, '/ai/artifact', { method: 'POST', body }),
};

/** One file of the sample app's trunk, to show what a change set replaces. */
export const repoFile = async (origin: string, path: string): Promise<string | null> => {
  try {
    return (await teamRequest<{ path: string; content: string }>(origin, `/pipeline/repo/file?path=${encodeURIComponent(path)}`)).content;
  } catch {
    return null;
  }
};
