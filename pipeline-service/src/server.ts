import { Hono } from 'hono';
import type { CallerVerifier } from './auth.ts';
import type { PipelineConfig } from './config.ts';
import type { Budget } from './budget.ts';
import { ServiceError, isServiceError } from './errors.ts';
import { serviceTraffic, serviceUrl } from './google.ts';
import type { JobService } from './jobs.ts';
import type { Locks } from './locks.ts';
import type { RolloutService, RolloutThresholds } from './rollouts.ts';
import type { RolloutDriver } from './rollouts.ts';
import type { SourceStore } from './source.ts';
import type { StateStore } from './store.ts';
import { ENVIRONMENTS, JOB_KINDS } from './shared/pipeline/types.ts';
import type { Environment, JobKind } from './shared/pipeline/types.ts';

export interface PipelineServices {
  cfg: PipelineConfig;
  store: StateStore;
  source: SourceStore;
  budget: Budget;
  jobs: JobService;
  rollouts: RolloutService;
  locks: Locks;
  run: RolloutDriver;
  verifier: CallerVerifier;
}

const idOf = (value: string | undefined): string | null => (typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(value) ? value : null);

const thresholdsFrom = (body: Record<string, unknown>): RolloutThresholds => ({
  errorRateMax: typeof body.errorRateMax === 'number' && body.errorRateMax >= 0 && body.errorRateMax <= 1 ? body.errorRateMax : 0.01,
  p95MsMax: typeof body.p95MsMax === 'number' && body.p95MsMax >= 50 ? Math.round(body.p95MsMax) : 800,
  scanRequired: body.scanRequired !== false,
  scanMaxSeverity: typeof body.scanMaxSeverity === 'string' ? (body.scanMaxSeverity.toUpperCase() as RolloutThresholds['scanMaxSeverity']) : 'MEDIUM',
});

