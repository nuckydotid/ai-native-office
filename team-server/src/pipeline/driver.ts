import type { ChangeFile, Environment, Job, JobKind, PipelinePolicy, Rollout } from '../shared/pipeline/types.ts';

/** A file of the sample app's trunk, as the pipeline sees it. */
export interface RepoFile {
  path: string;
  /** sha256 of the content: what a change set's `baseSha` is checked against. */
  sha: string;
  size: number;
}

export interface JobRequest {
  ticket: string;
  ticketKey: number;
  kind: JobKind;
  /** The digest of the accepted change set the job runs on. */
  inputDigest: string;
  /** Its files, so the pipeline can lay them over the trunk (the pipeline keeps no ticket state of its own). */
  files: ChangeFile[];
  startedBy: { id: string; name: string };
  approval?: { by: string; at: number; digest: string };
}

export interface RolloutRequest {
  ticket: string;
  ticketKey: number;
  service: Environment;
  /** The release build's image digest and the change-set digest it was built from. */
  imageDigest: string;
  inputDigest: string;
  plan: number[];
  /** The thresholds the pipeline service judges each traffic step against. */
  thresholds: { errorRateMax: number; p95MsMax: number; scanRequired: boolean; scanMaxSeverity: string };
  startedBy: { id: string; name: string };
}

export interface JobLog {
  text: string;
  /** Where to continue from (character offset into the whole log). */
  next: number;
  done: boolean;
}

/** What the pipeline service is willing to do right now, and what is left of the budgets (the service owns both). */
export interface PipelineStatus {
  enabled: boolean;
  killSwitch: boolean;
  jobsLeftToday: number;
  jobsLeftThisHour: number;
  concurrent: number;
  maxConcurrent: number;
  rolloutsLeftToday: number;
  scansLeftToday: number;
}

/** A refusal from the pipeline service: a budget, the kill switch, a lock. The routes turn it into a status and a sentence. */
export class PipelineRefusal extends Error {
  constructor(
    readonly code: 'budget' | 'busy' | 'killed' | 'locked' | 'invalid' | 'unavailable' | 'not_found',
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 429 | 503 = 429,
  ) {
    super(message);
  }
}

/**
 * Everything the web service asks of the pipeline service. The real one is an HTTP client for the private `studio-pipeline`
 * (ID-token calls); the fake runs in this process, so the stage pages, the gates and the tests work without Google Cloud.
 */
export interface PipelineDriver {
  readonly kind: 'fake' | 'http';
  /** The trunk's revision (`main@3`) and its files. */
  repo(): Promise<{ rev: string; files: RepoFile[] }>;
  readFile(path: string): Promise<string | null>;
  startJob(req: JobRequest): Promise<Job>;
  getJob(id: string): Promise<Job | null>;
  listJobs(ticket?: string): Promise<Job[]>;
  jobLog(id: string, from: number): Promise<JobLog | null>;
  cancelJob(id: string): Promise<Job | null>;
  startRollout(req: RolloutRequest): Promise<Rollout>;
  /** Moves a production rollout to its next traffic step and judges it; a failed judgement rolls it back. */
  stepRollout(id: string, by: { id: string; name: string }): Promise<Rollout>;
  rollback(id: string, by: { id: string; name: string }): Promise<Rollout>;
  getRollout(id: string): Promise<Rollout | null>;
  listRollouts(ticket?: string): Promise<Rollout[]>;
  status(uid: string): Promise<PipelineStatus>;
  /** Puts the sample app's trunk, both services and every job back to the baseline (the nightly reset). */
  reset(): Promise<void>;
}

export interface PolicyStore {
  get(): PipelinePolicy;
  set(p: PipelinePolicy): void;
}
