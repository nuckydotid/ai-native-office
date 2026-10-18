import assert from 'node:assert/strict';
import { afterAll, beforeAll, describe, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { TokenError } from '../src/auth.ts';
import { MemoryCollabStore } from '../src/collab-store.ts';
import { loadConfig } from '../src/config.ts';
import { setSilent } from '../src/log.ts';
import { createTeamServer } from '../src/server.ts';
import type { TeamServer } from '../src/server.ts';
import { MemoryStore, PostgresStore, OFFICE_ID } from '../src/store.ts';
import type { Issue, BoardPerson } from '../src/shared/board/types.ts';
import type { Page } from '../src/shared/pages/types.ts';
import { lookFromSeed } from '../src/shared/workspace/looks.ts';
import type { WorkspaceRole } from '../src/shared/workspace/types.ts';

setSilent(true);

/** A token is `<uid>|<role>`: the fake sign-in turns it into an identity. */
const tok = (uid: string, role: WorkspaceRole) => `${uid}|${role}`;
const FOUNDER = tok('g-1', 'owner');
const MEMBER = tok('g-2', 'member');
const OTHER = tok('g-3', 'member');
const APP = 'http://app.test';

const fakeAuth = {
  verify: async (t: string) => {
    const [uid, role] = t.split('|');
    if (!uid || !role) throw new TokenError('invalid token');
    return { uid, role: role as WorkspaceRole, name: uid, provider: 'dev' as const };
  },
};

describe('the project board', () => {
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

  beforeAll(async () => {
    store = new MemoryStore();
    const cfg = { ...loadConfig(), devAuth: false, store: 'memory' as const, allowedOrigins: [APP] };
    server = createTeamServer({ cfg, store, collabLimits: { ip: [10_000, 10_000], writes: [10_000, 10_000] }, auth: fakeAuth });
    base = `http://127.0.0.1:${await server.listen(0)}`;
    // A member row for assignees: the office creates it when someone enters; here it is seeded directly.
    await store.putMember(OFFICE_ID, { uid: 'g-1', role: 'owner', name: 'Owner', look: lookFromSeed('owner'), desk: null, joinedAt: 1, lastSeen: 1 });
  });
  afterAll(async () => {
    await server.close();
  });

  test('an allowed origin may reach the board, including PATCH edits', async () => {
    const preflight = await fetch(`${base}/board/issues/i-1`, {
      method: 'OPTIONS',
      headers: { origin: APP, 'access-control-request-method': 'PATCH', 'access-control-request-headers': 'authorization, content-type' },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), APP);
    assert.match(preflight.headers.get('access-control-allow-methods') ?? '', /PATCH/);
  });

  test('only someone signed in reads the board', async () => {
    assert.equal((await api('GET', '/board')).status, 401);
    assert.equal((await api('GET', '/board', 'garbage')).status, 401);
    assert.equal((await api('GET', '/board', MEMBER)).status, 200);
  });

  test('an issue is created with defaults, cleaned, and offered to the right people', async () => {
    const made = await api<{ issue: Issue }>('POST', '/board/issues', MEMBER, { title: '  Fix\n the leak  ' });
    assert.equal(made.status, 201);
    assert.equal(made.json?.issue.title, 'Fix the leak');
    assert.deepEqual(
      { status: made.json?.issue.status, priority: made.json?.issue.priority, assignee: made.json?.issue.assignee, labels: made.json?.issue.labels, points: made.json?.issue.points },
      { status: 'todo', priority: 'medium', assignee: null, labels: [], points: 0 },
    );
    assert.equal((await api('POST', '/board/issues', MEMBER, { body: 'no title' })).status, 400);

    const board = await api<{ issues: Issue[]; people: BoardPerson[] }>('GET', '/board', MEMBER);
    assert.equal(board.json?.issues.length, 1);
    assert.deepEqual(board.json?.people, [{ uid: 'g-1', name: 'Owner' }], 'assignees come from the team, names only');
  });

  test('moving an issue to another column puts it after the cards already there', async () => {
    const first = (await api<{ issue: Issue }>('POST', '/board/issues', MEMBER, { title: 'One', status: 'todo' })).json!.issue;
    const second = (await api<{ issue: Issue }>('POST', '/board/issues', MEMBER, { title: 'Two', status: 'todo' })).json!.issue;
    assert.ok(second.order > first.order);
    const moved = await api<{ issue: Issue }>('PATCH', `/board/issues/${first.id}`, MEMBER, { status: 'in_progress', assignee: 'g-1' });
    assert.equal(moved.json?.issue.status, 'in_progress');
    const board = (await api<{ issues: Issue[] }>('GET', '/board', MEMBER)).json!;
    const column = board.issues.filter((i) => i.status === 'in_progress');
    assert.deepEqual(column.map((i) => i.id), [first.id]);
  });

  test('In Progress needs someone on the ticket, In Review needs a pull request', async () => {
    const issue = (await api<{ issue: Issue }>('POST', '/board/issues', MEMBER, { title: 'Ship it' })).json!.issue;

    const unassigned = await api<{ error: string }>('PATCH', `/board/issues/${issue.id}`, MEMBER, { status: 'in_progress' });
    assert.equal(unassigned.status, 400);
    assert.equal(unassigned.json?.error, 'needs_assignee');

    const working = await api<{ issue: Issue }>('PATCH', `/board/issues/${issue.id}`, MEMBER, { status: 'in_progress', assignee: 'g-1' });
    assert.equal(working.json?.issue.status, 'in_progress');

    const unassignedAgain = await api<{ error: string }>('PATCH', `/board/issues/${issue.id}`, MEMBER, { assignee: null });
    assert.equal(unassignedAgain.status, 400, 'the assignee cannot be cleared while the ticket is In Progress');
    assert.equal(unassignedAgain.json?.error, 'needs_assignee');

    const noPr = await api<{ error: string }>('PATCH', `/board/issues/${issue.id}`, MEMBER, { status: 'review' });
    assert.equal(noPr.status, 400);
    assert.equal(noPr.json?.error, 'needs_pr');

    const reviewing = await api<{ issue: Issue }>('PATCH', `/board/issues/${issue.id}`, MEMBER, { status: 'review', pr: 'https://github.com/acme/app/pull/7' });
    assert.equal(reviewing.json?.issue.status, 'review');

    const prGone = await api<{ error: string }>('PATCH', `/board/issues/${issue.id}`, MEMBER, { pr: null });
    assert.equal(prGone.status, 400, 'the pull request cannot be cleared while the ticket is In Review');
    assert.equal(prGone.json?.error, 'needs_pr');

    const backToPlan = await api<{ issue: Issue }>('PATCH', `/board/issues/${issue.id}`, MEMBER, { status: 'todo', pr: null });
    assert.equal(backToPlan.json?.issue.status, 'todo', 'back to the Plan page: the pull request is released with it');
  });

  test('anyone may edit, but deleting someone else’s issue is for the author, a founder or an admin', async () => {
    const issue = (await api<{ issue: Issue }>('POST', '/board/issues', MEMBER, { title: 'Mine' })).json!.issue;
    assert.equal((await api('PATCH', `/board/issues/${issue.id}`, FOUNDER, { priority: 'urgent' })).status, 200);
    const refused = await api<{ error: string }>('DELETE', `/board/issues/${issue.id}`, OTHER);
    assert.equal(refused.status, 403);
    assert.equal(refused.json?.error, 'forbidden');
    assert.equal((await api('DELETE', `/board/issues/${issue.id}`, MEMBER)).status, 200);
  });
});

describe('tickets that worktrees work on', () => {
  let server: TeamServer;
  let store: MemoryStore;
  const collabStore = new MemoryCollabStore();
  let base = '';
  const api = async <T = any>(method: string, path: string, token?: string, body?: unknown): Promise<{ status: number; json: T | null }> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: (await res.json().catch(() => null)) as T | null };
  };

  beforeAll(async () => {
    store = new MemoryStore();
    const cfg = { ...loadConfig(), devAuth: false, store: 'memory' as const, allowedOrigins: [APP] };
    server = createTeamServer({ cfg, store, collabStore, collabLimits: { ip: [10_000, 10_000], writes: [10_000, 10_000] }, auth: fakeAuth });
    base = `http://127.0.0.1:${await server.listen(0)}`;
  });
  afterAll(async () => {
    await server.close();
  });

  test('tickets are numbered in order, and a board saved before numbers existed is numbered by age', async () => {
    // Saved the old way: no key, no links.
    const old = (id: string, createdAt: number) => ({ id, title: `Old ${id}`, body: '', status: 'todo', priority: 'medium', assignee: null, labels: [], points: 0, order: 1024, createdBy: 'g-1', createdAt, updatedBy: 'g-1', updatedAt: createdAt }) as unknown as Issue;
    await collabStore.putIssue(OFFICE_ID, old('i-b', 200));
    await collabStore.putIssue(OFFICE_ID, old('i-a', 100));
    const board = (await api<{ issues: Issue[] }>('GET', '/board', FOUNDER)).json!.issues;
    const byId = Object.fromEntries(board.map((i) => [i.id, i]));
    assert.equal(byId['i-a'].key, 1, 'the oldest is #1');
    assert.equal(byId['i-b'].key, 2);
    assert.deepEqual(byId['i-a'].docs, []);
    assert.equal(byId['i-a'].thread, null);
    const made = (await api<{ issue: Issue }>('POST', '/board/issues', MEMBER, { title: 'New one' })).json!.issue;
    assert.equal(made.key, 3);
    const again = (await api<{ issue: Issue }>('GET', `/board/issues/${made.id}`, MEMBER)).json!.issue;
    assert.equal(again.key, 3);
  });

  test('a ticket links to docs that exist, a worktree and a branch', async () => {
    const page = (await api<{ page: Page }>('POST', '/pages', MEMBER, { title: 'Spec' })).json!.page;
    const issue = (await api<{ issue: Issue }>('POST', '/board/issues', MEMBER, { title: 'Linked', docs: [page.id, 'p-nope'] })).json!.issue;
    assert.deepEqual(issue.docs, [page.id], 'a doc that is not there is not stored');
    const patched = await api<{ issue: Issue }>('PATCH', `/board/issues/${issue.id}`, MEMBER, { thread: 'w-1', branch: 'work/linked', pr: 'https://github.com/o/r/pull/1' });
    assert.equal(patched.status, 200);
    assert.equal(patched.json!.issue.branch, 'work/linked');
    assert.equal(patched.json!.issue.thread, 'w-1');
    assert.equal((await api('PATCH', `/board/issues/${issue.id}`, MEMBER, { branch: '--force' })).status, 400);
    assert.equal((await api('PATCH', `/board/issues/${issue.id}`, MEMBER, { pr: 'javascript:alert(1)' })).status, 400);
    assert.equal((await api('PATCH', `/board/issues/${issue.id}`, MEMBER, { docs: Array.from({ length: 11 }, (_, i) => `p-${i}`) })).status, 400);
  });

  test('an edit made on an old copy is refused instead of replacing a newer one', async () => {
    const issue = (await api<{ issue: Issue }>('POST', '/board/issues', MEMBER, { title: 'Contested' })).json!.issue;
    const first = await api<{ issue: Issue }>('PATCH', `/board/issues/${issue.id}`, FOUNDER, { title: 'Founder’s title', ifUpdatedAt: issue.updatedAt });
    assert.equal(first.status, 200);
    const late = await api<{ error: string }>('PATCH', `/board/issues/${issue.id}`, MEMBER, { title: 'Member’s title', ifUpdatedAt: issue.updatedAt });
    assert.equal(late.status, 409);
    assert.equal(late.json!.error, 'stale');
    // Without the precondition a status change from an app that does not know better still goes through (it only touches that field).
    const free = await api<{ issue: Issue }>('PATCH', `/board/issues/${issue.id}`, MEMBER, { status: 'in_progress', assignee: 'g-1' });
    assert.equal(free.status, 200);
    assert.equal(free.json!.issue.title, 'Founder’s title', 'the title was not overwritten');
  });

  test('the same for a page, and one page can be read by itself', async () => {
    const page = (await api<{ page: Page }>('POST', '/pages', MEMBER, { title: 'Draft', body: 'one' })).json!.page;
    assert.equal((await api('PATCH', `/pages/${page.id}`, FOUNDER, { body: 'two', ifUpdatedAt: page.updatedAt })).status, 200);
    const late = await api<{ error: string }>('PATCH', `/pages/${page.id}`, MEMBER, { body: 'three', ifUpdatedAt: page.updatedAt });
    assert.equal(late.status, 409);
    const read = (await api<{ page: Page }>('GET', `/pages/${page.id}`, MEMBER)).json!.page;
    assert.equal(read.body, 'two');
  });

  test('a ticket that an open worktree is working on is not deleted, until the tab is closed', async () => {
    const issue = (await api<{ issue: Issue }>('POST', '/board/issues', MEMBER, { title: 'In use' })).json!.issue;
    const now = Date.now();
    await store.putThread(OFFICE_ID, {
      id: 'w-live', zone: 'z-g-2', owner: 'g-2', ownerName: 'Dev', name: 'Work', branch: 'work/in-use', base: 'main', state: 'running',
      ticket: issue.id, docs: [], session: 'w-live-s', createdAt: now, updatedAt: now,
    });
    await api('PATCH', `/board/issues/${issue.id}`, MEMBER, { thread: 'w-live' });
    const refused = await api<{ error: string }>('DELETE', `/board/issues/${issue.id}`, MEMBER);
    assert.equal(refused.status, 409);
    assert.equal(refused.json!.error, 'in_use');
    await store.putThread(OFFICE_ID, { ...(await store.listThreads(OFFICE_ID)).find((t) => t.id === 'w-live')!, state: 'archived', updatedAt: now + 1 });
    assert.equal((await api('DELETE', `/board/issues/${issue.id}`, MEMBER)).status, 200);
  });
});

