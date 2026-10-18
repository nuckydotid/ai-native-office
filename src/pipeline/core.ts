// What the stage pages decide, pure and unit-tested: which buttons a stage offers, which artifact counts, how a job reads, and the
// line diff a change set is shown as. The rules for leaving a stage are the shared gates (`src/shared/pipeline/gates.ts`).

import type { WorkStage } from '../flow.ts';
import type { Artifact, ArtifactKind, Job, JobKind, JobState, Rollout } from '../shared/pipeline/types.ts';
import type { AskKind } from './api.ts';

/** A button that asks an agent for one artifact. */
export interface AskButton {
  ask: AskKind;
  /** The colleague who answers, as the sidebar names them. */
  agent: string;
  label: string;
  /** What it will hand back, in a few words (the tooltip). */
  hint: string;
}

export const ASKS: Record<WorkStage, AskButton[]> = {
  plan: [{ ask: 'spec', agent: 'Planner Agent', label: 'Draft the spec', hint: 'A user story, what done looks like as a checklist, an estimate and the risks.' }],
  design: [{ ask: 'design', agent: 'Designer Agent', label: 'Draft the design', hint: 'The flow, a prototype, the design tokens and an accessibility checklist.' }],
  build: [{ ask: 'change_set', agent: 'Developer Agent', label: 'Draft the change set', hint: 'The source files and their unit tests, nothing else.' }],
  test: [{ ask: 'tests', agent: 'QA Agent', label: 'Add end-to-end tests', hint: 'End-to-end and regression coverage, and which existing tests this could break.' }],
  release: [{ ask: 'release_pack', agent: 'Release Agent', label: 'Draft the release pack', hint: 'Release notes, the risk, and the readiness scorecard computed from the facts.' }],
  deploy: [{ ask: 'rollout_report', agent: 'Release Agent', label: 'Write the rollout report', hint: 'A plain account of the checks measured at each traffic step.' }],
};

/** The jobs a person starts from each stage, in the order they run. */
export const JOBS: Record<WorkStage, JobKind[]> = {
  plan: [],
  design: [],
  build: ['build'],
  test: ['unit', 'e2e'],
  release: ['release_build', 'scan'],
  deploy: [],
};

export const JOB_LABEL: Record<JobKind, string> = {
  build: 'Build',
  unit: 'Unit tests',
  e2e: 'End-to-end tests',
  release_build: 'Release image',
  scan: 'Vulnerability scan',
  explore: 'Exploratory QA',
  deploy: 'Deploy',
  traffic_step: 'Traffic step',
  rollback: 'Rollback',
};

export const ARTIFACT_LABEL: Record<ArtifactKind, string> = {
  spec: 'Spec',
  design: 'Design',
  change_set: 'Change set',
  test_report: 'Test report',
  release_pack: 'Release pack',
  rollout_report: 'Rollout report',
  exploration_report: 'Exploration report',
};

/** The artifact kinds a stage shows, the one it produces first. */
export const KINDS: Record<WorkStage, ArtifactKind[]> = {
  plan: ['spec'],
  design: ['design'],
  build: ['change_set'],
  test: ['change_set', 'test_report', 'exploration_report'],
  release: ['release_pack'],
  deploy: ['rollout_report'],
};

const alive = (a: Artifact) => a.state !== 'superseded';

/** A ticket's artifacts of some kinds, newest first, without the ones a newer version replaced. */
export function artifactsOf(all: readonly Artifact[], ticket: string, kinds: readonly ArtifactKind[]): Artifact[] {
  return all
    .filter((a) => a.ticket === ticket && kinds.includes(a.kind) && alive(a))
    .sort((a, b) => b.createdAt - a.createdAt || b.version - a.version);
}

/** The artifact a gate is looking at: the newest accepted one, or else the newest draft. */
export function currentArtifact(all: readonly Artifact[], ticket: string, kind: ArtifactKind): Artifact | undefined {
  const list = artifactsOf(all, ticket, [kind]);
  return list.find((a) => a.state === 'accepted') ?? list.find((a) => a.state === 'draft');
}

export const jobActive = (job: Pick<Job, 'state'>): boolean => job.state === 'queued' || job.state === 'running';
export const rolloutActive = (r: Pick<Rollout, 'state'>): boolean => r.state === 'candidate' || r.state === 'canary' || r.state === 'promoting';

/** The newest job of a kind that ran on this digest. */
export function jobOn(jobs: readonly Job[], ticket: string, kind: JobKind, digest: string | undefined): Job | undefined {
  if (!digest) return undefined;
  return jobs.filter((j) => j.ticket === ticket && j.kind === kind && j.inputDigest === digest).sort((a, b) => a.createdAt - b.createdAt).at(-1);
}

type Tone = 'default' | 'primary' | 'success' | 'warning' | 'danger';
export const JOB_TONE: Record<JobState, Tone> = { queued: 'default', running: 'primary', passed: 'success', failed: 'danger', cancelled: 'default', timed_out: 'warning' };
export const JOB_STATE_LABEL: Record<JobState, string> = { queued: 'Queued', running: 'Running', passed: 'Passed', failed: 'Failed', cancelled: 'Cancelled', timed_out: 'Timed out' };

/** 3 s, 1 min 20 s: how long a job took, for a chip. */
export function durationText(ms: number | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return `${m} min${s % 60 ? ` ${s % 60} s` : ''}`;
}

/** A short digest for display: the first eight characters. */
export const shortDigest = (digest: string | undefined): string => (digest ? digest.slice(0, 8) : '');
