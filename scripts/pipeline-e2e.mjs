#!/usr/bin/env bun
/*
 * The real end-to-end check of the delivery engine: it starts the same jobs a stage page starts, waits for Cloud Build, then rolls the
 * release out to staging and production in steps. It talks to studio-pipeline directly, so it proves the engine; the web gates and the
 * agents are checked separately.
 *
 *   PIPELINE_URL=https://... TOKEN=<id token> bun scripts/pipeline-e2e.mjs
 * The token is an ID token for the pipeline service from an account in PIPELINE_CALLERS:
 *   TOKEN="$(gcloud auth print-identity-token --impersonate-service-account=pipeline-smoke@<project>.iam.gserviceaccount.com \
 *     --audiences="$PIPELINE_URL" --include-email)"
 */
import { createHash } from 'node:crypto';

const base = (process.env.PIPELINE_URL ?? '').replace(/\/$/, '');
const token = process.env.TOKEN ?? '';
if (!base || !token) {
  console.error('PIPELINE_URL and TOKEN are required');
  process.exit(2);
}

const ticket = process.env.TICKET ?? 'e2e-ticket';
const ticketKey = Number(process.env.TICKET_KEY ?? 9001);
// A fresh runner id per run, so the per-guest hour cap never blocks a smoke run.
const person = { id: process.env.RUNNER ?? `e2e-runner-${Date.now().toString(36)}`, name: 'E2E runner' };
const sha = (text) => createHash('sha256').update(text).digest('hex');

async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(300_000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Keep the text for the error.
  }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${json?.message ?? text.slice(0, 300)}`);
  return json;
}

const log = (...args) => console.log(...args);

async function waitJob(id, label) {
  let announced = false;
  for (let attempt = 0; attempt < 360; attempt++) {
    if (!announced) {
      const { job } = await api(`/v1/jobs/${id}`);
      if (job.google?.buildId) {
        log(`  Cloud Build: https://console.cloud.google.com/cloud-build/builds/${job.google.buildId}?project=${process.env.PROJECT_ID ?? ''}`);
        announced = true;
      }
    }
    const { job } = await api(`/v1/jobs/${id}`);
    if (job.state === 'passed') {
      log(`✓ ${label}: passed${job.summary?.coveragePct !== undefined ? ` (coverage ${job.summary.coveragePct}%)` : ''}${job.imageDigest ? ` (${job.imageDigest.slice(0, 20)}…)` : ''}`);
      return job;
    }
    if (!['queued', 'running'].includes(job.state)) {
      const { text } = await api(`/v1/jobs/${id}/log?from=0`);
      log(text.slice(-3000));
      throw new Error(`${label}: ${job.state}`);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`${label}: took too long`);
}

async function start(kind, digest, files) {
  const { job } = await api('/v1/jobs', { ticket, ticketKey, kind, inputDigest: digest, files, startedBy: person });
  log(`→ ${kind}: ${job.id}`);
  return waitJob(job.id, kind);
}

const repo = await api('/v1/repo');
log(`trunk: ${repo.rev}, ${repo.files.length} files`);

const files = [
  {
    path: 'sample-app/src/api/stock-note.ts',
    op: 'write',
    role: 'src',
    content: "export const STOCK_NOTE = 'Stock is checked every morning.';\nexport function stockNote(): string {\n  return STOCK_NOTE;\n}\n",
    baseSha: null,
  },
  {
    path: 'sample-app/tests/stock-note.test.ts',
    op: 'write',
    role: 'unit_test',
    content: "import { describe, expect, it } from 'vitest';\nimport { stockNote } from '../src/api/stock-note';\n\ndescribe('stock note', () => {\n  it('says when stock is checked', () => {\n    expect(stockNote()).toContain('morning');\n  });\n});\n",
    baseSha: null,
  },
];
const digest = process.env.INPUT_DIGEST ?? sha(JSON.stringify(files));
let imageDigest = process.env.IMAGE_DIGEST ?? '';

if (!process.env.SKIP_JOBS) {
  await start('build', digest, files);
  const unit = await start('unit', digest, files);
  const e2e = await start('e2e', digest, files);
  if ((unit.summary?.coveragePct ?? 0) < 70) throw new Error('coverage is under the policy');
  if (!e2e.summary) throw new Error('the end-to-end job reported no summary');
  const release = await start('release_build', digest, files);
  if (!release.imageDigest) throw new Error('the release build produced no image digest');
  imageDigest = release.imageDigest;
  const scan = await start('scan', digest, files);
  log(`scan: ${scan.summary?.scanSeverity ?? 'no severity'}`);
} else if (!imageDigest) {
  throw new Error('SKIP_JOBS=1 needs IMAGE_DIGEST');
}

const thresholds = { errorRateMax: 0.01, p95MsMax: 800, scanRequired: true, scanMaxSeverity: 'MEDIUM' };
const staging = (await api('/v1/rollouts', { ticket, ticketKey, service: 'staging', imageDigest, inputDigest: digest, plan: [10, 50, 100], ...thresholds, startedBy: person })).rollout;
log(`staging: ${staging.state} on ${staging.revision}`);
if (staging.state !== 'complete') throw new Error(`staging did not pass: ${JSON.stringify(staging.checks?.at(-1) ?? {})}`);

const production = (await api('/v1/rollouts', { ticket, ticketKey, service: 'production', imageDigest, inputDigest: digest, plan: [10, 50, 100], ...thresholds, startedBy: person })).rollout;
log(`production candidate: ${production.revision} (previous ${production.previous})`);
let rollout = production;
for (const expected of [10, 50, 100]) {
  rollout = (await api(`/v1/rollouts/${production.id}/step`, { by: person })).rollout;
  log(`production: ${rollout.trafficPct}% (${rollout.state})`);
  if (rollout.trafficPct !== expected) throw new Error(`expected ${expected}%, got ${rollout.trafficPct}%`);
}
if (rollout.state !== 'complete') throw new Error(`the rollout ended ${rollout.state}`);

const after = await api('/v1/repo');
log(`trunk after: ${after.rev}`);
if (after.rev === repo.rev) throw new Error('the trunk did not move');
const environments = await api('/v1/environments');
log(JSON.stringify(environments.environments, null, 1));
log('e2e ok');
