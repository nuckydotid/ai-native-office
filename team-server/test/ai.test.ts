import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, test } from 'bun:test';
import { GuestAuthenticator } from '../src/auth.ts';
import { HttpAgentClient, readSse } from '../src/ai/client.ts';
import { RunBudget, nextResetAt } from '../src/ai/budget.ts';
import { KnowledgeSink, ticketItem } from '../src/ai/knowledge.ts';
import { AgentRegistry, parseAgentDef } from '../src/ai/agents.ts';
import { DEFAULT_AGENTS } from '../src/ai/default-agents.ts';
import { createWebApp } from '../src/demo/static.ts';
import { builtinSeed, frontMatter, loadSeed, writeSeed } from '../src/demo/seed.ts';
import { parseRunEvent } from '../src/shared/ai/protocol.ts';
import type { RunEvent, RunRequest } from '../src/shared/ai/types.ts';
import { setSilent } from '../src/log.ts';
import { MemoryCollabStore } from '../src/collab-store.ts';
import { MemoryStore } from '../src/store.ts';

setSilent(true);

const stream = (text: string, chunk = 7) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      const bytes = new TextEncoder().encode(text);
      for (let i = 0; i < bytes.length; i += chunk) c.enqueue(bytes.slice(i, i + chunk));
      c.close();
    },
  });

const request = (over: Partial<RunRequest> = {}): RunRequest => ({
  runId: 'r1', kind: 'mention', agent: { handle: 'librarian', displayName: 'Librarian Agent', role: 'Librarian', persona: 'p', skills: [] },
  asker: { uid: 'u', name: 'U' }, room: 'lobby', question: 'q', history: [], context: { board: [], docs: [] }, attachments: [], webBase: 'http://x', ...over,
});

describe('the event stream', () => {
  test('blocks end at a blank line, comments are skipped, CRLF and tiny chunks are fine', async () => {
    const text = ': keep-alive\r\n\r\nevent: status\r\ndata: {"phase":"thinking"}\r\n\r\nevent: step\ndata: {"tool":"a",\ndata: "summary":"b"}\n\n';
    const blocks = [];
    for await (const b of readSse(stream(text, 3))) blocks.push(b);
    assert.deepEqual(blocks, [
      { event: 'status', data: '{"phase":"thinking"}' },
      { event: 'step', data: '{"tool":"a",\n"summary":"b"}' },
    ]);
  });

  test('a stream that is far too large is refused', async () => {
    const big = new ReadableStream<Uint8Array>({ start(c) { for (let i = 0; i < 40; i++) c.enqueue(new Uint8Array(100_000)); c.close(); } });
    await assert.rejects(async () => { for await (const _ of readSse(big)) void _; }, /too much/);
  });
});

describe('what the agent service says is checked like a client frame', () => {
  test('a final answer is cleaned, its citations are filtered and only real cards stay', () => {
    const ev = parseRunEvent('final', JSON.stringify({
      text: 'The answer.\u0000', citations: [{ kind: 'doc', id: 'p-1', title: 'Release process', quote: 'every second Tuesday' }, { kind: 'doc', id: 'p-1', title: 'dup' }, { kind: 'web', id: 'x', title: 'no' }, { kind: 'ticket', id: 'bad id!', title: 'no' }],
      cards: [{ kind: 'proposal', id: 'x', title: 'Follow-ups', items: [{ id: 'item-1', type: 'ticket', title: 'Do it', body: 'b' }] }, { kind: 'nonsense' }],
      usage: { model: 'gemini-3.8-flash', inputTokens: 10.9, outputTokens: -1, seconds: 2 },
    }));
    assert.equal(ev?.event, 'final');
    if (ev?.event !== 'final') return;
    assert.equal(ev.data.text, 'The answer.');
    assert.deepEqual(ev.data.citations, [{ kind: 'doc', id: 'p-1', title: 'Release process', quote: 'every second Tuesday' }]);
    assert.equal(ev.data.cards.length, 1);
    assert.deepEqual(ev.data.usage, { model: 'gemini-3.8-flash', inputTokens: 10, outputTokens: 0, seconds: 2 });
  });

  test('an empty or oversized answer, an unknown phase and junk are not events', () => {
    assert.equal(parseRunEvent('final', JSON.stringify({ text: '   ', citations: [], cards: [] })), null);
    assert.equal(parseRunEvent('final', JSON.stringify({ text: 'x'.repeat(7000) })), null);
    assert.equal(parseRunEvent('status', '{"phase":"dancing"}'), null);
    assert.equal(parseRunEvent('status', 'not json'), null);
    assert.equal(parseRunEvent('whatever', '{}'), null);
    assert.deepEqual(parseRunEvent('error', '{"code":"weird","message":"m"}'), { event: 'error', data: { code: 'internal', message: 'm' } });
  });
});

