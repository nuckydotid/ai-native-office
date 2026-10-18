// ui-check-ignore-file: the test map's zone colors are map data, not app styling
import assert from 'node:assert/strict';
import { describe, test, type TestContext } from 'node:test';
import { lookFromSeed } from '../shared/workspace/looks.ts';
import type { AgentStatus, ClientMsg, ServerMsg } from '../shared/workspace/protocol.ts';
import type { ChatMessage } from '../shared/workspace/types.ts';
import { LocalRoom } from './net/local.ts';
import { OfficeSession } from './session.ts';
import { ScriptedRoom } from './testRoom.ts';
import { useOffice } from './store.ts';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const map = { id: 'm', name: 'm', width: 1, height: 1, floor: [1], wall: [0], zones: [], props: [], spawns: [] };
const msg = (n: number, over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: `m${String(n).padStart(4, '0')}`, kind: 'human', from: 'ann', fromName: 'Ann', text: `message ${n}`, at: n * 10, ...over,
});
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => msg(from + i));
const welcomeOf = (history: ChatMessage[], more = false, thinking: AgentStatus[] = []): ServerMsg => ({
  t: 'welcome', you: 'me', role: 'member', workspace: { id: 'main', name: 'HQ' }, map, players: [], deskOwners: {}, history, historyHasMore: more, thinking, protocol: 2, serverTime: 0,
});
const john = { handle: 'john', name: 'John', look: lookFromSeed('agent:john') };
const status = (over: Partial<AgentStatus> = {}): AgentStatus => ({ runId: 'run1', reqId: 'r1', agent: john, by: 'me', byName: 'Me', replyTo: 'm0001', state: 'thinking', ...over });

function scripted(t: TestContext, opts: { sendTimeoutMs?: number; pageTimeoutMs?: number } = {}) {
  const room = new ScriptedRoom();
  const session = new OfficeSession({ room, ...opts });
  session.start();
  t.after(() => session.stop());
  return { room, session };
}

describe('joining', () => {
  test('the welcome fills the store', (t) => {
    const { room } = scripted(t);
    assert.equal(useOffice.getState().loaded, false);
    room.deliver(welcomeOf(range(1, 3), true));
    const s = useOffice.getState();
    assert.equal(s.loaded, true);
    assert.equal(s.you, 'me');
    assert.equal(s.role, 'member');
    assert.equal(s.officeName, 'HQ');
    assert.equal(s.chat.length, 3);
    assert.equal(s.historyHasMore, true);
  });

  test('joining again after a short break keeps what was loaded; after a long one starts over', (t) => {
    const { room } = scripted(t);
    room.deliver(welcomeOf(range(41, 50), true));
    useOffice.getState().addPage(range(31, 40), true);
    room.deliver(welcomeOf(range(46, 55), true));
    let s = useOffice.getState();
    assert.deepEqual([s.chat[0].id, s.chat.length, s.restarts], ['m0031', 25, 0]);
    room.deliver(welcomeOf(range(200, 209), true));
    s = useOffice.getState();
    assert.deepEqual([s.chat[0].id, s.chat.length, s.restarts], ['m0200', 10, 1]);
  });

  test('the role can change while connected', (t) => {
    const { room } = scripted(t);
    room.deliver(welcomeOf([]));
    room.deliver({ t: 'role', role: 'admin' });
    assert.equal(useOffice.getState().role, 'admin');
  });
});

