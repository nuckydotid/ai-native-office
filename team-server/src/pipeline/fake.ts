import { createHash, randomBytes } from 'node:crypto';
import type { ChangeFile, Job, JobKind, Rollout, RolloutCheck } from '../shared/pipeline/types.ts';
import { PipelineRefusal } from './driver.ts';
import type { JobLog, JobRequest, PipelineDriver, PipelineStatus, RepoFile, RolloutRequest } from './driver.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** A small trunk for a run with no Google Cloud: a few files with real hashes, so change sets can be checked against them. */
const BASELINE: Record<string, string> = {
  'sample-app/src/main.tsx': "import { createRoot } from 'react-dom/client';\nimport { App } from './App';\ncreateRoot(document.getElementById('root')!).render(<App />);\n",
  'sample-app/src/App.tsx': "import { OrderList } from './OrderList';\nexport function App() {\n  return <OrderList />;\n}\n",
  'sample-app/src/OrderList.tsx': "export function OrderList() {\n  return <ul aria-label=\"Orders\" />;\n}\n",
  'sample-app/src/api/orders.ts': "export const orders = [{ id: 'o-1001', customer: 'Harbour Outfitters', status: 'shipped', total: 482.5 }];\n",
  'sample-app/tests/orders.test.ts': "import { orders } from '../src/api/orders';\nit('has orders', () => expect(orders.length).toBeGreaterThan(0));\n",
  'sample-app/e2e/orders.spec.ts': "import { test, expect } from '@playwright/test';\ntest('lists orders', async ({ page }) => { await page.goto('/'); await expect(page.getByLabel('Orders')).toBeVisible(); });\n",
};

/** Markers a change set can carry so a test (or a demo) can make the fake fail on purpose. */
export const FAKE_FAIL = '// fake:fail';
export const FAKE_5XX = '// fake:5xx';

export interface FakeOptions {
  now?: () => number;
  /** How long a job takes, in milliseconds (a quarter of it is spent queued). */
  jobMs?: number;
  jobsPerGuestHour?: number;
  jobsPerDay?: number;
  maxConcurrent?: number;
  scansPerDay?: number;
  rolloutsPerDay?: number;
}

interface Held {
  job: Job;
  req: JobRequest;
  willFail: boolean;
}

const LINES: Record<JobKind, string[]> = {
  build: ['docker build --target deps', 'npm ci', 'npx tsc --noEmit', 'npm run lint', 'npm run build', 'build finished'],
  unit: ['docker run --network none (unit)', 'vitest run --coverage', 'results written to results.json'],
  e2e: ['docker run --network none (e2e)', 'vite preview on a local port', 'playwright test', 'report written'],
  release_build: ['docker build --target runtime', 'push to Artifact Registry', 'provenance recorded', 'image digest recorded'],
  scan: ['scanning the image', 'no findings above the policy'],
  explore: ['opening a headless browser', 'exploring the candidate', 'report written'],
  deploy: ['deploying a tagged revision with no traffic'],
  traffic_step: ['patching traffic'],
  rollback: ['routing all traffic to the previous revision'],
};

/**
 * The pipeline service, in this process. Jobs move queued → running → passed over `jobMs` of the clock it is given; a change set that
 * carries `// fake:fail` makes its jobs fail and one that carries `// fake:5xx` passes its tests and then fails its canary. Budgets and
 * the trunk work the way the real service's do, so the routes and the gates can be tried against it.
 */
export class FakePipelineDriver implements PipelineDriver {
  readonly kind = 'fake' as const;
  private files = new Map<string, string>();
  private revision = 0;
  private jobs = new Map<string, Held>();
  private rollouts = new Map<string, Rollout>();
  private filesByDigest = new Map<string, ChangeFile[]>();
  private spent: { at: number; uid: string; kind: JobKind }[] = [];
  private now: () => number;
  private jobMs: number;
  private limits: Required<Pick<FakeOptions, 'jobsPerGuestHour' | 'jobsPerDay' | 'maxConcurrent' | 'scansPerDay' | 'rolloutsPerDay'>>;
  private rolloutCount = 0;

