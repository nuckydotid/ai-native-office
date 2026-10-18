import type { PipelineConfig } from '../src/config.ts';
import { Budget } from '../src/budget.ts';
import { FakeBuildDriver } from '../src/drivers.ts';
import { FakeRolloutDriver } from '../src/fake-run.ts';
import { JobService } from '../src/jobs.ts';
import { Locks } from '../src/locks.ts';
import { RolloutService } from '../src/rollouts.ts';
import { MemorySourceStore, sha256 } from '../src/source.ts';
import { MemoryStateStore } from '../src/store.ts';
import type { ChangeFile } from '../src/shared/pipeline/types.ts';

export const BASELINE: Record<string, string> = {
  'sample-app/package.json': '{"name":"northwind-customer-portal","version":"1.0.0"}\n',
  'sample-app/Dockerfile': 'FROM node:22 AS deps\n',
  'sample-app/src/App.tsx': "export function App() {\n  return <main>Northwind Customer Portal</main>;\n}\n",
  'sample-app/src/api/orders.ts': "export const orders = [{ id: 'o-1001' }];\n",
  'sample-app/tests/orders.test.ts': "it('has orders', () => expect(1).toBe(1));\n",
  'sample-app/e2e/orders.spec.ts': "test('lists', async ({ page }) => { await page.goto('/'); });\n",
  'sample-app/ci/hermetic-test.sh': '#!/usr/bin/env bash\n',
  'sample-app/smoke/smoke.mjs': 'console.log(JSON.stringify({ ok: true }));\n',
  'sample-app/smoke/checks.json': '{"checks":[]}\n',
};

export function testConfig(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    port: 0,
    driver: 'fake',
    auth: 'none',
    serviceUrl: '',
    callers: [],
    projectId: 'test',
    region: 'asia-southeast1',
    bucket: 'test-pipeline',
    firestoreDatabase: 'pipeline',
    artifactRepo: 'northwind',
    stagingService: 'northwind-portal-staging',
    prodService: 'northwind-portal',
    buildServiceAccount: '',
    runtimeServiceAccount: '',
    baselineDir: '',
    smokeScript: '',
    webServiceUrl: '',
    enabled: true,
    killSwitch: false,
    limits: { jobsPerDay: 30, jobsPerGuestHour: 6, maxConcurrent: 2, scansPerDay: 6, rolloutsPerDay: 15, exploresPerDay: 5, jobTimeoutSeconds: 600, probeRequests: 40 },
    ...overrides,
  };
}

export interface Services {
  cfg: PipelineConfig;
  store: MemoryStateStore;
  source: MemorySourceStore;
  budget: Budget;
  locks: Locks;
  build: FakeBuildDriver;
  run: FakeRolloutDriver;
  jobs: JobService;
  rollouts: RolloutService;
  advance(ms: number): void;
  clock: { value: number };
}

export function makeServices(options: {
  now?: number;
  cfg?: Partial<PipelineConfig>;
  buildMs?: number;
  scanSeverity?: 'LOW' | 'HIGH';
  probe?: (...args: unknown[]) => unknown;
  smoke?: (...args: unknown[]) => unknown;
} = {}): Services {
  const clock = { value: options.now ?? 1_800_000_000_000 };
  const now = () => clock.value;
  const cfg = testConfig(options.cfg);
  const store = new MemoryStateStore();
  const source = new MemorySourceStore(BASELINE, store);
  const budget = new Budget(store, cfg.limits, now, cfg.killSwitch);
  const locks = new Locks(store, now);
  const build = new FakeBuildDriver({ now, buildMs: options.buildMs ?? 800, scanSeverity: options.scanSeverity ?? 'LOW' });
  const run = new FakeRolloutDriver();
  const jobs = new JobService({ cfg, store, source, budget, build, now });
  const rollouts = new RolloutService({
    cfg,
    store,
    source,
    budget,
    jobs,
    locks,
    run,
    now,
    ...(options.probe ? { probeFn: options.probe as never } : {}),
    ...(options.smoke ? { smokeFn: options.smoke as never } : {}),
  });
  return { cfg, store, source, budget, locks, build, run, jobs, rollouts, clock, advance: (ms) => (clock.value += ms) };
}

export async function changeFiles(
  services: Services,
  files: { path: string; content: string; role?: ChangeFile['role'] }[],
): Promise<ChangeFile[]> {
  const repo = await services.source.repo();
  const shas = new Map(repo.map((f) => [f.path, f.sha]));
  return files.map((f) => ({
    path: f.path,
    op: 'write' as const,
    role: f.role ?? 'src',
    content: f.content,
    baseSha: shas.get(f.path) ?? null,
  }));
}

export const digestOf = (text: string) => sha256(text);

/** A valid 64-hex digest for a test change set. */
export const fakeDigest = (seed: string) => sha256(seed);

export const changeFile = (path: string, content: string, role: ChangeFile['role'] = 'src'): ChangeFile => ({ path, op: 'write', role, content, baseSha: null });
