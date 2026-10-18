import { randomBytes } from 'node:crypto';
import type { PipelineConfig } from './config.ts';
import type { Budget } from './budget.ts';
import type { BuildDriver, BuildRequest, BuildStatus } from './drivers.ts';
import { parseMarker, worstSeverity } from './drivers.ts';
import { ServiceError } from './errors.ts';
import type { SourceStore } from './source.ts';
import type { StateStore } from './store.ts';
import { denyScan, parseChangeSet } from './shared/pipeline/protocol.ts';
import type { ChangeFile, Job, JobKind, JobSummary, ScanSeverity } from './shared/pipeline/types.ts';
import { PIPELINE_LIMITS } from './shared/pipeline/types.ts';

/** A job as the pipeline service keeps it: the public `Job` plus what only the service needs to reconcile and ship. */
export interface StoredJob extends Job {
  files?: ChangeFile[];
  sourceObject?: string;
  imageUrl?: string;
}

const ACTIVE = new Set<Job['state']>(['queued', 'running']);
const JOB_KINDS: JobKind[] = ['build', 'unit', 'e2e', 'release_build', 'scan', 'explore'];

export interface JobServiceDeps {
  cfg: PipelineConfig;
  store: StateStore;
  source: SourceStore;
  budget: Budget;
  build: BuildDriver;
  /** Told when a job reaches a terminal state, so the web service can tell every open window. Never throws. */
  notify?: (job: Job) => Promise<void>;
  now?: () => number;
}

/**
 * Jobs: what a person starts from a stage page, run for real by Cloud Build. Everything an agent wrote is validated again here (the
 * web service's check is not trusted twice over), a changed trunk makes a change set stale, and every job ends in a state a gate can read.
 */
export class JobService {
  private now: () => number;