describe('sending', () => {
  test('a message is done when the server’s copy comes back with its id, and not before', async (t) => {
    const { room, session } = scripted(t);
    room.deliver(welcomeOf([]));
    let result: unknown = null;
    const pending = session.sendChat('  hello  ').then((r) => (result = r));
    const sent = room.last('chat')!;
    assert.equal(sent.text, 'hello', 'trimmed');
    assert.ok(sent.cid);
    await tick();
    assert.equal(result, null, 'still waiting');
    assert.equal(useOffice.getState().chat.length, 0, 'nothing is shown as sent before the server has it');
    room.deliver({ t: 'chat', msg: msg(1, { from: 'me', fromName: 'Me', text: 'hello', cid: sent.cid }) });
    await pending;
    assert.deepEqual(result, { ok: true, cid: sent.cid });
    assert.equal(useOffice.getState().chat.length, 1);
    assert.equal(session.sentHere(sent.cid), true);
    assert.equal(session.sentHere('someone-elses'), false);
  });

  test('a refusal comes back as the reason', async (t) => {
    const { room, session } = scripted(t);
    room.deliver(welcomeOf([]));
    const pending = session.sendChat('hi');
    const cid = room.last('chat')!.cid!;
    room.deliver({ t: 'error', code: 'rate_limited', message: 'Slow down a little.', cid });
    assert.deepEqual(await pending, { ok: false, cid, message: 'Slow down a little.' });
    assert.equal(useOffice.getState().notice, null, 'the composer shows it, not a banner');
  });

  test('without a connection it fails at once', async (t) => {
    const { room, session } = scripted(t);
    room.connected = false;
    const r = await session.sendChat('hi');
    assert.equal(r.ok, false);
    assert.match(r.ok ? '' : r.message, /not connected/);
  });

  test('silence for too long, or a dropped connection, is reported as unconfirmed rather than as sent', async (t) => {
    const { room, session } = scripted(t, { sendTimeoutMs: 20 });
    room.deliver(welcomeOf([]));
    const slow = await session.sendChat('hi');
    assert.equal(slow.ok, false);
    assert.match(slow.ok ? '' : slow.message, /didn’t confirm/);
    const dropped = session.sendChat('again');
    room.status({ state: 'reconnecting' });
    const r = await dropped;
    assert.equal(r.ok, false);
    assert.match(r.ok ? '' : r.message, /Couldn’t confirm/);
  });

  test('an empty message is not sent', async (t) => {
    const { room, session } = scripted(t);
    assert.equal((await session.sendChat('   ')).ok, false);
    assert.equal(room.sent.length, 0);
  });

  test('speech bubbles are only for people, and only for what is said now', (t) => {
    const { room, session } = scripted(t);
    const said: string[] = [];
    session.bubbles.on((b) => said.push(b.text));
    room.deliver(welcomeOf(range(1, 3)));
    room.deliver({ t: 'chat', msg: msg(4, { text: 'hello' }) });
    room.deliver({ t: 'chat', msg: msg(5, { kind: 'agent', from: 'agent:john', text: 'an answer' }) });
    room.deliver({ t: 'chat', msg: msg(6, { kind: 'system', from: 'system', text: 'a note' }) });
    assert.deepEqual(said, ['hello']);
  });
});

