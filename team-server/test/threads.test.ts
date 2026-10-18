import assert from 'node:assert/strict';
import { afterAll, afterEach, beforeAll, describe, test } from 'bun:test';
import { lookFromSeed } from '../src/shared/workspace/looks.ts';
import { THREAD_LIMITS } from '../src/shared/workspace/threads.ts';
import type { ServerMsg } from '../src/shared/workspace/protocol.ts';
import type { WorkThread, WorkspaceRole } from '../src/shared/workspace/types.ts';
import { setSilent } from '../src/log.ts';
import type { TeamServer } from '../src/server.ts';
import type { MemoryStore } from '../src/store.ts';
import { Bot, startDevServer } from './bot.ts';

setSilent(true);

type Update = Extract<ServerMsg, { t: 'thread.update' }>;
const isUpdate = (m: ServerMsg): m is Update => m.t === 'thread.update';

describe('worktree tabs', () => {
  let server: TeamServer;
  let store: MemoryStore;
  let url = '';
  const bots: Bot[] = [];
  const newBot = (uid: string, role?: WorkspaceRole) => {
    const b = new Bot(uid, url, role);
    bots.push(b);
    return b;
  };
  let n = 0;
  const open = async (bot: Bot, name = 'Fix login', branch = `work/t${n++}`, room = `z-dev-${bot.uid}`) => {
    const reqId = `r${n++}`;
    bot.send({ t: 'thread.new', reqId, room, name, branch, base: 'main' });
    return (await bot.waitFor((m) => isUpdate(m) && m.reqId === reqId)) as Update;
  };

  beforeAll(async () => {
    ({ server, store, url } = await startDevServer());
  });
  afterEach(async () => {
    for (const b of bots.splice(0)) b.ws?.terminate();
    await new Promise((r) => setTimeout(r, 30));
  });
  afterAll(async () => {
    await server.close();
  });

  test('a person opens a tab in their own zone; everyone sees it, with no folder path in it', async () => {
    const ann = await newBot('ta1').connect();
    const bo = await newBot('tb1').connect();
    const made = await open(ann);
    assert.equal(made.thread.owner, 'dev-ta1');
    assert.equal(made.thread.zone, 'z-dev-ta1');
    assert.equal(made.thread.state, 'creating');
    assert.equal(made.thread.ticket, null);
    assert.ok(!('path' in made.thread), 'the folder exists only on the owner’s Mac');
    const seen = (await bo.waitFor((m) => isUpdate(m) && m.thread.id === made.thread.id)) as Update;
    assert.equal(seen.reqId, undefined, 'only the person who asked is told which request it answers');
    // A person who joins later is told about it in the welcome.
    const late = await newBot('tc1').connect();
    assert.ok(late.welcome.threads?.some((t) => t.id === made.thread.id));
    assert.ok(!late.welcome.sessions?.some((s) => s.thread), 'a tab’s chat is not one of the room’s own sessions');
  });

  test('nobody opens a tab in someone else’s zone or in the lobby', async () => {
    const ann = await newBot('ta2').connect();
    await newBot('tb2').connect();
    ann.send({ t: 'thread.new', reqId: 'x1', room: 'z-dev-tb2', name: 'Not mine', branch: 'work/not-mine', base: 'main' });
    await ann.waitFor((m) => m.t === 'error' && m.code === 'forbidden' && m.reqId === 'x1');
    ann.send({ t: 'thread.new', reqId: 'x2', room: 'lobby', name: 'Lobby', branch: 'work/lobby', base: 'main' });
    await ann.waitFor((m) => m.t === 'error' && m.code === 'forbidden' && m.reqId === 'x2');
  });

  test('only the owner changes a tab; the steps must make sense', async () => {
    const ann = await newBot('ta3').connect();
    const bo = await newBot('tb3').connect();
    const { thread } = await open(ann);
    bo.send({ t: 'thread.patch', id: thread.id, patch: { state: 'intake' } });
    await bo.waitFor((m) => m.t === 'error' && m.code === 'forbidden');
    ann.send({ t: 'thread.patch', id: thread.id, patch: { state: 'running' } });
    await ann.waitFor((m) => m.t === 'error' && m.code === 'bad_state');
    ann.send({ t: 'thread.patch', id: thread.id, patch: { step: 'Checking your disk' } });
    await bo.waitFor((m) => isUpdate(m) && m.thread.id === thread.id && m.thread.step === 'Checking your disk');
    ann.send({ t: 'thread.patch', id: thread.id, patch: { state: 'failed', error: { code: 'disk_full', message: 'Out of space' } } });
    const failed = (await bo.waitFor((m) => isUpdate(m) && m.thread.state === 'failed')) as Update;
    assert.equal(failed.thread.error?.code, 'disk_full');
    // Try again: back to creating, and the old error is gone.
    ann.send({ t: 'thread.patch', id: thread.id, patch: { state: 'creating', step: 'Trying again' } });
    const again = (await bo.waitFor((m) => isUpdate(m) && m.thread.state === 'creating' && m.thread.step === 'Trying again')) as Update;
    assert.equal(again.thread.error, undefined);
    ann.send({ t: 'thread.patch', id: thread.id, patch: { state: 'intake' } });
    await bo.waitFor((m) => isUpdate(m) && m.thread.state === 'intake');
  });

  test('a branch can be used once, and the number of open tabs is limited', async () => {
    const ann = await newBot('ta4').connect();
    await open(ann, 'One', 'work/same');
    ann.send({ t: 'thread.new', reqId: 'd1', room: 'z-dev-ta4', name: 'Two', branch: 'work/same', base: 'main' });
    await ann.waitFor((m) => m.t === 'error' && m.code === 'branch_exists' && m.reqId === 'd1');
    for (let i = 1; i < THREAD_LIMITS.perOwner; i++) await open(ann, `T${i}`, `work/limit-${i}`);
    ann.send({ t: 'thread.new', reqId: 'd2', room: 'z-dev-ta4', name: 'Too many', branch: 'work/too-many', base: 'main' });
    await ann.waitFor((m) => m.t === 'error' && m.code === 'thread_limit' && m.reqId === 'd2');
  });

  test('chat in a tab is saved to the tab, mentions in it start nothing, and archiving closes it', async () => {
    const ann = await newBot('ta5').connect();
    const bo = await newBot('tb5').connect();
    const { thread } = await open(ann);
    bo.send({ t: 'chat', text: 'hello @sarah', thread: thread.id, cid: 'c1' });
    const msg = (await ann.waitFor((m) => m.t === 'chat' && m.msg.thread === thread.id)) as Extract<ServerMsg, { t: 'chat' }>;
    assert.equal(msg.msg.session, thread.session);
    assert.equal(msg.msg.room, thread.zone);
    assert.deepEqual(msg.msg.mentions, [], 'agents are asked from a tab by its owner only, and not yet');
    // It is in the tab's own history, and the zone's room chat does not have it.
    const hist = await store.listMessages('main', { session: thread.session, limit: 10 });
    assert.equal(hist.messages.length, 1);
    bo.send({ t: 'archive' } as never);
    bo.send({ t: 'thread.archive', id: thread.id });
    await bo.waitFor((m) => m.t === 'error' && m.code === 'forbidden');
    ann.send({ t: 'thread.archive', id: thread.id });
    await bo.waitFor((m) => isUpdate(m) && m.thread.id === thread.id && m.thread.state === 'archived');
    bo.send({ t: 'chat', text: 'too late', thread: thread.id, cid: 'c2' });
    await bo.waitFor((m) => m.t === 'error' && m.code === 'unknown_thread');
  });

  test('tabs survive a restart of the room', async () => {
    const ann = await newBot('ta6').connect();
    const { thread } = await open(ann, 'Kept', 'work/kept');
    const saved = (await store.listThreads('main')).find((t: WorkThread) => t.id === thread.id);
    assert.equal(saved?.branch, 'work/kept');
    assert.equal(saved?.session, thread.session);
  });
});