  constructor(o: FakeOptions = {}) {
    this.now = o.now ?? Date.now;
    this.jobMs = o.jobMs ?? 1500;
    this.limits = { jobsPerGuestHour: o.jobsPerGuestHour ?? 6, jobsPerDay: o.jobsPerDay ?? 30, maxConcurrent: o.maxConcurrent ?? 2, scansPerDay: o.scansPerDay ?? 6, rolloutsPerDay: o.rolloutsPerDay ?? 15 };
    this.loadBaseline();
  }

  private loadBaseline() {
    this.files = new Map(Object.entries(BASELINE));
    this.revision = 0;
  }

  async repo() {
    const files: RepoFile[] = [...this.files].map(([path, content]) => ({ path, sha: sha(content), size: Buffer.byteLength(content) })).sort((a, b) => (a.path < b.path ? -1 : 1));
    return { rev: `main@${this.revision}`, files };
  }

  async readFile(path: string) {
    return this.files.get(path) ?? null;
  }

  /** What the clock says a job has become. */
  private tick(h: Held): Job {
    const j = h.job;
    if (j.state === 'cancelled' || j.state === 'passed' || j.state === 'failed' || j.state === 'timed_out') return j;
    const age = this.now() - j.createdAt;
    if (age >= this.jobMs) {
      j.state = h.willFail ? 'failed' : 'passed';
      j.endedAt = j.createdAt + this.jobMs;
      j.startedAt ??= j.createdAt + Math.round(this.jobMs / 4);
      const lines = LINES[j.kind];
      j.logTail = [...lines, h.willFail ? 'FAILED: a test did not pass' : 'passed'].slice(-6).join('\n');
      j.summary = this.summaryOf(j, h);
      if (j.kind === 'release_build' && !h.willFail) j.imageDigest = `sha256:${sha(`${j.inputDigest}:image`)}`;
    } else if (age >= this.jobMs / 4) {
      j.state = 'running';
      j.startedAt ??= j.createdAt + Math.round(this.jobMs / 4);
      j.logTail = LINES[j.kind].slice(0, Math.max(1, Math.floor((age / this.jobMs) * LINES[j.kind].length))).join('\n');
    }
    return j;
  }

  private summaryOf(j: Job, h: Held): Job['summary'] {
    if (j.kind === 'unit') return h.willFail ? { passed: 11, failed: 2, skipped: 0, durationMs: this.jobMs, coveragePct: 74 } : { passed: 13, failed: 0, skipped: 0, durationMs: this.jobMs, coveragePct: 82 };
    if (j.kind === 'e2e') return h.willFail ? { passed: 3, failed: 1, durationMs: this.jobMs } : { passed: 4, failed: 0, durationMs: this.jobMs };
    if (j.kind === 'scan') return { scanSeverity: 'LOW', text: 'Two low findings in base image packages.' };
    if (j.kind === 'release_build') return { durationMs: this.jobMs, text: 'Image built with provenance.' };
    return { durationMs: this.jobMs };
  }

  private concurrent(): number {
    return [...this.jobs.values()].filter((h) => {
      const s = this.tick(h).state;
      return s === 'queued' || s === 'running';
    }).length;
  }

  async startJob(req: JobRequest): Promise<Job> {
    const at = this.now();
    const today = this.spent.filter((s) => at - s.at < 86_400_000);
    if (today.length >= this.limits.jobsPerDay) throw new PipelineRefusal('budget', 'The demo’s build budget for today is used up. It refills after the nightly reset.');
    if (today.filter((s) => s.uid === req.startedBy.id && at - s.at < 3_600_000).length >= this.limits.jobsPerGuestHour) throw new PipelineRefusal('budget', 'You have used your pipeline runs for this hour. They come back soon.');
    if (req.kind === 'scan' && today.filter((s) => s.kind === 'scan').length >= this.limits.scansPerDay) throw new PipelineRefusal('budget', 'The vulnerability scans for today are used up.');
    if (this.concurrent() >= this.limits.maxConcurrent) throw new PipelineRefusal('busy', 'Two jobs are already running. Wait for one to finish.', 409);
    this.spent.push({ at, uid: req.startedBy.id, kind: req.kind });
    const id = `job-${at.toString(36)}-${randomBytes(3).toString('hex')}`;
    this.filesByDigest.set(req.inputDigest, req.files);
    const willFail = req.files.some((f) => f.op === 'write' && f.content.includes(FAKE_FAIL));
    const job: Job = {
      id, ticket: req.ticket, kind: req.kind, state: 'queued', inputDigest: req.inputDigest,
      startedBy: req.startedBy, ...(req.approval ? { approval: req.approval } : {}),
      logTail: 'queued', links: [], createdAt: at,
    };
    this.jobs.set(id, { job, req, willFail });
    return structuredClone(job);
  }

