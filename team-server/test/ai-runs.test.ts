import assert from 'node:assert/strict';
import { afterAll, afterEach, beforeAll, describe, test } from 'bun:test';
import type { AgentClient } from '../src/ai/client.ts';
import { agentReplyId } from '../src/shared/workspace/chat.ts';
import type { AgentStatus, ServerMsg } from '../src/shared/workspace/protocol.ts';
import type { WorkspaceRole } from '../src/shared/workspace/types.ts';
import type { RunEvent, RunRequest } from '../src/shared/ai/types.ts';
import { setSilent } from '../src/log.ts';
import { GuestAuthenticator } from '../src/auth.ts';
import { builtinSeed } from '../src/demo/seed.ts';
import type { TeamServer } from '../src/server.ts';
import { Bot, agentRef, sleep, startDevServer } from './bot.ts';

setSilent(true);

type Status = Extract<ServerMsg, { t: 'agent.status' }>;
type Chat = Extract<ServerMsg, { t: 'chat' }>;
type Err = Extract<ServerMsg, { t: 'error' }>;
type CardMsg = Extract<ServerMsg, { t: 'card' }>;
const isStatus = (state: AgentStatus['state'], handle?: string) => (m: ServerMsg) => m.t === 'agent.status' && m.status.state === state && (!handle || m.status.agent.handle === handle);
const isAgentChat = (m: ServerMsg) => m.t === 'chat' && m.msg.kind === 'agent';

/** A stand-in for the agent service: records each request and plays a script. */
class FakeAgents implements AgentClient {
  calls: RunRequest[] = [];
  script: (req: RunRequest, on: (e: RunEvent) => void, signal: AbortSignal) => Promise<void> | void = (req, on) => {
    on({ event: 'status', data: { phase: 'searching' } });
    on({ event: 'step', data: { tool: 'search_knowledge', summary: '2 passages from 1 doc' } });
    on({ event: 'final', data: { text: `Answer for ${req.agent.handle}.`, citations: [{ kind: 'doc', id: 'p-release-process', title: 'Release process', quote: 'every second Tuesday' }], cards: [], usage: { model: 'fake', inputTokens: 5, outputTokens: 5, seconds: 0.1 } } });
  };
  async run(req: RunRequest, on: (e: RunEvent) => void, signal: AbortSignal) {
    this.calls.push(req);
    await this.script(req, on, signal);
  }
}

const auth = (uid: string, role: WorkspaceRole = 'owner') => ({ authorization: `Bearer dev:${uid}@${role}:${uid}`, 'content-type': 'application/json' });

