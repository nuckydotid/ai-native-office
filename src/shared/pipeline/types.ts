/**
 * The delivery pipeline: what a ticket goes through from an idea to a rollout, and what is kept along the way. The web service
 * keeps tickets, artifacts, gate decisions and the audit trail; the private pipeline service keeps jobs and rollouts and does the
 * building, testing and deploying. Agents propose artifacts, people accept them and press the buttons that start jobs.
 */

/** The stages a ticket moves through, in order. `done` is after the rollout. */
export const PIPELINE_STAGES = ['plan', 'design', 'build', 'test', 'release', 'deploy', 'done'] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/** Where a pipeline ticket stands, besides its stage: the revision of the sample app's virtual trunk its work started from. */
export interface TicketPipeline {
  stage: PipelineStage;
  /** `main@<number>`: the trunk revision the ticket's change set is checked against. It advances on every deploy. */
  mainRev: string;
}

export const ARTIFACT_KINDS = ['spec', 'design', 'change_set', 'test_report', 'release_pack', 'rollout_report', 'exploration_report'] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/** `draft`: proposed, waiting for a person. `accepted`: a person approved exactly this digest. `superseded`: a newer one took its place. */
export const ARTIFACT_STATES = ['draft', 'accepted', 'superseded', 'rejected'] as const;
export type ArtifactState = (typeof ARTIFACT_STATES)[number];

/** One file of a change set. `baseSha` is the sha256 of the file it replaces on the trunk (null for a new file, or a delete of nothing). */
export interface ChangeFile {
  path: string;
  op: 'write' | 'delete';
  /** What the file is for. It must agree with where it lives: `src/` is `src`, `tests/` is `unit_test`, `e2e/` is `e2e_test`. */
  role: 'src' | 'unit_test' | 'e2e_test';
  content: string;
  baseSha: string | null;
}

export interface ArtifactAuthor {
  /** A person's uid, or `agent:<handle>`. */
  id: string;
  name: string;
  agent?: boolean;
}

/**
 * Something the pipeline keeps for a ticket. Immutable: a change is a new artifact with the next `version`, and an approval
 * binds to the `digest` (sha256 of kind, title, body and files), so what a person accepted is exactly what later steps use.
 */
export interface Artifact {
  id: string;
  /** The ticket's id and number. */
  ticket: string;
  ticketKey: number;
  kind: ArtifactKind;
  version: number;
  digest: string;
  title: string;
  /** Markdown for a spec, a release pack or a report; the page's HTML for a design; a short note for a change set. */
  body: string;
  files?: ChangeFile[];
  meta?: Record<string, string | number | boolean>;
  state: ArtifactState;
  by: ArtifactAuthor;
  runId?: string;
  createdAt: number;
  decidedBy?: string;
  decidedAt?: number;
}

/** What an agent hands back: the server gives it an id, a number, a digest and `draft` state. */
export interface ArtifactDraft {
  kind: ArtifactKind;
  title: string;
  body: string;
  files?: ChangeFile[];
  meta?: Record<string, string | number | boolean>;
}