describe('the HTTP agent client', () => {
  const servers: { stop(): void }[] = [];
  afterAll(() => servers.forEach((s) => s.stop()));

  const serve = (handler: (req: Request) => Response | Promise<Response>) => {
    const s = Bun.serve({ port: 0, fetch: handler });
    servers.push(s);
    return `http://127.0.0.1:${s.port}`;
  };
  const collect = async (client: HttpAgentClient, signal = new AbortController().signal) => {
    const events: RunEvent[] = [];
    await client.run(request(), (e) => events.push(e), signal);
    return events;
  };

  test('streams status, step and final, and stops reading after the final', async () => {
    let body: RunRequest | null = null;
    const base = serve(async (req) => {
      body = (await req.json()) as RunRequest;
      return new Response('event: status\ndata: {"phase":"searching"}\n\nevent: step\ndata: {"tool":"search_knowledge","summary":"3 passages"}\n\nevent: final\ndata: {"text":"Hi","citations":[],"cards":[],"usage":{}}\n\nevent: status\ndata: {"phase":"writing"}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    });
    const events = await collect(new HttpAgentClient({ base, auth: 'none' }));
    assert.deepEqual(events.map((e) => e.event), ['status', 'step', 'final']);
    assert.equal((body as unknown as RunRequest).runId, 'r1');
  });

  test('a service that is down, refuses, or ends without an answer is an error event, never a throw', async () => {
    const down = await collect(new HttpAgentClient({ base: 'http://127.0.0.1:1', auth: 'none' }));
    assert.deepEqual(down.map((e) => e.event === 'error' && e.data.code), ['model_unavailable']);
    const busy = await collect(new HttpAgentClient({ base: serve(() => new Response('', { status: 429 })), auth: 'none' }));
    assert.equal(busy[0].event === 'error' && busy[0].data.code, 'budget');
    const broken = await collect(new HttpAgentClient({ base: serve(() => new Response('', { status: 503 })), auth: 'none' }));
    assert.equal(broken[0].event === 'error' && broken[0].data.code, 'model_unavailable');
    const silent = await collect(new HttpAgentClient({ base: serve(() => new Response('event: status\ndata: {"phase":"thinking"}\n\n')), auth: 'none' }));
    assert.deepEqual(silent.map((e) => e.event), ['status', 'error']);
  });

  test('with Google auth the call carries an ID token for the service address', async () => {
    let seen = '';
    const base = serve((req) => {
      seen = req.headers.get('authorization') ?? '';
      return new Response('event: error\ndata: {"code":"internal","message":"x"}\n\n');
    });
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.startsWith('http://metadata.google.internal/')) {
        assert.ok(u.includes(`audience=${encodeURIComponent(base)}`));
        return new Response(`h.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.s`);
      }
      return fetch(url, init);
    }) as typeof fetch;
    await collect(new HttpAgentClient({ base, auth: 'google', fetchFn: fakeFetch }));
    assert.match(seen, /^Bearer h\./);
  });

  test('aborting stops a run', async () => {
    const base = serve(() => new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'text/event-stream' } }));
    const ctrl = new AbortController();
    const done = new HttpAgentClient({ base, auth: 'none' }).run(request(), () => {}, ctrl.signal);
    setTimeout(() => ctrl.abort(), 50);
    await assert.rejects(done);
  });
});

describe('the demo budget', () => {
  test('a guest has runs per hour, everyone together has runs per day, and the window rolls', () => {
    let now = Date.UTC(2026, 9, 17, 6, 0, 0);
    const b = new RunBudget(2, 3, () => now);
    assert.equal(b.status('a').runsLeft, 2);
    assert.deepEqual(b.take('a'), { ok: true });
    assert.deepEqual(b.take('a'), { ok: true });
    assert.deepEqual(b.take('a'), { ok: false, reason: 'guest' });
    assert.deepEqual(b.take('b'), { ok: true });
    assert.deepEqual(b.take('c'), { ok: false, reason: 'day' });
    assert.equal(b.status('c').runsLeft, 0);
    b.refund('b');
    assert.deepEqual(b.take('c'), { ok: true });
    now += 61 * 60_000;
    assert.equal(b.status('a').runsLeft, 0, 'the day is still used up');
    now += 24 * 3600_000;
    assert.equal(b.status('a').runsLeft, 2, 'a new day');
  });

  test('the reset is at 03:00 Singapore time', () => {
    const t = Date.UTC(2026, 9, 17, 6, 0, 0); // 14:00 SGT
    assert.equal(new Date(nextResetAt(t)).toISOString(), '2026-10-17T19:00:00.000Z');
    const early = Date.UTC(2026, 9, 17, 18, 0, 0); // 02:00 SGT on the 18th
    assert.equal(new Date(nextResetAt(early)).toISOString(), '2026-10-17T19:00:00.000Z');
  });
});