describe('earlier messages', () => {
  test('one page at a time, from the oldest message on screen', (t) => {
    const { room, session } = scripted(t);
    room.deliver(welcomeOf(range(61, 90), true));
    session.loadEarlier();
    session.loadEarlier();
    const asks = room.sent.filter((m) => m.t === 'history.get');
    assert.equal(asks.length, 1, 'a second press while waiting does nothing');
    const ask = asks[0] as Extract<ClientMsg, { t: 'history.get' }>;
    assert.deepEqual(ask.before, { at: 610, id: 'm0061' });
    assert.equal(useOffice.getState().loadingEarlier, true);
    room.deliver({ t: 'history.page', reqId: 'someone-elses', messages: range(1, 5), hasMore: false });
    assert.equal(useOffice.getState().chat.length, 30, 'a page nobody asked for is ignored');
    room.deliver({ t: 'history.page', reqId: ask.reqId, messages: range(11, 60), hasMore: true });
    const s = useOffice.getState();
    assert.equal(s.chat.length, 80);
    assert.equal(s.chat[0].id, 'm0011');
    assert.equal(s.historyHasMore, true);
    assert.equal(s.loadingEarlier, false);
  });

  test('nothing is asked when there is nothing earlier', (t) => {
    const { room, session } = scripted(t);
    room.deliver(welcomeOf(range(1, 3), false));
    session.loadEarlier();
    assert.equal(room.last('history.get'), undefined);
  });

  test('a page the server could not give is explained in words, and the button works again', (t) => {
    const { room, session } = scripted(t);
    room.deliver(welcomeOf(range(61, 90), true));
    session.loadEarlier();
    // What the server really sends: a short code, not a sentence.
    room.deliver({ t: 'history.page', reqId: room.last('history.get')!.reqId, messages: [], hasMore: true, error: 'unavailable' });
    const s = useOffice.getState();
    assert.match(s.notice ?? '', /history didn’t answer/);
    assert.equal(s.loadingEarlier, false);
    session.loadEarlier();
    assert.equal(room.sent.filter((m) => m.t === 'history.get').length, 2);
  });

  test('a page the server refused because of the rate limit says so', (t) => {
    const { room, session } = scripted(t);
    room.deliver(welcomeOf(range(61, 90), true));
    session.loadEarlier();
    room.deliver({ t: 'error', code: 'rate_limited', message: 'Slow down a little.', reqId: room.last('history.get')!.reqId });
    const s = useOffice.getState();
    assert.equal(s.notice, 'Slow down a little.');
    assert.equal(s.loadingEarlier, false);
  });

  test('joining again ends a wait for a page that was asked for on the connection before', (t) => {
    const { room, session } = scripted(t);
    room.deliver(welcomeOf(range(61, 90), true));
    session.loadEarlier();
    assert.equal(useOffice.getState().loadingEarlier, true);
    room.deliver(welcomeOf(range(61, 91), true));
    assert.equal(useOffice.getState().loadingEarlier, false);
    session.loadEarlier();
    assert.equal(room.sent.filter((m) => m.t === 'history.get').length, 2, 'the button works at once');
  });

  test('no answer in time ends the wait', async (t) => {
    const { room, session } = scripted(t, { pageTimeoutMs: 15 });
    room.deliver(welcomeOf(range(61, 90), true));
    session.loadEarlier();
    await sleep(40);
    assert.equal(useOffice.getState().loadingEarlier, false);
    assert.match(useOffice.getState().notice ?? '', /slow/);
  });

  test('losing the connection ends the wait too', (t) => {
    const { room, session } = scripted(t);
    room.deliver(welcomeOf(range(61, 90), true));
    session.loadEarlier();
    room.status({ state: 'reconnecting' });
    assert.equal(useOffice.getState().loadingEarlier, false);
  });
});

describe('deleting', () => {
  test('a deleted message is replaced by its tombstone', (t) => {
    const { room, session } = scripted(t);
    room.deliver(welcomeOf(range(1, 3)));
    session.deleteMessage('m0002');
    assert.deepEqual(room.last('chat.delete'), { t: 'chat.delete', id: 'm0002' });
    room.deliver({ t: 'chat.deleted', id: 'm0002' });
    const gone = useOffice.getState().chat[1];
    assert.equal(gone.deleted, true);
    assert.equal(gone.text, '');
  });
});

describe('agents that are preparing an answer', () => {
  test('are listed while they work and gone when they are done, each run on its own', (t) => {
    const { room } = scripted(t);
    room.deliver(welcomeOf([]));
    room.deliver({ t: 'agent.status', status: status() });
    room.deliver({ t: 'agent.status', status: status({ runId: 'run2', reqId: 'r2', agent: { ...john, handle: 'sarah', name: 'Sarah' }, state: 'queued' }) });
    assert.deepEqual(useOffice.getState().pending.map((p) => [p.runId, p.state]), [['run1', 'thinking'], ['run2', 'queued']]);
    room.deliver({ t: 'agent.status', status: status({ runId: 'run2', reqId: 'r2', state: 'thinking' }) });
    assert.deepEqual(useOffice.getState().pending.map((p) => [p.runId, p.state]), [['run1', 'thinking'], ['run2', 'thinking']]);
    room.deliver({ t: 'agent.status', status: status({ state: 'done' }) });
    assert.deepEqual(useOffice.getState().pending.map((p) => p.runId), ['run2']);
    room.deliver({ t: 'agent.status', status: status({ runId: 'run2', state: 'expired' }) });
    assert.deepEqual(useOffice.getState().pending, []);
  });

  test('what the server says on joining replaces what this window thought', (t) => {
    const { room } = scripted(t);
    room.deliver(welcomeOf([]));
    room.deliver({ t: 'agent.status', status: status() });
    room.deliver(welcomeOf([], false, [status({ runId: 'other', offline: true })]));
    assert.deepEqual(useOffice.getState().pending.map((p) => [p.runId, p.offline]), [['other', true]]);
  });
});

