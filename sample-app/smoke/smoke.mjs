#!/usr/bin/env node
/*
 * The vetted smoke suite. It is not AI-written and a change set cannot edit it: the file lives in `smoke/`, outside the three roots the
 * pipeline lets an agent write. The pipeline service runs it against a staging candidate and against each production traffic step.
 *
 *   SMOKE_BASE_URL=https://... node smoke/smoke.mjs
 *   SMOKE_BASE_URL=https://... SMOKE_LOAD=1 SMOKE_REQUESTS=200 SMOKE_CONCURRENCY=20 node smoke/smoke.mjs
 *
 * It prints one JSON line and exits 1 when anything fails. The pipeline service reads that line; a person can run it too.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const base = (process.env.SMOKE_BASE_URL ?? process.argv[2] ?? '').replace(/\/$/, '');
if (!base) {
  console.error('usage: SMOKE_BASE_URL=https://service node smoke/smoke.mjs');
  process.exit(2);
}

const checks = JSON.parse(readFileSync(resolve(import.meta.dirname, 'checks.json'), 'utf8')).checks;
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 5000);
const expectRevision = process.env.SMOKE_EXPECT_REVISION ?? '';
const load = process.env.SMOKE_LOAD === '1' || process.argv.includes('--load');
const requests = Math.max(1, Number(process.env.SMOKE_REQUESTS ?? (load ? 200 : 10)));
const concurrency = Math.max(1, Number(process.env.SMOKE_CONCURRENCY ?? 20));
const maxErrorRate = Number(process.env.SMOKE_MAX_ERROR_RATE ?? 0.01);
const maxP95Ms = Number(process.env.SMOKE_MAX_P95_MS ?? 800);

async function get(path) {
  const started = performance.now();
  const res = await fetch(`${base}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  const ms = performance.now() - started;
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Not every check is JSON.
  }
  return { status: res.status, headers: res.headers, text, json, ms };
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

const failures = [];
const revisions = new Map();
for (const check of checks) {
  try {
    const res = await get(check.path);
    if (res.status !== check.status) failures.push(`${check.path}: status ${res.status}, wanted ${check.status}`);
    if (check.contains && !res.text.includes(check.contains)) failures.push(`${check.path}: does not contain ${JSON.stringify(check.contains)}`);
    if (check.json) {
      if (res.json === null) failures.push(`${check.path}: not JSON`);
      else if (typeof check.json === 'object') {
        for (const [key, value] of Object.entries(check.json)) if (res.json[key] !== value) failures.push(`${check.path}: ${key} is ${JSON.stringify(res.json[key])}, wanted ${JSON.stringify(value)}`);
      }
    }
    const rev = res.headers.get('x-revision') ?? 'unknown';
    if (expectRevision && rev !== expectRevision) failures.push(`${check.path}: revision ${rev}, wanted ${expectRevision}`);
    revisions.set(rev, (revisions.get(rev) ?? 0) + 1);
  } catch (error) {
    failures.push(`${check.path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

let byRevision = Object.fromEntries([...revisions].map(([rev, count]) => [rev, { requests: count, errors: 0 }]));
let errors = 0;
let p95Ms = 0;

if (load) {
  const paths = ['/health', '/api/orders', '/api/orders/o-1001', '/api/summary'];
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < requests) {
      const index = next++;
      try {
        const res = await get(paths[index % paths.length]);
        results.push({ status: res.status, ms: res.ms, revision: res.headers.get('x-revision') ?? 'unknown' });
      } catch {
        results.push({ status: 0, ms: timeoutMs, revision: 'unknown' });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, requests) }, worker));
  errors = results.filter((r) => r.status < 200 || r.status >= 400).length;
  p95Ms = Math.round(percentile(results.map((r) => r.ms), 95));
  byRevision = {};
  for (const result of results) {
    const entry = (byRevision[result.revision] ??= { requests: 0, errors: 0, ms: [] });
    entry.requests += 1;
    if (result.status < 200 || result.status >= 400) entry.errors += 1;
    entry.ms.push(result.ms);
  }
  for (const entry of Object.values(byRevision)) {
    entry.p95Ms = Math.round(percentile(entry.ms, 95));
    delete entry.ms;
  }
  const rate = errors / results.length;
  if (rate > maxErrorRate) failures.push(`load: error rate ${(rate * 100).toFixed(1)}% is over ${(maxErrorRate * 100).toFixed(1)}%`);
  if (p95Ms > maxP95Ms) failures.push(`load: p95 ${p95Ms} ms is over ${maxP95Ms} ms`);
}

const result = { ok: failures.length === 0, base, requests: load ? requests : checks.length, errors, errorRate: load ? errors / requests : 0, p95Ms, byRevision, failures };
console.log(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);