  constructor(private deps: JobServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  private id(): string {
    return `job-${this.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  }

  private public(job: StoredJob): Job {
    const { files: _files, sourceObject: _sourceObject, imageUrl: _imageUrl, ...rest } = job;
    return structuredClone(rest);
  }

  private async stored(id: string): Promise<StoredJob | null> {
    return this.deps.store.get<StoredJob>('jobs', id);
  }

  private async save(job: StoredJob) {
    await this.deps.store.set('jobs', job.id, job);
  }

  /** How much of the trunk a change set replaces is not what the trunk holds now: ask the Developer Agent to start again. */
  private async checkTrunk(files: readonly ChangeFile[]) {
    const repo = await this.deps.source.repo();
    const shas = new Map(repo.map((f) => [f.path, f.sha]));
    for (const file of files) {
      const current = shas.get(file.path) ?? null;
      const stale = file.op === 'delete' ? current === null || file.baseSha !== current : file.baseSha !== current;
      if (stale) throw new ServiceError('stale', `${file.path} changed on main since this change set was written. Ask the Developer Agent to start again from the current code.`, 409);
    }
  }

  private async active(): Promise<number> {
    const jobs = await this.deps.store.list<StoredJob>('jobs');
    const stale = this.now() - this.deps.cfg.limits.jobTimeoutSeconds * 2000;
    let count = 0;
    for (const { value } of jobs) {
      if (!ACTIVE.has(value.state)) continue;
      // A job the pipeline lost touch with (a restart during a build) must not hold a concurrency slot for ever.
      if (value.createdAt < stale) continue;
      count += 1;
    }
    return count;
  }

  private async passedOn(kind: JobKind, inputDigest: string): Promise<StoredJob | undefined> {
    const jobs = await this.deps.store.list<StoredJob>('jobs');
    return jobs
      .map((j) => j.value)
      .filter((j) => j.kind === kind && j.inputDigest === inputDigest && j.state === 'passed')
      .sort((a, b) => a.createdAt - b.createdAt)
      .at(-1);
  }

  async start(req: {
    ticket: string;
    ticketKey: number;
    kind: JobKind;
    inputDigest: string;
    files: unknown;
    startedBy: { id: string; name: string };
    approval?: { by: string; at: number; digest: string };
  }): Promise<Job> {
    if (!this.deps.cfg.enabled) throw new ServiceError('unavailable', 'The pipeline is switched off on this service.', 503);
    if (!JOB_KINDS.includes(req.kind)) throw new ServiceError('invalid', 'That kind of job is started another way.', 400);
    if (req.kind === 'explore') throw new ServiceError('invalid', 'The exploratory job is not built yet. Everything else is ready.', 400);
    if (typeof req.inputDigest !== 'string' || !/^[0-9a-f]{64}$/.test(req.inputDigest)) throw new ServiceError('invalid', 'That change set digest is not one.', 400);
    // A scan only needs the release image; the change set comes from the release job that produced it.
    const files = parseChangeSet(req.files) ?? (req.kind === 'scan' ? await this.changeFiles(req.inputDigest) : null);
    if (!files || files.length === 0) throw new ServiceError('invalid', 'The change set has a file outside the places an agent may write, or is over a limit.', 400);
    const denied = denyScan(files);
    if (denied.length) throw new ServiceError('denied', `A change set cannot use ${denied[0].rule} (${denied[0].path}, line ${denied[0].line}).`, 400);
    await this.checkTrunk(files);

    if (req.kind === 'release_build') {
      const [unit, e2e] = await Promise.all([this.passedOn('unit', req.inputDigest), this.passedOn('e2e', req.inputDigest)]);
      if (!unit || !e2e) throw new ServiceError('stage', 'Run the unit and end-to-end tests on this change set first.', 409);
    }
    if (req.kind === 'scan') {
      const release = await this.passedOn('release_build', req.inputDigest);
      if (!release?.imageDigest) throw new ServiceError('stage', 'Build the release image first.', 409);
    }

    const active = await this.active();
    if (active >= this.deps.cfg.limits.maxConcurrent) throw new ServiceError('busy', 'Two jobs are already running. Wait for one to finish.', 409);
    await this.deps.budget.reserveJob(req.kind, req.startedBy.id);

    const id = this.id();
    const staged = await this.deps.source.stage(id, files);
    const release = req.kind === 'scan' ? await this.passedOn('release_build', req.inputDigest) : undefined;
    const buildRequest: BuildRequest = {
      jobId: id,
      kind: req.kind,
      ticket: req.ticket,
      ticketKey: req.ticketKey,
      inputDigest: req.inputDigest,
      sourceObject: staged.object,
      ...(release?.imageUrl ? { imageRef: release.imageUrl } : {}),
      files,
    };
    const started = await this.deps.build.start(buildRequest).catch((e) => {
      throw new ServiceError('unavailable', `The build could not be started: ${e instanceof Error ? e.message : String(e)}`, 503);
    });
    if (!started.buildId) throw new ServiceError('unavailable', 'The build service created a build without an id; nothing was started.', 503);
    const job: StoredJob = {
      id,
      ticket: req.ticket,
      kind: req.kind,
      state: 'queued',
      inputDigest: req.inputDigest,
      startedBy: req.startedBy,
      ...(req.approval ? { approval: req.approval } : {}),
      logTail: 'queued',
      links: [{ label: 'Cloud Build', url: `https://console.cloud.google.com/cloud-build/builds/${started.buildId}?project=${this.deps.cfg.projectId}` }],
      google: { buildId: started.buildId },
      createdAt: this.now(),
      files,
      sourceObject: staged.object,
      ...(release?.imageUrl ? { imageUrl: release.imageUrl } : {}),
    };
    await this.save(job);
    return this.public(job);
  }

