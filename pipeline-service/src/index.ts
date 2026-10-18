/** The pipeline service's entry point: reads the environment, builds the drivers, and serves `/v1/*`. */
import { AccessTokenSource, IdTokenSource, createVerifier } from './auth.ts';
import { Budget } from './budget.ts';
import { loadConfig } from './config.ts';
import { CloudBuildDriver, FakeBuildDriver } from './drivers.ts';
import { FakeRolloutDriver } from './fake-run.ts';
import { CloudRunClient, FirestoreClient, GcsClient, GoogleRest } from './google.ts';
import { JobService } from './jobs.ts';
import { Locks } from './locks.ts';
import { CloudRunRolloutDriver, RolloutService } from './rollouts.ts';
import { createServer } from './server.ts';
import type { PipelineServices } from './server.ts';
import { GoogleSourceStore, MemorySourceStore } from './source.ts';
import { FirestoreStateStore, MemoryStateStore } from './store.ts';
import type { Job, Rollout } from './shared/pipeline/types.ts';

const FAKE_BASELINE: Record<string, string> = {
  'sample-app/package.json': '{"name":"northwind-customer-portal","version":"1.0.0","scripts":{"test":"vitest run"}}',
  'sample-app/Dockerfile': 'FROM node:22 AS deps\nCOPY . .\n',
  'sample-app/src/App.tsx': "export function App() {\n  return <main>Northwind Customer Portal</main>;\n}\n",
  'sample-app/src/api/orders.ts': "export const orders = [{ id: 'o-1001', customer: 'Harbour Outfitters' }];\n",
  'sample-app/tests/orders.test.ts': "import { orders } from '../src/api/orders';\nit('has orders', () => expect(orders.length).toBeGreaterThan(0));\n",
  'sample-app/e2e/orders.spec.ts': "import { test, expect } from '@playwright/test';\ntest('lists orders', async ({ page }) => { await page.goto('/'); await expect(page.getByText('Northwind')).toBeVisible(); });\n",
  'sample-app/ci/hermetic-test.sh': '#!/usr/bin/env bash\nset -euo pipefail\n',
  'sample-app/smoke/smoke.mjs': 'console.log(JSON.stringify({ ok: true }));\n',
  'sample-app/smoke/checks.json': '{"checks":[]}\n',
};

async function main() {
  const cfg = loadConfig();
  const fake = cfg.driver === 'fake';
  const accessTokens = new AccessTokenSource(fetch, fake ? 'fake-access-token' : null);
  const idTokens = new IdTokenSource(fetch, fake ? 'fake-id-token' : null);
  const rest = new GoogleRest(accessTokens);
  const store = fake ? new MemoryStateStore() : new FirestoreStateStore(new FirestoreClient(rest, cfg.projectId, cfg.firestoreDatabase));
  const gcs = fake ? null : new GcsClient(rest, cfg.bucket);
  const source = fake ? new MemorySourceStore(FAKE_BASELINE, store) : new GoogleSourceStore(cfg.baselineDir, gcs!, store);
  const budget = new Budget(store, cfg.limits, Date.now, cfg.killSwitch);
  const locks = new Locks(store);
  const build = fake ? new FakeBuildDriver() : new CloudBuildDriver(cfg, accessTokens);
  const run = fake ? new FakeRolloutDriver() : new CloudRunRolloutDriver(cfg, new CloudRunClient(rest, cfg.projectId, cfg.region));

  const post = async (path: string, body: unknown) => {
    if (!cfg.webServiceUrl) return;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (cfg.auth === 'google') headers.authorization = `Bearer ${await idTokens.get(cfg.webServiceUrl)}`;
    const res = await fetch(`${cfg.webServiceUrl}${path}`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`the web service answered ${res.status}`);
  };

  const jobs = new JobService({
    cfg,
    store,
    source,
    budget,
    build,
    notify: async (job: Job) => post(`/internal/v1/jobs/${encodeURIComponent(job.id)}/event`, { job }),
  });
  const rollouts = new RolloutService({
    cfg,
    store,
    source,
    budget,
    jobs,
    locks,
    run,
    notify: async (rollout: Rollout) => post(`/internal/v1/rollouts/${encodeURIComponent(rollout.id)}/event`, { rollout }),
  });

  const services: PipelineServices = { cfg, store, source, budget, jobs, rollouts, locks, run, verifier: createVerifier(cfg) };
  const app = createServer(services);
  Bun.serve({ port: cfg.port, hostname: '0.0.0.0', fetch: app.fetch });
  console.log(
    `studio-pipeline listening on :${cfg.port} (driver ${cfg.driver}, auth ${cfg.auth}, project ${cfg.projectId || '(none)'}, bucket ${cfg.bucket || '(none)'})`,
  );
}

await main();