describe('guests', () => {
  test('a guest token verifies, a tampered or foreign one does not', async () => {
    const guest = new GuestAuthenticator('a-long-enough-secret-for-tests');
    const { token, uid } = await guest.issue('  Ada\u0000 ');
    assert.match(token, /^demo:/);
    const id = await guest.verify(token);
    assert.deepEqual([id.uid, id.name, id.provider], [uid, 'Ada', 'guest']);
    await assert.rejects(guest.verify(token.slice(0, -2) + 'xx'));
    await assert.rejects(new GuestAuthenticator('another-secret-another-secret!!').verify(token));
    assert.throws(() => new GuestAuthenticator('short'));
  });
});

describe('the agents', () => {
  test('an agent from a request is cleaned and bounded', () => {
    const ok = parseAgentDef('scribe', { displayName: 'Scribe', role: 'Scribe', greeting: 'hi', look: DEFAULT_AGENTS[0].look, persona: 'You write minutes.', skills: [{ name: 'minutes', body: 'steps' }] });
    assert.equal(ok?.handle, 'scribe');
    assert.equal(parseAgentDef('here', { displayName: 'x', role: 'x', look: DEFAULT_AGENTS[0].look, persona: 'p' }), null, 'a reserved handle');
    assert.equal(parseAgentDef('scribe', { displayName: 'x', role: 'x', look: { skin: 'red' }, persona: 'p' }), null, 'a bad look');
    assert.equal(parseAgentDef('scribe', { displayName: 'x', role: 'x', look: DEFAULT_AGENTS[0].look, persona: '' }), null, 'no instructions');
  });

  test('the registry knows its agents by handle', () => {
    const r = new AgentRegistry(DEFAULT_AGENTS);
    assert.ok(r.has('librarian') && r.has('scribe') && r.has('planner'));
    r.replaceAll([DEFAULT_AGENTS[0]]);
    assert.deepEqual(r.list().map((a) => a.handle), ['studio']);
  });
});

describe('the seed', () => {
  test('front matter splits at the dashes', () => {
    assert.deepEqual(frontMatter('---\nid: p-1\ntitle: "Hello"\n---\nBody\n'), { meta: { id: 'p-1', title: 'Hello' }, body: 'Body\n' });
    assert.deepEqual(frontMatter('No front matter'), { meta: {}, body: 'No front matter' });
  });

  test('a folder is read, bad rows are left out, and a missing folder falls back to the built-in seed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'seed-'));
    mkdirSync(join(dir, 'pages'));
    mkdirSync(join(dir, 'agents', 'zed'), { recursive: true });
    writeFileSync(join(dir, 'team.json'), JSON.stringify({ name: 'Acme', members: [{ handle: 'ann', name: 'Ann', role: 'founder' }, { handle: 'Bad Handle', name: 'x', role: 'pm' }] }));
    writeFileSync(join(dir, 'pages', 'handbook.md'), '---\nid: p-hb\ntitle: Handbook\norder: 1\n---\nWelcome.');
    writeFileSync(join(dir, 'pages', 'policy.md'), '---\ntitle: Policy\nparent: handbook\norder: 2\n---\nThe thing is 42.');
    writeFileSync(join(dir, 'pages', 'untitled.md'), 'no title');
    writeFileSync(join(dir, 'tickets.json'), JSON.stringify([
      { key: 1, title: 'Fine', status: 'todo' },
      { key: 2, title: 'In progress without anyone', status: 'in_progress' },
      { key: 3, title: 'Review without a PR', status: 'review', assignee: 'ann' },
      { key: 4, title: 'Done', status: 'done', assignee: 'ann', pr: 'https://example.com/pull/9' },
    ]));
    writeFileSync(join(dir, 'agents', 'zed', 'agent.json'), JSON.stringify({ displayName: 'Zed', role: 'Tester', greeting: 'hi' }));
    writeFileSync(join(dir, 'agents', 'zed', 'persona.md'), 'You test things.');
    const seed = loadSeed(dir);
    assert.deepEqual([seed.name, seed.members.map((m) => m.handle)], ['Acme', ['ann']]);
    assert.deepEqual(seed.pages.map((p) => [p.id, p.parent]), [['p-hb', null], ['p-policy', 'handbook']]);
    assert.deepEqual(seed.tickets.map((t) => t.key), [1, 4]);
    assert.deepEqual(seed.agents.map((a) => a.handle), ['zed']);
    assert.equal(loadSeed(join(dir, 'nope')).name, builtinSeed().name);
  });

  test('writing the seed twice leaves one copy, and the rules of the columns hold', async () => {
    const store = new MemoryStore();
    const collab = new MemoryCollabStore();
    const seed = builtinSeed();
    const first = await writeSeed(store, collab, seed, 1_800_000_000_000);
    await writeSeed(store, collab, seed, 1_800_000_000_000);
    assert.equal((await store.listMembers('main')).length, seed.members.length);
    const issues = await collab.listIssues('main');
    assert.equal(issues.length, seed.tickets.length);
    for (const i of issues) {
      if (i.status === 'in_progress') assert.ok(i.assignee);
      if (i.status === 'review') assert.ok(i.pr);
    }
    assert.equal((await collab.listPages('main')).length, seed.pages.length);
    assert.equal(first.standup[0].uid, 'seed-maya');
    assert.ok((await store.getMessage('main', 'welcome-1'))?.text.includes('synthetic'));
  });
});

