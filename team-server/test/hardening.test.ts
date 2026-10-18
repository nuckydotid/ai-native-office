import assert from 'node:assert/strict';
import { afterEach, describe, setSystemTime, test } from 'bun:test';
import { WebSocket } from 'ws';
import { lookFromSeed } from '../src/shared/workspace/looks.ts';
import type { ClientMsg, ServerMsg } from '../src/shared/workspace/protocol.ts';
import type { ChatMessage, WorkspaceRole } from '../src/shared/workspace/types.ts';
import { TokenError } from '../src/auth.ts';
import type { Authenticator } from '../src/auth.ts';
import { setSilent } from '../src/log.ts';
import { Room, timing } from '../src/room.ts';
import type { Client } from '../src/room.ts';
import { TokenBucket } from '../src/ratelimit.ts';
import { MemoryStore, compareMessages } from '../src/store.ts';
import type { StoredMessage } from '../src/store.ts';
import { Bot, agentRef, sleep, startDevServer } from './bot.ts';
import { PROTOCOL_VERSION } from '../src/shared/workspace/protocol.ts';

setSilent(true);

type Chat = Extract<ServerMsg, { t: 'chat' }>;
type Err = Extract<ServerMsg, { t: 'error' }>;
type Page = Extract<ServerMsg, { t: 'history.page' }>;

const human = (n: number, over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: `m${String(n).padStart(4, '0')}`, kind: 'human', from: 'dev-seed', fromName: 'seed', look: lookFromSeed('seed'), text: `message ${n}`, at: 1_000_000 + n * 10, mentions: [], ...over,
});

afterEach(() => {
  timing.storeMs = 5000;
  timing.jobMs = 17_000;
});

const open: Bot[] = [];
const bot = (url: string, uid: string, role: WorkspaceRole = 'member') => {
  const b = new Bot(uid, url, role);
  open.push(b);
  return b;
};
afterEach(async () => {
  for (const b of open.splice(0)) b.ws?.terminate();
  await sleep(30);
});

describe('the recent messages a joiner is shown', () => {
  test('stay in order and complete when an old message and a recent one are deleted', async () => {
    const store = new MemoryStore();
    for (let i = 1; i <= 100; i++) await store.appendMessage('main', human(i));
    const { server, url } = await startDevServer({}, { store });
    const boss = await bot(url, 'boss', 'owner').connect();
    assert.equal(boss.welcome.history.length, 30);
    // m0005 is far older than the recent ones kept in memory; m0075 is among them.
    boss.send({ t: 'chat.delete', id: 'm0005' });
    boss.send({ t: 'chat.delete', id: 'm0075' });
    await boss.waitFor((m) => m.t === 'chat.deleted' && m.id === 'm0075');
    const late = await bot(url, 'late').connect();
    const ids = late.welcome.history.map((m) => m.id);
    assert.deepEqual([...late.welcome.history].sort(compareMessages).map((m) => m.id), ids, 'in order');
    assert.equal(ids.length, 30);
    assert.equal(ids.at(-1), 'm0100');
    assert.equal(ids[0], 'm0071', 'the newest 30, none lost to the old tombstone');
    assert.ok(!ids.includes('m0005'));
    assert.equal(late.welcome.history[ids.indexOf('m0075')].deleted, true, 'the recent tombstone is where the message was');
    assert.equal(late.welcome.historyHasMore, true);
    // "Load earlier" continues exactly where the welcome stopped.
    late.send({ t: 'history.get', reqId: 'p1', before: { at: late.welcome.history[0].at, id: ids[0] }, limit: 5 });
    const page = await late.waitFor<Page>((m) => m.t === 'history.page' && m.reqId === 'p1');
    assert.deepEqual(page.messages.map((m) => m.id), ['m0066', 'm0067', 'm0068', 'm0069', 'm0070']);
    await server.close();
  });
});

/** A store that is slow to answer reads. */
class SlowStore extends MemoryStore {
  delay = 0;
  override async getMessage(wid: string, id: string) {
    if (this.delay) await sleep(this.delay);
    return super.getMessage(wid, id);
  }
}