describe('agents that run on the server', () => {
  let server: TeamServer;
  let url = '';
  let base = '';
  let agents: FakeAgents;
  const indexed: { path: string; body: any }[] = [];
  const bots: Bot[] = [];
  const RESET = 'reset-token-for-tests';

  beforeAll(async () => {
    agents = new FakeAgents();
    const agentFetch = (async (u: string, init: RequestInit) => {
      indexed.push({ path: new URL(u).pathname, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ chunks: 1, indexed: 3 }));
    }) as unknown as typeof fetch;
    ({ server, url, base } = await startDevServer(
      { demo: true, agentServiceUrl: 'http://agents.invalid', agentServiceAuth: 'none', resetToken: RESET, runsPerGuestHour: 50, runsPerDay: 500 },
      { agentClient: agents, agentFetch, guest: null, seed: builtinSeed() },
    ));
  });
  afterEach(async () => {
    for (const b of bots.splice(0)) b.ws?.terminate();
    await sleep(40);
    agents.calls.length = 0;
    agents.script = new FakeAgents().script;
    const room = await server.office.get();
    for (const run of room.runs.all()) room.runs.remove(run);
  });
  afterAll(async () => {
    await server.close();
  });

  // A person's budgets are theirs across connections, so each test brings new people.
  let n = 0;
  const fresh = (name: string) => `${name}${++n}`;
  const join = (uid: string, role: WorkspaceRole = 'owner') => {
    const b = new Bot(uid, url, role);
    bots.push(b);
    return b.connect();
  };
  const ask = async (bot: Bot, text: string, handle: string, reqId = `r${Math.random().toString(36).slice(2, 7)}`) => {
    const m = await bot.say(text);
    bot.send({ t: 'agent.start', reqId, replyTo: m.id, agent: agentRef(handle), mode: 'fresh' });
    return { m, reqId };
  };

  test('the demo opens seeded: a team, a board, docs, agents, and a conversation that says what to try', async () => {
    const ann = await join(fresh('ann'));
    assert.ok(ann.welcome.history.some((h) => h.id === 'welcome-1' && h.text.includes('synthetic')));
    const board = (await (await fetch(`${base}/board`, { headers: auth(ann.uid) })).json()) as { issues: { title: string; status: string }[] };
    assert.ok(board.issues.length >= 2);
    const roster = (await (await fetch(`${base}/agents`, { headers: auth(ann.uid) })).json()) as { agents: { handle: string }[] };
    assert.ok(['librarian', 'scribe', 'planner'].every((h) => roster.agents.some((a) => a.handle === h)));
    assert.ok(ann.welcome.map.zones.some((z) => z.id === 'z-seed-maya'), 'the seeded teammates have their rooms');
  });

  test('a mention is answered on the server: everyone sees it work, then the answer with its sources', async () => {
    const ann = await join(fresh('ann'));
    const bob = await join(fresh('bob'));
    const { m } = await ask(ann, '@librarian when do we release?', 'librarian', 'r1');
    const working = await bob.waitFor<Status>(isStatus('thinking', 'librarian'));
    assert.equal(working.status.reqId, undefined);
    const stepped = await bob.waitFor<Status>((x) => x.t === 'agent.status' && x.status.step === '2 passages from 1 doc');
    assert.equal(stepped.status.phase, 'searching');
    const posted = (await bob.waitFor<Chat>(isAgentChat)).msg;
    assert.equal(posted.id, agentReplyId(m.id, 'librarian'));
    assert.equal(posted.fromName, 'Librarian Agent');
    assert.equal(posted.text, 'Answer for librarian.');
    assert.deepEqual(posted.citations, [{ kind: 'doc', id: 'p-release-process', title: 'Release process', quote: 'every second Tuesday' }]);
    assert.deepEqual([posted.via, posted.viaName, posted.replyTo], [`dev-${ann.uid}`, ann.uid, m.id]);
    await bob.waitFor(isStatus('done', 'librarian'));

    // What the agent service was told.
    const req = agents.calls[0];
    assert.equal(req.kind, 'mention');
    assert.equal(req.agent.handle, 'librarian');
    assert.ok(req.agent.persona.length > 10);
    assert.equal(req.asker.name, ann.uid);
    assert.equal(req.question, '@librarian when do we release?');
    assert.ok(req.history.some((h) => h.id === m.id), 'the conversation comes with it');
    assert.ok(req.context.board.length >= 2 && req.context.docs.length >= 2);
    assert.equal(req.webBase, `http://127.0.0.1:${new URL(base).port}`);
  });

  test('asking again for the same message does not run it twice', async () => {
    const ann = await join(fresh('ann'));
    const { m, reqId } = await ask(ann, '@librarian hello', 'librarian', 'r2');
    await ann.waitFor(isAgentChat);
    ann.send({ t: 'agent.start', reqId, replyTo: m.id, agent: agentRef('librarian'), mode: 'resume' });
    await ann.next(isStatus('done', 'librarian'));
    assert.equal(agents.calls.length, 1);
  });

  test('an agent nobody here has is refused, and the secret in an answer never reaches the room', async () => {
    const ann = await join(fresh('ann'));
    const refused = ann.next<Err>((x) => x.t === 'error' && x.code === 'unknown_agent');
    await ask(ann, '@ghost are you there', 'ghost', 'r3');
    assert.match((await refused).message, /no agent called @ghost/);

    agents.script = (_req, on) => on({ event: 'final', data: { text: `The key is ${['AI', 'zaSyA1234567890abcdefghijklmnopqrstuv'].join('')} ok`, citations: [], cards: [], usage: { model: 'f', inputTokens: 0, outputTokens: 0, seconds: 0 } } });
    await ask(ann, '@librarian what is the key', 'librarian', 'r4');
    const posted = (await ann.waitFor<Chat>(isAgentChat)).msg;
    assert.ok(!posted.text.includes('AIza'));
  });

  test('when the agent service fails the room is told plainly, and the person gets their run back', async () => {
    const ann = await join(fresh('ann'));
    agents.script = (_req, on) => on({ event: 'error', data: { code: 'model_unavailable', message: 'nope' } });
    const before = ((await (await fetch(`${base}/demo/status`, { headers: auth(ann.uid) })).json()) as { runsLeft: number }).runsLeft;
    await ask(ann, '@librarian are you there', 'librarian', 'r5');
    const note = (await ann.waitFor<Chat>((x) => x.t === 'chat' && x.msg.kind === 'system' && x.msg.text.includes('Gemini'))).msg;
    assert.match(note.text, /Librarian Agent couldn’t reach Gemini/);
    await ann.waitFor(isStatus('failed', 'librarian'));
    const after = ((await (await fetch(`${base}/demo/status`, { headers: auth(ann.uid) })).json()) as { runsLeft: number }).runsLeft;
    assert.equal(after, before, 'a run the model never answered is not counted');
  });

  test('the sample standup is played by the seeded teammates, once at a time', async () => {
    const ann = await join(fresh('ann'));
    const res = await fetch(`${base}/demo/sample-standup`, { method: 'POST', headers: auth(ann.uid), body: JSON.stringify({ room: 'lobby' }) });
    assert.equal(res.status, 202);
    const first = (await ann.waitFor<Chat>((x) => x.t === 'chat' && x.msg.from === 'seed-maya')).msg;
    assert.ok(first.text.length > 0 && first.fromName === 'Maya');
    const again = await fetch(`${base}/demo/sample-standup`, { method: 'POST', headers: auth(ann.uid), body: JSON.stringify({ room: 'lobby' }) });
    assert.equal(again.status, 409);
    await ann.waitFor((x) => x.t === 'chat' && x.msg.from === 'seed-linh', 8000);
  }, 15_000);

  test('ending a meeting gets minutes and a proposal; accepting part of it creates those tickets, as that person', async () => {
    const ann = await join(fresh('ann'));
    const spoken = await ann.say('Decision: we freeze on Monday. Action: Linh finishes the offline list.');
    agents.script = (req, on) => {
      assert.equal(req.kind, 'minutes');
      assert.equal(req.agent.handle, 'scribe');
      on({ event: 'final', data: {
        text: 'Minutes: freeze on Monday.', citations: [],
        cards: [{ kind: 'proposal', id: 'agent-made-id', title: 'Follow-ups', items: [
          { id: 'item-1', type: 'ticket', title: 'Freeze the code on Monday', body: 'Nothing new after 5 pm.', labels: ['release'], points: 2 },
          { id: 'item-2', type: 'ticket', title: 'Not wanted', body: '' },
          { id: 'item-3', type: 'doc', title: 'Minutes 2026-10-19', body: '# Minutes\n\nFreeze on Monday.' },
        ] }],
        usage: { model: 'fake', inputTokens: 1, outputTokens: 1, seconds: 0 },
      } });
    };
    const res = await fetch(`${base}/ai/minutes`, { method: 'POST', headers: auth(ann.uid), body: JSON.stringify({ room: 'lobby', session: spoken.session }) });
    assert.equal(res.status, 202);
    const posted = (await ann.waitFor<Chat>(isAgentChat)).msg;
    assert.equal(posted.fromName, 'Scribe Agent');
    assert.equal(posted.ui?.kind, 'proposal');
    assert.notEqual(posted.ui?.kind === 'proposal' && posted.ui.id, 'agent-made-id', 'the server makes the card’s id');

    ann.send({ t: 'card.decide', message: posted.id, decision: 'proceeded', chosen: ['item-1', 'item-3'] });
    const decided = await ann.waitFor<CardMsg>((x) => x.t === 'card' && x.id === posted.id);
    assert.equal(decided.session, posted.session);
    assert.equal(decided.thread, undefined);
    const ui = decided.ui;
    assert.equal(ui.kind === 'proposal' && ui.decided, 'proceeded');
    const created = ui.kind === 'proposal' ? (ui.created ?? []) : [];
    assert.deepEqual(created.map((c) => c.item), ['item-1', 'item-3']);
    assert.match(created[0].ref, /^#\d+$/);

    const board = (await (await fetch(`${base}/board`, { headers: auth(ann.uid) })).json()) as { issues: { title: string; createdBy: string; labels: string[] }[] };
    const made = board.issues.find((i) => i.title === 'Freeze the code on Monday');
    assert.deepEqual([made?.createdBy, made?.labels], [`dev-${ann.uid}`, ['release']]);
    assert.ok(!board.issues.some((i) => i.title === 'Not wanted'));
    const pages = (await (await fetch(`${base}/pages`, { headers: auth(ann.uid) })).json()) as { pages: { id: string; title: string; parent: string | null }[] };
    const meetings = pages.pages.find((p) => p.title === 'Meetings');
    assert.equal(pages.pages.find((p) => p.title === 'Minutes 2026-10-19')?.parent, meetings?.id);

    // Deciding twice, or something that is not on the card, is refused.
    ann.send({ t: 'card.decide', message: posted.id, decision: 'proceeded', chosen: ['item-2'] });
    assert.equal((await ann.waitFor<Err>((x) => x.t === 'error' && x.code === 'already_answered')).code, 'already_answered');
  });

  test('a proposal can be turned down, and a stranger cannot decide someone else’s', async () => {
    const ann = await join(fresh('ann'));
    const bob = await join(fresh('bob'), 'member');
    const spoken = await ann.say('Anything to write down?');
    agents.script = (_req, on) => on({ event: 'final', data: { text: 'Here.', citations: [], cards: [{ kind: 'proposal', id: 'x', title: 'T', items: [{ id: 'item-1', type: 'ticket', title: 'One', body: '' }] }], usage: { model: 'f', inputTokens: 0, outputTokens: 0, seconds: 0 } } });
    await fetch(`${base}/ai/minutes`, { method: 'POST', headers: auth(ann.uid), body: JSON.stringify({ room: 'lobby', session: spoken.session }) });
    const posted = (await ann.waitFor<Chat>(isAgentChat)).msg;
    bob.send({ t: 'card.decide', message: posted.id, decision: 'proceeded', chosen: ['item-1'] });
    assert.equal((await bob.waitFor<Err>((x) => x.t === 'error' && x.code === 'forbidden')).code, 'forbidden');
    ann.send({ t: 'card.decide', message: posted.id, decision: 'dismissed', chosen: [] });
    const done = await ann.waitFor<CardMsg>((x) => x.t === 'card' && x.id === posted.id);
    assert.equal(done.ui.kind === 'proposal' && done.ui.decided, 'dismissed');
  });

  test('the budget stops a guest, with a sentence that says when it comes back', async () => {
    const ann = await join(fresh('ann'));
    const room = await server.office.get();
    const ai = room['ai']!;
    const saved = ai.budget['perGuestHour'];
    (ai.budget as unknown as { perGuestHour: number }).perGuestHour = 1;
    ai.budget.reset();
    try {
      await ask(ann, '@librarian one', 'librarian', 'b1');
      await ann.waitFor(isAgentChat);
      const refused = ann.next<Err>((x) => x.t === 'error' && x.code === 'budget');
      await ask(ann, '@librarian two', 'librarian', 'b2');
      assert.match((await refused).message, /AI runs for this hour/);
    } finally {
      (ai.budget as unknown as { perGuestHour: number }).perGuestHour = saved;
      ai.budget.reset();
    }
  });

  test('the agent service can read tickets, docs and the conversation through the internal door; nothing writes', async () => {
    const ann = await join(fresh('ann'));
    const spoken = await ann.say('Hello for the record');
    const tickets = (await (await fetch(`${base}/internal/v1/tickets?q=offline`)).json()) as { tickets: { key: number; title: string; assigneeName: string | null }[] };
    assert.ok(tickets.tickets.some((t) => /offline/i.test(t.title)));
    const one = (await (await fetch(`${base}/internal/v1/tickets/${tickets.tickets[0].key}`)).json()) as { title: string };
    assert.equal(one.title, tickets.tickets[0].title);
    assert.equal((await fetch(`${base}/internal/v1/tickets/9999`)).status, 404);
    const pages = (await (await fetch(`${base}/internal/v1/pages?q=release`)).json()) as { pages: { id: string }[] };
    const page = (await (await fetch(`${base}/internal/v1/pages/${pages.pages[0].id}`)).json()) as { body: string };
    assert.ok(page.body.includes('Tuesday'));
    const messages = (await (await fetch(`${base}/internal/v1/messages?room=lobby&limit=5`)).json()) as { messages: { id: string }[] };
    assert.ok(messages.messages.some((m) => m.id === spoken.id));
    assert.equal((await fetch(`${base}/internal/v1/tickets`, { method: 'POST' })).status, 404);
  });

  test('a change to a ticket or a page is sent to the agents’ knowledge', async () => {
    const ann = await join(fresh('ann'));
    indexed.length = 0;
    const made = await fetch(`${base}/board/issues`, { method: 'POST', headers: auth(ann.uid), body: JSON.stringify({ title: 'Add a dark map style', body: 'Night mode for the field map.' }) });
    assert.equal(made.status, 201);
    await sleep(700);
    const sent = indexed.find((i) => i.path === '/v1/index' && i.body.kind === 'ticket' && i.body.title.includes('dark map'));
    assert.ok(sent, 'the new ticket was indexed');
    assert.ok(sent.body.body.includes('Night mode'));
  });

  test('the shared agents’ instructions are read-only in the demo unless the server allows edits', async () => {
    const ann = await join(fresh('ann'));
    const body = { displayName: 'Librarian Agent', role: 'Knowledge keeper', greeting: 'hi', look: agentRef('librarian').look, persona: 'You are rude.' };
    const refused = await fetch(`${base}/agents/librarian`, { method: 'PUT', headers: auth(ann.uid), body: JSON.stringify(body) });
    assert.equal(refused.status, 403);
    const room = await server.office.get();
    assert.ok(!room['ai']!.agents.get('librarian')!.persona.includes('rude'));
  });

  test('a reset sends everyone away and puts the seed back', async () => {
    const ann = await join(fresh('ann'));
    await fetch(`${base}/board/issues`, { method: 'POST', headers: auth(ann.uid), body: JSON.stringify({ title: 'Something a visitor added' }) });
    assert.equal((await fetch(`${base}/demo/reset`, { method: 'POST' })).status, 403);
    assert.equal((await fetch(`${base}/demo/reset`, { method: 'POST', headers: { 'x-reset-token': 'wrong' } })).status, 403);
    const res = await fetch(`${base}/demo/reset`, { method: 'POST', headers: { 'x-reset-token': RESET } });
    assert.equal(res.status, 200);
    await sleep(100);
    assert.equal(ann.closed?.code, 1012, 'told to come back');
    const board = (await (await fetch(`${base}/board`, { headers: auth(ann.uid) })).json()) as { issues: { title: string }[] };
    assert.ok(!board.issues.some((i) => i.title === 'Something a visitor added'));
    assert.ok(board.issues.length >= 2);
    const back = await join(ann.uid);
    assert.ok(back.welcome.history.some((h) => h.id === 'welcome-1'));
  });
});

