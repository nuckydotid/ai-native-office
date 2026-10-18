import { randomBytes } from 'node:crypto';
import type { PipelineConfig } from './config.ts';
import { Budget } from './budget.ts';
import { ServiceError } from './errors.ts';
import type { JobService } from './jobs.ts';
import type { Locks } from './locks.ts';
import { probe, runSmoke, trafficSplit } from './probe.ts';
import type { ProbeResult, SmokeResult } from './probe.ts';
import { serviceTraffic, serviceUrl } from './google.ts';
import type { CloudRunClient, RunService } from './google.ts';
import type { Environment, ScanSeverity } from './shared/pipeline/types.ts';
import type { Rollout, RolloutCheck } from './shared/pipeline/types.ts';
import type { SourceStore } from './source.ts';
import type { StateStore } from './store.ts';

export interface RolloutThresholds {
  errorRateMax: number;
  p95MsMax: number;
  scanRequired: boolean;
  scanMaxSeverity: ScanSeverity;
}

export interface DeployRequest {
  service: Environment;
  image: string;
  ticket: string;
  ticketKey: number;
  percent: number;
  previous: string | null;
  tag: string;
  labels: Record<string, string>;
}

export interface DeployedCandidate {
  revision: string;
  previous: string | null;
  url: string;
}

/** Everything the rollout service asks of Cloud Run (and of the in-process stand-in in tests). */
export interface RolloutDriver {
  service(name: Environment): Promise<RunService>;
  deploy(req: DeployRequest): Promise<DeployedCandidate>;
  setTraffic(service: Environment, revision: string, previous: string | null, percent: number, tag?: string): Promise<void>;
}

const tag = (name: string): string => name.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 63);

/** The real Cloud Run driver: revisions and traffic splits are the rollout engine, and Cloud Run stays the truth. */
export class CloudRunRolloutDriver implements RolloutDriver {
  constructor(
    private cfg: PipelineConfig,
    private run: CloudRunClient,
  ) {}

  service(name: Environment) {
    return this.run.getService(name === 'staging' ? this.cfg.stagingService : this.cfg.prodService);
  }