describe('one person cannot block the room', () => {
  test('a flood of agent requests is refused, and everyone else can still chat', async () => {
    const store = new SlowStore();
    const { server, url } = await startDevServer({}, { store });
    const mallory = await bot(url, 'mallory').connect();
    const vic = await bot(url, 'vic').connect();
    store.delay = 25;
    for (let i = 0; i < 60; i++) mallory.send({ t: 'agent.start', reqId: `x${i}`, replyTo: `nope${i}`, agent: agentRef('sarah'), mode: 'resume' });
    for (let i = 0; i < 30; i++) mallory.send({ t: 'agent.reply', reqId: `y${i}`, replyTo: `nope${i}`, agent: agentRef('sarah'), text: 'forged' });
    const said = await vic.say('is anyone there?');
    assert.ok(said.id, 'the chat still works while the flood is being refused');
    await sleep(300);
    const errors = mallory.inbox.filter((m): m is Err => m.t === 'error' && !!m.reqId);
    assert.ok(errors.filter((e) => e.code === 'rate_limited').length >= 50, `${errors.filter((e) => e.code === 'rate_limited').length} refused by budget`);
    await server.close();
  });

  test('a person holds at most a few places in the queue', async () => {
    const store = new SlowStore();
    const { server, url } = await startDevServer({}, { store });
    const ann = await bot(url, 'ann').connect();
    store.delay = 120;
    // Chat has its own, larger budget; the queue's per-person share is what refuses these.
    for (let i = 0; i < 12; i++) ann.send({ t: 'chat.delete', id: `none${i}` });
    await sleep(200);
    const busy = ann.inbox.filter((m): m is Err => m.t === 'error' && m.code === 'busy');
    assert.ok(busy.length >= 2, `${busy.length} told the chat is busy`);
    await server.close();
  });
});

describe('answers an admin has removed', () => {
  test('stay removed; the person who took back their own can ask again', async () => {
    const { server, store, url } = await startDevServer();
    const ann = await bot(url, 'ann').connect();
    const boss = await bot(url, 'boss', 'owner').connect();
    const answer = async (text: string, reqId: string) => {
      const m = await ann.say(`@sarah ${text}`);
      ann.send({ t: 'agent.start', reqId, replyTo: m.id, agent: agentRef('sarah'), mode: 'fresh' });
      await ann.waitFor((x) => x.t === 'agent.status' && x.status.reqId === reqId && x.status.state === 'thinking');
      ann.send({ t: 'agent.reply', reqId, replyTo: m.id, agent: agentRef('sarah'), text: `answer to ${text}` });
      const posted = (await ann.waitFor<Chat>((x) => x.t === 'chat' && x.msg.kind === 'agent' && x.msg.replyTo === m.id)).msg;
      return { m, posted };
    };

    // An admin deletes an answer: it cannot be answered again, by a run or by a late reply.
    const first = await answer('one', 'r1');
    boss.send({ t: 'chat.delete', id: first.posted.id });
    await ann.waitFor((x) => x.t === 'chat.deleted' && x.id === first.posted.id);
    assert.equal(((await store.getMessage('main', first.posted.id)) as StoredMessage).deletedBy, 'dev-boss');
    ann.send({ t: 'agent.reply', reqId: 'again', replyTo: first.m.id, agent: agentRef('sarah'), text: 'something the admin did not want' });
    assert.equal((await ann.waitFor<Err>((x) => x.t === 'error' && x.reqId === 'again')).code, 'not_allowed');
    ann.send({ t: 'agent.start', reqId: 'again2', replyTo: first.m.id, agent: agentRef('sarah'), mode: 'rerun' });
    const refused = await ann.waitFor<Err>((x) => x.t === 'error' && x.reqId === 'again2');
    assert.equal(refused.code, 'not_allowed');
    assert.match(refused.message, /admin removed/);
    assert.equal(((await store.getMessage('main', first.posted.id)) as StoredMessage).deleted, true);

    // The asker takes their own answer back (Undo) and asks again: that works, and the answer is back.
    const second = await answer('two', 'r2');
    ann.send({ t: 'chat.delete', id: second.posted.id });
    await ann.waitFor((x) => x.t === 'chat.deleted' && x.id === second.posted.id);
    ann.send({ t: 'agent.start', reqId: 'r3', replyTo: second.m.id, agent: agentRef('sarah'), mode: 'rerun' });
    await ann.waitFor((x) => x.t === 'agent.status' && x.status.reqId === 'r3' && x.status.state === 'thinking');
    ann.send({ t: 'agent.reply', reqId: 'r3', replyTo: second.m.id, agent: agentRef('sarah'), text: 'second try' });
    await ann.waitFor((x) => x.t === 'agent.status' && x.status.reqId === 'r3' && x.status.state === 'done');
    const back = (await store.getMessage('main', second.posted.id)) as StoredMessage;
    assert.deepEqual([back.text, back.deleted], ['second try', undefined]);
    await server.close();
  });

  test('the asker can take an answer back for a minute, not for ever', async () => {
    const { server, url } = await startDevServer();
    const ann = await bot(url, 'ann').connect();
    const m = await ann.say('@sarah hi');
    ann.send({ t: 'agent.start', reqId: 'r1', replyTo: m.id, agent: agentRef('sarah'), mode: 'fresh' });
    await ann.waitFor((x) => x.t === 'agent.status' && x.status.state === 'thinking');
    ann.send({ t: 'agent.reply', reqId: 'r1', replyTo: m.id, agent: agentRef('sarah'), text: 'hello' });
    const posted = (await ann.waitFor<Chat>((x) => x.t === 'chat' && x.msg.kind === 'agent')).msg;
    // Five minutes later the answer is no longer theirs to take back.
    setSystemTime(new Date(Date.now() + 5 * 60_000));
    ann.send({ t: 'chat.delete', id: posted.id });
    const err = await ann.waitFor<Err>((x) => x.t === 'error' && x.code === 'forbidden');
    assert.match(err.message, /admins/);
    setSystemTime();
    await server.close();
  });
});

