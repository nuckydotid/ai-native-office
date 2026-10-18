import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTVerifyGetKey } from 'jose';
import type { Hono } from 'hono';
import type { Collab } from '../collab.ts';
import type { Config } from '../config.ts';
import type { Env } from '../http.ts';
import type { Office } from '../office.ts';
import type { Pipeline } from '../pipeline/service.ts';
import { KeyedBuckets } from '../ratelimit.ts';
import { OFFICE_ID } from '../store.ts';
import type { Store } from '../store.ts';

const GOOGLE_JWKS = 'https://www.googleapis.com/oauth2/v3/certs';

/** Whether a request to `/internal/v1/*` comes from the agent service. */
export interface InternalVerifier {
  verify(authorization: string | undefined): Promise<boolean>;
}

/**
 * Cloud Run to Cloud Run: the agent service sends a Google ID token for this server's address, signed by its service account. The
 * route is public at the network level (so is the rest of this server), which is why the token is checked here: the right
 * audience, and the one email `INTERNAL_CALLER` names.
 */
export class GoogleInternalVerifier implements InternalVerifier {
  private callers: Set<string>;

  constructor(
    private audience: string,
    callers: string | string[],
    private jwks: JWTVerifyGetKey = createRemoteJWKSet(new URL(GOOGLE_JWKS)),
  ) {
    this.callers = new Set((Array.isArray(callers) ? callers : [callers]).map((c) => c.toLowerCase()).filter(Boolean));
    if (!audience || this.callers.size === 0) throw new Error('PUBLIC_URL and INTERNAL_CALLER are required to accept the agent service');
  }

  async verify(authorization: string | undefined): Promise<boolean> {
    const bearer = /^Bearer (.+)$/i.exec(authorization ?? '')?.[1];
    if (!bearer) return false;
    try {
      const { payload } = await jwtVerify(bearer, this.jwks, { issuer: ['https://accounts.google.com', 'accounts.google.com'], audience: this.audience });
      return payload.email_verified === true && typeof payload.email === 'string' && this.callers.has(payload.email.toLowerCase());
    } catch {
      return false;
    }
  }
}

/** Local development only (`AGENT_SERVICE_AUTH=none`, refused on Cloud Run): any caller on this machine. */
export class OpenInternalVerifier implements InternalVerifier {
  async verify(): Promise<boolean> {
    return true;
  }
}

export function createInternalVerifier(cfg: Pick<Config, 'agentServiceAuth' | 'publicUrl' | 'internalCaller' | 'pipelineCaller'>): InternalVerifier {
  return cfg.agentServiceAuth === 'none' ? new OpenInternalVerifier() : new GoogleInternalVerifier(cfg.publicUrl, [cfg.internalCaller, cfg.pipelineCaller]);
}

export interface InternalRouteDeps {
  verifier: InternalVerifier;
  collab: Collab;
  store: Store;
  office: Office;
  /** The delivery pipeline, when it is on: its artifacts, jobs and the sample app's files become readable to the agents. */
  pipeline?: Pipeline | null;
}