  async getJob(id: string) {
    const h = this.jobs.get(id);
    return h ? structuredClone(this.tick(h)) : null;
  }

  async listJobs(ticket?: string) {
    return [...this.jobs.values()].map((h) => structuredClone(this.tick(h))).filter((j) => !ticket || j.ticket === ticket).sort((a, b) => a.createdAt - b.createdAt);
  }

  async jobLog(id: string, from: number): Promise<JobLog | null> {
    const h = this.jobs.get(id);
    if (!h) return null;
    const job = this.tick(h);
    const all = `${LINES[job.kind].join('\n')}\n${job.state === 'failed' ? 'FAILED' : job.state === 'passed' ? 'passed' : ''}`;
    const upto = job.state === 'queued' ? 0 : job.state === 'running' ? Math.floor(all.length / 2) : all.length;
    const start = Math.max(0, Math.min(from, upto));
    return { text: all.slice(start, upto), next: upto, done: !(job.state === 'queued' || job.state === 'running') };
  }

  async cancelJob(id: string) {
    const h = this.jobs.get(id);
    if (!h) return null;
    const j = this.tick(h);
    if (j.state === 'queued' || j.state === 'running') {
      j.state = 'cancelled';
      j.endedAt = this.now();
    }
    return structuredClone(j);
  }

  private liveRollout(service: Rollout['service']) {
    return [...this.rollouts.values()].find((r) => r.service === service && ['candidate', 'canary', 'promoting', 'paused'].includes(r.state));
  }

  async startRollout(req: RolloutRequest): Promise<Rollout> {
    if (this.liveRollout(req.service)) throw new PipelineRefusal('locked', `Another rollout to ${req.service} is still going. Finish or roll it back first.`, 409);
    const at = this.now();
    if ([...this.rollouts.values()].filter((r) => at - r.createdAt < 86_400_000).length >= this.limits.rolloutsPerDay) throw new PipelineRefusal('budget', 'The demo’s rollouts for today are used up.');
    const staging = req.service === 'staging';
    if (!staging && ![...this.rollouts.values()].some((r) => r.ticket === req.ticket && r.service === 'staging' && r.state === 'complete')) {
      throw new PipelineRefusal('invalid', 'Roll out to staging first and let it pass.', 409);
    }
    this.rolloutCount += 1;
    const previous = [...this.rollouts.values()].filter((r) => r.service === req.service && r.state === 'complete').at(-1)?.revision ?? `${req.service === 'staging' ? 'northwind-portal-staging' : 'northwind-portal'}-baseline`;
    const rollout: Rollout = {
      id: `ro-${at.toString(36)}-${randomBytes(3).toString('hex')}`,
      ticket: req.ticket, service: req.service, image: req.imageDigest,
      revision: `${req.service === 'staging' ? 'northwind-portal-staging' : 'northwind-portal'}-${String(this.rolloutCount).padStart(5, '0')}`,
      previous, plan: req.plan, step: -1, trafficPct: staging ? 100 : 0,
      state: 'candidate', checks: [], startedBy: req.startedBy, createdAt: at, updatedAt: at,
    };
    if (staging) {
      // Staging takes all its traffic at once and runs the vetted smoke suite against the tagged revision.
      rollout.checks.push({ at, percent: 100, requests: 40, errorRate: 0, p95Ms: 180, byRevision: { [rollout.revision]: { requests: 40, errors: 0, p95Ms: 180 } }, ok: true });
      rollout.state = 'complete';
    }
    this.rollouts.set(rollout.id, rollout);
    return structuredClone(rollout);
  }