describe('a send that is repeated', () => {
  test('is confirmed, not saved twice, even after it has left the recent messages, and a deleted one does not come back', async () => {
    const { server, store, url } = await startDevServer();
    const ann = await bot(url, 'ann').connect();
    const boss = await bot(url, 'boss', 'owner').connect();
    const watcher = await bot(url, 'watcher').connect();
    const first = await ann.say('the first one', 'keep-1');
    // More than the recent messages the room keeps: several people chatting.
    const talkers = await Promise.all(Array.from({ length: 10 }, (_, i) => bot(url, `t${i}`).connect()));
    await Promise.all(talkers.map(async (t, i) => { for (let k = 0; k < 5; k++) await t.say(`talk ${i}.${k}`); }));
    const before = watcher.inbox.length;
    ann.send({ t: 'chat', text: 'the first one', cid: 'keep-1' });
    const again = await ann.next<Chat>((m) => m.t === 'chat' && m.msg.cid === 'keep-1');
    assert.equal(again.msg.id, first.id, 'the same message');
    assert.equal((await store.listMessages('main', { limit: 500 })).messages.filter((m) => m.text === 'the first one').length, 1);
    await sleep(100);
    assert.equal(watcher.inbox.slice(before).filter((m) => m.t === 'chat' && m.msg.id === first.id).length, 0, 'an old message is not shown to everyone again');

    // Deleted, and sent again with the same id: it stays deleted.
    boss.send({ t: 'chat.delete', id: first.id });
    await ann.waitFor((m) => m.t === 'chat.deleted' && m.id === first.id);
    ann.send({ t: 'chat', text: 'the first one', cid: 'keep-1' });
    const echoed = await ann.next<Chat>((m) => m.t === 'chat' && m.msg.cid === 'keep-1');
    assert.equal(echoed.msg.deleted, true);
    assert.equal(((await store.getMessage('main', first.id)) as StoredMessage).deleted, true);
    await server.close();
  });
});

