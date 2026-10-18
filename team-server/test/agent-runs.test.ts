import assert from 'node:assert/strict';
import { afterAll, afterEach, beforeAll, describe, test } from 'bun:test';
import { agentFailureId, agentReplyId } from '../src/shared/workspace/chat.ts';
import { lookFromSeed } from '../src/shared/workspace/looks.ts';
import type { AgentStatus, ServerMsg } from '../src/shared/workspace/protocol.ts';
import type { ChatMessage, WorkspaceRole } from '../src/shared/workspace/types.ts';
import { setSilent } from '../src/log.ts';
import type { TeamServer } from '../src/server.ts';
import type { MemoryStore } from '../src/store.ts';
import { Bot, agentRef, sleep, startDevServer } from './bot.ts';

setSilent(true);

type Status = Extract<ServerMsg, { t: 'agent.status' }>;
type Chat = Extract<ServerMsg, { t: 'chat' }>;
type Err = Extract<ServerMsg, { t: 'error' }>;
/** A status of `state` for the asker, who is told the request id of their own runs. */
const isMine = (state: AgentStatus['state'], reqId: string) => (m: ServerMsg) => m.t === 'agent.status' && m.status.state === state && m.status.reqId === reqId;
/** The same for anyone, by the agent's handle (other people are never told a run's request id, so that is how they tell runs apart). */
const isStatus = (state?: AgentStatus['state'], handle?: string) => (m: ServerMsg) => m.t === 'agent.status' && (!state || m.status.state === state) && (!handle || m.status.agent.handle === handle);

