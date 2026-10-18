import assert from 'node:assert/strict';
import { afterAll, afterEach, beforeAll, describe, test } from 'bun:test';
import { lookFromSeed } from '../src/shared/workspace/looks.ts';
import type { ClientMsg, ServerMsg } from '../src/shared/workspace/protocol.ts';
import { zoneAt } from '../src/shared/workspace/layout.ts';
import type { ChatMessage, WorkspaceRole } from '../src/shared/workspace/types.ts';
import { GuestAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { setSilent } from '../src/log.ts';
import { createTeamServer } from '../src/server.ts';
import type { TeamServer } from '../src/server.ts';
import { MemoryStore } from '../src/store.ts';
import { Bot, sleep, startDevServer } from './bot.ts';
import { PROTOCOL_VERSION } from '../src/shared/workspace/protocol.ts';

setSilent(true);

describe('office server', () => {
  let server: TeamServer;
  let store: MemoryStore;
  let url = '';
  const bots: Bot[] = [];
  const newBot = (uid: string, role?: WorkspaceRole) => {
    const b = new Bot(uid, url, role);
    bots.push(b);
    return b;
  };

  beforeAll(async () => {
    ({ server, store, url } = await startDevServer());
  });

  // One project = one office, so every test starts from an empty room.
  afterEach(async () => {
    for (const b of bots.splice(0)) b.ws?.terminate();
    await new Promise((r) => setTimeout(r, 30));
  });

  afterAll(async () => {
    await server.close();
  });

  test('healthz and public config', async () => {
    const base = url.replace('ws://', 'http://').replace('/ws', '');
    const h = (await (await fetch(`${base}/healthz`)).json()) as { ok: boolean };
    assert.equal(h.ok, true);
    assert.equal(((await (await fetch(`${base}/health`)).json()) as { ok: boolean }).ok, true, 'the path Cloud Run lets through');
    const c = await (await fetch(`${base}/config`)).json();
    assert.deepEqual(c, { name: 'Garden', protocol: PROTOCOL_VERSION, pipeline: false });
    assert.deepEqual(await (await fetch(`${base}/`)).json(), { name: 'worktrees-team-server', ws: '/ws' });
    assert.equal((await fetch(`${base}/projects`)).status, 404, 'the multi-tenant project API is gone');
    assert.equal((await fetch(`${base}/ai/generate`, { method: 'POST' })).status, 404, 'no server-side AI');
  });

  test('there is no team to manage, no design room and no check of who is a member', async () => {
    const base = url.replace('ws://', 'http://').replace('/ws', '');
    const auth = { authorization: 'Bearer dev:alice@owner:Alice', 'content-type': 'application/json' };
    for (const [method, path] of [['GET', '/members'], ['POST', '/members'], ['DELETE', '/members/dev-alice'], ['GET', '/me']] as const) {
      assert.equal((await fetch(`${base}${path}`, { method, headers: auth, body: method === 'POST' ? '{"email":"x@example.com","role":"member"}' : undefined })).status, 404, `${method} ${path}`);
    }
    const design = new globalThis.WebSocket(`${url.replace('/ws', '/design')}`);
    const closed = await new Promise<string>((resolve) => {
      design.onopen = () => resolve('open');
      design.onerror = () => resolve('refused');
      design.onclose = () => resolve('refused');
    });
    assert.equal(closed, 'refused', 'WS /design is not served any more');
  });

  test('join returns the world with only the people in it (agents are not in the office)', async () => {
    const a = await newBot('alice', 'owner').connect();
    const w = a.welcome;
    assert.equal(w.you, 'dev-alice');
    assert.equal(w.role, 'owner');
    // The office is a lobby, the two fixed rooms and one zone for each member (the members of earlier tests are still on the team).
    assert.equal(w.map.zones[0].id, 'lobby');
    assert.ok(w.map.zones.some((z) => z.id === 'z-dev-alice'));
    assert.ok(w.map.zones.some((z) => z.id === 'plan') && w.map.zones.some((z) => z.id === 'review'));
    assert.equal(w.map.zones.length, 3 + new Set(Object.values(w.deskOwners)).size);
    assert.deepEqual(w.players.map((p) => p.id), ['dev-alice']);
    assert.equal(w.deskOwners['desk-dev-alice'], 'dev-alice');
    assert.equal(w.players[0].desk, 'desk-dev-alice');
    assert.equal(zoneAt(w.map, w.players[0].x, w.players[0].y)?.id, 'lobby', 'people arrive in the lobby');
    assert.equal(w.protocol, PROTOCOL_VERSION);
    assert.deepEqual(w.thinking, []);
    assert.equal(w.historyHasMore, false);
  });

  test('rejects bad tokens and malformed frames', async () => {
    const bad = await newBot('mallory').connect({ token: 'garbage', expectWelcome: false });
    const err = (await bad.waitFor((m) => m.t === 'error')) as Extract<ServerMsg, { t: 'error' }>;
    assert.equal(err.code, 'auth_failed');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(bad.closed?.code, 4003);

    const a = await newBot('alice2').connect();
    a.ws.send('{"t":"move","x":"nope"}');
    await a.waitFor((m) => m.t === 'error' && m.code === 'bad_message');
  });

  test('players see each other and positions stream', async () => {
    const a = await newBot('p1').connect();
    const b = await newBot('p2').connect();
    await a.waitFor((m) => m.t === 'join' && m.player.id === 'dev-p2');
    assert.ok(b.welcome.players.some((p) => p.id === 'dev-p1'));
    const me = b.welcome.players.find((p) => p.id === 'dev-p2')!;
    b.send({ t: 'move', x: me.x + 0.1, y: me.y, dir: 'right', moving: true });
    const st = (await a.waitFor((m) => m.t === 'state' && m.p.some((t) => t[0] === 'dev-p2'))) as Extract<ServerMsg, { t: 'state' }>;
    const tup = st.p.find((t) => t[0] === 'dev-p2')!;
    assert.equal(tup[3], 'right');
    // never echoes your own position back
    await b.expectNone((m) => m.t === 'state' && m.p.some((t) => t[0] === 'dev-p2'));
    b.close();
    await a.waitFor((m) => m.t === 'leave' && m.id === 'dev-p2');
  });

  test('teleporting and walking through walls is rejected', async () => {
    const a = await newBot('tp').connect();
    const me = a.welcome.players.find((p) => p.id === 'dev-tp')!;
    a.send({ t: 'move', x: me.x, y: me.y - 20, dir: 'up', moving: true });
    const c = (await a.waitFor((m) => m.t === 'correct')) as Extract<ServerMsg, { t: 'correct' }>;
    assert.ok(Math.abs(c.x - me.x) < 0.01 && Math.abs(c.y - me.y) < 0.01);
    // inside the south wall of the building
    a.inbox.length = 0;
    a.send({ t: 'move', x: me.x, y: 33.5, dir: 'down', moving: true });
    await a.waitFor((m) => m.t === 'correct');
  });

  test('the Room is one conversation: everyone hears it, and only the sender gets their cid back', async () => {
    const a = await newBot('c1').connect();
    const b = await newBot('c2').connect();
    const c = await newBot('c3').connect();
    const saved = await a.say('hello everyone', 'cid-1');
    assert.equal(saved.kind, 'human');
    assert.equal(saved.from, 'dev-c1');
    assert.equal(saved.fromName, 'c1');
    assert.deepEqual(saved.look, lookFromSeed('c1'), 'the sender’s look is stamped by the server');
    for (const other of [b, c]) {
      const m = (await other.waitFor((x) => x.t === 'chat' && x.msg.text === 'hello everyone')) as Extract<ServerMsg, { t: 'chat' }>;
      assert.equal(m.msg.id, saved.id);
      assert.equal(m.msg.cid, undefined, 'someone else’s cid is never shown');
    }
  });

  test('mentions are found by the server (at most three, lower case)', async () => {
    const a = await newBot('m1').connect();
    const m = await a.say('@John @sarah and @alex and @david, see ann@example.com');
    assert.deepEqual(m.mentions, ['john', 'sarah', 'alex']);
  });

  test('a message is saved before it is shown, and a joiner gets it exactly once', async () => {
    const a = await newBot('sv1').connect();
    const saved = await a.say('saved first');
    const late = await newBot('sv2').connect();
    assert.deepEqual(late.welcome.history.filter((m) => m.id === saved.id).length, 1);
    assert.equal(late.welcome.history.at(-1)?.text, 'saved first');
  });

  test('the old nearby and direct messages are refused, and a refused chat says which send it was', async () => {
    const a = await newBot('old').connect();
    a.ws.send(JSON.stringify({ t: 'chat', scope: 'nearby', text: 'psst', cid: 'n1' }));
    const e1 = (await a.waitFor((m) => m.t === 'error' && m.cid === 'n1')) as Extract<ServerMsg, { t: 'error' }>;
    assert.equal(e1.code, 'bad_message');
    a.ws.send('{"t":"chat","text":"   ","cid":"n2"}');
    await a.waitFor((m) => m.t === 'error' && m.cid === 'n2');
    a.ws.send('{"t":"history.get","reqId":"r9","limit":999}');
    await a.waitFor((m) => m.t === 'error' && m.reqId === 'r9');
  });

  test('sending the same cid twice (a retry) saves one message', async () => {
    const a = await newBot('dup').connect();
    a.send({ t: 'chat', text: 'once', cid: 'dup-1' });
    await a.waitFor((m) => m.t === 'chat' && m.msg.cid === 'dup-1');
    a.send({ t: 'chat', text: 'once', cid: 'dup-1' });
    await sleep(150);
    const echoes = a.inbox.filter((m) => m.t === 'chat' && m.msg.cid === 'dup-1');
    assert.equal(echoes.length, 2, 'the retry is confirmed again');
    assert.equal(new Set(echoes.map((m) => (m as Extract<ServerMsg, { t: 'chat' }>).msg.id)).size, 1);
    const stored = await store.listMessages('main', { limit: 50 });
    assert.equal(stored.messages.filter((m) => m.text === 'once').length, 1);
  });

  test('chat is rate limited, and the messages that are dropped are answered', async () => {
    const a = await newBot('spam').connect();
    const b = await newBot('listener').connect();
    for (let i = 0; i < 20; i++) a.send({ t: 'chat', text: `m${i}`, cid: `s${i}` });
    await sleep(300);
    const got = b.inbox.filter((m) => m.t === 'chat').length;
    assert.ok(got <= 8, `expected rate limiting, got ${got}`);
    assert.ok(got >= 1);
    const refused = a.inbox.filter((m) => m.t === 'error' && m.code === 'rate_limited');
    assert.ok(refused.length >= 10, 'every dropped message gets an answer');
    assert.ok(refused.every((m) => (m as Extract<ServerMsg, { t: 'error' }>).cid?.startsWith('s')));
  });

  test('an app that does not speak the current protocol is told to update', async () => {
    const old = await newBot('legacy').connect({ protocol: null, expectWelcome: false });
    const err = (await old.waitFor((m) => m.t === 'error')) as Extract<ServerMsg, { t: 'error' }>;
    assert.equal(err.code, 'update_required');
    await sleep(100);
    assert.equal(old.closed?.code, 4002);
  });

  test('display names come from the verified account and are unique in the room', async () => {
    const first = await newBot('n1', 'member').connect({ token: 'dev:n1:Ann' });
    const second = await newBot('n2', 'member').connect({ token: 'dev:n2:Ann' });
    assert.equal(first.welcome.players.find((p) => p.id === 'dev-n1')?.name, 'Ann');
    assert.equal(second.welcome.players.find((p) => p.id === 'dev-n2')?.name, 'Ann 2');
  });

  test('the office grows with the team, and no zone moves when someone joins', async () => {
    const a = await newBot('g1').connect();
    const before = a.welcome.map.zones.find((z) => z.id === 'z-dev-g1')!;
    const b = await newBot('g2').connect();
    const grown = (await a.waitFor((m) => m.t === 'map.set' && m.map.zones.some((z) => z.id === 'z-dev-g2'))) as Extract<ServerMsg, { t: 'map.set' }>;
    assert.deepEqual(grown.map.zones.find((z) => z.id === 'z-dev-g1'), before, 'the first zone stays where it was');
    assert.equal(grown.deskOwners['desk-dev-g1'], 'dev-g1');
    assert.equal(grown.deskOwners['desk-dev-g2'], 'dev-g2');
    assert.ok(b.welcome.map.zones.some((z) => z.id === 'z-dev-g2'), 'the joiner is sent the map with their own zone in it');
    assert.equal(grown.map.floor.length, grown.map.width * grown.map.height);
    // and it closes up again when someone is removed
    const room = await server.office.get();
    assert.equal(await room.removeMember('dev-g2'), true);
    const shrunk = (await a.waitFor((m) => m.t === 'map.set' && !m.map.zones.some((z) => z.id === 'z-dev-g2'))) as Extract<ServerMsg, { t: 'map.set' }>;
    assert.equal(shrunk.deskOwners['desk-dev-g1'], 'dev-g1');
    assert.equal(shrunk.deskOwners['desk-dev-g2'], undefined);
    assert.equal(shrunk.map.zones.length, grown.map.zones.length - 1);
  });

  test('desks are not claimed: everyone has the one in their own zone', async () => {
    const a = await newBot('o1').connect();
    a.send({ t: 'desk.claim', deskId: null });
    await a.waitFor((m) => m.t === 'error' && m.code === 'desk_assigned');
    const room = await server.office.get();
    assert.equal(room.deskOwners.get('desk-dev-o1'), 'dev-o1');
  });

  test('sitting requires being near the desk, and any zone is open to anyone', async () => {
    const a = await newBot('s1').connect();
    const b = await newBot('s2').connect();
    await a.waitFor((m) => m.t === 'map.set' && m.map.zones.some((z) => z.id === 'z-dev-s2'));
    const room = (await server.office.get()).map;
    const desk = room.props.find((p) => p.id === 'desk-dev-s2')!;
    a.send({ t: 'sit', deskId: desk.id });
    await a.waitFor((m) => m.t === 'correct'); // far away: refused
    const live = await server.office.get();
    Object.assign(live.players.get('dev-s1')!, { x: desk.x + 1.5, y: desk.y + 2.2 });
    a.inbox.length = 0;
    a.send({ t: 'sit', deskId: desk.id });
    await new Promise((r) => setTimeout(r, 100));
    const p = live.players.get('dev-s1')!;
    assert.equal(p.sitting, desk.id, 'someone else’s desk, in someone else’s zone');
    assert.equal(p.dir, 'up');
    b.close();
  });

  test('the map is laid out from the team, so it is not edited by hand', async () => {
    const owner = await newBot('boss', 'owner').connect();
    owner.send({ t: 'edit', op: { op: 'prop.add', prop: { id: 'new-plant', kind: 'plant', x: 4, y: 10 } } });
    await owner.waitFor((m) => m.t === 'error' && m.code === 'forbidden');
    const room = await server.office.get();
    assert.ok(!room.map.props.some((p) => p.id === 'new-plant'));
  });

  test('second login replaces the first connection', async () => {
    const a1 = await newBot('twin').connect();
    const a2 = await newBot('twin').connect();
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(a1.closed?.code, 4001);
    assert.ok(a1.inbox.some((m) => m.t === 'error' && m.code === 'replaced'), 'it says why before it closes');
    assert.ok(a2.welcome);
  });

  test('the role follows the sign-in on every join', async () => {
    const first = await newBot('flip', 'admin').connect();
    assert.equal(first.welcome.role, 'admin');
    first.close();
    await new Promise((r) => setTimeout(r, 100));
    const demoted = await newBot('flip', 'member').connect();
    assert.equal(demoted.welcome.role, 'member', 'a person whose sign-in now says member loses admin rights');
  });

  test('the old agent messages are gone', async () => {
    const a = await newBot('gone').connect();
    a.ws.send(JSON.stringify({ t: 'agent.chat', agentId: 'x', text: 'hi', reqId: 'r1' }));
    await a.waitFor((m) => m.t === 'error' && m.code === 'bad_message' && m.reqId === 'r1');
  });
});

describe('sign-in gate (dev auth off)', () => {
  const bots: Bot[] = [];
  let server: TeamServer;
  let url = '';
  let guests: GuestAuthenticator;

  beforeAll(async () => {
    guests = new GuestAuthenticator('a-secret-of-at-least-16-chars');
    const cfg = { ...loadConfig(), devAuth: false, store: 'memory' as const, allowedOrigins: ['*'] };
    server = createTeamServer({ cfg, store: new MemoryStore(), auth: guests });
    url = `ws://127.0.0.1:${await server.listen(0)}/ws`;
  });

  afterAll(async () => {
    for (const b of bots) b.ws?.terminate();
    await server.close();
  });

  const bot = () => {
    const b = new Bot('x', url);
    bots.push(b);
    return b;
  };

  test('a guest gets in as the owner; a development token, a made-up one and a Google one do not', async () => {
    const { token } = await guests.issue('Ann');
    const ann = bot();
    await ann.connect({ token });
    assert.equal(ann.welcome.role, 'owner');

    for (const rejected of ['dev:mallory@owner:Mallory', 'demo:garbage', 'google:eyJ.a.b', '']) {
      const b = bot();
      await b.connect({ token: rejected, expectWelcome: false });
      await b.waitFor((m) => m.t === 'error' && m.code === 'auth_failed');
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(b.closed?.code, 4003, rejected);
    }
  });
});