describe('what a person sends about themselves is cleaned', () => {
  test('extra fields on a look never reach anyone', async () => {
    const { server, store, url } = await startDevServer();
    const ws = new WebSocket(url);
    const welcome = await new Promise<Extract<ServerMsg, { t: 'welcome' }>>((resolve, reject) => {
      ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', token: 'dev:ann:ann', workspaceId: 'main', name: 'ann', look: { ...lookFromSeed('ann'), junk: 'x'.repeat(50_000), nested: { a: 1 } }, protocol: PROTOCOL_VERSION })));
      ws.on('message', (d) => {
        const m = JSON.parse(d.toString()) as ServerMsg;
        if (m.t === 'welcome') resolve(m);
      });
      ws.on('error', reject);
    });
    assert.deepEqual(welcome.players[0].look, lookFromSeed('ann'));
    ws.send(JSON.stringify({ t: 'chat', text: 'hi', cid: 'c1' }));
    await sleep(100);
    assert.deepEqual((await store.listMessages('main', { limit: 5 })).messages.at(-1)?.look, lookFromSeed('ann'), 'nor are they saved');
    ws.terminate();
    await server.close();
  });

  test('names from a sign-in are cleaned, and two that only look alike are told apart', async () => {
    const names = new Map<string, string>([
      ['a', `Ann${String.fromCharCode(0x200b)}`],
      ['b', 'x'.repeat(40)],
      ['c', `${'y'.repeat(31)}${String.fromCodePoint(0x1f600)}${String.fromCodePoint(0x1f600)}`],
      ['d', 'Ａｎｎ'],
    ]);
    const auth: Authenticator = { verify: async (t) => ({ uid: `dev-${t}`, name: names.get(t), role: 'member', provider: 'dev' }) };
    const { server, url } = await startDevServer({}, { auth });
    const join = async (t: string) => {
      const b = new Bot(t, url);
      open.push(b);
      return b.connect({ token: t });
    };
    const a = await join('a');
    assert.equal(a.welcome.players.find((p) => p.id === 'dev-a')?.name, 'Ann', 'the invisible character is gone');
    const b = await join('b');
    assert.equal(b.welcome.players.find((p) => p.id === 'dev-b')?.name.length, 32, 'at most 32 characters');
    const c = await join('c');
    const cn = c.welcome.players.find((p) => p.id === 'dev-c')!.name;
    assert.equal(cn, `${'y'.repeat(31)}${String.fromCodePoint(0x1f600)}`, 'cut between whole emoji');
    const d = await join('d');
    assert.notEqual(d.welcome.players.find((p) => p.id === 'dev-d')!.name.normalize('NFKC').toLowerCase(), 'ann', 'full-width “Ann” does not pass for “Ann”');
    await server.close();
  });
});

describe('a person’s budgets', () => {
  test('survive reconnecting', async () => {
    const { server, url } = await startDevServer();
    const first = await bot(url, 'spam').connect();
    for (let i = 0; i < 8; i++) first.send({ t: 'chat', text: `m${i}`, cid: `a${i}` });
    await sleep(150);
    assert.ok(first.inbox.some((m) => m.t === 'error' && m.code === 'rate_limited'));
    first.ws.terminate();
    await sleep(50);
    const again = await bot(url, 'spam').connect();
    for (let i = 0; i < 4; i++) again.send({ t: 'chat', text: `n${i}`, cid: `b${i}` });
    await sleep(150);
    assert.ok(again.inbox.some((m) => m.t === 'error' && m.code === 'rate_limited'), 'a new connection does not refill them');
    await server.close();
  });

  test('joining over and over is refused', async () => {
    const { server, url } = await startDevServer();
    let refused = 0;
    for (let i = 0; i < 13; i++) {
      const b = new Bot('loop', url);
      open.push(b);
      await b.connect({ expectWelcome: false });
      const got = await b.waitFor((m) => m.t === 'welcome' || m.t === 'error', 3000);
      if (got.t === 'error' && got.code === 'rate_limited') refused++;
      b.ws.terminate();
    }
    assert.ok(refused >= 2, `${refused} joins refused`);
    await server.close();
  });
});