describe('what arrived while the page was hidden', () => {
  test('only messages from others are counted, and looking clears it', (t) => {
    const { room } = scripted(t);
    room.deliver(welcomeOf(range(1, 2)));
    const store = useOffice.getState();
    store.setVisible(false);
    room.deliver({ t: 'chat', msg: msg(3) });
    room.deliver({ t: 'chat', msg: msg(3) });
    room.deliver({ t: 'chat', msg: msg(4, { from: 'me' }) });
    room.deliver({ t: 'chat', msg: msg(5, { kind: 'system', from: 'system' }) });
    room.deliver({ t: 'chat', msg: msg(6, { kind: 'agent', from: 'agent:john' }) });
    assert.equal(useOffice.getState().hiddenUnread, 2, 'Ann once (the repeat is not new) and the agent');
    useOffice.getState().setVisible(true);
    assert.equal(useOffice.getState().hiddenUnread, 0);
    room.deliver({ t: 'chat', msg: msg(7) });
    assert.equal(useOffice.getState().hiddenUnread, 0, 'while looking, nothing is unread');
  });
});

describe('with the practice office', () => {
  test('a person can send, page back and delete, end to end', async (t) => {
    let clock = 1_000_000;
    const room = new LocalRoom({ uid: 'me', name: 'Me', look: lookFromSeed('me'), now: () => (clock += 2), rand: () => 'r' });
    const session = new OfficeSession({ room });
    session.start();
    t.after(() => session.stop());
    await tick();
    assert.equal(useOffice.getState().loaded, true);
    for (let i = 1; i <= 45; i++) assert.equal((await session.sendChat(`message ${i}`)).ok, true);
    assert.equal(useOffice.getState().chat.length, 46);
    // Join again: the latest 30 are merged into what is already there, and nothing is lost or repeated.
    room.close();
    room.open();
    await tick();
    assert.equal(useOffice.getState().chat.length, 46);
    assert.equal(useOffice.getState().historyHasMore, false, 'everything is already loaded');
    const last = useOffice.getState().chat.at(-1)!;
    session.deleteMessage(last.id);
    await tick();
    assert.equal(useOffice.getState().chat.at(-1)!.deleted, true);
  });

  test('a fresh visit shows the latest 30 and “Load earlier” brings the rest', async (t) => {
    let clock = 1_000_000;
    const room = new LocalRoom({ uid: 'me', name: 'Me', look: lookFromSeed('me'), now: () => (clock += 2), rand: () => 'r' });
    const first = new OfficeSession({ room });
    first.start();
    await tick();
    for (let i = 1; i <= 45; i++) await first.sendChat(`message ${i}`);
    first.stop();
    const second = new OfficeSession({ room });
    second.start();
    t.after(() => second.stop());
    await tick();
    assert.equal(useOffice.getState().chat.length, 30, 'a new visit starts from the latest');
    assert.equal(useOffice.getState().historyHasMore, true);
    second.loadEarlier();
    await tick();
    assert.equal(useOffice.getState().chat.length, 46);
    assert.equal(useOffice.getState().historyHasMore, false);
    assert.equal(useOffice.getState().chat[0].kind, 'system');
  });
});