describe('the knowledge index', () => {
  test('a ticket is written the way an agent reads it', () => {
    const item = ticketItem({ id: 'i-1', key: 7, title: 'Offline mode', body: 'Open without a connection.', status: 'in_progress', priority: 'high', assignee: 'u1', labels: ['feature'], points: 8, order: 0, docs: [], thread: null, branch: null, pr: null, createdBy: 'u1', createdAt: 1, updatedBy: 'u1', updatedAt: 5 }, new Map([['u1', 'Linh']]));
    assert.equal(item.id, '7');
    assert.ok(item.body.includes('Status: in progress') && item.body.includes('Assigned to: Linh'));
  });

  test('changes are sent once after a short pause, deleted ones as deletions, and a failing send is retried', async () => {
    const sent: { path: string; body: any }[] = [];
    let failures = 1;
    const fetchFn = (async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      const body = JSON.parse(String(init.body));
      if (failures-- > 0) return new Response('', { status: 503 });
      sent.push({ path, body });
      return new Response(JSON.stringify({ chunks: 1 }));
    }) as unknown as typeof fetch;
    const sink = new KnowledgeSink({
      base: 'http://agents.invalid', auth: 'none', tokens: {} as never, fetchFn, backoff: [5, 5],
      source: {
        issue: async () => null,
        page: async (id) => (id === 'p-1' ? { id: 'p-1', parent: null, title: 'Release', body: 'Tuesdays', order: 0, createdBy: 'u', createdAt: 1, updatedBy: 'u', updatedAt: 2 } : null),
        people: async () => new Map(),
      },
    });
    sink.schedule('pages', ['p-1']);
    sink.schedule('pages', ['p-1', 'p-gone']);
    await sink.flush();
    assert.deepEqual(sent.map((s) => [s.path, s.body.id, !!s.body.deleted]), [['/v1/index', 'p-1', false], ['/v1/index', 'p-gone', true]]);
    assert.equal(await sink.reindex([{ kind: 'doc', id: 'a', title: 't', body: 'b', updatedAt: 1 }]), 1);
    assert.equal(sent.at(-1)?.body.replaceAll, true);
  });
});

describe('serving the built web app', () => {
  const dir = mkdtempSync(join(tmpdir(), 'web-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Studio</title>');
  writeFileSync(join(dir, 'assets', 'app-abc123.js'), 'console.log(1)');
  writeFileSync(join(dir, '..', 'secret.txt'), 'outside');
  const web = createWebApp(dir);
  const get = (path: string, headers: Record<string, string> = {}) => new Request(`http://x${path}`, { headers });

  test('the page, its hashed files and nothing else', async () => {
    const page = await web.file(get('/'));
    assert.equal(page?.headers.get('cache-control'), 'no-cache');
    assert.ok((await page!.text()).includes('Studio'));
    const js = await web.file(get('/assets/app-abc123.js'));
    assert.match(js!.headers.get('cache-control')!, /immutable/);
    assert.equal(js!.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(await web.file(get('/assets/missing.js')), null, 'the API gets a turn for what is not a file');
    assert.equal(await web.file(get('/assets')), null, 'a folder is not a file');
  });

  test('a path that climbs out of the folder is never served', async () => {
    for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/assets/../../secret.txt', '/%00', '/%zz']) assert.equal(await web.file(get(p)), null, p);
  });

  test('a page address gets the app, a missing file or an API call does not', async () => {
    assert.ok(await web.index(get('/plan', { accept: 'text/html' })));
    assert.equal(await web.index(get('/assets/x.js', { accept: 'text/html' })), null);
    assert.equal(await web.index(get('/plan', { accept: 'application/json' })), null);
    assert.equal(await web.file(new Request('http://x/', { method: 'POST' })), null);
  });
});
