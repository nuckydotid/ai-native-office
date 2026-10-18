import type { Hono } from 'hono';
import { AuthzError, isTokenProblem } from './auth.ts';
import type { Authenticator } from './auth.ts';
import { Collab, CollabError } from './collab.ts';
import { RequestError } from './http.ts';
import type { Env, Limit } from './http.ts';
import { log } from './log.ts';
import { KeyedBuckets } from './ratelimit.ts';
import { OFFICE_ID } from './store.ts';
import type { Store } from './store.ts';
import type { WorkspaceRole } from './shared/workspace/types.ts';

export interface CollabRouteDeps {
  auth: Authenticator;
  collab: Collab;
  /** For the list of people a board offers as assignees (names only). */
  store: Store;
  /** Budgets: requests per address (before anyone is looked up) and changes per person. Tests loosen them. */
  limits?: { ip?: Limit; writes?: Limit };
}

/**
 * The collaboration routes: `/board` (issues) and `/pages` (the docs tree), for everyone who is signed in, over the same
 * bearer token as everything else. Anyone may read and write; deleting someone else's issue or page is for the author,
 * the owner and admins (`DELETE` checks the author inside `Collab`).
 */
export function registerCollabRoutes(app: Hono<Env>, { auth, collab, store, limits }: CollabRouteDeps) {
  const byIp = new KeyedBuckets(...(limits?.ip ?? [240, 4]));
  const writes = new KeyedBuckets(...(limits?.writes ?? [120, 1]));

  async function actor(c: { req: { header(name: string): string | undefined }; env: Env['Bindings'] }): Promise<{ uid: string; workspace: WorkspaceRole }> {
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
    return { uid: identity.uid, workspace: identity.role };
  }

  /** A write: signed in, on the team, inside the change budget. */
  async function changer(c: Parameters<typeof actor>[0]) {
    const who = await actor(c);
    if (!writes.take(who.uid)) throw new RequestError('rate_limited', 'Too many changes. Try again in a minute.');
    return { ...who, canModerate: who.workspace === 'owner' || who.workspace === 'admin' };
  }

  const answer = (c: { json(body: unknown, status?: number): Response }, e: unknown) => {
    if (e instanceof CollabError) return c.json({ error: e.code, message: e.message }, e.status);
    if (e instanceof RequestError) return c.json({ error: e.code, message: e.message }, e.code === 'rate_limited' ? 429 : e.status);
    if (e instanceof AuthzError) return c.json({ error: e.code, message: e.message }, 401);
    log.error('collaboration request failed', { err: String(e) });
    return c.json({ error: 'unavailable', message: 'The team server couldn’t do that just now. Try again in a moment.' }, 503);
  };

  /* ───────────── board ───────────── */

  app.get('/board', async (c) => {
    try {
      const who = await actor(c);
      const [{ issues }, members] = await Promise.all([collab.board(OFFICE_ID), store.listMembers(OFFICE_ID)]);
      const people = members.map((m) => ({ uid: m.uid, name: m.name })).sort((a, b) => a.name.localeCompare(b.name));
      return c.json({ issues, people, you: who.uid, canModerate: who.workspace === 'owner' || who.workspace === 'admin' });
    } catch (e) {
      return answer(c, e);
    }
  });

  app.get('/board/issues/:id', async (c) => {
    try {
      await actor(c);
      return c.json({ issue: await collab.issue(OFFICE_ID, c.req.param('id')) });
    } catch (e) {
      return answer(c, e);
    }
  });

  app.post('/assets', async (c) => {
    try {
      const who = await changer(c);
      // The body is base64 text of a picture of at most 1 MB: a request far larger than that is not read.
      if (Number(c.req.header('content-length') ?? 0) > 2 * 1024 * 1024) throw new CollabError('asset_too_big', 'A picture can be up to 1 MB.');
      return c.json(await collab.addAsset(OFFICE_ID, who.uid, await c.req.json().catch(() => null)), 201);
    } catch (e) {
      return answer(c, e);
    }
  });

  app.get('/assets/:id', async (c) => {
    try {
      await actor(c);
      const a = await collab.asset(OFFICE_ID, c.req.param('id'));
      return c.json({ id: a.id, mime: a.mime, size: a.size, data: a.data });
    } catch (e) {
      return answer(c, e);
    }
  });

  /** What was said in the worktree tabs that worked on a ticket: its history, whether or not a tab is still open. */
  app.get('/board/issues/:id/chat', async (c) => {
    try {
      await actor(c);
      const issue = await collab.issue(OFFICE_ID, c.req.param('id'));
      const ids = new Set([...(issue.threads ?? []), ...(issue.thread ? [issue.thread] : [])]);
      const threads = (await store.listThreads(OFFICE_ID)).filter((t) => ids.has(t.id));
      const messages = [];
      for (const t of threads) {
        const page = await store.listMessages(OFFICE_ID, { session: t.session, limit: 200 });
        for (const m of page.messages) if (m.thread === t.id && !m.deleted) messages.push({ id: m.id, kind: m.kind, from: m.from, fromName: m.fromName, text: m.text, at: m.at, thread: t.id });
      }
      messages.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
      return c.json({ messages: messages.slice(-400), threads: threads.map((t) => ({ id: t.id, name: t.name, branch: t.branch, state: t.state, ownerName: t.ownerName })) });
    } catch (e) {
      return answer(c, e);
    }
  });

  app.post('/board/issues', async (c) => {
    try {
      const who = await changer(c);
      const issue = await collab.createIssue(OFFICE_ID, who.uid, await c.req.json().catch(() => null));
      return c.json({ issue }, 201);
    } catch (e) {
      return answer(c, e);
    }
  });

  app.patch('/board/issues/:id', async (c) => {
    try {
      const who = await changer(c);
      const issue = await collab.updateIssue(OFFICE_ID, who.uid, c.req.param('id'), await c.req.json().catch(() => null));
      return c.json({ issue });
    } catch (e) {
      return answer(c, e);
    }
  });

  app.delete('/board/issues/:id', async (c) => {
    try {
      const who = await changer(c);
      await collab.deleteIssue(OFFICE_ID, who.uid, c.req.param('id'), who.canModerate);
      return c.json({ ok: true });
    } catch (e) {
      return answer(c, e);
    }
  });

  /* ───────────── docs ───────────── */

  app.get('/pages', async (c) => {
    try {
      await actor(c);
      return c.json({ pages: await collab.pages(OFFICE_ID) });
    } catch (e) {
      return answer(c, e);
    }
  });

  app.get('/pages/:id', async (c) => {
    try {
      await actor(c);
      return c.json({ page: await collab.page(OFFICE_ID, c.req.param('id')) });
    } catch (e) {
      return answer(c, e);
    }
  });

  app.post('/pages', async (c) => {
    try {
      const who = await changer(c);
      const page = await collab.createPage(OFFICE_ID, who.uid, await c.req.json().catch(() => null));
      return c.json({ page }, 201);
    } catch (e) {
      return answer(c, e);
    }
  });

  app.patch('/pages/:id', async (c) => {
    try {
      const who = await changer(c);
      const page = await collab.updatePage(OFFICE_ID, who.uid, c.req.param('id'), await c.req.json().catch(() => null));
      return c.json({ page });
    } catch (e) {
      return answer(c, e);
    }
  });

  app.delete('/pages/:id', async (c) => {
    try {
      const who = await changer(c);
      return c.json({ pages: await collab.deletePage(OFFICE_ID, who.uid, c.req.param('id'), who.canModerate) });
    } catch (e) {
      return answer(c, e);
    }
  });
}