describe('what was kept while away', () => {
  /** The person has m0001..m0060 (the latest 30, then two pages earlier) and then loses the connection. */
  function holding(t: TestContext) {
    const ctx = scripted(t);
    ctx.room.deliver(welcomeOf(range(31, 60), true));
    useOffice.getState().addPage(range(1, 30), false);
    return ctx;
  }

  test('a removal that happened while away shows up in the older messages that were kept', (t) => {
    const { room } = holding(t);
    // Back again: the latest 30 are m0041..m0070. m0010 was removed meanwhile, which the tail does not mention.
    room.deliver(welcomeOf(range(41, 70), true));
    const ask = room.last('history.get')!;
    assert.deepEqual(ask.before, { at: 410, id: 'm0041' }, 'asks about what is older than the tail');
    assert.equal(useOffice.getState().chat.find((m) => m.id === 'm0010')!.deleted, undefined, 'not known yet');
    const removed = (list: ChatMessage[]) => list.map((m) => (m.id === 'm0010' ? { ...m, text: '', deleted: true } : m));
    // The first page (the 30 before the tail) doesn't reach m0010, so it asks for the next one.
    room.deliver({ t: 'history.page', reqId: ask.reqId, messages: removed(range(11, 40)), hasMore: true });
    const next = room.last('history.get')!;
    assert.notEqual(next.reqId, ask.reqId);
    assert.deepEqual(next.before, { at: 110, id: 'm0011' });
    assert.equal(next.limit, 10, 'and then only what is left (m0001 to m0010)');
    room.deliver({ t: 'history.page', reqId: next.reqId, messages: removed(range(1, 10)), hasMore: false });
    const kept = useOffice.getState().chat.find((m) => m.id === 'm0010')!;
    assert.equal(kept.deleted, true);
    assert.equal(kept.text, '');
    assert.equal(room.all('history.get').length, 2, 'it stopped when it had reached the oldest message it kept');
  });

  test('what cannot be checked is let go, and Load earlier brings it back as the server has it', (t) => {
    const { room } = holding(t);
    room.deliver(welcomeOf(range(41, 70), true));
    const ask = room.last('history.get')!;
    room.deliver({ t: 'error', code: 'rate_limited', message: 'Slow down.', reqId: ask.reqId });
    const s = useOffice.getState();
    assert.equal(s.chat[0].id, 'm0041', 'nothing older than the tail is kept unchecked');
    assert.equal(s.historyHasMore, true);
  });

  test('only a few pages are checked; beyond that the oldest are let go', (t) => {
    const { room } = holding(t);
    useOffice.setState({ chat: range(1, 445) });
    room.deliver(welcomeOf(range(441, 470), true));
    for (let page = 0; page < 6; page++) {
      const ask = room.last('history.get')!;
      const upto = (ask.before!.at / 10) - 1;
      room.deliver({ t: 'history.page', reqId: ask.reqId, messages: range(upto - 49, upto), hasMore: true });
    }
    assert.equal(room.all('history.get').length, 6, 'it stops asking');
    const s = useOffice.getState();
    assert.equal(s.historyHasMore, true);
    assert.ok(s.chat[0].at >= 440 * 10 - 6 * 50 * 10, `the oldest are gone: ${s.chat[0].id}`);
  });

  test('checking what was kept does not load history that was never loaded', (t) => {
    const { room } = scripted(t);
    // Only the latest 30 were ever loaded; the person has not paged back.
    room.deliver(welcomeOf(range(31, 60), true));
    room.deliver(welcomeOf(range(41, 70), true));
    const ask = room.last('history.get')!;
    assert.deepEqual(ask.before, { at: 410, id: 'm0041' });
    assert.equal(ask.limit, 10, 'asks for as many as it holds (m0031 to m0040), not a whole page');
    // The server's page reaches back to the very start, and says m0035 (kept, older than the new tail) was removed.
    const page = range(1, 40).map((m) => (m.id === 'm0035' ? { ...m, text: '', deleted: true } : m));
    room.deliver({ t: 'history.page', reqId: ask.reqId, messages: page, hasMore: false });
    const s = useOffice.getState();
    assert.equal(s.chat[0].id, 'm0031', 'nothing older than what the person already had is added');
    assert.equal(s.chat.length, 40);
    assert.equal(s.chat.find((m) => m.id === 'm0035')!.deleted, true, 'the removal is applied');
    assert.equal(s.historyHasMore, true, 'there is still older history to load on request');
  });

  test('nothing is asked when nothing older was kept', (t) => {
    const { room } = scripted(t);
    room.deliver(welcomeOf(range(41, 70), true));
    room.deliver(welcomeOf(range(41, 74), true));
    assert.equal(room.all('history.get').length, 0);
  });

  test('losing the connection while checking leaves it to the next welcome', (t) => {
    const { room } = holding(t);
    room.deliver(welcomeOf(range(41, 70), true));
    room.status({ state: 'reconnecting' });
    room.deliver(welcomeOf(range(45, 74), true));
    assert.equal(room.all('history.get').length, 2, 'asked again after rejoining');
  });
});