  async stepRollout(id: string, by: { id: string; name: string }): Promise<Rollout> {
    const r = this.rollouts.get(id);
    if (!r) throw new PipelineRefusal('not_found', 'That rollout is not here.', 404);
    if (r.service !== 'production' || !['candidate', 'canary'].includes(r.state)) throw new PipelineRefusal('invalid', 'This rollout is not waiting for a step.', 409);
    const at = this.now();
    const percent = r.plan[r.step + 1];
    const bad = [...this.filesByDigest.values()].some((files) => files.some((f) => f.op === 'write' && f.content.includes(FAKE_5XX))) && this.badDigest(r);
    const requests = 200;
    const errors = bad && percent > 0 ? Math.round(requests * (percent / 100) * 0.4) : 0;
    const share = Math.max(1, Math.round(requests * (percent / 100)));
    const check: RolloutCheck = {
      at, percent, requests, errorRate: bad ? errors / share : 0, p95Ms: bad ? 950 : 210,
      byRevision: { [r.revision]: { requests: share, errors, p95Ms: bad ? 950 : 210 }, ...(r.previous ? { [r.previous]: { requests: requests - share, errors: 0, p95Ms: 190 } } : {}) },
      ok: !bad,
      ...(bad ? { reason: 'The new revision answered with errors under load.' } : {}),
    };
    r.checks.push(check);
    r.updatedAt = at;
    if (!check.ok) {
      r.state = 'rolled_back';
      r.trafficPct = 0;
    } else {
      r.step += 1;
      r.trafficPct = percent;
      r.state = percent >= 100 ? 'complete' : 'canary';
      if (r.state === 'complete') this.advanceTrunk(r);
    }
    void by;
    return structuredClone(r);
  }

  /** Whether the change set this rollout ships carries the 5xx marker (the rollout knows its image; the image knows its digest). */
  private badDigest(r: Rollout): boolean {
    for (const h of this.jobs.values()) if (h.job.imageDigest === r.image) return (this.filesByDigest.get(h.job.inputDigest) ?? []).some((f) => f.op === 'write' && f.content.includes(FAKE_5XX));
    return false;
  }

  /** A completed production rollout moves the trunk: its files become the new baseline and the revision goes up. */
  private advanceTrunk(r: Rollout) {
    for (const h of this.jobs.values()) {
      if (h.job.imageDigest !== r.image) continue;
      for (const f of this.filesByDigest.get(h.job.inputDigest) ?? []) {
        if (f.op === 'write') this.files.set(f.path, f.content);
        else this.files.delete(f.path);
      }
      this.revision += 1;
      return;
    }
  }

  async rollback(id: string, _by: { id: string; name: string }): Promise<Rollout> {
    const r = this.rollouts.get(id);
    if (!r) throw new PipelineRefusal('not_found', 'That rollout is not here.', 404);
    if (!['candidate', 'canary', 'paused', 'complete'].includes(r.state)) throw new PipelineRefusal('invalid', 'This rollout is already rolled back.', 409);
    r.state = 'rolled_back';
    r.trafficPct = 0;
    r.updatedAt = this.now();
    return structuredClone(r);
  }

  async getRollout(id: string) {
    const r = this.rollouts.get(id);
    return r ? structuredClone(r) : null;
  }

  async listRollouts(ticket?: string) {
    return [...this.rollouts.values()].filter((r) => !ticket || r.ticket === ticket).sort((a, b) => a.createdAt - b.createdAt).map((r) => structuredClone(r));
  }

  async status(uid: string): Promise<PipelineStatus> {
    const at = this.now();
    const today = this.spent.filter((s) => at - s.at < 86_400_000);
    const hour = today.filter((s) => s.uid === uid && at - s.at < 3_600_000);
    return {
      enabled: true, killSwitch: false,
      jobsLeftToday: Math.max(0, this.limits.jobsPerDay - today.length),
      jobsLeftThisHour: Math.max(0, this.limits.jobsPerGuestHour - hour.length),
      concurrent: this.concurrent(), maxConcurrent: this.limits.maxConcurrent,
      rolloutsLeftToday: Math.max(0, this.limits.rolloutsPerDay - [...this.rollouts.values()].filter((r) => at - r.createdAt < 86_400_000).length),
      scansLeftToday: Math.max(0, this.limits.scansPerDay - today.filter((s) => s.kind === 'scan').length),
    };
  }

  async reset() {
    this.jobs.clear();
    this.rollouts.clear();
    this.filesByDigest.clear();
    this.spent = [];
    this.rolloutCount = 0;
    this.loadBaseline();
  }
}
