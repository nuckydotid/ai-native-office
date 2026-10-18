import { timingSafeEqual } from 'node:crypto';
import type { Hono } from 'hono';
import { AuthzError, isTokenProblem } from '../auth.ts';
import type { Authenticator, GuestAuthenticator } from '../auth.ts';
import { parseAgentDef } from '../ai/agents.ts';
import type { AiServices } from '../ai/services.ts';
import type { Collab } from '../collab.ts';
import { CollabError } from '../collab.ts';
import type { Config } from '../config.ts';
import { RequestError } from '../http.ts';
import type { Env } from '../http.ts';
import { log } from '../log.ts';
import type { Office } from '../office.ts';
import { KeyedBuckets } from '../ratelimit.ts';
import { OFFICE_ID } from '../store.ts';
import { AI_LIMITS } from '../shared/ai/types.ts';
import type { RunFinal, RunRequest } from '../shared/ai/types.ts';
import { cleanAgentText, isMapId, sanitizeText } from '../shared/workspace/protocol.ts';
import type { WorkspaceRole } from '../shared/workspace/types.ts';
import type { Demo } from './demo.ts';
import type { Pipeline } from '../pipeline/service.ts';
import type { RunKind } from '../shared/ai/types.ts';

export interface DemoRouteDeps {
  cfg: Config;
  auth: Authenticator;
  guest: GuestAuthenticator | null;
  office: Office;
  collab: Collab;
  ai: AiServices | null;
  demo: Demo | null;
  /** The delivery pipeline, when it is on: its stage buttons start the agents through `/ai/artifact`. */
  pipeline?: Pipeline | null;
}

const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const IMPORT_MIMES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'text/plain', 'text/markdown'];

const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * The hosted demo's own doors: a guest token for anyone, the run budget, the nightly reset, the scripted standup, and the buttons
 * that start an agent (end a meeting, import a file). `/agents` is the roster the Agents page reads and edits.
 */
