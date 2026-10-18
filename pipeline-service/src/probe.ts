import type { RunTraffic } from './google.ts';

export interface ProbeResult {
  requests: number;
  errors: number;
  errorRate: number;
  p95Ms: number;
  byRevision: Record<string, { requests: number; errors: number; p95Ms: number }>;
}

const percentile = (values: number[], p: number): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

/**
 * Sends real requests at a service and counts what each revision answered. Cloud Run's own metrics lag one to three minutes; a rollout
 * step cannot wait for them, so the pipeline asks the service directly and reads the `x-revision` header. Monitoring corroborates it.
 */
export async function probe(
  baseUrl: string,
  options: { requests: number; concurrency?: number; timeoutMs?: number; paths?: string[]; fetchFn?: typeof fetch },
): Promise<ProbeResult> {
  const fetchFn = options.fetchFn ?? fetch;
  const paths = options.paths ?? ['/health', '/api/orders', '/'];
  const timeoutMs = options.timeoutMs ?? 3000;
  const concurrency = Math.min(options.concurrency ?? 20, options.requests);
  const results: { status: number; ms: number; revision: string }[] = [];
  let next = 0;
  const worker = async () => {
    while (next < options.requests) {
      const index = next++;
      const started = performance.now();
      try {
        const res = await fetchFn(`${baseUrl}${paths[index % paths.length]}`, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
        results.push({ status: res.status, ms: performance.now() - started, revision: res.headers.get('x-revision') ?? 'unknown' });
      } catch {
        results.push({ status: 0, ms: timeoutMs, revision: 'unknown' });
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));

  const byRevision: ProbeResult['byRevision'] = {};
  const times = new Map<string, number[]>();
  for (const result of results) {
    const entry = (byRevision[result.revision] ??= { requests: 0, errors: 0, p95Ms: 0 });
    entry.requests += 1;
    if (result.status < 200 || result.status >= 400) entry.errors += 1;
    let list = times.get(result.revision);
    if (!list) {
      list = [];
      times.set(result.revision, list);
    }
    list.push(result.ms);
  }
  for (const [revision, values] of times) byRevision[revision].p95Ms = Math.round(percentile(values, 95));
  const errors = results.filter((r) => r.status < 200 || r.status >= 400).length;
  return {
    requests: results.length,
    errors,
    errorRate: results.length ? errors / results.length : 0,
    p95Ms: Math.round(percentile(results.map((r) => r.ms), 95)),
    byRevision,
  };
}

export interface SmokeResult {
  ok: boolean;
  errors: number;
  errorRate: number;
  p95Ms: number;
  byRevision: Record<string, { requests: number; errors: number; p95Ms: number }>;
  failures: string[];
}

/**
 * Runs the vetted suite in `smoke/` against a candidate. The suite is ours and a change set cannot edit it; its JSON line is the answer.
 */
export async function runSmoke(
  script: string,
  baseUrl: string,
  env: Record<string, string> = {},
  timeoutMs = 120_000,
): Promise<SmokeResult> {
  const proc = Bun.spawn([process.execPath, script], {
    env: { ...process.env, SMOKE_BASE_URL: baseUrl, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const line = stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .pop();
  try {
    const parsed = JSON.parse(line ?? '{}') as Partial<SmokeResult>;
    return { ok: code === 0 && parsed.ok === true, errors: parsed.errors ?? 0, errorRate: parsed.errorRate ?? 0, p95Ms: parsed.p95Ms ?? 0, byRevision: parsed.byRevision ?? {}, failures: parsed.failures ?? (code === 0 ? [] : [stderr.slice(-400) || 'the smoke suite failed']) };
  } catch {
    return { ok: false, errors: 1, errorRate: 1, p95Ms: 0, byRevision: {}, failures: [`the smoke suite did not answer (exit ${code}): ${(stderr || stdout).slice(-400)}`] };
  }
}

const shortRevision = (name: string): string => name.split('/').pop() ?? name;

/** The traffic entries for a revision-pinned split: the candidate at `percent`, the rest at the previous revision.
 *  Cloud Run traffic entries name revisions by their short name (`<service>-00001-abc`), not by their full resource path. */
export function trafficSplit(revision: string, previous: string | null, percent: number, tag?: string): RunTraffic[] {
  const target = shortRevision(revision);
  const before = previous ? shortRevision(previous) : null;
  const entries: RunTraffic[] = [{ type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION', revision: target, percent, ...(tag ? { tag } : {}) }];
  if (before && before !== target && percent < 100) {
    entries.push({ type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION', revision: before, percent: 100 - percent });
  }
  return entries;
}