describe('sending again', () => {
  test('a send that is tried again with the same id is not a new message', async (t) => {
    const { room, session } = scripted(t, { sendTimeoutMs: 15 });
    room.deliver(welcomeOf([]));
    const first = await session.sendChat('hello');
    assert.equal(first.ok, false);
    const again = session.sendChat('hello', first.cid);
    assert.equal(room.all('chat').length, 2);
    assert.equal(room.all('chat')[1].cid, first.cid, 'the same id, so the server can tell it already has it');
    room.deliver({ t: 'chat', msg: msg(1, { from: 'me', text: 'hello', cid: first.cid }) });
    assert.equal((await again).ok, true);
    assert.equal(session.sentHere(first.cid), true);
  });

  test('an id that is not safe is not reused', async (t) => {
    const { room, session } = scripted(t, { sendTimeoutMs: 10 });
    room.deliver(welcomeOf([]));
    void session.sendChat('hi', 'not valid!');
    assert.match(room.all('chat')[0].cid ?? '', /^c[a-z0-9-]+$/);
  });
});

describe('the count of unread messages', () => {
  test('messages that came while away and hidden count too, and leaving clears the count', (t) => {
    const { room, session } = scripted(t);
    room.deliver(welcomeOf(range(31, 60), true));
    useOffice.getState().setVisible(false);
    room.deliver(welcomeOf(range(41, 70), true));
    assert.equal(useOffice.getState().hiddenUnread, 10, 'm0061..m0070 are new');
    session.stop();
    const s = useOffice.getState();
    assert.deepEqual([s.hiddenUnread, s.visible], [0, true]);
  });
});

describe('the cap', () => {
  test('while the person reads further up the oldest messages are not trimmed; back at the bottom they are', (t) => {
    const { room } = scripted(t);
    const store = useOffice;
    room.deliver(welcomeOf(range(1, 1999), true));
    store.getState().setAtBottom(false);
    room.deliver({ t: 'chat', msg: msg(2000) });
    room.deliver({ t: 'chat', msg: msg(2001) });
    room.deliver({ t: 'chat', msg: msg(2002) });
    assert.equal(store.getState().chat.length, 2002, 'nothing trimmed while reading');
    store.getState().setAtBottom(true);
    const s = store.getState();
    assert.equal(s.chat.length, 2000);
    assert.equal(s.chat[0].id, 'm0003');
    assert.equal(s.historyHasMore, true);
  });

  test('a page for a list that lost the message it continues from is dropped', (t) => {
    const { room } = scripted(t);
    room.deliver(welcomeOf(range(1001, 1030), true));
    const from = { at: 10010, id: 'm1001' };
    useOffice.setState({ chat: useOffice.getState().chat.slice(3) });
    useOffice.getState().addPage(range(951, 1000), true, from);
    assert.equal(useOffice.getState().chat[0].id, 'm1004', 'it would have left a gap');
    assert.equal(useOffice.getState().loadingEarlier, false);
  });
});