describe('agent messages and cards in a tab', () => {
  let server: TeamServer;
  let url = '';
  const bots: Bot[] = [];
  const newBot = (uid: string) => {
    const b = new Bot(uid, url);
    bots.push(b);
    return b;
  };
  let n = 0;
  const agent = { handle: 'sarah', name: 'Sarah', role: 'Project manager', look: lookFromSeed('sarah') };
  const open = async (bot: Bot) => {
    const reqId = `c${n++}`;
    bot.send({ t: 'thread.new', reqId, room: `z-dev-${bot.uid}`, name: 'Cards', branch: `work/cards-${n}`, base: 'main' });
    return ((await bot.waitFor((m) => isUpdate(m) && m.reqId === reqId)) as Update).thread;
  };
  const ask = {
    kind: 'ask' as const, id: 'a1', mode: 'choice' as const, prompt: 'What is this for?',
    options: [{ id: 'ticket', label: 'A ticket' }, { id: 'describe', label: 'Describe it' }],
  };
  const plan = {
    kind: 'plan' as const,
    plan: { summary: 'Add dark mode', steps: ['Tokens', 'Toggle'], agents: [{ handle: 'dana', why: 'UI' }, { handle: 'quinn', why: 'Tests' }], ticket: null, risks: [] },
  };

  beforeAll(async () => {
    ({ server, url } = await startDevServer());
  });
  afterEach(async () => {
    for (const b of bots.splice(0)) b.ws?.terminate();
    await new Promise((r) => setTimeout(r, 30));
  });
  afterAll(async () => {
    await server.close();
  });

  const say = async (bot: Bot, thread: string, text: string, ui?: unknown, cid = `s${n++}`) => {
    bot.send({ t: 'thread.say', cid, thread, agent, text, ...(ui ? { ui } : {}) } as never);
    return (await bot.waitFor((m) => m.t === 'chat' && m.msg.cid === cid)) as Extract<ServerMsg, { t: 'chat' }>;
  };

  test('the owner’s agent speaks in the tab with a card, everyone sees it, a guest cannot', async () => {
    const ann = await newBot('ka1').connect();
    const bo = await newBot('kb1').connect();
    const thread = await open(ann);
    const said = await say(ann, thread.id, 'What is this worktree for?', ask);
    assert.equal(said.msg.kind, 'agent');
    assert.equal(said.msg.from, 'agent:sarah');
    assert.equal(said.msg.via, 'dev-ka1');
    assert.equal(said.msg.session, thread.session);
    assert.equal(said.msg.ui?.kind, 'ask');
    await bo.waitFor((m) => m.t === 'chat' && m.msg.id === said.msg.id && m.msg.ui?.kind === 'ask');
    bo.send({ t: 'thread.say', cid: 'g1', thread: thread.id, agent, text: 'I am an agent too' });
    await bo.waitFor((m) => m.t === 'error' && m.code === 'forbidden' && m.cid === 'g1');
    // A card the server has to trust is cleaned: one option is not a choice, and nothing the client says about "answered" is kept.
    ann.send({ t: 'thread.say', cid: 'g2', thread: thread.id, agent, text: 'x', ui: { ...ask, options: [ask.options[0]] } });
    await ann.waitFor((m) => m.t === 'error' && m.cid === 'g2');
    const sneaky = await say(ann, thread.id, 'q', { ...ask, id: 'a2', answered: ['ticket'] });
    assert.equal(sneaky.msg.ui?.kind === 'ask' ? sneaky.msg.ui.answered : 'x', undefined);
  });

  test('a secret in an agent’s message is scrubbed before it is saved or shown', async () => {
    const ann = await newBot('ka2').connect();
    const thread = await open(ann);
    const said = await say(ann, thread.id, 'Use token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB to push');
    assert.ok(!said.msg.text.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789AB'));
  });

  test('only the owner answers a question, once, with one of its options', async () => {
    const ann = await newBot('ka3').connect();
    const bo = await newBot('kb3').connect();
    const thread = await open(ann);
    const said = await say(ann, thread.id, 'What is this for?', ask);
    bo.send({ t: 'card.answer', thread: thread.id, message: said.msg.id, picked: ['ticket'] });
    await bo.waitFor((m) => m.t === 'error' && m.code === 'forbidden');
    ann.send({ t: 'card.answer', thread: thread.id, message: said.msg.id, picked: ['made-up'] });
    await ann.waitFor((m) => m.t === 'error' && m.code === 'bad_answer');
    ann.send({ t: 'card.answer', thread: thread.id, message: said.msg.id, picked: ['ticket', 'describe'] });
    await ann.waitFor((m) => m.t === 'error' && m.code === 'bad_answer');
    ann.send({ t: 'card.answer', thread: thread.id, message: said.msg.id, picked: ['ticket'] });
    const card = (await bo.waitFor((m) => m.t === 'card' && m.id === said.msg.id)) as Extract<ServerMsg, { t: 'card' }>;
    assert.deepEqual(card.ui.kind === 'ask' ? card.ui.answered : null, ['ticket']);
    ann.send({ t: 'card.answer', thread: thread.id, message: said.msg.id, picked: ['describe'] });
    await ann.waitFor((m) => m.t === 'error' && m.code === 'already_answered');
    // It is in the saved history too, so a person who joins later sees it answered.
    const late = await newBot('kc3').connect();
    late.send({ t: 'history.get', reqId: 'h1', room: thread.zone, session: thread.session });
    const page = (await late.waitFor((m) => m.t === 'history.page' && m.reqId === 'h1')) as Extract<ServerMsg, { t: 'history.page' }>;
    const saved = page.messages.find((x) => x.id === said.msg.id);
    assert.deepEqual(saved?.ui?.kind === 'ask' ? saved.ui.answered : null, ['ticket']);
  });

  test('a plan is decided once, with agents from its own list', async () => {
    const ann = await newBot('ka4').connect();
    const thread = await open(ann);
    const said = await say(ann, thread.id, 'Here is the plan', plan);
    ann.send({ t: 'card.decide', thread: thread.id, message: said.msg.id, decision: 'proceeded', chosen: [] });
    await ann.waitFor((m) => m.t === 'error' && m.code === 'bad_answer');
    ann.send({ t: 'card.decide', thread: thread.id, message: said.msg.id, decision: 'proceeded', chosen: ['mallory'] });
    await ann.waitFor((m) => m.t === 'error' && m.code === 'bad_answer');
    ann.send({ t: 'card.decide', thread: thread.id, message: said.msg.id, decision: 'proceeded', chosen: ['dana'] });
    const card = (await ann.waitFor((m) => m.t === 'card' && m.id === said.msg.id)) as Extract<ServerMsg, { t: 'card' }>;
    assert.equal(card.ui.kind === 'plan' ? card.ui.decided : null, 'proceeded');
    assert.deepEqual(card.ui.kind === 'plan' ? card.ui.chosen : null, ['dana']);
    ann.send({ t: 'card.decide', thread: thread.id, message: said.msg.id, decision: 'dismissed', chosen: [] });
    await ann.waitFor((m) => m.t === 'error' && m.code === 'already_answered');
  });
});