/** The pipeline service's doors. Everything under `/v1` is behind an ID token; `/healthz` is open for Cloud Run. */
export function createServer(services: PipelineServices) {
  const app = new Hono();

  // `/healthz` is reserved by Google's front end for Cloud Run; the health door is `/health`.
  app.get('/health', (c) => c.json({ ok: true, service: 'studio-pipeline', driver: services.cfg.driver, enabled: services.cfg.enabled }));

  app.use('/v1/*', async (c, next) => {
    if (!(await services.verifier.verify(c.req.header('authorization')))) return c.json({ error: 'unauthorized', message: 'Sign-in is required.' }, 401);
    await next();
  });

  const answer = (c: { json: (body: unknown, status?: number) => Response }, e: unknown) => {
    if (isServiceError(e)) return c.json({ error: e.code, message: e.message }, e.status);
    console.error('pipeline request failed', e);
    return c.json({ error: 'unavailable', message: 'The pipeline could not do that just now. Try again in a moment.' }, 503);
  };

  /* ───────────── the trunk ───────────── */

  app.get('/v1/repo', async (c) => {
    try {
      const [rev, files] = await Promise.all([services.source.rev(), services.source.repo()]);
      return c.json({ rev: `main@${rev}`, files });
    } catch (e) {
      return answer(c, e);
    }
  });

  app.get('/v1/repo/file', async (c) => {
    try {
      const path = c.req.query('path') ?? '';
      if (!path.startsWith('sample-app/') || path.includes('..')) throw new ServiceError('invalid', 'That path is not part of the sample app.', 400);
      const content = await services.source.read(path);
      if (content === null) throw new ServiceError('not_found', 'That file is not on main.', 404);
      return c.json({ path, content });
    } catch (e) {
      return answer(c, e);
    }
  });

  /* ───────────── jobs ───────────── */

  app.post('/v1/jobs', async (c) => {
    try {
      const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
      const ticket = typeof body?.ticket === 'string' ? idOf(body.ticket) : null;
      const kind = typeof body?.kind === 'string' && (JOB_KINDS as readonly string[]).includes(body.kind) ? (body.kind as JobKind) : null;
      const inputDigest = typeof body?.inputDigest === 'string' ? body.inputDigest : '';
      const startedBy = body?.startedBy as { id?: unknown; name?: unknown } | undefined;
      if (!ticket || !kind || !startedBy || typeof startedBy.id !== 'string' || typeof startedBy.name !== 'string') throw new ServiceError('invalid', 'Say which ticket, which kind of job, and who started it.', 400);
      const job = await services.jobs.start({
        ticket,
        ticketKey: typeof body?.ticketKey === 'number' ? body.ticketKey : 0,
        kind,
        inputDigest,
        files: body?.files,
        startedBy: { id: startedBy.id.slice(0, 100), name: startedBy.name.slice(0, 100) },
        ...(body?.approval && typeof body.approval === 'object' ? { approval: body.approval as { by: string; at: number; digest: string } } : {}),
      });
      return c.json({ job }, 201);
    } catch (e) {
      return answer(c, e);
    }
  });

  app.get('/v1/jobs', async (c) => {
    try {
      const ticket = c.req.query('ticket');
      return c.json({ jobs: await services.jobs.list(ticket ? idOf(ticket) ?? undefined : undefined) });
    } catch (e) {
      return answer(c, e);
    }
  });

  app.get('/v1/jobs/:id', async (c) => {
    try {
      const job = await services.jobs.get(c.req.param('id'));
      if (!job) throw new ServiceError('not_found', 'That job is not here.', 404);
      return c.json({ job });
    } catch (e) {
      return answer(c, e);
    }
  });

  app.get('/v1/jobs/:id/log', async (c) => {
    try {
      const from = Math.max(0, Math.floor(Number(c.req.query('from') ?? 0)) || 0);
      return c.json(await services.jobs.log(c.req.param('id'), from));
    } catch (e) {
      return answer(c, e);
    }
  });

  app.post('/v1/jobs/:id/cancel', async (c) => {
    try {
      const job = await services.jobs.cancel(c.req.param('id'));
      if (!job) throw new ServiceError('not_found', 'That job is not here.', 404);
      return c.json({ job });
    } catch (e) {
      return answer(c, e);
    }
  });

  /* ───────────── rollouts ───────────── */

  app.get('/v1/rollouts', async (c) => {
    try {
      const ticket = c.req.query('ticket');
      return c.json({ rollouts: await services.rollouts.list(ticket ? idOf(ticket) ?? undefined : undefined) });
    } catch (e) {
      return answer(c, e);
    }
  });

  app.post('/v1/rollouts', async (c) => {
    try {
      const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
      const ticket = typeof body?.ticket === 'string' ? idOf(body.ticket) : null;
      const service = typeof body?.service === 'string' && (ENVIRONMENTS as readonly string[]).includes(body.service) ? (body.service as Environment) : null;
      const imageDigest = typeof body?.imageDigest === 'string' ? body.imageDigest : '';
      const inputDigest = typeof body?.inputDigest === 'string' ? body.inputDigest : '';
      const startedBy = body?.startedBy as { id?: unknown; name?: unknown } | undefined;
      if (!ticket || !service || !startedBy || typeof startedBy.id !== 'string' || typeof startedBy.name !== 'string') throw new ServiceError('invalid', 'Say which ticket, which environment, and who started it.', 400);
      const plan = Array.isArray(body?.plan) && body.plan.every((p) => Number.isInteger(p)) ? (body.plan as number[]) : [10, 50, 100];
      const rollout = await services.rollouts.start({
        ticket,
        ticketKey: typeof body?.ticketKey === 'number' ? body.ticketKey : 0,
        service,
        imageDigest,
        inputDigest,
        plan,
        thresholds: thresholdsFrom(body ?? {}),
        startedBy: { id: startedBy.id.slice(0, 100), name: startedBy.name.slice(0, 100) },
      });
      return c.json({ rollout }, 201);
    } catch (e) {
      return answer(c, e);
    }
  });

  app.get('/v1/rollouts/:id', async (c) => {
    try {
      const rollout = await services.rollouts.reconcile(c.req.param('id'));
      if (!rollout) throw new ServiceError('not_found', 'That rollout is not here.', 404);
      return c.json({ rollout });
    } catch (e) {
      return answer(c, e);
    }
  });

  app.post('/v1/rollouts/:id/step', async (c) => {
    try {
      const body = (await c.req.json().catch(() => null)) as { by?: { id?: string; name?: string } } | null;
      const by = { id: body?.by?.id ?? 'unknown', name: body?.by?.name ?? 'Someone' };
      return c.json({ rollout: await services.rollouts.step(c.req.param('id'), by) });
    } catch (e) {
      return answer(c, e);
    }
  });

  app.post('/v1/rollouts/:id/rollback', async (c) => {
    try {
      const body = (await c.req.json().catch(() => null)) as { by?: { id?: string; name?: string } } | null;
      const by = { id: body?.by?.id ?? 'unknown', name: body?.by?.name ?? 'Someone' };
      return c.json({ rollout: await services.rollouts.rollback(c.req.param('id'), by) });
    } catch (e) {
      return answer(c, e);
    }
  });

  /* ───────────── state, environments, reset ───────────── */

  app.get('/v1/status', async (c) => {
    try {
      const uid = idOf(c.req.query('uid') ?? '') ?? 'unknown';
      const [budget, active, killSwitch] = await Promise.all([services.budget.status(uid), services.jobs.activeCount(), services.budget.isKilled()]);
      return c.json({
        enabled: services.cfg.enabled,
        killSwitch,
        concurrent: active,
        maxConcurrent: services.cfg.limits.maxConcurrent,
        ...budget,
      });
    } catch (e) {
      return answer(c, e);
    }
  });

  app.get('/v1/environments', async (c) => {
    try {
      const environments = [];
      for (const name of ENVIRONMENTS) {
        const service = await services.run.service(name).catch(() => null);
        environments.push({
          name,
          url: service ? serviceUrl(service) : '',
          latestRevision: service?.latestReadyRevision ?? service?.status?.latestReadyRevision ?? '',
          traffic: (service ? serviceTraffic(service) : []).map((t) => ({ revision: t.revision ?? '', percent: t.percent ?? 0, tag: t.tag, url: t.url })),
        });
      }
      return c.json({ environments });
    } catch (e) {
      return answer(c, e);
    }
  });

  app.post('/v1/reset', async (c) => {
    try {
      await services.rollouts.reset();
      await services.jobs.reset();
      await services.budget.reset();
      await services.locks.clear();
      await services.source.reset();
      return c.json({ ok: true });
    } catch (e) {
      return answer(c, e);
    }
  });

  /* ───────────── Pub/Sub push ───────────── */

  const pubsubData = (body: unknown): Record<string, unknown> | null => {
    const message = (body as { message?: { data?: string } })?.message;
    if (!message?.data) return null;
    try {
      return JSON.parse(Buffer.from(message.data, 'base64').toString('utf8')) as Record<string, unknown>;
    } catch {
      return null;
    }
  };

  app.post('/v1/events/build', async (c) => {
    try {
      const event = pubsubData(await c.req.json().catch(() => null));
      const buildId = typeof event?.id === 'string' ? event.id : '';
      if (buildId) await services.jobs.reconcileByBuildId(buildId);
      return c.body(null, 204);
    } catch (e) {
      // Pub/Sub retries a non-2xx; a failed read is retried, a bad event is acknowledged.
      console.error('build event failed', e);
      return c.body(null, 204);
    }
  });

  app.post('/v1/events/budget', async (c) => {
    try {
      const event = pubsubData(await c.req.json().catch(() => null));
      const cost = Number(event?.costAmount ?? 0);
      const budget = Number(event?.budgetAmount ?? 0);
      if (budget > 0 && cost / budget >= 0.8) {
        await services.budget.setKillSwitch(true);
        console.warn(`the budget alert reached ${Math.round((cost / budget) * 100)}%: the kill switch is on`);
      }
      return c.body(null, 204);
    } catch (e) {
      console.error('budget event failed', e);
      return c.body(null, 204);
    }
  });

  return app;
}
