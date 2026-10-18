import assert from 'node:assert/strict';
import { afterAll, afterEach, beforeAll, describe, test } from 'bun:test';
import type { AgentClient } from '../src/ai/client.ts';
import { parseAgentDef } from '../src/ai/agents.ts';
import { lookFromSeed } from '../src/shared/workspace/looks.ts';
import type { ServerMsg } from '../src/shared/workspace/protocol.ts';
import type { Artifact } from '../src/shared/pipeline/types.ts';
import type { RunEvent, RunRequest } from '../src/shared/ai/types.ts';
import { setSilent } from '../src/log.ts';
import { builtinSeed } from '../src/demo/seed.ts';
import type { TeamServer } from '../src/server.ts';
import { Bot, agentRef, sleep, startDevServer } from './bot.ts';

setSilent(true);

type Chat = Extract<ServerMsg, { t: 'chat' }>;
type CardMsg = Extract<ServerMsg, { t: 'card' }>;
const isAgentChat = (m: ServerMsg) => m.t === 'chat' && m.msg.kind === 'agent';
const auth = (uid: string) => ({ authorization: `Bearer dev:${uid}@owner:${uid}`, 'content-type': 'application/json' });
const usage = { model: 'fake', inputTokens: 1, outputTokens: 1, seconds: 0 };
const SPEC = '## Acceptance criteria\n- [ ] The list filters by status';

/** A stand-in for the agent service that plays a script for each request. */
class FakeAgents implements AgentClient {
  calls: RunRequest[] = [];
  script: (req: RunRequest, on: (e: RunEvent) => void) => void = (_req, on) => on({ event: 'final', data: { text: 'Hello.', citations: [], cards: [], usage } });
  async run(req: RunRequest, on: (e: RunEvent) => void) {
    this.calls.push(req);
    this.script(req, on);
  }
}

