import type { Hono } from 'hono';
import { AuthzError, isTokenProblem } from '../auth.ts';
import type { Authenticator } from '../auth.ts';
import { CollabError } from '../collab.ts';
import { RequestError } from '../http.ts';
import type { Env, Limit } from '../http.ts';
import { log } from '../log.ts';
import { KeyedBuckets } from '../ratelimit.ts';
import { isStage, parseDecision, parsePolicy } from '../shared/pipeline/protocol.ts';
import { ENVIRONMENTS, JOB_KINDS } from '../shared/pipeline/types.ts';
import type { Environment, JobKind } from '../shared/pipeline/types.ts';
import type { Actor, Pipeline } from './service.ts';
import { PipelineError } from './service.ts';

export interface PipelineRouteDeps {
  auth: Authenticator;
  pipeline: Pipeline;
  /** Budgets: requests per address (before anyone is looked up) and changes per person. Tests loosen them. */
  limits?: { ip?: Limit; writes?: Limit };
}

const id = (v: string | undefined) => (typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(v) ? v : null);

/**
 * The delivery pipeline's doors for the web app: artifacts to read and decide, the gate and Approve & advance, the jobs a person
 * starts and the logs they read, rollouts, the audit trail and the thresholds. Same bearer token as the rest; what each person may
 * do is decided inside `Pipeline`, so every window sees the same answer.
 */
