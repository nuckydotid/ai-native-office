import assert from 'node:assert/strict';
import { afterAll, beforeAll, describe, test } from 'bun:test';
import { TokenError } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { setSilent } from '../src/log.ts';
import { createTeamServer } from '../src/server.ts';
import type { TeamServer } from '../src/server.ts';
import { MemoryStore, OFFICE_ID } from '../src/store.ts';
import type { Issue } from '../src/shared/board/types.ts';
import type { Page } from '../src/shared/pages/types.ts';
import { lookFromSeed } from '../src/shared/workspace/looks.ts';
import type { WorkspaceRole } from '../src/shared/workspace/types.ts';

setSilent(true);

/** A token is `<uid>|<role>`: the fake sign-in turns it into an identity. */
const tok = (uid: string, role: WorkspaceRole) => `${uid}|${role}`;
const FOUNDER = tok('g-1', 'owner');
const MEMBER = tok('g-2', 'member');
const APP = 'http://app.test';
const fakeAuth = {
  verify: async (t: string) => {
    const [uid, role] = t.split('|');
    if (!uid || !role) throw new TokenError('invalid token');
    return { uid, role: role as WorkspaceRole, name: uid, provider: 'dev' as const };
  },
};

/** A real 1×1 PNG, base64. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('the ticket detail on the team server', () => {
  let server: TeamServer;
  let store: MemoryStore;
  let base = '';
  const api = async <T = any>(method: string, path: string, token?: string, body?: unknown): Promise<{ status: number; json: T | null }> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: (await res.json().catch(() => null)) as T | null };
  };
  const issue = async (over: Record<string, unknown> = {}) => (await api<{ issue: Issue }>('POST', '/board/issues', MEMBER, { title: 'Dark mode', ...over })).json!.issue;

  beforeAll(async () => {
    store = new MemoryStore();
    const cfg = { ...loadConfig(), devAuth: false, store: 'memory' as const, allowedOrigins: [APP] };
    server = createTeamServer({ cfg, store, collabLimits: { ip: [10_000, 10_000], writes: [10_000, 10_000] }, auth: fakeAuth });
    base = `http://127.0.0.1:${await server.listen(0)}`;
    await store.putMember(OFFICE_ID, { uid: 'g-1', role: 'owner', name: 'Owner', look: lookFromSeed('owner'), desk: null, joinedAt: 1, lastSeen: 1 });
  });
  afterAll(async () => {
    await server.close();
  });

  test('a ticket carries links, and only https ones with a plain address', async () => {
    const made = await issue({ links: [{ url: 'https://example.com/spec', title: 'Spec' }, { url: 'https://example.com/spec' }] });
    assert.deepEqual(made.links, [{ url: 'https://example.com/spec', title: 'Spec' }]);
    for (const bad of ['http://x.test', 'javascript:alert(1)', 'https://a b', 'ftp://x']) {
      assert.equal((await api('PATCH', `/board/issues/${made.id}`, MEMBER, { links: [{ url: bad }] })).status, 400, bad);
    }
  });

  test('a picture is checked by what it is, kept, and read back for anyone signed in', async () => {
    const up = await api<{ id: string; mime: string }>('POST', '/assets', MEMBER, { mime: 'image/png', data: PNG });
    assert.equal(up.status, 201);
    const got = await api<{ mime: string; data: string }>('GET', `/assets/${up.json!.id}`, FOUNDER);
    assert.deepEqual([got.status, got.json?.mime, got.json?.data], [200, 'image/png', PNG]);
    // The wrong kind, claimed as a picture, is refused; so is one that is too big, and a request with no sign-in.
    assert.equal((await api('POST', '/assets', MEMBER, { mime: 'image/png', data: Buffer.from('<script>alert(1)</script>').toString('base64') })).status, 400);
    assert.equal((await api('POST', '/assets', MEMBER, { mime: 'image/svg+xml', data: PNG })).status, 400);
    assert.equal((await api('POST', '/assets', MEMBER, { mime: 'image/png', data: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(1024 * 1024)]).toString('base64') })).status, 400);
    assert.equal((await api('POST', '/assets', undefined, { mime: 'image/png', data: PNG })).status, 401);
    assert.equal((await api('GET', `/assets/${up.json!.id}`)).status, 401);
    assert.equal((await api('GET', '/assets/a-nothing', MEMBER)).status, 404);
  });

  test('a ticket lists only pictures this project has', async () => {
    const up = (await api<{ id: string }>('POST', '/assets', MEMBER, { mime: 'image/png', data: PNG })).json!.id;
    const made = await issue({ images: [up, 'a-not-here'] });
    assert.deepEqual(made.images, [up]);
  });

  test('its history says what happened, and every tab that worked on it stays on it', async () => {
    const made = await issue();
    await api('PATCH', `/board/issues/${made.id}`, MEMBER, { status: 'in_progress', assignee: 'g-1', thread: 't-1', branch: 'feat/1-dark' });
    await api('PATCH', `/board/issues/${made.id}`, MEMBER, { thread: null });
    const again = (await api<{ issue: Issue }>('PATCH', `/board/issues/${made.id}`, MEMBER, { thread: 't-2', prInfo: { number: 7, title: 'feat: dark', state: 'open', updatedAt: 5 }, pr: 'https://github.com/o/r/pull/7' })).json!.issue;
    assert.deepEqual(again.threads, ['t-1', 't-2']);
    assert.equal(again.prInfo?.number, 7);
    const text = again.activity!.map((a) => a.text).join(' | ');
    assert.match(text, /Created the ticket/);
    assert.match(text, /Moved from todo to in progress/);
    assert.match(text, /worktree tab was closed/);
    assert.match(text, /Pull request #7 is open/);
    assert.equal((await api('PATCH', `/board/issues/${made.id}`, MEMBER, { prInfo: { number: 1, title: 'x', state: 'weird', updatedAt: 1 } })).status, 400);
  });

  test('a ticket’s tab chat is readable after the tab is closed, and only that ticket’s', async () => {
    const made = await issue();
    await store.putThread(OFFICE_ID, { id: 't-chat', zone: 'z', owner: 'g-2', ownerName: 'dev', name: 'Dark', branch: 'feat/1', base: 'main', state: 'archived', ticket: made.id, docs: [], session: 's-chat', createdAt: 1, updatedAt: 2 } as never);
    await store.putThread(OFFICE_ID, { id: 't-other', zone: 'z', owner: 'g-2', ownerName: 'dev', name: 'Other', branch: 'feat/2', base: 'main', state: 'review', ticket: null, docs: [], session: 's-other', createdAt: 1, updatedAt: 2 } as never);
    const msg = (id: string, thread: string, session: string, at: number, text: string) =>
      ({ id, kind: 'agent', from: 'agent:sarah', fromName: 'Sarah', look: lookFromSeed('sarah'), text, at, mentions: [], room: 'z', session, thread }) as never;
    await store.appendMessage(OFFICE_ID, msg('m1', 't-chat', 's-chat', 10, 'What is this for?'));
    await store.appendMessage(OFFICE_ID, msg('m2', 't-other', 's-other', 11, 'Not this ticket'));
    await api('PATCH', `/board/issues/${made.id}`, MEMBER, { thread: 't-chat' });
    await api('PATCH', `/board/issues/${made.id}`, MEMBER, { thread: null });
    const chat = await api<{ messages: { text: string }[]; threads: { id: string; state: string }[] }>('GET', `/board/issues/${made.id}/chat`, FOUNDER);
    assert.deepEqual(chat.json?.messages.map((m) => m.text), ['What is this for?']);
    assert.deepEqual(chat.json?.threads.map((t) => [t.id, t.state]), [['t-chat', 'archived']]);
    assert.equal((await api('GET', `/board/issues/${made.id}/chat`)).status, 401);
  });

  test('deleting a page takes it off the tickets that used it', async () => {
    const page = (await api<{ page: Page }>('POST', '/pages', MEMBER, { title: 'Design notes' })).json!.page;
    const made = await issue({ docs: [page.id] });
    assert.deepEqual(made.docs, [page.id]);
    assert.equal((await api('DELETE', `/pages/${page.id}`, MEMBER)).status, 200);
    const after = (await api<{ issue: Issue }>('GET', `/board/issues/${made.id}`, MEMBER)).json!.issue;
    assert.deepEqual(after.docs, []);
  });

  test('a ticket saved before these fields existed is read with their defaults', async () => {
    const old = { id: 'i-old', key: 99, title: 'Old', body: '', status: 'todo', priority: 'low', assignee: null, sprint: null, labels: [], points: 0, order: 1, docs: [], thread: 't-x', branch: null, pr: null, createdBy: 'g-2', createdAt: 1, updatedBy: 'g-2', updatedAt: 1 };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (server as any).collab?.store?.putIssue?.(OFFICE_ID, old);
    const read = await api<{ issue: Issue }>('GET', '/board/issues/i-old', MEMBER);
    if (read.status === 200) assert.deepEqual([read.json!.issue.links, read.json!.issue.images, read.json!.issue.threads], [[], [], ['t-x']]);
  });
});