describe('when a person is not the one the room thinks', () => {
  const fakeClient = (uid: string, role: WorkspaceRole = 'member') => {
    const sent: ServerMsg[] = [];
    let closed: number | null = null;
    const client: Client = {
      uid, role,
      transport: { send: (d) => void sent.push(JSON.parse(d)), close: (code) => void (closed = code ?? 0) },
      send: (m) => void sent.push(m),
      buckets: { move: new TokenBucket(99, 99), chat: new TokenBucket(99, 99), emote: new TokenBucket(99, 99), edit: new TokenBucket(99, 99), misc: new TokenBucket(99, 99), history: new TokenBucket(99, 99), agent: new TokenBucket(99, 99), session: new TokenBucket(99, 99) },
      lastMoveAt: Date.now(),
    };
    return { client, sent, closed: () => closed };
  };
  const info = (uid: string, over: Partial<Parameters<Room['join']>[1]> = {}) => ({ uid, name: uid, look: lookFromSeed(uid), role: 'member' as WorkspaceRole, ...over });
  const newRoom = (store = new MemoryStore()) => {
    const room = new Room({ id: 'main', name: 'Garden', createdAt: 1 }, [], [], false, store, { maxPlayers: 50 });
    return { room, store };
  };

  test('everyone who signed in gets a place of their own, with the role their sign-in gave', async () => {
    const { room, store } = newRoom();
    const ann = fakeClient('ann');
    room.join(ann.client, info('ann'));
    const boss = fakeClient('boss', 'owner');
    room.join(boss.client, info('boss', { role: 'owner' }));
    assert.equal(ann.closed(), null);
    assert.equal(boss.closed(), null);
    assert.equal(room.players.size, 2);
    assert.deepEqual([room.members.get('ann')?.role, room.members.get('boss')?.role], ['member', 'owner']);
    assert.deepEqual((await store.listMembers('main')).map((m) => m.uid).sort(), ['ann', 'boss'], 'and the place is saved');
    await room.stop();
  });

  test('a member being removed is not let back in until the removal is written', async () => {
    const { room, store } = newRoom();
    const member = { uid: 'bob', role: 'member' as const, name: 'bob', look: lookFromSeed('bob'), desk: null, joinedAt: 1, lastSeen: 1 };
    room.members.set('bob', member);
    await store.putMember('main', member);
    const slowDelete = store.deleteMember.bind(store);
    store.deleteMember = async (w, u) => {
      await sleep(60);
      return slowDelete(w, u);
    };
    const removal = room.removeMember('bob');
    const late = fakeClient('bob');
    room.join(late.client, info('bob'));
    assert.equal(late.closed(), 4003, 'refused while their removal is being written');
    assert.equal((late.sent[0] as Err).code, 'not_a_member');
    await removal;
    assert.equal(room.members.has('bob'), false);
    const later = fakeClient('bob');
    room.join(later.client, info('bob'));
    assert.equal(later.closed(), null, 'and welcome again afterwards, to a place made fresh (a guest who was swept comes back)');
    assert.equal(room.members.has('bob'), true);
    await room.stop();
  });

  test('frames from a window that was replaced do nothing', async () => {
    const { room } = newRoom();
    room.members.set('ann', { uid: 'ann', role: 'member', name: 'ann', look: lookFromSeed('ann'), desk: null, joinedAt: 1, lastSeen: 1 });
    const observer = fakeClient('obs');
    room.members.set('obs', { uid: 'obs', role: 'member', name: 'obs', look: lookFromSeed('obs'), desk: null, joinedAt: 1, lastSeen: 1 });
    room.join(observer.client, info('obs'));
    const oldWindow = fakeClient('ann');
    room.join(oldWindow.client, info('ann'));
    const newWindow = fakeClient('ann');
    room.join(newWindow.client, info('ann'));
    assert.equal(oldWindow.closed(), 4001);
    const before = observer.sent.length;
    room.handle(oldWindow.client, { t: 'chat', text: 'from the old window', cid: 'o1' } as ClientMsg);
    await sleep(60);
    assert.equal(observer.sent.length, before, 'nothing was said');
    room.handle(newWindow.client, { t: 'chat', text: 'from the new window', cid: 'n1' } as ClientMsg);
    await sleep(60);
    assert.ok(observer.sent.some((m) => m.t === 'chat' && m.msg.text === 'from the new window'));
    await room.stop();
  });

  test('removing a member ends their runs and tells everyone why', async () => {
    const { room } = newRoom();
    for (const uid of ['bob', 'obs']) room.members.set(uid, { uid, role: 'member', name: uid, look: lookFromSeed(uid), desk: null, joinedAt: 1, lastSeen: 1 });
    const bob = fakeClient('bob');
    const obs = fakeClient('obs');
    room.join(obs.client, info('obs'));
    room.join(bob.client, info('bob'));
    const base = { uid: 'bob', byName: 'bob', agent: agentRef('sarah'), startedAt: Date.now(), owner: bob.client, offlineSince: null, failures: 0 };
    room.runs.add({ ...base, runId: 'run1', reqId: 'q1', replyTo: 'm1' });
    room.runs.add({ ...base, runId: 'run2', reqId: 'q2', replyTo: 'm2' });
    await room.removeMember('bob');
    const states = obs.sent.filter((m) => m.t === 'agent.status').map((m) => (m as Extract<ServerMsg, { t: 'agent.status' }>).status);
    assert.deepEqual(states.filter((s) => s.state === 'failed').map((s) => [s.runId, s.reason]), [['run1', 'removed'], ['run2', 'removed']]);
    assert.equal(room.runs.size, 0);
    assert.equal(bob.closed(), 4003);
    await room.stop();
  });
});