export const JOB_KINDS = ['build', 'unit', 'e2e', 'release_build', 'scan', 'explore', 'deploy', 'traffic_step', 'rollback'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const JOB_STATES = ['queued', 'running', 'passed', 'failed', 'cancelled', 'timed_out'] as const;
export type JobState = (typeof JOB_STATES)[number];

export const SCAN_SEVERITIES = ['NONE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type ScanSeverity = (typeof SCAN_SEVERITIES)[number];

export interface JobSummary {
  passed?: number;
  failed?: number;
  skipped?: number;
  durationMs?: number;
  /** Line coverage of the unit run, in percent. */
  coveragePct?: number;
  /** The worst finding of a vulnerability scan. */
  scanSeverity?: ScanSeverity;
  text?: string;
}

/** A unit of real work the pipeline service did (or is doing) on Google Cloud. The pipeline service owns it; the web service shows it. */
export interface Job {
  id: string;
  ticket: string;
  kind: JobKind;
  state: JobState;
  /** The digest of the change set (or release pack) the job ran on. A gate only counts a job whose digest is the accepted one. */
  inputDigest: string;
  /** The image a release build produced, and the revision or traffic step a deploy job made. */
  imageDigest?: string;
  revision?: string;
  percent?: number;
  startedBy: { id: string; name: string };
  /** Who allowed it, and which digest they looked at. */
  approval?: { by: string; at: number; digest: string };
  summary?: JobSummary;
  /** The last few lines of its log, for the list. The whole log is read on demand. */
  logTail: string;
  links: { label: string; url: string }[];
  google?: { buildId?: string; operation?: string };
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
}

export const ROLLOUT_STATES = ['candidate', 'canary', 'promoting', 'complete', 'rolled_back', 'paused', 'failed'] as const;
export type RolloutState = (typeof ROLLOUT_STATES)[number];

export const ENVIRONMENTS = ['staging', 'production'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

/** One health reading at one traffic step: what the pipeline measured by sending requests, per revision. */
export interface RolloutCheck {
  at: number;
  percent: number;
  requests: number;
  errorRate: number;
  p95Ms: number;
  byRevision: Record<string, { requests: number; errors: number; p95Ms: number }>;
  ok: boolean;
  reason?: string;
}

export interface Rollout {
  id: string;
  ticket: string;
  service: Environment;
  image: string;
  revision: string;
  /** The revision that served before, which a rollback goes back to. */
  previous: string | null;
  /** The traffic steps, for example `[10, 50, 100]`. */
  plan: number[];
  /** Index into `plan` of the step reached (-1 before the first). */
  step: number;
  trafficPct: number;
  state: RolloutState;
  checks: RolloutCheck[];
  startedBy: { id: string; name: string };
  createdAt: number;
  updatedAt: number;
}

/** The thresholds a gate reads. Owners edit them in Tools; the demo ships these defaults. */
export interface PipelinePolicy {
  /** Least line coverage (percent) a unit run may report. */
  coverageMin: number;
  /** Most 5xx a canary step may show, as a fraction of requests (0.01 is 1%). */
  errorRateMax: number;
  /** Slowest 95th-percentile latency a canary step may show, in milliseconds. */
  p95MsMax: number;
  /** The worst finding a release may carry. */
  scanMaxSeverity: ScanSeverity;
  /** Whether a release needs a vulnerability scan at all. */
  scanRequired: boolean;
  /** Whether the person who approves a release must be someone other than the author of its change set. Off in the demo. */
  separationOfDuties: boolean;
  /** The traffic steps of a rollout. */
  rolloutPlan: number[];
}

export const DEFAULT_POLICY: PipelinePolicy = {
  coverageMin: 70,
  errorRateMax: 0.01,
  p95MsMax: 800,
  scanMaxSeverity: 'MEDIUM',
  scanRequired: true,
  separationOfDuties: false,
  rolloutPlan: [10, 50, 100],
};

/** Every approval, job start, advance and rollback, so a release can be explained afterwards. */
export interface AuditEvent {
  id: string;
  at: number;
  by: { id: string; name: string; role: string };
  action: string;
  ticket?: string;
  ref?: string;
  detail: string;
}

export const PIPELINE_LIMITS = {
  title: 200,
  /** An artifact's body: markdown or the HTML of a prototype. */
  body: 120_000,
  files: 8,
  fileLines: 400,
  fileBytes: 40_000,
  changeSetBytes: 200_000,
  path: 200,
  metaKeys: 20,
  metaKey: 40,
  metaValue: 200,
  /** Artifacts kept per ticket, audit events kept, and the longest log tail on a job. */
  artifactsPerTicket: 60,
  audit: 500,
  logTail: 4000,
  /** An agent may hand back this many artifacts in one answer. */
  draftsPerRun: 4,
} as const;

/** The ticket status a stage implies. `Issue.status` is derived from the stage and written only by `advanceStage`. */
export function statusForStage(stage: PipelineStage): 'todo' | 'in_progress' | 'review' | 'done' {
  switch (stage) {
    case 'plan':
      return 'todo';
    case 'design':
    case 'build':
    case 'test':
      return 'in_progress';
    case 'release':
    case 'deploy':
      return 'review';
    default:
      return 'done';
  }
}

export const stageIndex = (stage: PipelineStage): number => PIPELINE_STAGES.indexOf(stage);
export const nextStage = (stage: PipelineStage): PipelineStage | null => PIPELINE_STAGES[stageIndex(stage) + 1] ?? null;