const matches = (q: string | undefined, ...fields: string[]) => {
  const words = (q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = fields.join('\n').toLowerCase();
  return words.every((w) => hay.includes(w));
};

/**
 * What the agent service's tools may read: tickets, pages and a room's recent conversation. Read-only; an agent proposes and a
 * person accepts, so nothing here writes.
 */
export function registerInternalRoutes(app: Hono<Env>, { verifier, collab, store, office, pipeline }: InternalRouteDeps) {
  const byCaller = new KeyedBuckets(300, 10);
  app.use('/internal/*', async (c, next) => {
    if (!byCaller.take('agent')) return c.json({ error: 'rate_limited' }, 429);
    if (!(await verifier.verify(c.req.header('authorization')))) return c.json({ error: 'unauthorized' }, 401);
    await next();
  });

  app.get('/internal/v1/tickets', async (c) => {
    const status = c.req.query('status');
    const [{ issues }, members] = await Promise.all([collab.board(OFFICE_ID), store.listMembers(OFFICE_ID)]);
    const names = new Map(members.map((m) => [m.uid, m.name]));
    const tickets = issues
      .filter((i) => (!status || i.status === status) && matches(c.req.query('q'), i.title, i.body, i.labels.join(' ')))
      .slice(0, 100)
      .map((i) => ({ key: i.key, title: i.title, body: i.body, status: i.status, priority: i.priority, assignee: i.assignee, assigneeName: i.assignee ? (names.get(i.assignee) ?? null) : null, labels: i.labels, points: i.points, pr: i.pr, docs: i.docs, updatedAt: i.updatedAt }));
    return c.json({ tickets });
  });

  app.get('/internal/v1/tickets/:key', async (c) => {
    const key = Number(c.req.param('key'));
    const [{ issues }, members] = await Promise.all([collab.board(OFFICE_ID), store.listMembers(OFFICE_ID)]);
    const i = issues.find((x) => x.key === key);
    if (!i) return c.json({ error: 'not_found' }, 404);
    const names = new Map(members.map((m) => [m.uid, m.name]));
    return c.json({ key: i.key, title: i.title, body: i.body, status: i.status, priority: i.priority, assignee: i.assignee, assigneeName: i.assignee ? (names.get(i.assignee) ?? null) : null, labels: i.labels, points: i.points, pr: i.pr, docs: i.docs, updatedAt: i.updatedAt });
  });

  app.get('/internal/v1/pages', async (c) => {
    const pages = (await collab.pages(OFFICE_ID)).filter((p) => matches(c.req.query('q'), p.title, p.body)).slice(0, 200);
    return c.json({ pages: pages.map((p) => ({ id: p.id, title: p.title, parent: p.parent, updatedAt: p.updatedAt })) });
  });

  app.get('/internal/v1/pages/:id', async (c) => {
    try {
      const p = await collab.page(OFFICE_ID, c.req.param('id'));
      return c.json({ id: p.id, title: p.title, body: p.body, parent: p.parent, updatedAt: p.updatedAt });
    } catch {
      return c.json({ error: 'not_found' }, 404);
    }
  });

  app.get('/internal/v1/messages', async (c) => {
    const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') ?? 40) || 40));
    let session = c.req.query('session');
    if (!session) session = (await office.get()).getActiveSession(c.req.query('room') ?? 'lobby')?.id;
    if (!session) return c.json({ messages: [] });
    const page = await store.listMessages(OFFICE_ID, { session, limit });
    return c.json({
      messages: page.messages.filter((m) => !m.deleted && m.text).map((m) => ({ id: m.id, from: m.from, name: m.fromName, text: m.text, at: m.at, kind: m.kind ?? 'human' })),
    });
  });

  if (!pipeline) return;

  // What the pipeline agents read: the sample app's code, what has been drafted and accepted for a ticket, and how its jobs went.
  // All of it is read-only, and none of it is trusted: the agent service quotes it as data.
  app.get('/internal/v1/repo', async (c) => c.json(await pipeline.driver.repo()));

  app.get('/internal/v1/repo/file', async (c) => {
    const path = c.req.query('path') ?? '';
    if (!path.startsWith('sample-app/') || path.includes('..')) return c.json({ error: 'bad_path' }, 400);
    const content = await pipeline.driver.readFile(path);
    return content === null ? c.json({ error: 'not_found' }, 404) : c.json({ path, content });
  });

  app.get('/internal/v1/artifacts', async (c) => {
    const ticket = c.req.query('ticket');
    if (!ticket || !/^[A-Za-z0-9_.:-]{1,200}$/.test(ticket)) return c.json({ error: 'bad_ticket' }, 400);
    const kind = c.req.query('kind');
    const list = (await pipeline.artifacts(ticket)).filter((a) => !kind || a.kind === kind);
    return c.json({ artifacts: list.map((a) => ({ id: a.id, kind: a.kind, version: a.version, state: a.state, title: a.title, digest: a.digest, by: a.by.name, createdAt: a.createdAt })) });
  });

  app.get('/internal/v1/artifacts/:id', async (c) => {
    try {
      const a = await pipeline.artifact(c.req.param('id'));
      return c.json({ id: a.id, ticket: a.ticket, kind: a.kind, version: a.version, state: a.state, title: a.title, body: a.body, digest: a.digest, files: a.files, meta: a.meta });
    } catch {
      return c.json({ error: 'not_found' }, 404);
    }
  });

  app.get('/internal/v1/jobs', async (c) => {
    const ticket = c.req.query('ticket');
    if (!ticket || !/^[A-Za-z0-9_.:-]{1,200}$/.test(ticket)) return c.json({ error: 'bad_ticket' }, 400);
    const jobs = await pipeline.jobs(ticket);
    return c.json({ jobs: jobs.map((j) => ({ id: j.id, kind: j.kind, state: j.state, inputDigest: j.inputDigest, summary: j.summary, createdAt: j.createdAt, endedAt: j.endedAt })) });
  });

  app.get('/internal/v1/jobs/:id/log', async (c) => {
    try {
      const log = await pipeline.jobLog(c.req.param('id'), 0);
      return c.json({ text: log.text.slice(-6000), done: log.done });
    } catch {
      return c.json({ error: 'not_found' }, 404);
    }
  });

  app.get('/internal/v1/rollouts', async (c) => {
    const ticket = c.req.query('ticket');
    if (!ticket || !/^[A-Za-z0-9_.:-]{1,200}$/.test(ticket)) return c.json({ error: 'bad_ticket' }, 400);
    const rollouts = await pipeline.rollouts(ticket);
    return c.json({
      rollouts: rollouts.map((r) => ({
        id: r.id,
        service: r.service,
        state: r.state,
        revision: r.revision,
        previous: r.previous,
        plan: r.plan,
        step: r.step,
        trafficPct: r.trafficPct,
        image: r.image,
        checks: r.checks,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
    });
  });

  // The pipeline service tells the web service when a job or a rollout changed: every open window reads the pipeline again.
  const ticketFrom = (body: unknown): string => {
    const parsed = body as { job?: { ticket?: string }; rollout?: { ticket?: string } } | null;
    return parsed?.job?.ticket ?? parsed?.rollout?.ticket ?? '';
  };

  app.post('/internal/v1/jobs/:id/event', async (c) => {
    const ticket = ticketFrom(await c.req.json().catch(() => null));
    if (ticket) office.current()?.broadcastSync('pipeline', [ticket]);
    return c.body(null, 204);
  });

  app.post('/internal/v1/rollouts/:id/event', async (c) => {
    const ticket = ticketFrom(await c.req.json().catch(() => null));
    if (ticket) office.current()?.broadcastSync('pipeline', [ticket]);
    return c.body(null, 204);
  });
}