describe('room movement and hold time', () => {
  const multiZoneMap = {
    id: 'm',
    name: 'HQ',
    width: 20,
    height: 20,
    floor: new Array(400).fill(1),
    wall: new Array(400).fill(0),
    zones: [
      { id: 'lobby', name: 'Lobby', x: 0, y: 0, w: 5, h: 5, kind: 'lobby' as const, color: 'blue' },
      { id: 'design', name: 'Design Studio', x: 6, y: 0, w: 5, h: 5, kind: 'open' as const, color: 'purple' },
    ],
    props: [],
    spawns: [{ x: 2, y: 2 }],
  };

  test('doorways keep previous room and a new room holds for 250ms before switching', async (t) => {
    const { room, session } = scripted(t);
    room.deliver({
      t: 'welcome',
      you: 'me',
      role: 'member',
      workspace: { id: 'main', name: 'HQ' },
      map: multiZoneMap,
      players: [{ id: 'me', name: 'Me', x: 2, y: 2, dir: 'down', moving: false, sitting: null, status: 'available', look: lookFromSeed('me'), desk: null }],
      deskOwners: {},
      history: [msg(1, { room: 'lobby', session: 's1' })],
      historyHasMore: false,
      thinking: [],
      room: 'lobby',
      sessions: [{ id: 's1', room: 'lobby', state: 'active', createdAt: 1000, createdBy: 'me' }],
      protocol: 3,
      serverTime: 0,
    });

    session.look();
    assert.equal(useOffice.getState().roomId, 'lobby');
    assert.equal(useOffice.getState().zone, 'Lobby');

    // Walk into doorway / wall (null zone at x=5.5)
    session.world.me!.x = 5.5;
    session.world.me!.y = 2;
    session.look();
    assert.equal(useOffice.getState().roomId, 'lobby', 'null zone preserves current room');

    // Step into Design Studio at x=7
    session.world.me!.x = 7;
    session.world.me!.y = 2;
    session.look();
    assert.equal(useOffice.getState().roomId, 'lobby', 'does not switch immediately');

    // Wait for 260ms
    await sleep(260);
    session.look();
    assert.equal(useOffice.getState().roomId, 'design', 'switches after 250ms hold');
    assert.equal(useOffice.getState().zone, 'Design Studio');

    // Swapping to design fetched history for design
    const historyGets = room.all('history.get');
    assert.equal(historyGets.some((h) => h.room === 'design'), true);

    // Messages for lobby do not pollute design room chat
    room.deliver({ t: 'chat', msg: msg(2, { room: 'lobby', session: 's1', text: 'lobby chat' }) });
    assert.equal(useOffice.getState().chat.some((m) => m.text === 'lobby chat'), false);
    assert.equal(useOffice.getState().views.lobby?.chat.some((m) => m.text === 'lobby chat'), true);
  });
});

describe('session lifecycle in the client', () => {
  test('session.update, session.removed, and actions work through session and store', async (t) => {
    const { room, session } = scripted(t);
    room.deliver({
      t: 'welcome',
      you: 'me',
      role: 'owner',
      workspace: { id: 'main', name: 'HQ' },
      map,
      players: [],
      deskOwners: {},
      history: [msg(1, { room: 'lobby', session: 's1', text: 'first session' })],
      historyHasMore: false,
      thinking: [],
      room: 'lobby',
      sessions: [{ id: 's1', room: 'lobby', state: 'active', createdAt: 1000, createdBy: 'me' }],
      protocol: 3,
      serverTime: 0,
    });

    assert.equal(useOffice.getState().sessions.length, 1);
    assert.equal(useOffice.getState().chat.length, 1);

    // Owner creates new session
    session.newSession('lobby');
    assert.equal(room.last('session.new')?.room, 'lobby');

    // Server announces old session archived and new session active
    room.deliver({
      t: 'session.update',
      session: { id: 's1', room: 'lobby', state: 'archived', createdAt: 1000, archivedAt: 2000, createdBy: 'me' },
    });
    room.deliver({
      t: 'session.update',
      session: { id: 's2', room: 'lobby', state: 'active', createdAt: 2000, createdBy: 'me' },
    });

    assert.equal(useOffice.getState().sessions.length, 2);
    assert.equal(useOffice.getState().chat.length, 0, 'new active session starts with fresh empty chat');

    // Delete session removes it and drops messages
    session.deleteSession('s1');
    assert.equal(room.last('session.delete')?.session, 's1');
    room.deliver({ t: 'session.removed', id: 's1', room: 'lobby' });
    assert.equal(useOffice.getState().sessions.length, 1);
    assert.equal(useOffice.getState().sessions[0].id, 's2');
  });
});