describe('pipeline agents: what they draft is kept for a person to accept', () => {
  let server: TeamServer;
  let url = '';
  let base = '';
  let agents: FakeAgents;
  const bots: Bot[] = [];

  beforeAll(async () => {
    agents = new FakeAgents();
    const agentFetch = (async () => new Response(JSON.stringify({ chunks: 1, indexed: 1 }))) as unknown as typeof fetch;
    ({ server, url, base } = await startDevServer(
      { demo: true, agentServiceUrl: 'http://agents.invalid', agentServiceAuth: 'none', resetToken: 'r', runsPerGuestHour: 100, runsPerDay: 1000, pipelineEnabled: true, pipelineDriver: 'fake' },
      { agentClient: agents, agentFetch, guest: null, seed: builtinSeed() },
    ));
    const ai = (await server.office.get())['ai']!;
    for (const handle of ['planner', 'designer', 'developer']) {
      const def = parseAgentDef(handle, { displayName: `${handle[0].toUpperCase()}${handle.slice(1)} Agent`, role: 'Colleague', greeting: 'Hello.', look: lookFromSeed(handle), persona: 'You help the team.', skills: [] });
      if (def) ai.agents.set(def);
    }
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

  let n = 0;
  const fresh = (name: string) => `${name}${++n}`;
  const join = (uid: string) => {
    const b = new Bot(uid, url, 'owner');
    bots.push(b);
    return b.connect();
  };
  const lobbySession = (b: Bot) => (b.welcome.sessions ?? []).find((s) => s.room === 'lobby' && s.state === 'active')!.id;
  const post = (path: string, uid: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: auth(uid), body: JSON.stringify(body) });
  const newTicket = async (uid: string, title: string) => ((await (await post('/board/issues', uid, { title })).json()) as { issue: { id: string; key: number; pipeline?: { stage: string } } }).issue;
  const artifactsOf = async (uid: string, ticket: string) => ((await (await fetch(`${base}/artifacts?ticket=${ticket}`, { headers: auth(uid) })).json()) as { artifacts: Artifact[] }).artifacts;

  test('a stage button starts the agent on that ticket; its draft is kept, offered in one card, and accepting the card accepts the draft', async () => {
    const ann = await join(fresh('ann'));
    const t = await newTicket(ann.uid, 'Filter orders by status');
    assert.equal(t.pipeline?.stage, 'plan');
    agents.script = (_req, on) => on({ event: 'final', data: { text: 'Here is the spec.', citations: [], cards: [], artifacts: [{ kind: 'spec', title: 'Order status filter', body: SPEC }], usage } });
    const res = await post('/ai/artifact', ann.uid, { ticket: t.id, ask: 'spec', room: 'lobby', session: lobbySession(ann) });
    assert.equal(res.status, 202);
    const posted = (await ann.waitFor<Chat>(isAgentChat)).msg;
    assert.equal(posted.fromName, 'Planner Agent');
    assert.equal(posted.ui?.kind, 'proposal');
    const card = posted.ui!.kind === 'proposal' ? posted.ui! : null;
    assert.equal(card?.items[0].type, 'artifact');
    assert.equal(card?.items[0].artifactKind, 'spec');
    const artifactId = card!.items[0].artifactId!;

    // What the agent service was told about the ticket and what the pipeline holds.
    const req = agents.calls[0];
    assert.equal(req.kind, 'spec');
    assert.equal(req.agent.handle, 'planner');
    assert.equal(req.ticket?.key, t.key);
    assert.equal(req.ticket?.stage, 'plan');
    assert.deepEqual(req.artifacts, []);

    // It is a draft, written by the agent, until a person accepts the card.
    let [a] = await artifactsOf(ann.uid, t.id);
    assert.equal(a.id, artifactId);
    assert.equal(a.state, 'draft');
    assert.equal(a.by.id, 'agent:planner');
    ann.send({ t: 'card.decide', message: posted.id, decision: 'proceeded', chosen: ['item-1'] });
    const decided = await ann.waitFor<CardMsg>((x) => x.t === 'card' && x.id === posted.id);
    assert.equal(decided.ui.kind === 'proposal' && decided.ui.decided, 'proceeded');
    assert.deepEqual(decided.ui.kind === 'proposal' ? decided.ui.created : null, [{ item: 'item-1', ref: artifactId }]);
    [a] = await artifactsOf(ann.uid, t.id);
    assert.equal(a.state, 'accepted');
    assert.equal(a.decidedBy, `dev-${ann.uid}`);
  });

  test('dismissing the card rejects what was drafted', async () => {
    const ann = await join(fresh('ann'));
    const t = await newTicket(ann.uid, 'Dismissed');
    agents.script = (_req, on) => on({ event: 'final', data: { text: 'Spec.', citations: [], cards: [], artifacts: [{ kind: 'spec', title: 'S', body: SPEC }], usage } });
    await post('/ai/artifact', ann.uid, { ticket: t.id, ask: 'spec', room: 'lobby', session: lobbySession(ann) });
    const posted = (await ann.waitFor<Chat>(isAgentChat)).msg;
    ann.send({ t: 'card.decide', message: posted.id, decision: 'dismissed', chosen: [] });
    await ann.waitFor<CardMsg>((x) => x.t === 'card' && x.id === posted.id);
    assert.equal((await artifactsOf(ann.uid, t.id))[0].state, 'rejected');
  });

  test('asking in a room nobody has spoken in yet starts that room’s conversation', async () => {
    const ann = await join(fresh('ann'));
    const t = await newTicket(ann.uid, 'First words in the Plan Room');
    agents.script = (_req, on) => on({ event: 'final', data: { text: 'Here is the spec.', citations: [], cards: [], artifacts: [{ kind: 'spec', title: 'Spec', body: SPEC }], usage } });
    const res = await post('/ai/artifact', ann.uid, { ticket: t.id, ask: 'spec', room: 'plan' });
    assert.equal(res.status, 202);
    const posted = (await ann.waitFor<Chat>(isAgentChat)).msg;
    assert.equal(posted.room, 'plan');
    assert.equal(posted.ui?.kind, 'proposal');
    assert.equal((await post('/ai/artifact', ann.uid, { ticket: t.id, ask: 'spec', room: 'plan', session: 'not a session id!' })).status, 400, 'a named conversation must be a real id');
  });

  test('a pipeline agent mentioned in a room finds its ticket by the number in the question', async () => {
    const ann = await join(fresh('ann'));
    const t = await newTicket(ann.uid, 'Named in chat');
    agents.script = (_req, on) => on({ event: 'final', data: { text: 'Designed.', citations: [], cards: [], artifacts: [{ kind: 'design', title: 'Screens', body: '<main>list</main>' }], usage } });
    const m = await ann.say(`@designer draw #${t.key}`);
    ann.send({ t: 'agent.start', reqId: 'q1', replyTo: m.id, agent: agentRef('designer'), mode: 'fresh' });
    await ann.waitFor<Chat>(isAgentChat);
    assert.equal(agents.calls[0].kind, 'design');
    assert.equal(agents.calls[0].ticket?.id, t.id);
    assert.equal((await artifactsOf(ann.uid, t.id)).length, 1);
  });

  test('a draft with no ticket to keep it on is not lost silently: the answer says so, and there is no card', async () => {
    const ann = await join(fresh('ann'));
    agents.script = (_req, on) => on({ event: 'final', data: { text: 'Designed.', citations: [], cards: [], artifacts: [{ kind: 'design', title: 'Screens', body: '<main>list</main>' }], usage } });
    const m = await ann.say('@designer draw something');
    ann.send({ t: 'agent.start', reqId: 'q2', replyTo: m.id, agent: agentRef('designer'), mode: 'fresh' });
    const posted = (await ann.waitFor<Chat>(isAgentChat)).msg;
    assert.match(posted.text, /no ticket to keep it on/);
    assert.equal(posted.ui, undefined);
  });

  test('a draft that does something AI-written code may not is not kept, and the answer says why', async () => {
    const ann = await join(fresh('ann'));
    const t = await newTicket(ann.uid, 'Hostile draft');
    const repo = (await (await fetch(`${base}/pipeline/repo`, { headers: auth(ann.uid) })).json()) as { files: { path: string; sha: string }[] };
    const file = repo.files.find((f) => f.path === 'sample-app/src/OrderList.tsx')!;
    agents.script = (_req, on) =>
      on({ event: 'final', data: { text: 'Implemented.', citations: [], cards: [], usage, artifacts: [{ kind: 'change_set', title: 'Hostile', body: 'x', files: [{ path: file.path, op: 'write', role: 'src', content: "const k = process.env.SECRET;\n", baseSha: file.sha }] }] } });
    await post('/ai/artifact', ann.uid, { ticket: t.id, ask: 'change_set', room: 'lobby', session: lobbySession(ann) });
    const posted = (await ann.waitFor<Chat>(isAgentChat)).msg;
    assert.match(posted.text, /Not kept: A change set cannot use process\.env/);
    assert.equal(posted.ui, undefined);
    assert.deepEqual(await artifactsOf(ann.uid, t.id), []);
  });

  test('the stage button refuses what makes no sense, and the agents can read the pipeline but not change it', async () => {
    const ann = await join(fresh('ann'));
    const t = await newTicket(ann.uid, 'Reads');
    assert.equal((await post('/ai/artifact', ann.uid, { ticket: t.id, ask: 'nonsense', room: 'lobby', session: lobbySession(ann) })).status, 400);
    assert.equal((await post('/ai/artifact', ann.uid, { ticket: 'no-such', ask: 'spec', room: 'lobby', session: lobbySession(ann) })).status, 404);
    // The internal doors the agent service reads through (open here because the test server has no ID-token check).
    const repo = (await (await fetch(`${base}/internal/v1/repo`)).json()) as { rev: string; files: { path: string }[] };
    assert.equal(repo.rev, 'main@0');
    assert.ok(repo.files.some((f) => f.path === 'sample-app/src/App.tsx'));
    const file = (await (await fetch(`${base}/internal/v1/repo/file?path=sample-app/src/App.tsx`)).json()) as { content: string };
    assert.match(file.content, /OrderList/);
    assert.equal((await fetch(`${base}/internal/v1/repo/file?path=${encodeURIComponent('../secret')}`)).status, 400);
    assert.equal((await fetch(`${base}/internal/v1/artifacts?ticket=${t.id}`)).status, 200);
    assert.equal((await fetch(`${base}/internal/v1/artifacts/ar-none`)).status, 404);
    assert.equal((await fetch(`${base}/internal/v1/repo`, { method: 'POST' })).status, 404, 'nothing here writes');
  });
});