describe('agents answering in the Room', () => {
  let server: TeamServer;
  let store: MemoryStore;
  let url = '';
  const bots: Bot[] = [];

  beforeAll(async () => {
    ({ server, store, url } = await startDevServer());
  });
  // One room for the whole project, so each test starts from an empty one.
  afterEach(async () => {
    for (const b of bots.splice(0)) b.ws?.terminate();
    await sleep(40);
    // Runs wait for their person to come back, so they would leak into the next test.
    const room = await server.office.get();
    for (const run of room.runs.all()) room.runs.remove(run);
  });
  afterAll(async () => {
    await server.close();
  });

  const join = (uid: string, role: WorkspaceRole = 'member') => {
    const b = new Bot(uid, url, role);
    bots.push(b);
    return b.connect();
  };
  const runOf = async (uid: string, reqId: string) => (await server.office.get()).runs.get(uid, reqId);

  test('a mention starts a run everyone sees; the reply is posted as the agent, saved, and ends the run', async () => {
    const ann = await join('ann', 'owner');
    const bob = await join('bob');
    const m = await ann.say('@sarah plan the login screen');
    ann.send({ t: 'agent.start', reqId: 'r1', replyTo: m.id, agent: agentRef('sarah'), mode: 'fresh' });
    const thinking = await bob.waitFor<Status>(isStatus('thinking'));
    assert.deepEqual([thinking.status.by, thinking.status.byName, thinking.status.replyTo, thinking.status.agent.handle], ['dev-ann', 'ann', m.id, 'sarah']);
    assert.equal(thinking.status.reqId, undefined, 'other people are not told the request id');
    assert.equal((await ann.waitFor<Status>(isStatus('thinking'))).status.reqId, 'r1', 'the asker is');

    ann.send({ t: 'agent.reply', reqId: 'r1', replyTo: m.id, agent: agentRef('sarah'), text: 'Sure. Here is a plan.' });
    const posted = (await bob.waitFor<Chat>((x) => x.t === 'chat' && x.msg.kind === 'agent')).msg;
    assert.equal(posted.id, agentReplyId(m.id, 'sarah'));
    assert.deepEqual([posted.from, posted.fromName, posted.via, posted.viaName, posted.replyTo, posted.runId, posted.mentions], ['agent:sarah', 'Sarah', 'dev-ann', 'ann', m.id, thinking.status.runId, []]);
    assert.deepEqual(posted.look, lookFromSeed('sarah'));
    await bob.waitFor(isStatus('done'));
    assert.equal(await runOf('dev-ann', 'r1'), undefined, 'the run is over');
    assert.equal((await store.getMessage('main', posted.id))?.text, 'Sure. Here is a plan.', 'saved');
    const late = await join('carol');
    assert.deepEqual(late.welcome.thinking, [], 'nothing is "preparing" any more');
    assert.ok(late.welcome.history.some((h) => h.id === posted.id));
  });

  test('secrets in a reply are redacted before it is saved or shown', async () => {
    const ann = await join('ann2');
    const m = await ann.say('@sarah show me the config');
    ann.send({ t: 'agent.start', reqId: 'r1', replyTo: m.id, agent: agentRef('sarah'), mode: 'fresh' });
    await ann.waitFor(isStatus('thinking'));
    ann.send({ t: 'agent.reply', reqId: 'r1', replyTo: m.id, agent: agentRef('sarah'), text: 'db is postgres://admin:hunter2@db.example.com/app and key ya29.a0AfH6SMBabcdefghijklmnop' });
    const posted = (await ann.waitFor<Chat>((x) => x.t === 'chat' && x.msg.kind === 'agent')).msg;
    assert.ok(!posted.text.includes('hunter2') && !posted.text.includes('ya29.a0AfH6'));
    assert.ok(posted.text.includes('db.example.com'));
  });

  test('nobody else can start, answer, or cancel someone’s run', async () => {
    const ann = await join('ann3');
    const bob = await join('bob3');
    const m = await ann.say('@sarah help');
    bob.send({ t: 'agent.start', reqId: 'x1', replyTo: m.id, agent: agentRef('sarah'), mode: 'fresh' });
    assert.equal((await bob.waitFor<Err>((x) => x.t === 'error' && x.reqId === 'x1')).code, 'not_allowed', 'a message that is not yours');
    ann.send({ t: 'agent.start', reqId: 'r1', replyTo: m.id, agent: agentRef('sarah'), mode: 'fresh' });
    await ann.waitFor(isStatus('thinking'));
    bob.send({ t: 'agent.reply', reqId: 'r1', replyTo: m.id, agent: agentRef('sarah'), text: 'forged' });
    assert.equal((await bob.waitFor<Err>((x) => x.t === 'error' && x.reqId === 'r1')).code, 'not_allowed');
    bob.send({ t: 'agent.fail', reqId: 'r1' });
    await sleep(100);
    assert.ok(await runOf('dev-ann3', 'r1'), 'still running');
    await ann.expectNone((x) => x.t === 'chat' && x.msg.kind === 'agent');
  });

  test('an agent that the message does not mention cannot be started', async () => {
    const ann = await join('ann4');
    const m = await ann.say('@sarah help');
    ann.send({ t: 'agent.start', reqId: 'r1', replyTo: m.id, agent: agentRef('david'), mode: 'fresh' });
    assert.equal((await ann.waitFor<Err>((x) => x.t === 'error' && x.reqId === 'r1')).code, 'not_allowed');
    ann.send({ t: 'agent.start', reqId: 'r2', replyTo: 'no-such-message', agent: agentRef('sarah'), mode: 'fresh' });
    assert.equal((await ann.waitFor<Err>((x) => x.t === 'error' && x.reqId === 'r2')).code, 'not_allowed');
  });

  test('one person’s agents work side by side, and each ends on its own', async () => {
    const ann = await join('ann5');
    const bob = await join('bob5');
    const m = await ann.say('@alex @david compare Hono and Elysia');
    ann.send({ t: 'agent.start', reqId: 'a', replyTo: m.id, agent: agentRef('alex'), mode: 'fresh' });
    ann.send({ t: 'agent.start', reqId: 'd', replyTo: m.id, agent: agentRef('david'), mode: 'fresh' });
    assert.equal((await bob.waitFor<Status>(isStatus('thinking', 'alex'))).status.agent.handle, 'alex');
    assert.equal((await bob.waitFor<Status>(isStatus('thinking', 'david'))).status.agent.handle, 'david', 'not waiting for the first');
    ann.send({ t: 'agent.reply', reqId: 'a', replyTo: m.id, agent: agentRef('alex'), text: 'Hono.' });
    ann.send({ t: 'agent.fail', reqId: 'd' });
    await bob.waitFor(isStatus('failed', 'david'));
  });

  test('three runs at a time per person, then "too many"', async () => {
    const ann = await join('ann6');
    const m = await ann.say('@a1 @b2 @c3');
    for (const [i, h] of ['a1', 'b2', 'c3'].entries()) ann.send({ t: 'agent.start', reqId: `r${i}`, replyTo: m.id, agent: agentRef(h), mode: 'fresh' });
    await ann.waitFor(isStatus('thinking', 'c3'));
    const m2 = await ann.say('@d4 too');
    ann.send({ t: 'agent.start', reqId: 'r9', replyTo: m2.id, agent: agentRef('d4'), mode: 'fresh' });
    assert.equal((await ann.waitFor<Err>((x) => x.t === 'error' && x.reqId === 'r9')).code, 'too_many_runs');
  });

  test('when the person’s app goes away the run waits for it, and taking it over again clears "offline"', async () => {
    const ann = await join('ann7');
    const bob = await join('bob7');
    const m = await ann.say('@sarah plan it');
    ann.send({ t: 'agent.start', reqId: 'r1', replyTo: m.id, agent: agentRef('sarah'), mode: 'fresh' });
    await bob.waitFor(isStatus('thinking'));
    ann.ws.terminate();
    const offline = await bob.waitFor<Status>((x) => x.t === 'agent.status' && x.status.offline === true);
    assert.equal(offline.status.state, 'thinking');

    const carol = await join('carol7');
    assert.equal(carol.welcome.thinking?.length, 1, 'a late joiner sees it too');
    assert.equal(carol.welcome.thinking?.[0].offline, true);

    const back = await join('ann7');
    back.send({ t: 'agent.start', reqId: 'r1', replyTo: m.id, agent: agentRef('sarah'), mode: 'resume' });
    const resumed = await bob.next<Status>(isStatus('thinking', 'sarah'));
    assert.equal(resumed.status.offline, undefined);
    back.send({ t: 'agent.reply', reqId: 'r1', replyTo: m.id, agent: agentRef('sarah'), text: 'Back now.' });
    await bob.waitFor((x) => x.t === 'chat' && x.msg.kind === 'agent' && x.msg.text === 'Back now.');
  });

  test('a second window of the same person does not leave a ghost: the run expires if nobody takes it over', async () => {
    const first = await join('ann8');
    const bob = await join('bob8');
    const m = await first.say('@sarah plan it');
    first.send({ t: 'agent.start', reqId: 'r1', replyTo: m.id, agent: agentRef('sarah'), mode: 'fresh' });
    await bob.waitFor(isStatus('thinking'));
    await join('ann8'); // replaces the first window (4001)
    const run = await runOf('dev-ann8', 'r1');
    assert.ok(run && run.owner === null && run.offlineSince !== null, 'the old window’s run is waiting');
    run.offlineSince = Date.now() - 6 * 60_000; // nobody took it over for more than five minutes
    const gone = await bob.waitFor<Status>(isStatus('expired'), 2500);
    assert.equal(gone.status.reason, 'offline');
    const note = (await bob.waitFor<Chat>((x) => x.t === 'chat' && x.msg.kind === 'system')).msg;
    assert.equal(note.id, agentFailureId(m.id, 'sarah'));
    assert.match(note.text, /went offline/);
    assert.equal(await runOf('dev-ann8', 'r1'), undefined, 'the slot is free');
  });

  test('a run that takes too long expires, and a late answer is still accepted', async () => {
    const ann = await join('ann9');
    const bob = await join('bob9');
    const m = await ann.say('@sarah plan it');
    ann.send({ t: 'agent.start', reqId: 'r1', replyTo: m.id, agent: agentRef('sarah'), mode: 'fresh' });
    await bob.waitFor(isStatus('thinking'));
    (await runOf('dev-ann9', 'r1'))!.startedAt = Date.now() - 16 * 60_000;
    assert.equal((await bob.waitFor<Status>(isStatus('expired'), 2500)).status.reason, 'too_long');
    // The app finishes anyway, a little late: the question is still recent, so the answer is welcome.
    ann.send({ t: 'agent.reply', reqId: 'r1', replyTo: m.id, agent: agentRef('sarah'), text: 'Late but here.' });
    const posted = (await bob.waitFor<Chat>((x) => x.t === 'chat' && x.msg.kind === 'agent')).msg;
    assert.equal(posted.text, 'Late but here.');
    assert.equal(posted.runId, undefined, 'there was no run any more');
    await ann.waitFor((x) => x.t === 'agent.status' && x.status.state === 'done' && x.status.reqId === 'r1');
  });

  test('a question that was answered is not started again, and says so only to the asker', async () => {
    const ann = await join('ann10');
    const bob = await join('bob10');
    const m = await ann.say('@sarah plan it');
    ann.send({ t: 'agent.start', reqId: 'r1', replyTo: m.id, agent: agentRef('sarah'), mode: 'fresh' });
    ann.send({ t: 'agent.reply', reqId: 'r1', replyTo: m.id, agent: agentRef('sarah'), text: 'Done once.' });
    await bob.waitFor((x) => x.t === 'chat' && x.msg.kind === 'agent');
    await bob.waitFor(isStatus('done'));
    bob.inbox.length = 0;
    ann.send({ t: 'agent.start', reqId: 'r2', replyTo: m.id, agent: agentRef('sarah'), mode: 'resume' });
    const again = await ann.next<Status>(isStatus('done', 'sarah'));
    assert.equal(again.status.state, 'done');
    await bob.expectNone(isStatus());
    ann.send({ t: 'agent.reply', reqId: 'r2', replyTo: m.id, agent: agentRef('sarah'), text: 'Twice?' });
    await sleep(150);
    assert.equal(bob.inbox.filter((x) => x.t === 'chat' && x.msg.kind === 'agent').length, 0, 'a second answer is not posted');
    assert.equal((await store.getMessage('main', agentReplyId(m.id, 'sarah')))?.text, 'Done once.');
  });

  test('an answer that is empty or too long fails the run with a note; "run again" can try once more', async () => {
    const ann = await join('ann11');
    const bob = await join('bob11');
    const m = await ann.say('@sarah write everything');
    ann.send({ t: 'agent.start', reqId: 'r1', replyTo: m.id, agent: agentRef('sarah'), mode: 'fresh' });
    await bob.waitFor(isStatus('thinking'));
    ann.send({ t: 'agent.reply', reqId: 'r1', replyTo: m.id, agent: agentRef('sarah'), text: 'x'.repeat(6001) });
    const failed = await bob.waitFor<Status>(isStatus('failed'));
    assert.equal(failed.status.reason, 'invalid');
    const note = (await bob.waitFor<Chat>((x) => x.t === 'chat' && x.msg.kind === 'system')).msg;
    assert.equal(note.id, agentFailureId(m.id, 'sarah'));
    await bob.expectNone((x) => x.t === 'chat' && x.msg.kind === 'agent');

    ann.send({ t: 'agent.start', reqId: 'r2', replyTo: m.id, agent: agentRef('sarah'), mode: 'resume' });
    const stillFailed = await ann.next<Status>(isMine('failed', 'r2'));
    assert.equal(stillFailed.status.reason, 'earlier_failure');
    ann.send({ t: 'agent.start', reqId: 'r3', replyTo: m.id, agent: agentRef('sarah'), mode: 'rerun' });
    await ann.waitFor(isMine('thinking', 'r3'));
  });

  test('how old a mention may be depends on how the run is started', async () => {
    const ann = await join('ann12');
    const init = await ann.say('setup');
    const sid = init.session!;
    const old = (minutes: number, text: string): ChatMessage => ({ id: `old-${minutes}`, kind: 'human', from: 'dev-ann12', fromName: 'ann12', look: lookFromSeed('ann12'), text, at: Date.now() - minutes * 60_000, mentions: ['sarah'], session: sid, room: 'lobby' });
    await store.appendMessage('main', old(5, '@sarah five minutes ago'));
    await store.appendMessage('main', old(20, '@sarah twenty minutes ago'));
    const start = async (id: string, mode: 'fresh' | 'resume' | 'rerun', reqId: string) => {
      ann.send({ t: 'agent.start', reqId, replyTo: id, agent: agentRef('sarah'), mode });
      const out = await ann.waitFor<Status | Err>((x) => (x.t === 'agent.status' && x.status.reqId === reqId) || (x.t === 'error' && x.reqId === reqId));
      return out.t === 'error' ? out.code : out.status.state;
    };
    assert.equal(await start('old-5', 'fresh', 'q1'), 'not_allowed', 'a fresh start is for a message just sent');
    assert.equal(await start('old-5', 'resume', 'q2'), 'thinking', 'taking a run over after a reconnect');
    ann.send({ t: 'agent.fail', reqId: 'q2' });
    await ann.waitFor(isMine('failed', 'q2'));
    assert.equal(await start('old-20', 'resume', 'q3'), 'not_allowed', 'past the 15 minute cap');
    assert.equal(await start('old-20', 'rerun', 'q4'), 'thinking', '"Run again" works on older questions');
  });

  test('who may delete what: admins anything, the person whose computer ran an agent its answer', async () => {
    const boss = await join('boss13', 'owner');
    const bob = await join('bob13');
    const m = await bob.say('@sarah plan it');
    bob.send({ t: 'agent.start', reqId: 'r1', replyTo: m.id, agent: agentRef('sarah'), mode: 'fresh' });
    bob.send({ t: 'agent.reply', reqId: 'r1', replyTo: m.id, agent: agentRef('sarah'), text: 'A plan.' });
    const answer = (await boss.waitFor<Chat>((x) => x.t === 'chat' && x.msg.kind === 'agent')).msg;
    const bossLine = await boss.say('boss says hi');

    bob.send({ t: 'chat.delete', id: bossLine.id });
    assert.equal((await bob.waitFor<Err>((x) => x.t === 'error' && x.code === 'forbidden')).code, 'forbidden');
    bob.send({ t: 'chat.delete', id: answer.id }); // "Undo"
    await boss.waitFor((x) => x.t === 'chat.deleted' && x.id === answer.id);
    boss.send({ t: 'chat.delete', id: m.id });
    await bob.waitFor((x) => x.t === 'chat.deleted' && x.id === m.id);

    const stored = await store.getMessage('main', answer.id);
    assert.deepEqual([stored?.deleted, stored?.text, stored?.via], [true, '', 'dev-bob13']);
    const late = await join('late13');
    assert.equal(late.welcome.history.find((h) => h.id === answer.id)?.deleted, true, 'a joiner sees the tombstone, not the text');
  });
});