describe('a database that is slow', () => {
  test('a message that cannot be saved in time is answered, and the room carries on', async () => {
    timing.storeMs = 60;
    timing.jobMs = 400;
    const store = new MemoryStore();
    const slow = store.insertMessage.bind(store);
    let stall = true;
    store.insertMessage = async (w, m) => {
      if (stall) await sleep(200);
      return slow(w, m);
    };
    const { server, url } = await startDevServer({}, { store });
    const ann = await bot(url, 'ann').connect();
    const bob = await bot(url, 'bob').connect();
    ann.send({ t: 'chat', text: 'slow one', cid: 's1' });
    assert.equal((await ann.waitFor<Err>((m) => m.t === 'error' && m.cid === 's1')).code, 'not_saved');
    assert.equal(bob.inbox.filter((m) => m.t === 'chat' && m.msg.text === 'slow one').length, 0);
    stall = false;
    await sleep(250);
    // It did get saved in the end; sending it again finds that, and then everyone is told.
    ann.send({ t: 'chat', text: 'slow one', cid: 's1' });
    await bob.waitFor((m) => m.t === 'chat' && m.msg.text === 'slow one');
    assert.equal((await store.listMessages('main', { limit: 50 })).messages.filter((m) => m.text === 'slow one').length, 1);
    await server.close();
  });

  test('a job that takes longer than allowed stops changing anything, and the person is told', async () => {
    timing.storeMs = 100;
    timing.jobMs = 150;
    const store = new SlowStore();
    const { server, url } = await startDevServer({}, { store });
    const ann = await bot(url, 'ann').connect();
    const bob = await bot(url, 'bob').connect();
    const m = await ann.say('@sarah hi');
    store.delay = 90;
    ann.send({ t: 'agent.start', reqId: 'r1', replyTo: m.id, agent: agentRef('sarah'), mode: 'fresh' });
    const err = await ann.waitFor<Err>((x) => x.t === 'error' && x.reqId === 'r1', 3000);
    assert.equal(err.code, 'unavailable');
    store.delay = 0;
    await sleep(300);
    assert.equal((await server.office.get()).runs.get('dev-ann', 'r1'), undefined, 'the late job did not start a run');
    assert.ok((await bob.say('still working')).id, 'the room was not held up');
    await server.close();
  });

  test('an answer that was saved but not confirmed in time is shown to everyone when it is sent again', async () => {
    timing.storeMs = 60;
    timing.jobMs = 500;
    const store = new MemoryStore();
    const real = store.insertMessageOnce.bind(store);
    let stall = true;
    store.insertMessageOnce = async (w, m, o) => {
      const saved = await real(w, m, o);
      if (stall) await sleep(200);
      return saved;
    };
    const { server, url } = await startDevServer({}, { store });
    const ann = await bot(url, 'ann').connect();
    const bob = await bot(url, 'bob').connect();
    const m = await ann.say('@sarah hi');
    ann.send({ t: 'agent.start', reqId: 'r1', replyTo: m.id, agent: agentRef('sarah'), mode: 'fresh' });
    await ann.waitFor((x) => x.t === 'agent.status' && x.status.state === 'thinking');
    ann.send({ t: 'agent.reply', reqId: 'r1', replyTo: m.id, agent: agentRef('sarah'), text: 'the answer' });
    assert.equal((await ann.waitFor<Err>((x) => x.t === 'error' && x.reqId === 'r1')).code, 'not_saved');
    assert.equal(bob.inbox.filter((x) => x.t === 'chat' && x.msg.kind === 'agent').length, 0, 'nobody saw it yet');
    stall = false;
    await sleep(250);
    ann.send({ t: 'agent.reply', reqId: 'r1', replyTo: m.id, agent: agentRef('sarah'), text: 'the answer' });
    const shown = (await bob.waitFor<Chat>((x) => x.t === 'chat' && x.msg.kind === 'agent')).msg;
    assert.equal(shown.text, 'the answer');
    await ann.waitFor((x) => x.t === 'agent.status' && x.status.state === 'done');
    await server.close();
  });
});