export function registerPipelineRoutes(app: Hono<Env>, { auth, pipeline, limits }: PipelineRouteDeps) {
  const byIp = new KeyedBuckets(...(limits?.ip ?? [240, 4]));
  const writes = new KeyedBuckets(...(limits?.writes ?? [60, 0.5]));

  async function actor(c: { req: { header(name: string): string | undefined }; env: Env['Bindings'] }): Promise<Actor> {
    if (!byIp.take(c.env.ip || 'unknown')) throw new RequestError('rate_limited', 'Too many requests. Try again in a moment.', 403);
    const bearer = /^Bearer (.+)$/i.exec(c.req.header('authorization') ?? '')?.[1];
    if (!bearer) throw new AuthzError('unauthorized', 'Sign in first.');
    let identity;
    try {
      identity = await auth.verify(bearer);
    } catch (e) {
      if (!isTokenProblem(e)) throw new RequestError('unavailable', 'The team server couldn’t check your sign-in just now. Try again in a moment.', 503);
      throw new AuthzError('unauthorized', 'Sign-in failed.');
    }
    return { uid: identity.uid, name: identity.name ?? 'Guest', role: identity.role };
  }

  async function changer(c: Parameters<typeof actor>[0]): Promise<Actor> {
    const who = await actor(c);
    if (!writes.take(who.uid)) throw new RequestError('rate_limited', 'Too many changes. Try again in a minute.');
    return who;
  }

  const answer = (c: { json(body: unknown, status?: number): Response }, e: unknown) => {
    if (e instanceof PipelineError) return c.json({ error: e.code, message: e.message }, e.status);
    if (e instanceof CollabError) return c.json({ error: e.code, message: e.message }, e.status);
    if (e instanceof RequestError) return c.json({ error: e.code, message: e.message }, e.code === 'rate_limited' ? 429 : e.status);
    if (e instanceof AuthzError) return c.json({ error: e.code, message: e.message }, 401);
    log.error('pipeline request failed', { err: String(e) });
    return c.json({ error: 'unavailable', message: 'The pipeline couldn’t do that just now. Try again in a moment.' }, 503);
  };

  app.get('/pipeline/status', async (c) => {
    try {
      const who = await actor(c);
      return c.json(await pipeline.status(who.uid));
    } catch (e) {
      return answer(c, e);
    }
  });

  app.put('/pipeline/policy', async (c) => {
    try {
      const who = await changer(c);
      if (who.role !== 'owner' && who.role !== 'admin') throw new PipelineError('forbidden', 'Only an owner or an admin changes the thresholds.', 403);
      const policy = parsePolicy(await c.req.json().catch(() => null));
      if (!policy) throw new PipelineError('bad_policy', 'One of those thresholds is out of range. Nothing was changed.');
      pipeline.setPolicy(policy);
      await pipeline.audit(who, 'policy.change', `${who.name} changed the pipeline thresholds`);
      return c.json({ policy });
    } catch (e) {
      return answer(c, e);
    }
  });

  /* ───────────── the trunk ───────────── */

  app.get('/pipeline/repo', async (c) => {
    try {
      await actor(c);
      return c.json(await pipeline.driver.repo());
    } catch (e) {
      return answer(c, e);
    }
  });

  app.get('/pipeline/repo/file', async (c) => {
    try {
      await actor(c);
      const path = c.req.query('path') ?? '';
      if (!path.startsWith('sample-app/') || path.includes('..')) throw new PipelineError('bad_path', 'That path is not part of the sample app.');
      const content = await pipeline.driver.readFile(path);
      if (content === null) throw new PipelineError('not_found', 'That file is not on main.', 404);
      return c.json({ path, content });
    } catch (e) {
      return answer(c, e);
    }
  });

  /* ───────────── artifacts ───────────── */

  app.get('/artifacts', async (c) => {
    try {
      await actor(c);
      const ticket = c.req.query('ticket');
      return c.json({ artifacts: await pipeline.artifacts(ticket && id(ticket) ? ticket : undefined) });
    } catch (e) {
      return answer(c, e);
    }
  });

  app.get('/artifacts/:id', async (c) => {
    try {
      await actor(c);
      return c.json({ artifact: await pipeline.artifact(c.req.param('id')) });
    } catch (e) {
      return answer(c, e);
    }
  });

  app.post('/artifacts/:id/decide', async (c) => {
    try {
      const who = await changer(c);
      const decision = parseDecision(await c.req.json().catch(() => null));
      if (!decision) throw new PipelineError('bad_decision', 'Say accepted or rejected.');
      return c.json({ artifact: await pipeline.decide(c.req.param('id'), who, decision) });
    } catch (e) {
      return answer(c, e);
    }
  });

  /* ───────────── tickets: gate and stage ───────────── */

  app.get('/tickets/:id/gate', async (c) => {
    try {
      const who = await actor(c);
      return c.json(await pipeline.gate(c.req.param('id'), who));
    } catch (e) {
      return answer(c, e);
    }
  });

  app.post('/tickets/:id/advance', async (c) => {
    try {
      const who = await changer(c);
      const body = (await c.req.json().catch(() => null)) as { to?: unknown } | null;
      if (!isStage(body?.to)) throw new PipelineError('bad_stage', 'That is not a stage.');
      const issue = await pipeline.advance(c.req.param('id'), who, body.to);
      return c.json({ issue, ...(await pipeline.gate(issue.id, who)) });
    } catch (e) {
      return answer(c, e);
    }
  });

  app.post('/tickets/:id/design/no-ui', async (c) => {
    try {
      const who = await changer(c);
      return c.json({ artifact: await pipeline.acceptNoUi(c.req.param('id'), who) }, 201);
    } catch (e) {
      return answer(c, e);
    }
  });

  /* ───────────── jobs ───────────── */

  app.get('/pipeline/jobs', async (c) => {
    try {
      await actor(c);
      const ticket = c.req.query('ticket');
      return c.json({ jobs: await pipeline.jobs(ticket && id(ticket) ? ticket : undefined) });
    } catch (e) {
      return answer(c, e);
    }
  });

  app.post('/pipeline/jobs', async (c) => {
    try {
      const who = await changer(c);
      const body = (await c.req.json().catch(() => null)) as { ticket?: unknown; kind?: unknown } | null;
      const kind = body?.kind;
      if (typeof body?.ticket !== 'string' || !id(body.ticket) || typeof kind !== 'string' || !(JOB_KINDS as readonly string[]).includes(kind)) throw new PipelineError('bad_job', 'Say which ticket and which kind of job.');
      return c.json({ job: await pipeline.startJob(body.ticket, who, kind as JobKind) }, 201);
    } catch (e) {
      return answer(c, e);
    }
  });

  app.get('/pipeline/jobs/:id', async (c) => {
    try {
      await actor(c);
      return c.json({ job: await pipeline.job(c.req.param('id')) });
    } catch (e) {
      return answer(c, e);
    }
  });

  app.get('/pipeline/jobs/:id/log', async (c) => {
    try {
      await actor(c);
      const from = Math.max(0, Math.floor(Number(c.req.query('from') ?? 0)) || 0);
      return c.json(await pipeline.jobLog(c.req.param('id'), from));
    } catch (e) {
      return answer(c, e);
    }
  });

  app.post('/pipeline/jobs/:id/cancel', async (c) => {
    try {
      const who = await changer(c);
      return c.json({ job: await pipeline.cancelJob(c.req.param('id'), who) });
    } catch (e) {
      return answer(c, e);
    }
  });

  /* ───────────── rollouts ───────────── */

  app.get('/pipeline/rollouts', async (c) => {
    try {
      await actor(c);
      const ticket = c.req.query('ticket');
      return c.json({ rollouts: await pipeline.rollouts(ticket && id(ticket) ? ticket : undefined) });
    } catch (e) {
      return answer(c, e);
    }
  });

  app.post('/pipeline/rollouts', async (c) => {
    try {
      const who = await changer(c);
      const body = (await c.req.json().catch(() => null)) as { ticket?: unknown; service?: unknown } | null;
      const service = body?.service;
      if (typeof body?.ticket !== 'string' || !id(body.ticket) || typeof service !== 'string' || !(ENVIRONMENTS as readonly string[]).includes(service)) throw new PipelineError('bad_rollout', 'Say which ticket and which environment.');
      return c.json({ rollout: await pipeline.startRollout(body.ticket, who, service as Environment) }, 201);
    } catch (e) {
      return answer(c, e);
    }
  });

  app.post('/pipeline/rollouts/:id/step', async (c) => {
    try {
      const who = await changer(c);
      return c.json({ rollout: await pipeline.stepRollout(c.req.param('id'), who) });
    } catch (e) {
      return answer(c, e);
    }
  });

  app.post('/pipeline/rollouts/:id/rollback', async (c) => {
    try {
      const who = await changer(c);
      return c.json({ rollout: await pipeline.rollback(c.req.param('id'), who) });
    } catch (e) {
      return answer(c, e);
    }
  });

  /* ───────────── audit ───────────── */

  app.get('/pipeline/audit', async (c) => {
    try {
      await actor(c);
      return c.json({ events: await pipeline.auditTrail(Math.min(500, Math.max(1, Number(c.req.query('limit') ?? 100) || 100))) });
    } catch (e) {
      return answer(c, e);
    }
  });
}