export function registerDemoRoutes(app: Hono<Env>, { cfg, auth, guest, office, collab, ai, demo, pipeline }: DemoRouteDeps) {
  const guestByIp = new KeyedBuckets(10, 0.1);
  const byIp = new KeyedBuckets(240, 4);
  const writes = new KeyedBuckets(30, 0.5);

  async function actor(c: { req: { header(name: string): string | undefined }; env: Env['Bindings'] }): Promise<{ uid: string; name: string; role: WorkspaceRole }> {
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

  const answer = (c: { json(body: unknown, status?: number): Response }, e: unknown) => {
    if (e instanceof CollabError) return c.json({ error: e.code, message: e.message }, e.status);
    if (e instanceof RequestError) return c.json({ error: e.code, message: e.message }, e.code === 'rate_limited' ? 429 : e.status);
    if (e instanceof AuthzError) return c.json({ error: e.code, message: e.message }, 401);
    log.error('demo request failed', { err: String(e) });
    return c.json({ error: 'unavailable', message: 'The team server couldn’t do that just now. Try again in a moment.' }, 503);
  };

  /* ───────────── guests, budget, reset ───────────── */

  app.post('/demo/guest', async (c) => {
    if (!guest) return c.json({ error: 'not_found' }, 404);
    if (!guestByIp.take(c.env.ip || 'unknown')) return c.json({ error: 'rate_limited', message: 'Too many new guests from here. Try again in a minute.' }, 429);
    const body = (await c.req.json().catch(() => null)) as { name?: unknown } | null;
    const name = typeof body?.name === 'string' ? sanitizeText(body.name, 32) : '';
    return c.json(await guest.issue(name || 'Guest'), 201);
  });

  app.get('/demo/status', async (c) => {
    try {
      const who = await actor(c);
      return c.json({ synthetic: true, ...(ai ? ai.budget.status(who.uid) : { runsLeft: 0, runsPerHour: 0, resetsAt: '' }), agents: ai ? ai.agents.list().length : 0 });
    } catch (e) {
      return answer(c, e);
    }
  });

  app.post('/demo/reset', async (c) => {
    const given = c.req.header('x-reset-token') ?? '';
    if (!demo || !cfg.resetToken || !sameSecret(given, cfg.resetToken)) return c.json({ error: 'forbidden' }, 403);
    await demo.reset();
    return c.json({ ok: true });
  });

  app.post('/demo/sample-standup', async (c) => {
    try {
      const who = await actor(c);
      if (!demo) return c.json({ error: 'not_found' }, 404);
      if (!writes.take(who.uid)) throw new RequestError('rate_limited', 'Too many requests. Try again in a minute.');
      const body = (await c.req.json().catch(() => null)) as { room?: unknown } | null;
      const roomId = typeof body?.room === 'string' && isMapId(body.room) ? body.room : 'lobby';
      const res = await (await office.get()).replay(roomId, who.uid, demo.standupLines());
      return res.ok ? c.json({ ok: true, session: res.session }, 202) : c.json({ error: res.code, message: res.message }, res.code === 'busy' ? 409 : 400);
    } catch (e) {
      return answer(c, e);
    }
  });

  /* ───────────── the agents roster ───────────── */

  app.get('/agents', async (c) => {
    try {
      await actor(c);
      return c.json({ agents: (ai?.agents.list() ?? []).map((d) => ({ handle: d.handle, displayName: d.displayName, role: d.role, greeting: d.greeting, look: d.look, persona: d.persona, skills: d.skills })) });
    } catch (e) {
      return answer(c, e);
    }
  });

  app.put('/agents/:handle', async (c) => {
    try {
      const who = await actor(c);
      if (!ai) return c.json({ error: 'not_found' }, 404);
      if (cfg.demo && !cfg.agentEdits) throw new RequestError('forbidden', 'The agents are shared by every visitor of the demo, so their instructions are read-only here.', 403);
      if (who.role !== 'owner' && who.role !== 'admin') throw new RequestError('forbidden', 'Only the founder and admins change an agent.', 403);
      if (!writes.take(who.uid)) throw new RequestError('rate_limited', 'Too many changes. Try again in a minute.');
      const def = parseAgentDef(c.req.param('handle'), await c.req.json().catch(() => null));
      if (!def) return c.json({ error: 'bad_agent', message: 'That agent needs a name, a role, a look and instructions within the limits.' }, 400);
      ai.agents.set(def);
      return c.json({ agent: def });
    } catch (e) {
      return answer(c, e);
    }
  });

  /* ───────────── buttons that start an agent ───────────── */

  /** "End meeting": the Scribe writes the minutes of a room's conversation and proposes the tickets. */
  app.post('/ai/minutes', async (c) => {
    try {
      const who = await actor(c);
      if (!ai) return c.json({ error: 'unavailable', message: 'Agents are not set up on this server.' }, 503);
      if (!writes.take(who.uid)) throw new RequestError('rate_limited', 'Too many requests. Try again in a minute.');
      const body = (await c.req.json().catch(() => null)) as { room?: unknown; session?: unknown } | null;
      const roomId = typeof body?.room === 'string' && isMapId(body.room) ? body.room : '';
      const sessionId = typeof body?.session === 'string' && SESSION_ID.test(body.session) ? body.session : '';
      if (!roomId || !sessionId) return c.json({ error: 'bad_request', message: 'Say which room and session to write up.' }, 400);
      const room = await office.get();
      const session = room.sessions.get(sessionId);
      const me = room.members.get(who.uid);
      if (!session || session.thread || session.room !== roomId) return c.json({ error: 'not_found', message: 'That conversation is not there.' }, 404);
      if (!me) return c.json({ error: 'not_a_member', message: 'Join the office first.' }, 403);
      const started = await room.startAiRun({
        uid: who.uid, byName: me.name, handle: 'scribe', kind: 'minutes', room: roomId, session: sessionId,
        replyTo: `min-${sessionId}-${Date.now().toString(36)}`,
        question: 'Write the minutes of this conversation: the decisions, the action items with owners, the open questions and the risks. Propose tickets for the action items that are not on the board yet.',
      });
      if (!started.ok) return c.json({ error: started.code, message: started.message }, started.code === 'budget' ? 429 : started.code === 'unknown_agent' ? 404 : 409);
      return c.json({ ok: true, runId: started.runId }, 202);
    } catch (e) {
      return answer(c, e);
    }
  });

  /**
   * A stage page's "Ask the <agent>" button: the agent drafts that stage's artifact for one ticket, and the answer (with a card to accept
   * it) lands in the room's conversation like any other. Nothing is created: the draft waits for a person.
   */
  const ASKS: Record<string, { handle: string; kind: RunKind; question: string }> = {
    spec: { handle: 'planner', kind: 'spec', question: 'Write the spec for this ticket: a short user story, the acceptance criteria as a checklist, an estimate, the risks and what done looks like.' },
    design: { handle: 'designer', kind: 'design', question: 'Design the screens for this ticket: the flow, an HTML prototype, the design tokens and an accessibility checklist.' },
    change_set: { handle: 'developer', kind: 'implement', question: 'Implement this ticket as a change set: the source files and their unit tests, nothing else.' },
    tests: { handle: 'qa', kind: 'tests', question: 'Add end-to-end tests and regression coverage for this ticket to the accepted change set, and say which existing tests this change could break.' },
    release_pack: { handle: 'release', kind: 'release_pack', question: 'Prepare the release pack for this ticket: the release notes, the risk, and the readiness scorecard computed from the facts.' },
    rollout_report: { handle: 'release', kind: 'rollout_review', question: 'Write the rollout report for this ticket from the checks measured at each traffic step.' },
  };

  app.post('/ai/artifact', async (c) => {
    try {
      const who = await actor(c);
      if (!ai || !pipeline) return c.json({ error: 'unavailable', message: 'The delivery pipeline is not set up on this server.' }, 503);
      if (!writes.take(who.uid)) throw new RequestError('rate_limited', 'Too many requests. Try again in a minute.');
      const body = (await c.req.json().catch(() => null)) as { ticket?: unknown; ask?: unknown; room?: unknown; session?: unknown; note?: unknown } | null;
      const ask = typeof body?.ask === 'string' ? ASKS[body.ask] : undefined;
      const ticket = typeof body?.ticket === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(body.ticket) ? body.ticket : '';
      const roomId = typeof body?.room === 'string' && isMapId(body.room) ? body.room : '';
      let sessionId = typeof body?.session === 'string' && SESSION_ID.test(body.session) ? body.session : '';
      if (!ask || !ticket || !roomId || (body?.session !== undefined && !sessionId)) return c.json({ error: 'bad_request', message: 'Say which ticket, what to draft, and which room to answer in.' }, 400);
      const held = await pipeline.ticketContext(ticket);
      if (!held) return c.json({ error: 'not_found', message: 'That ticket is not in the delivery pipeline.' }, 404);
      const room = await office.get();
      const me = room.members.get(who.uid);
      if (!me) return c.json({ error: 'not_a_member', message: 'Join the office first.' }, 403);
      // No conversation named: the room's own, started now when it has none (a room nobody has spoken in yet has no conversation).
      if (!sessionId) {
        const open = await room.openSession(roomId, who.uid);
        if (!open) return c.json({ error: 'no_session', message: 'This room’s chat is closed. The owner can start a new session.' }, 409);
        sessionId = open.id;
      }
      const session = room.sessions.get(sessionId);
      if (!session || session.thread || session.room !== roomId) return c.json({ error: 'not_found', message: 'That conversation is not there.' }, 404);
      const note = typeof body?.note === 'string' ? sanitizeText(body.note, 300) : '';
      const started = await room.startAiRun({
        uid: who.uid, byName: me.name, handle: ask.handle, kind: ask.kind, room: roomId, session: sessionId, ticket: held.ticket.id,
        replyTo: `art-${held.ticket.key}-${Date.now().toString(36)}`,
        question: `${ask.question} The ticket is #${held.ticket.key}: ${held.ticket.title}.${note ? ` The person adds: ${note}` : ''}`,
      });
      if (!started.ok) return c.json({ error: started.code, message: started.message }, started.code === 'budget' ? 429 : started.code === 'unknown_agent' ? 404 : 409);
      return c.json({ ok: true, runId: started.runId }, 202);
    } catch (e) {
      return answer(c, e);
    }
  });

  /** "Import with AI": a PDF or a picture becomes a Docs page. The request waits for it (a minute at most). */
  app.post('/ai/import', async (c) => {
    try {
      const who = await actor(c);
      if (!ai) return c.json({ error: 'unavailable', message: 'Agents are not set up on this server.' }, 503);
      if (!writes.take(who.uid)) throw new RequestError('rate_limited', 'Too many requests. Try again in a minute.');
      if (Number(c.req.header('content-length') ?? 0) > Math.ceil((AI_LIMITS.importBytes * 4) / 3) + 4096) return c.json({ error: 'too_big', message: 'That file is too big. The limit is 4 MB.' }, 413);
      const body = (await c.req.json().catch(() => null)) as { name?: unknown; mime?: unknown; dataBase64?: unknown; parent?: unknown } | null;
      const name = typeof body?.name === 'string' ? sanitizeText(body.name, 120) : '';
      const mime = typeof body?.mime === 'string' ? body.mime : '';
      const data = typeof body?.dataBase64 === 'string' ? body.dataBase64 : '';
      if (!name || !IMPORT_MIMES.includes(mime) || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return c.json({ error: 'bad_request', message: 'Send a PDF, a picture or a text file with its name.' }, 400);
      if (Buffer.byteLength(data, 'base64') > AI_LIMITS.importBytes) return c.json({ error: 'too_big', message: 'That file is too big. The limit is 4 MB.' }, 413);
      const parent = typeof body?.parent === 'string' && SESSION_ID.test(body.parent) ? body.parent : null;
      const def = ai.agents.get('importer');
      if (!def) return c.json({ error: 'unknown_agent', message: 'There is no importer agent here.' }, 404);
      const spent = ai.budget.take(who.uid);
      if (!spent.ok) return c.json({ error: 'budget', message: 'The demo’s AI budget is used up for now. It comes back soon.' }, 429);

      const req: RunRequest = {
        runId: `imp-${Date.now().toString(36)}`, kind: 'import',
        agent: { handle: def.handle, displayName: def.displayName, role: def.role, persona: def.persona, skills: def.skills },
        asker: { uid: who.uid, name: who.name }, room: 'lobby',
        question: `Turn the attached file "${name}" into a clean Docs page in Markdown. Keep every figure exactly as printed.`,
        history: [], context: await ai.context(), attachments: [{ name, mime, dataBase64: data }], webBase: ai.webBase,
      };
      let final: RunFinal | null = null;
      let failed = false;
      await ai.client.run(req, (ev) => { if (ev.event === 'final') final = ev.data; else if (ev.event === 'error') failed = true; }, AbortSignal.timeout(90_000)).catch(() => { failed = true; });
      const done = final as RunFinal | null;
      if (failed || !done) {
        ai.budget.refund(who.uid);
        return c.json({ error: 'ai_unavailable', message: 'The importer could not read that file just now. Try again in a moment.' }, 502);
      }
      const card = done.cards.find((x) => x.kind === 'proposal');
      const item = card?.kind === 'proposal' ? card.items.find((i) => i.type === 'doc') : undefined;
      const page = await collab.createPage(OFFICE_ID, who.uid, {
        title: item?.title || name.replace(/\.[A-Za-z0-9]{1,5}$/, ''),
        body: item?.body || cleanAgentText(done.text) || 'The importer found nothing to write down.',
        ...(parent ? { parent } : {}),
      });
      return c.json({ pageId: page.id, title: page.title }, 201);
    } catch (e) {
      return answer(c, e);
    }
  });
}
