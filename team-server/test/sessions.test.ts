import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'bun:test';
import type { AgentStatus, ServerMsg } from '../src/shared/workspace/protocol.ts';
import type { ChatMessage, SessionInfo, WorkspaceRole } from '../src/shared/workspace/types.ts';
import { setSilent } from '../src/log.ts';
import type { TeamServer } from '../src/server.ts';
import type { MemoryStore } from '../src/store.ts';
import { Bot, agentRef, sleep, startDevServer } from './bot.ts';

setSilent(true);

type Chat = Extract<ServerMsg, { t: 'chat' }>;
type Err = Extract<ServerMsg, { t: 'error' }>;
type SessionUpdate = Extract<ServerMsg, { t: 'session.update' }>;
type SessionRemoved = Extract<ServerMsg, { t: 'session.removed' }>;
type Page = Extract<ServerMsg, { t: 'history.page' }>;

describe('sessions in the Office', () => {
  let server: TeamServer;
  let store: MemoryStore;
  let url = '';
  const bots: Bot[] = [];

  beforeEach(async () => {
    ({ server, store, url } = await startDevServer());
  });

  afterEach(async () => {
    for (const b of bots.splice(0)) b.ws?.terminate();
    await server.close();
  });

  const join = (uid: string, role: WorkspaceRole = 'member') => {
    const b = new Bot(uid, url, role);
    bots.push(b);
    return b.connect();
  };

  test('welcome includes current room and sessions list', async () => {
    const b = await join('owner1', 'owner');
    assert.equal(b.welcome.room, 'lobby');
    assert.ok(Array.isArray(b.welcome.sessions));
  });

  test('lazy session creation on first message to a room', async () => {
    const b = await join('owner2', 'owner');
    const msg = await b.say('first message in lobby');
    assert.ok(msg.session, 'message should have a session id');
    assert.equal(msg.room, 'lobby');

    const room = await server.office.get();
    const active = room.getActiveSession('lobby');
    assert.ok(active, 'active session should be created');
    assert.equal(active.id, msg.session);
    assert.equal(active.state, 'active');
  });

  test('owner can start a new session, which archives the previous one', async () => {
    const owner = await join('owner3', 'owner');
    const member = await join('member3', 'member');

    // First message starts s1
    const m1 = await owner.say('session 1 chat');
    const s1Id = m1.session!;

    // Owner creates new session for lobby
    owner.send({ t: 'session.new', reqId: 'sn1', room: 'lobby' });

    // Both clients receive updates: s1 archived, s2 active
    const s1Archived = await member.waitFor<SessionUpdate>((m) => m.t === 'session.update' && m.session.id === s1Id && m.session.state === 'archived');
    assert.equal(s1Archived.session.state, 'archived');

    const s2Update = await member.waitFor<SessionUpdate>((m) => m.t === 'session.update' && m.session.room === 'lobby' && m.session.id !== s1Id && m.session.state === 'active');
    assert.notEqual(s2Update.session.id, s1Id);

    // Next message lands in s2
    const m2 = await member.say('session 2 chat');
    assert.equal(m2.session, s2Update.session.id);
  });

  test('non-owner cannot manage sessions', async () => {
    const member = await join('member4', 'member');
    member.send({ t: 'session.new', reqId: 'sn-bad', room: 'lobby' });
    const err = await member.waitFor<Err>((m) => m.t === 'error' && m.reqId === 'sn-bad');
    assert.equal(err.code, 'forbidden');
  });

  test('owner can archive a session, making room read-only (no_session error)', async () => {
    const owner = await join('owner5', 'owner');
    const member = await join('member5', 'member');

    // Ensure active session
    await owner.say('hello before archive');

    // Archive lobby session
    owner.send({ t: 'session.archive', reqId: 'sa1', room: 'lobby' });
    const update = await member.waitFor<SessionUpdate>((m) => m.t === 'session.update' && m.session.room === 'lobby' && m.session.state === 'archived');
    assert.equal(update.session.state, 'archived');

    // Trying to chat in closed room fails with no_session
    member.send({ t: 'chat', text: 'cannot chat now', cid: 'closed-cid', room: 'lobby' });
    const err = await member.waitFor<Err>((m) => m.t === 'error' && m.cid === 'closed-cid');
    assert.equal(err.code, 'no_session');

    // Owner can resume by starting a new session
    owner.send({ t: 'session.new', reqId: 'sn-resume', room: 'lobby' });
    await member.waitFor<SessionUpdate>((m) => m.t === 'session.update' && m.session.room === 'lobby' && m.session.state === 'active');

    // Now chatting works again
    const m = await member.say('chatting resumed');
    assert.ok(m.session);
  });

  test('owner can delete a session and its messages', async () => {
    const owner = await join('owner6', 'owner');
    const member = await join('member6', 'member');

    const m = await owner.say('to be deleted');
    const sid = m.session!;

    owner.send({ t: 'session.delete', reqId: 'sd1', session: sid });
    const removed = await member.waitFor<SessionRemoved>((msg) => msg.t === 'session.removed' && msg.id === sid);
    assert.equal(removed.id, sid);

    // Messages in that session are deleted from the store
    const page = await store.listMessages('main', { session: sid, limit: 50 });
    assert.equal(page.messages.length, 0);
  });

  test('agent reply is refused with gone if session was archived before reply', async () => {
    const owner = await join('owner7', 'owner');
    const m = await owner.say('@sarah long task');

    owner.send({ t: 'agent.start', reqId: 'r-arch', replyTo: m.id, agent: agentRef('sarah'), mode: 'fresh' });
    await owner.waitFor((x) => x.t === 'agent.status' && x.status.reqId === 'r-arch' && x.status.state === 'thinking');

    // Archive the session
    owner.send({ t: 'session.archive', reqId: 'sa-arch', room: 'lobby' });
    await owner.waitFor<SessionUpdate>((x) => x.t === 'session.update' && x.session.id === m.session && x.session.state === 'archived');

    // Now reply arrives
    owner.send({ t: 'agent.reply', reqId: 'r-arch', replyTo: m.id, agent: agentRef('sarah'), text: 'done too late' });
    const err = await owner.waitFor<Err>((x) => x.t === 'error' && x.reqId === 'r-arch');
    assert.equal(err.code, 'gone');
  });

  test('history.get loads messages for specific session', async () => {
    const owner = await join('owner8', 'owner');

    // Session 1
    const m1 = await owner.say('session 1 item');
    const s1 = m1.session!;

    // Session 2
    owner.send({ t: 'session.new', reqId: 'sn-hist', room: 'lobby' });
    await owner.waitFor<SessionUpdate>((x) => x.t === 'session.update' && x.session.room === 'lobby' && x.session.state === 'active');
    const m2 = await owner.say('session 2 item');
    const s2 = m2.session!;

    // Query session 1 specifically
    owner.send({ t: 'history.get', reqId: 'h-s1', room: 'lobby', session: s1 });
    const p1 = await owner.waitFor<Page>((x) => x.t === 'history.page' && x.reqId === 'h-s1');
    assert.ok(p1.messages.some((x) => x.id === m1.id));
    assert.ok(!p1.messages.some((x) => x.id === m2.id));

    // Query session 2 specifically
    owner.send({ t: 'history.get', reqId: 'h-s2', room: 'lobby', session: s2 });
    const p2 = await owner.waitFor<Page>((x) => x.t === 'history.page' && x.reqId === 'h-s2');
    assert.ok(p2.messages.some((x) => x.id === m2.id));
    assert.ok(!p2.messages.some((x) => x.id === m1.id));
  });
});