  /** Reads the build once and writes down what it became. Idempotent. */
  private async reconcile(job: StoredJob, statusOverride?: BuildStatus): Promise<StoredJob> {
    if (!ACTIVE.has(job.state) || !job.google?.buildId) return job;
    let status: BuildStatus;
    try {
      status = statusOverride ?? (await this.deps.build.status(job.google.buildId));
    } catch (e) {
      // The build service being unreachable is not the job's fault: leave it running and try again on the next read.
      void e;
      return job;
    }
    const timedOut = status.state === 'running' && status.startedAt !== undefined && this.now() - status.startedAt > this.deps.cfg.limits.jobTimeoutSeconds * 1000;
    const state: Job['state'] = timedOut ? 'timed_out' : status.state;
    if (ACTIVE.has(state)) {
      if (job.state !== 'running' || job.startedAt !== status.startedAt) {
        job.state = 'running';
        if (status.startedAt) job.startedAt = status.startedAt;
        const log = await this.deps.build.log(job.google.buildId, 0).catch(() => null);
        if (log?.text) job.logTail = log.text.slice(-PIPELINE_LIMITS.logTail);
        await this.save(job);
      }
      return job;
    }

    job.state = state;
    if (status.startedAt) job.startedAt ??= status.startedAt;
    job.endedAt = status.endedAt ?? this.now();
    if (status.imageDigest) job.imageDigest = status.imageDigest;
    if (status.imageUrl) job.imageUrl = status.imageUrl;
    const log = (await this.deps.build.log(job.google.buildId, 0).catch(() => null))?.text ?? '';
    if (log) job.logTail = log.slice(-PIPELINE_LIMITS.logTail);
    const result = parseMarker<JobSummary>(log, 'PIPELINE_RESULT');
    const summary: JobSummary = { ...(result ?? {}) };
    if (state !== 'passed') {
      summary.text = summary.text ?? (status.statusDetail || 'The job did not pass.');
    }
    if (job.kind === 'scan' && state === 'passed' && job.imageUrl) {
      const findings = await this.deps.build.findings(job.imageUrl).catch(() => []);
      const worst: ScanSeverity = worstSeverity(findings.map((f) => f.severity));
      summary.scanSeverity = worst;
      summary.text = findings.length ? `${findings.length} finding${findings.length === 1 ? '' : 's'}; worst ${worst.toLowerCase()}.` : 'No findings.';
    }
    job.summary = summary;
    if (timedOut) {
      await this.deps.build.cancel(job.google.buildId).catch(() => undefined);
      job.summary.text = `It ran past ${this.deps.cfg.limits.jobTimeoutSeconds}s and was stopped.`;
    }
    await this.save(job);
    try {
      await this.deps.notify?.(this.public(job));
    } catch {
      // The answer is already saved; a failed notification is not worth failing the read.
    }
    return job;
  }

  async get(id: string): Promise<Job | null> {
    const job = await this.stored(id);
    if (!job) return null;
    return this.public(await this.reconcile(job));
  }

  async list(ticket?: string): Promise<Job[]> {
    const jobs = (await this.deps.store.list<StoredJob>('jobs')).map((j) => j.value).filter((j) => !ticket || j.ticket === ticket);
    const reconciled: StoredJob[] = [];
    // Reconcile the jobs that are still moving; the settled ones are read as they are.
    for (const job of jobs.sort((a, b) => a.createdAt - b.createdAt)) {
      reconciled.push(ACTIVE.has(job.state) ? await this.reconcile(job) : job);
    }
    return reconciled.map((j) => this.public(j));
  }

  async log(id: string, from: number): Promise<{ text: string; next: number; done: boolean }> {
    const job = await this.stored(id);
    if (!job?.google?.buildId) throw new ServiceError('not_found', 'That job is not here.', 404);
    const log = await this.deps.build.log(job.google.buildId, Math.max(0, from));
    if (log.text) job.logTail = log.text.slice(-PIPELINE_LIMITS.logTail);
    await this.save(job);
    return log;
  }

  async cancel(id: string): Promise<Job | null> {
    const job = await this.stored(id);
    if (!job) return null;
    if (ACTIVE.has(job.state) && job.google?.buildId) await this.deps.build.cancel(job.google.buildId).catch(() => undefined);
    job.state = 'cancelled';
    job.endedAt = this.now();
    await this.save(job);
    return this.public(job);
  }

  /** How many jobs are queued or running right now, for the status the stage pages show. */
  async activeCount(): Promise<number> {
    return this.active();
  }

  /** A Cloud Build event names a build: find the job and read it again. */
  async reconcileByBuildId(buildId: string): Promise<Job | null> {
    const jobs = await this.deps.store.list<StoredJob>('jobs');
    const job = jobs.map((j) => j.value).find((j) => j.google?.buildId === buildId);
    if (!job) return null;
    return this.public(await this.reconcile(job));
  }

  /** The files a change set wrote, for the trunk commit after a completed rollout. */
  async changeFiles(inputDigest: string): Promise<ChangeFile[]> {
    const jobs = await this.deps.store.list<StoredJob>('jobs');
    const job = jobs
      .map((j) => j.value)
      .filter((j) => j.inputDigest === inputDigest && j.files?.length)
      .sort((a, b) => a.createdAt - b.createdAt)
      .at(-1);
    return job?.files ?? [];
  }

  async reset(): Promise<void> {
    await this.deps.store.clear('jobs');
  }
}