  /**
   * Waits for the revision the template patch created to be Ready. `latestReadyRevision` only moves once traffic does, so the wait is on
   * `latestCreatedRevision`. A patch that changes nothing (the same image and labels are already there) creates no new revision; then
   * the current one is the candidate, and it must be ready too.
   */
  private async waitForRevision(service: Environment, beforeCreated: string | undefined, wantedImage: string): Promise<string> {
    const serviceName = service === 'staging' ? this.cfg.stagingService : this.cfg.prodService;
    for (let attempt = 0; attempt < 120; attempt++) {
      const current = await this.service(service);
      const created = current.latestCreatedRevision ?? current.latestReadyRevision;
      const unchanged = created === beforeCreated && current.template?.containers?.[0]?.image === wantedImage;
      if (created && (created !== beforeCreated || unchanged)) {
        const revision = await this.run.getRevision(serviceName, created).catch(() => null);
        const ready = revision?.terminalCondition?.state === 'CONDITION_SUCCEEDED' || revision?.conditions?.some((c) => c.type === 'Ready' && c.state === 'CONDITION_SUCCEEDED');
        if (ready) return created;
        if (revision?.terminalCondition?.state === 'CONDITION_FAILED') throw new ServiceError('unavailable', `The new revision did not start: ${revision.terminalCondition.message ?? 'no reason given'}`, 503);
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new ServiceError('unavailable', 'Cloud Run did not finish the new revision in time.', 503);
  }

  async deploy(req: DeployRequest): Promise<DeployedCandidate> {
    const current = await this.service(req.service);
    const container = current.template?.containers?.[0];
    const url = serviceUrl(current);
    const beforeCreated = current.latestCreatedRevision ?? current.latestReadyRevision ?? current.status?.latestReadyRevision;
    const previous = req.previous ?? serviceTraffic(current).find((t) => (t.percent ?? 0) >= 100)?.revision ?? current.latestReadyRevision ?? current.status?.latestReadyRevision ?? null;
    const patch = {
      template: {
        containers: [{ ...(container ?? {}), image: req.image }],
        labels: req.labels,
      },
    };
    const name = req.service === 'staging' ? this.cfg.stagingService : this.cfg.prodService;
    // Only the image and the labels change: the service account, the scaling and the environment stay as they are.
    const operation = await this.run.patchService(name, patch, 'template.containers,template.labels');
    await this.run.wait(operation);
    const revision = await this.waitForRevision(req.service, beforeCreated, req.image);
    // The traffic entry is what makes the rollout real: the candidate tagged, at `percent`; everything else stays where it was.
    await this.run.patchService(name, { traffic: trafficSplit(revision, previous, req.percent, req.tag) }, 'traffic').then((op) => this.run.wait(op));
    return { revision, previous, url };
  }

  async setTraffic(service: Environment, revision: string, previous: string | null, percent: number, tagName?: string): Promise<void> {
    const name = service === 'staging' ? this.cfg.stagingService : this.cfg.prodService;
    const operation = await this.run.patchService(name, { traffic: trafficSplit(revision, previous, percent, tagName) }, 'traffic');
    await this.run.wait(operation);
  }
}

export interface RolloutServiceDeps {
  cfg: PipelineConfig;
  store: StateStore;
  source: SourceStore;
  budget: Budget;
  jobs: JobService;
  locks: Locks;
  run: RolloutDriver;
  /** Injectable for tests. */
  probeFn?: typeof probe;
  smokeFn?: typeof runSmoke;
  notify?: (rollout: Rollout) => Promise<void>;
  now?: () => number;
}

export interface StoredRollout extends Rollout {
  inputDigest: string;
  thresholds: RolloutThresholds;
  canaryTag?: string;
  previousUrl?: string;
  trunkRev?: number;
  lockHolder?: string;
}

/** Rollouts: a candidate on staging, then production in steps, judged by thresholds a person set. AI never moves traffic. */
export class RolloutService {
  private now: () => number;

  constructor(private deps: RolloutServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  private id(): string {
    return `ro-${this.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  }

  private public(r: StoredRollout): Rollout {
    const { inputDigest: _i, thresholds: _t, canaryTag: _c, previousUrl: _p, trunkRev: _tr, lockHolder: _l, ...rest } = r;
    return structuredClone(rest);
  }

  private async stored(id: string) {
    return this.deps.store.get<StoredRollout>('rollouts', id);
  }

  private async save(r: StoredRollout) {
    await this.deps.store.set('rollouts', r.id, r);
  }

  async list(ticket?: string): Promise<Rollout[]> {
    const rollouts = (await this.deps.store.list<StoredRollout>('rollouts')).map((r) => r.value).filter((r) => !ticket || r.ticket === ticket);
    return rollouts.sort((a, b) => a.createdAt - b.createdAt).map((r) => this.public(r));
  }

  async get(id: string): Promise<Rollout | null> {
    const rollout = await this.stored(id);
    return rollout ? this.public(rollout) : null;
  }

  private live(rollouts: StoredRollout[], service: Environment): StoredRollout | undefined {
    return rollouts.find((r) => r.service === service && ['candidate', 'canary', 'promoting', 'paused'].includes(r.state));
  }

  async start(req: {
    ticket: string;
    ticketKey: number;
    service: Environment;
    imageDigest: string;
    inputDigest: string;
    plan: number[];
    thresholds: RolloutThresholds;
    startedBy: { id: string; name: string };
  }): Promise<Rollout> {
    if (!this.deps.cfg.enabled) throw new ServiceError('unavailable', 'The pipeline is switched off on this service.', 503);
    if (!/^sha256:[0-9a-f]{64}$/.test(req.imageDigest)) throw new ServiceError('invalid', 'The release image digest is not one.', 400);
    const plan = req.plan?.length ? req.plan : [10, 50, 100];
    if (plan.at(-1) !== 100) throw new ServiceError('invalid', 'A rollout plan must end at 100%.', 400);
    const all = (await this.deps.store.list<StoredRollout>('rollouts')).map((r) => r.value);
    if (this.live(all, req.service)) throw new ServiceError('locked', `Another rollout to ${req.service} is still going. Finish it or roll it back first.`, 409);
    if (req.service === 'production' && !all.some((r) => r.ticket === req.ticket && r.inputDigest === req.inputDigest && r.service === 'staging' && r.state === 'complete')) {
      throw new ServiceError('invalid', 'Roll out to staging first and let it pass.', 409);
    }
    if (req.service === 'production' && req.thresholds.scanRequired) {
      const scan = (await this.deps.store.list<{ kind: string; state: string; inputDigest: string }>('jobs'))
        .map((j) => j.value)
        .some((j) => j.kind === 'scan' && j.state === 'passed' && j.inputDigest === req.inputDigest);
      if (!scan) throw new ServiceError('invalid', 'The release image has not passed its scan.', 409);
    }
    // Cloud Run needs the full image reference (repository plus digest); the digest alone is not one. The release job keeps it.
    const releaseJob = (await this.deps.store.list<{ kind: string; state: string; inputDigest: string; imageDigest?: string; imageUrl?: string }>('jobs'))
      .map((j) => j.value)
      .find((j) => j.kind === 'release_build' && j.inputDigest === req.inputDigest && j.state === 'passed' && j.imageDigest === req.imageDigest);
    if (!releaseJob?.imageUrl) throw new ServiceError('invalid', 'The release image for this change set is not on this service. Build it again.', 409);
    await this.deps.budget.reserveRollout();

    const id = this.id();
    const holder = `${req.ticket}:${id}`;
    await this.deps.locks.acquire(req.service, holder);
    const labels = { pipeline: 'true', ticket: tag(String(req.ticketKey)), approver: tag(req.startedBy.id) };
    let deployed: DeployedCandidate;
    try {
      deployed = await this.deps.run.deploy({
        service: req.service,
        image: releaseJob.imageUrl,
        ticket: req.ticket,
        ticketKey: req.ticketKey,
        percent: req.service === 'staging' ? 100 : 0,
        previous: null,
        tag: req.service === 'staging' ? 'cand' : 'canary',
        labels,
      });
    } catch (e) {
      await this.deps.locks.release(req.service, holder);
      if (e instanceof ServiceError) throw e;
      throw new ServiceError('unavailable', `Cloud Run refused the rollout: ${e instanceof Error ? e.message : String(e)}`, 503);
    }
    const rollout: StoredRollout = {
      id,
      ticket: req.ticket,
      service: req.service,
      image: releaseJob.imageUrl,
      revision: deployed.revision,
      previous: deployed.previous,
      plan,
      step: -1,
      trafficPct: req.service === 'staging' ? 100 : 0,
      state: req.service === 'staging' ? 'promoting' : 'candidate',
      checks: [],
      startedBy: req.startedBy,
      createdAt: this.now(),
      updatedAt: this.now(),
      inputDigest: req.inputDigest,
      thresholds: req.thresholds,
      canaryTag: req.service === 'staging' ? 'cand' : 'canary',
      previousUrl: deployed.url,
      lockHolder: holder,
    };

    if (req.service === 'staging') {
      const tagUrl = deployed.url.replace('https://', 'https://cand---');
      const smoke = await (this.deps.smokeFn ?? runSmoke)(this.deps.cfg.smokeScript, tagUrl, { SMOKE_EXPECT_REVISION: deployed.revision.split('/').pop() ?? deployed.revision });
      rollout.checks.push(this.checkFromSmoke(100, smoke));
      if (smoke.ok) {
        rollout.state = 'complete';
        await this.deps.locks.release(req.service, holder);
      } else {
        await this.deps.run.setTraffic('staging', deployed.revision, deployed.previous, 0, undefined).catch(() => undefined);
        rollout.state = 'rolled_back';
        rollout.trafficPct = 0;
        await this.deps.locks.release(req.service, holder);
      }
    }
    await this.save(rollout);
    await this.notify(rollout);
    return this.public(rollout);
  }

  private checkFromSmoke(percent: number, smoke: SmokeResult): RolloutCheck {
    return {
      at: this.now(),
      percent,
      requests: Object.values(smoke.byRevision).reduce((n, r) => n + r.requests, 0),
      errorRate: smoke.errorRate,
      p95Ms: smoke.p95Ms,
      byRevision: smoke.byRevision,
      ok: smoke.ok,
      ...(smoke.ok ? {} : { reason: smoke.failures[0] ?? `The candidate failed its smoke check at ${percent}%.` }),
    };
  }

  private judge(check: RolloutCheck, thresholds: RolloutThresholds): string | null {
    if (check.errorRate > thresholds.errorRateMax) return `The new revision answered errors under load (${(check.errorRate * 100).toFixed(1)}% > ${(thresholds.errorRateMax * 100).toFixed(1)}%).`;
    if (check.p95Ms > thresholds.p95MsMax) return `The new revision got slow under load (p95 ${check.p95Ms} ms > ${thresholds.p95MsMax} ms).`;
    return null;
  }

  async step(id: string, by: { id: string; name: string }): Promise<Rollout> {
    const rollout = await this.stored(id);
    if (!rollout) throw new ServiceError('not_found', 'That rollout is not here.', 404);
    if (rollout.service !== 'production' || !['candidate', 'canary'].includes(rollout.state)) throw new ServiceError('invalid', 'This rollout is not waiting for a step.', 409);
    const percent = rollout.plan[rollout.step + 1];
    await this.deps.run.setTraffic('production', rollout.revision, rollout.previous, percent, percent < 100 ? rollout.canaryTag : undefined);
    const result: ProbeResult = await (this.deps.probeFn ?? probe)(rollout.previousUrl ?? '', {
      requests: this.deps.cfg.limits.probeRequests,
      concurrency: 20,
      paths: ['/health', '/api/orders', '/api/summary', '/'],
    });
    const shortRevision = rollout.revision.split('/').pop() ?? rollout.revision;
    const candidate = result.byRevision[shortRevision] ?? { requests: 0, errors: 0, p95Ms: 0 };
    const errorRate = candidate.requests ? candidate.errors / candidate.requests : result.errorRate;
    const check: RolloutCheck = {
      at: this.now(),
      percent,
      requests: result.requests,
      errorRate,
      p95Ms: candidate.p95Ms || result.p95Ms,
      byRevision: result.byRevision,
      ok: true,
    };
    const reason = candidate.requests === 0 ? 'No request reached the new revision, so it was not judged.' : this.judge(check, rollout.thresholds);
    if (reason) {
      check.ok = false;
      check.reason = reason;
      rollout.checks.push(check);
      await this.deps.run.setTraffic('production', rollout.revision, rollout.previous, 0, rollout.canaryTag).catch(() => undefined);
      await this.deps.run.setTraffic('production', rollout.previous ?? rollout.revision, null, 100).catch(() => undefined);
      rollout.state = 'rolled_back';
      rollout.trafficPct = 0;
      rollout.updatedAt = this.now();
      await this.save(rollout);
      await this.deps.locks.release('production', rollout.lockHolder ?? '');
      await this.notify(rollout);
      return this.public(rollout);
    }

    rollout.checks.push(check);
    rollout.step += 1;
    rollout.trafficPct = percent;
    rollout.state = percent >= 100 ? 'complete' : 'canary';
    rollout.updatedAt = this.now();
    if (rollout.state === 'complete') {
      const files = await this.deps.jobs.changeFiles(rollout.inputDigest);
      if (files.length) rollout.trunkRev = await this.deps.source.commit(files);
      await this.deps.locks.release('production', rollout.lockHolder ?? '');
    }
    await this.save(rollout);
    void by;
    await this.notify(rollout);
    return this.public(rollout);
  }

  async rollback(id: string, _by: { id: string; name: string }): Promise<Rollout> {
    const rollout = await this.stored(id);
    if (!rollout) throw new ServiceError('not_found', 'That rollout is not here.', 404);
    if (!['candidate', 'canary', 'paused', 'complete', 'rolling_back'].includes(rollout.state)) throw new ServiceError('invalid', 'This rollout is already rolled back.', 409);
    const to = rollout.previous ?? rollout.revision;
    await this.deps.run.setTraffic(rollout.service, to, null, 100);
    rollout.state = 'rolled_back';
    rollout.trafficPct = 0;
    rollout.updatedAt = this.now();
    await this.save(rollout);
    await this.deps.locks.release(rollout.service, rollout.lockHolder ?? '');
    await this.notify(rollout);
    return this.public(rollout);
  }

  /** Cloud Run is the truth for traffic: a change made in the console shows up here on the next read. */
  async reconcile(id: string): Promise<Rollout | null> {
    const rollout = await this.stored(id);
    if (!rollout) return null;
    if (!['candidate', 'canary', 'promoting'].includes(rollout.state)) return this.public(rollout);
    try {
      const service = await this.deps.run.service(rollout.service);
      const entry = serviceTraffic(service).find((t) => (t.revision ?? '').endsWith(rollout.revision.split('/').pop() ?? '') || (t.revision ?? '') === rollout.revision);
      if (entry && typeof entry.percent === 'number' && entry.percent !== rollout.trafficPct) {
        rollout.trafficPct = entry.percent;
        rollout.updatedAt = this.now();
        await this.save(rollout);
      }
    } catch {
      // A read that fails leaves the record as it is.
    }
    return this.public(rollout);
  }

  private async notify(rollout: StoredRollout) {
    try {
      await this.deps.notify?.(this.public(rollout));
    } catch {
      // The rollout is saved; a failed notification is not worth failing the change.
    }
  }

  async reset(): Promise<void> {
    const all = (await this.deps.store.list<StoredRollout>('rollouts')).map((r) => r.value);
    for (const rollout of all) {
      // Put both services back on the revision that served before the rollout, then forget it.
      await this.deps.run.setTraffic(rollout.service, rollout.previous ?? rollout.revision, null, 100).catch(() => undefined);
    }
    await this.deps.store.clear('rollouts');
    await this.deps.locks.clear();
  }
}