describe('the project docs', () => {
  let server: TeamServer;
  let base = '';
  const api = async <T = any>(method: string, path: string, token?: string, body?: unknown): Promise<{ status: number; json: T | null }> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: (await res.json().catch(() => null)) as T | null };
  };

  beforeAll(async () => {
    const store = new MemoryStore();
    const cfg = { ...loadConfig(), devAuth: false, store: 'memory' as const, allowedOrigins: [APP] };
    server = createTeamServer({ cfg, store, auth: fakeAuth, collabLimits: { ip: [10_000, 10_000], writes: [10_000, 10_000] } });
    base = `http://127.0.0.1:${await server.listen(0)}`;
  });
  afterAll(async () => {
    await server.close();
  });

  test('a page tree is created parents first and read back in order', async () => {
    const root = (await api<{ page: Page }>('POST', '/pages', FOUNDER, { title: 'Handbook', body: '# Welcome' })).json!.page;
    const child = (await api<{ page: Page }>('POST', '/pages', FOUNDER, { title: 'Onboarding', parent: root.id })).json!.page;
    assert.equal(child.parent, root.id);
    assert.equal((await api('POST', '/pages', FOUNDER, { title: 'Lost', parent: 'p-nope' })).status, 400);

    const pages = (await api<{ pages: Page[] }>('GET', '/pages', FOUNDER)).json!.pages;
    assert.deepEqual(pages.map((p) => p.title), ['Handbook', 'Onboarding']);
  });

  test('the tree cannot loop or grow past its depth', async () => {
    const root = (await api<{ page: Page }>('POST', '/pages', FOUNDER, { title: 'Deep 0' })).json!.page;
    let parent = root.id;
    for (let i = 1; i < 6; i++) parent = (await api<{ page: Page }>('POST', '/pages', FOUNDER, { title: `Deep ${i}`, parent })).json!.page.id;
    assert.equal((await api('POST', '/pages', FOUNDER, { title: 'Too deep', parent })).status, 400, 'six levels are allowed, seven are not');

    const a = (await api<{ page: Page }>('POST', '/pages', FOUNDER, { title: 'A' })).json!.page;
    const b = (await api<{ page: Page }>('POST', '/pages', FOUNDER, { title: 'B', parent: a.id })).json!.page;
    assert.equal((await api('PATCH', `/pages/${a.id}`, FOUNDER, { parent: b.id })).status, 400, 'a page cannot move inside itself');
  });

  test('deleting a page keeps its children, moved up to where it was', async () => {
    const root = (await api<{ page: Page }>('POST', '/pages', FOUNDER, { title: 'Root' })).json!.page;
    const middle = (await api<{ page: Page }>('POST', '/pages', FOUNDER, { title: 'Middle', parent: root.id })).json!.page;
    const leaf = (await api<{ page: Page }>('POST', '/pages', FOUNDER, { title: 'Leaf', parent: middle.id })).json!.page;

    const refused = await api('DELETE', `/pages/${middle.id}`, OTHER);
    assert.equal(refused.status, 403);
    const after = (await api<{ pages: Page[] }>('DELETE', `/pages/${middle.id}`, FOUNDER)).json!.pages;
    assert.equal(after.find((p) => p.id === leaf.id)?.parent, root.id);
    assert.ok(!after.some((p) => p.id === middle.id));
  });
});