describe('guest sign-in', () => {
  test('anyone gets a token, and with it joins the office as its owner; a made-up token is turned away', async () => {
    const guest = new GuestAuthenticator('guest-test-secret-guest-test-secret');
    const { server, url, base } = await startDevServer({ devAuth: false, demo: true, agentServiceUrl: '', allowedOrigins: ['*'] }, { guest, agentClient: new FakeAgents(), seed: builtinSeed() });
    try {
      const made = await fetch(`${base}/demo/guest`, { method: 'POST', body: JSON.stringify({ name: 'Judge' }) });
      assert.equal(made.status, 201);
      const { token, uid, name } = (await made.json()) as { token: string; uid: string; name: string };
      assert.deepEqual([name, uid.startsWith('guest-')], ['Judge', true]);
      const status = await fetch(`${base}/demo/status`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(status.status, 200);
      const body = (await status.json()) as { synthetic: boolean; runsLeft: number };
      assert.equal(body.synthetic, true);

      const bot = new Bot(uid, url, 'member', 'Judge');
      await bot.connect({ token });
      assert.equal(bot.welcome.role, 'owner');
      assert.equal(bot.welcome.workspace.name, 'Northwind Field App');
      bot.close();

      const forged = new Bot('mallory', url, 'member');
      await forged.connect({ token: 'demo:not.a.token', expectWelcome: false });
      await forged.waitFor((m) => m.t === 'error' && m.code === 'auth_failed');
      assert.equal((await fetch(`${base}/demo/status`, { headers: { authorization: 'Bearer demo:nope' } })).status, 401);
      assert.equal((await fetch(`${base}/board`)).status, 401);
    } finally {
      await server.close();
    }
  });
});