describe('opening a page', () => {
  // A strip of rooms: the lobby, the two fixed rooms, and the person's own zone.
  const rooms = { ...map, width: 8, height: 4, floor: Array.from({ length: 32 }, () => 1), wall: Array.from({ length: 32 }, () => 0),
    zones: [
      { id: 'lobby', name: 'Lobby', kind: 'lobby' as const, x: 0, y: 0, w: 2, h: 4, color: '#fff' },
      { id: 'plan', name: 'Plan Room', kind: 'open' as const, x: 2, y: 0, w: 2, h: 4, color: '#fff' },
      { id: 'review', name: 'Review Room', kind: 'open' as const, x: 4, y: 0, w: 2, h: 4, color: '#fff' },
      { id: 'z-me', name: 'My zone', kind: 'open' as const, x: 6, y: 0, w: 2, h: 4, color: '#fff' },
    ], spawns: [{ x: 0.5, y: 0.5 }] };
  const standing = (x: number, y: number): ServerMsg => ({
    t: 'welcome', you: 'me', role: 'member', workspace: { id: 'main', name: 'HQ' }, map: rooms,
    players: [{ id: 'me', name: 'Me', x, y, dir: 'down', moving: false, sitting: null, status: 'available', look: lookFromSeed('me'), desk: null }],
    deskOwners: {}, history: [], historyHasMore: false, thinking: [], protocol: 6, serverTime: 0,
  });

  test('the page is told at once, and the character is asked to walk to its room', (t) => {
    const { room, session } = scripted(t);
    room.deliver(standing(0.5, 0.5));
    session.setPage('plan');
    assert.deepEqual(room.last('page.set'), { t: 'page.set', page: 'plan' }, 'presence follows the page right away');
    assert.equal(room.last('move'), undefined, 'no teleport: the character walks');
    assert.equal(session.takeWalkRequest(), 'plan', 'the engine is asked once');
    assert.equal(session.takeWalkRequest(), null);
    assert.equal(useOffice.getState().roomId, 'plan', 'the chat is on the Plan Room already');
  });

  test('a page opened before the office answered still ends in its own room', (t) => {
    const { room, session } = scripted(t);
    session.setPage('plan'); // the app opens on Plan, before the welcome arrives
    room.deliver(standing(0.5, 0.5));
    assert.equal(useOffice.getState().roomId, 'plan', 'the welcome does not send the chat back to the lobby');
    assert.equal(session.takeWalkRequest(), 'plan', 'and the character is asked to walk there');
    assert.deepEqual(room.last('page.set'), { t: 'page.set', page: 'plan' });
  });

  test('walking out of a room does not flip the chat on the way; the feet rule again once the walk is over', async (t) => {
    const { room, session } = scripted(t);
    room.deliver(standing(2.5, 0.5)); // standing in the Plan Room
    session.setPage('plan');
    session.walkEnded(); // arrived
    session.setPage('progress'); // walking out, through the Plan Room zone, to the lobby
    assert.equal(useOffice.getState().roomId, 'lobby', 'the chat is the office at once');
    await sleep(260);
    session.look();
    assert.equal(useOffice.getState().roomId, 'lobby', 'still passing the Plan Room: the chat does not flip back');
    session.walkEnded();
    session.look();
    await sleep(260);
    session.look();
    assert.equal(useOffice.getState().roomId, 'plan', 'the walk is over: the room follows where the person stands');
  });
});