describe('sign-in problems', () => {
  test('a bad token is the person’s problem; a failure on our side is not, and says to try again', async () => {
    let mode: 'token' | 'ours' = 'token';
    const auth: Authenticator = {
      verify: async () => {
        if (mode === 'token') throw new TokenError('bad token');
        throw new Error('database timeout: query read timeout');
      },
    };
    const { server, url, base } = await startDevServer({}, { auth });
    const board = () => fetch(`${base}/board`, { headers: { authorization: 'Bearer x' } });
    const hello = async () => {
      const b = new Bot('x', url);
      open.push(b);
      await b.connect({ expectWelcome: false });
      const err = await b.waitFor<Err>((m) => m.t === 'error');
      await sleep(50);
      return { code: err.code, closed: b.closed?.code };
    };
    assert.deepEqual(await hello(), { code: 'auth_failed', closed: 4003 });
    assert.equal((await board()).status, 401);
    mode = 'ours';
    assert.deepEqual(await hello(), { code: 'unavailable', closed: 1013 });
    const refused = await board();
    assert.equal(refused.status, 503);
    assert.equal(((await refused.json()) as { error: string }).error, 'unavailable');
    await server.close();
  });
});

describe('who an address belongs to', () => {
  test('a forwarded address is only believed behind a proxy that is ours', async () => {
    const hit = async (base: string, n: number) => {
      const codes: number[] = [];
      for (let i = 0; i < n; i++) codes.push((await fetch(`${base}/board`, { headers: { 'x-forwarded-for': `10.0.${i}.1`, authorization: `Bearer dev:caller${i}:x` } })).status);
      return codes;
    };
    const tight = { collabLimits: { ip: [20, 2] as [number, number] } };
    const plain = await startDevServer({}, tight);
    assert.ok((await hit(plain.base, 30)).includes(429), 'writing a different address on every request does not help');
    await plain.server.close();

    process.env.TRUST_PROXY_HOPS = '1';
    try {
      const behind = await startDevServer({}, tight);
      assert.ok(!(await hit(behind.base, 30)).includes(429), 'behind a proxy the last hop is the caller');
      await behind.server.close();
    } finally {
      delete process.env.TRUST_PROXY_HOPS;
    }
  });
});