describe('the board on Postgres', () => {
  let server: TeamServer;
  let db: PGlite;
  let base = '';

  beforeAll(async () => {
    db = new PGlite();
    const store = new PostgresStore(db);
    await store.whenReady();
    const cfg = { ...loadConfig(), devAuth: false, store: 'postgres' as const, allowedOrigins: ['*'] };
    server = createTeamServer({ cfg, store, auth: fakeAuth, collabLimits: { ip: [10_000, 10_000], writes: [10_000, 10_000] } });
    base = `http://127.0.0.1:${await server.listen(0)}`;
  });
  afterAll(async () => {
    await server.close();
    await db.close();
  });

  test('issues and pages survive a round trip through the shared connection', async () => {
    const res = await fetch(`${base}/board/issues`, { method: 'POST', headers: { authorization: `Bearer ${FOUNDER}`, 'content-type': 'application/json' }, body: JSON.stringify({ title: 'On the real store' }) });
    assert.equal(res.status, 201);
    const issue = ((await res.json()) as { issue: Issue }).issue;
    const patched = await fetch(`${base}/board/issues/${issue.id}`, { method: 'PATCH', headers: { authorization: `Bearer ${FOUNDER}`, 'content-type': 'application/json' }, body: JSON.stringify({ status: 'in_progress', assignee: 'g-1' }) });
    assert.equal(patched.status, 200);
    const board = (await (await fetch(`${base}/board`, { headers: { authorization: `Bearer ${FOUNDER}` } })).json()) as { issues: Issue[] };
    assert.equal(board.issues.find((i) => i.id === issue.id)?.status, 'in_progress');

    const page = await fetch(`${base}/pages`, { method: 'POST', headers: { authorization: `Bearer ${FOUNDER}`, 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Runbook' }) });
    assert.equal(page.status, 201);
    const pages = (await (await fetch(`${base}/pages`, { headers: { authorization: `Bearer ${FOUNDER}` } })).json()) as { pages: Page[] };
    assert.deepEqual(pages.pages.map((p) => p.title), ['Runbook']);
  });
});
