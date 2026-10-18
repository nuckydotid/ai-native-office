import assert from 'node:assert/strict';
import { describe, test, type TestContext } from 'node:test';
import { lookFromSeed } from '../../shared/workspace/looks.ts';
import { PROTOCOL_VERSION } from '../../shared/workspace/protocol.ts';
import type { ClientMsg, ServerMsg } from '../../shared/workspace/protocol.ts';
import { agentFailureId, agentReplyId } from '../../shared/workspace/chat.ts';
import type { AgentRef } from '../../shared/workspace/protocol.ts';
import { LocalRoom } from './local.ts';
import { RemoteRoom, type SocketLike } from './remote.ts';
import type { ConnStatus } from './room.ts';

class FakeSocket implements SocketLike {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: ClientMsg[] = [];
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  deliver(msg: ServerMsg) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  drop(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

function remote() {
  FakeSocket.all = [];
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const room = new RemoteRoom({
    url: 'ws://team.test/ws',
    hello: () => ({ token: 'dev:ada:Ada', name: 'Ada', look: lookFromSeed('ada'), github: 'dev:owner' }),
    socket: (url) => new FakeSocket(url),
    schedule: (fn, ms) => {
      const t = { fn, ms, live: true };
      timers.push(t);
      return () => (t.live = false);
    },
    now: () => 1000,
    random: () => 1,
  });
  const statuses: ConnStatus[] = [];
  const got: ServerMsg[] = [];
  room.onStatus((s) => statuses.push(s));
  room.onMessage((m) => got.push(m));
  return { room, statuses, got, timers, sock: () => FakeSocket.all[FakeSocket.all.length - 1] };
}

const welcome: ServerMsg = {
  t: 'welcome', you: 'dev-ada', role: 'owner', workspace: { id: 'main', name: 'HQ' }, map: { id: 'm', name: 'm', width: 1, height: 1, floor: [1], wall: [0], zones: [], props: [], spawns: [] },
  players: [], deskOwners: {}, history: [], historyHasMore: false, thinking: [], protocol: PROTOCOL_VERSION, serverTime: 0,
};

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('RemoteRoom', () => {
  test('says hello (with the protocol it speaks) as soon as the socket opens, then is online after the welcome', () => {
    const { room, statuses, sock } = remote();
    room.open();
    sock().open();
    const hello = sock().sent[0] as Extract<ClientMsg, { t: 'hello' }>;
    assert.equal(hello.t, 'hello');
    assert.equal(hello.token, 'dev:ada:Ada');
    assert.equal(hello.protocol, PROTOCOL_VERSION);
    assert.match(hello.workspaceId, /^[A-Za-z0-9_-]{1,64}$/);
    sock().deliver(welcome);
    assert.deepEqual(statuses.map((s) => s.state), ['connecting', 'online']);
  });

  test('passes server messages on and refuses to send before it is connected', () => {
    const { room, got, sock } = remote();
    assert.equal(room.send({ t: 'ping', at: 1 }), false);
    room.open();
    assert.equal(room.send({ t: 'ping', at: 1 }), false);
    sock().open();
    sock().deliver(welcome);
    sock().deliver({ t: 'state', time: 1, p: [] });
    assert.deepEqual(got.map((m) => m.t), ['welcome', 'state']);
    assert.equal(room.send({ t: 'chat', text: 'hi', cid: 'c1' }), true);
    assert.deepEqual(sock().sent.pop(), { t: 'chat', text: 'hi', cid: 'c1' });
  });

  test('a dropped connection is retried with a growing delay, and a welcome resets it', () => {
    const { room, statuses, timers, sock } = remote();
    room.open();
    sock().open();
    sock().deliver(welcome);
    sock().drop(1006);
    const first = timers.filter((t) => t.live).pop()!;
    assert.equal(first.ms, 1000);
    first.fn();
    sock().drop(1006);
    const second = timers.filter((t) => t.live).pop()!;
    assert.equal(second.ms, 2000);
    second.fn();
    sock().open();
    sock().deliver(welcome);
    sock().drop(1006);
    assert.equal(timers.filter((t) => t.live).pop()!.ms, 1000);
    assert.ok(statuses.some((s) => s.state === 'reconnecting'));
  });

  test('being refused is final and says why', () => {
    const { room, statuses, sock } = remote();
    room.open();
    sock().open();
    sock().deliver({ t: 'error', code: 'not_a_member', message: 'This account is not on the team yet.' });
    sock().drop(4003);
    assert.deepEqual(statuses[statuses.length - 1], { state: 'failed', message: 'This account is not on the team yet.', code: 'not_a_member' });
    assert.equal(FakeSocket.all.length, 1, 'no second attempt');
  });

  test('a server that is newer than the app is final too, with a message even if it sent none', () => {
    const { room, statuses, timers, sock } = remote();
    room.open();
    sock().open();
    const timersBefore = timers.length;
    sock().drop(4002);
    const last = statuses[statuses.length - 1];
    assert.equal(last.state, 'failed');
    assert.equal(last.code, 'update_required');
    assert.match(last.message ?? '', /newer Worktrees Studio/);
    assert.equal(timers.length, timersBefore, 'nothing is scheduled');
  });

  test('an error about one message is not the reason the connection ended', () => {
    const { room, statuses, sock } = remote();
    room.open();
    sock().open();
    sock().deliver(welcome);
    sock().deliver({ t: 'error', code: 'rate_limited', message: 'Slow down.', cid: 'c1' });
    sock().drop(4003);
    assert.equal(statuses[statuses.length - 1].message, 'The team server wouldn’t let you in.');
  });

  test('closing on purpose does not reconnect', () => {
    const { room, statuses, sock } = remote();
    room.open();
    sock().open();
    room.close();
    assert.equal(statuses[statuses.length - 1].state, 'closed');
    assert.equal(FakeSocket.all.length, 1);
  });

  /** A room whose clock the test moves, and whose timers it fires by hand. */
  function clocked(extra: Partial<ConstructorParameters<typeof RemoteRoom>[0]> = {}) {
    let clock = 1000;
    FakeSocket.all = [];
    const timers: { fn: () => void; ms: number; live: boolean }[] = [];
    const room = new RemoteRoom({
      url: 'ws://team.test/ws',
      hello: () => ({ token: 't', name: 'Ada', look: lookFromSeed('ada') }),
      socket: (url) => new FakeSocket(url),
      schedule: (fn, ms) => {
        const t = { fn, ms, live: true };
        timers.push(t);
        return () => (t.live = false);
      },
      now: () => clock,
      random: () => 1,
      ...extra,
    });
    const statuses: ConnStatus[] = [];
    room.onStatus((s) => statuses.push(s));
    return {
      room, statuses, timers,
      advance: (ms: number) => void (clock += ms),
      live: (ms: number) => timers.filter((t) => t.live && t.ms === ms).pop(),
      lastLive: () => timers.filter((t) => t.live).pop()!,
    };
  }

  test('a connection whose ping goes unanswered is replaced, and one that answers is not', () => {
    const { room, statuses, timers, advance, live, lastLive } = clocked();
    room.open();
    const first = FakeSocket.all[0];
    first.open();
    first.deliver(welcome);
    // The server answers: the next round pings again.
    advance(15_000);
    live(15_000)!.fn();
    assert.equal(first.sent.filter((m) => m.t === 'ping').length, 1);
    first.deliver({ t: 'pong', at: 16_000, serverTime: 0 });
    advance(15_000);
    live(15_000)!.fn();
    assert.equal(first.sent.filter((m) => m.t === 'ping').length, 2, 'still alive');
    assert.equal(FakeSocket.all.length, 1);
    // The second ping gets no answer. At the next round it has been waiting longer than a pong should take: the connection is
    // dropped and a new one made.
    assert.equal(first.readyState, 1, 'the unanswered ping alone does not end it');
    advance(15_000);
    live(15_000)!.fn();
    assert.equal(first.readyState, 3, 'the quiet connection was closed');
    assert.equal(statuses[statuses.length - 1].state, 'reconnecting');
    lastLive().fn();
    assert.equal(FakeSocket.all.length, 2, 'and a new one is opened');
    assert.ok(timers.length > 0);
  });

  test('a timer that fires late does not make a healthy connection look dead', () => {
    // After the Mac naps, the next ping can be due 40 seconds late. The server is fine: it answered the last one at once.
    const { room, advance, live } = clocked();
    room.open();
    const first = FakeSocket.all[0];
    first.open();
    first.deliver(welcome);
    advance(15_000);
    live(15_000)!.fn();
    first.deliver({ t: 'pong', at: 16_000, serverTime: 0 });
    advance(40_000);
    live(15_000)!.fn();
    assert.equal(first.readyState, 1, 'still the same connection');
    assert.equal(FakeSocket.all.length, 1);
    assert.equal(first.sent.filter((m) => m.t === 'ping').length, 2, 'it just pings now');
  });

  test('anything the server says counts as an answer', () => {
    const { room, advance, live } = clocked();
    room.open();
    const first = FakeSocket.all[0];
    first.open();
    first.deliver(welcome);
    advance(15_000);
    live(15_000)!.fn();
    first.deliver({ t: 'state', time: 1, p: [] });
    advance(15_000);
    live(15_000)!.fn();
    assert.equal(first.readyState, 1);
  });

  test('a message is not sent before the server has welcomed the person, even though the socket is open', () => {
    const { room } = clocked();
    room.open();
    const ws = FakeSocket.all[0];
    ws.open();
    assert.equal(room.send({ t: 'ping', at: 1 }), false, 'the server would ignore it');
    assert.deepEqual(ws.sent.map((m) => m.t), ['hello']);
    ws.deliver(welcome);
    assert.equal(room.send({ t: 'ping', at: 1 }), true);
    // And not again after the connection drops and a new one opens but is not welcomed yet.
    ws.drop(1006);
    assert.equal(room.send({ t: 'ping', at: 1 }), false);
  });

  test('a server that never answers the hello is given up on', () => {
    const { room, statuses, live, lastLive } = clocked();
    room.open();
    const first = FakeSocket.all[0];
    first.open();
    assert.ok(live(20_000), 'a handshake timer is running');
    live(20_000)!.fn();
    assert.equal(first.readyState, 3);
    assert.equal(statuses[statuses.length - 1].state, 'reconnecting');
    lastLive().fn();
    assert.equal(FakeSocket.all.length, 2);
  });

  test('a welcome stops the handshake timer', () => {
    const { room, timers } = clocked();
    room.open();
    FakeSocket.all[0].open();
    const handshake = timers.find((t) => t.ms === 20_000)!;
    FakeSocket.all[0].deliver(welcome);
    assert.equal(handshake.live, false);
  });

  test('reconnects are spread out, so a restart does not bring every window back at once', () => {
    for (const [random, expected] of [[0, 500], [0.5, 750], [1, 1000]] as const) {
      const { room, live } = clocked({ random: () => random });
      room.open();
      FakeSocket.all[0].open();
      FakeSocket.all[0].deliver(welcome);
      FakeSocket.all[0].drop(1006);
      assert.equal(live(expected)?.ms, expected, `random ${random}`);
    }
  });

  describe('with a sign-in token to fetch', () => {
    const gate = () => {
      let resolve!: (token: string) => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise<string>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    };

    test('the token is fetched before the socket opens, and sent in the hello', async () => {
      let asked = 0;
      const { room, statuses } = clocked({ credential: async () => `token-${++asked}`, hello: () => ({ name: 'Ada', look: lookFromSeed('ada') }) });
      room.open();
      assert.equal(FakeSocket.all.length, 0, 'nothing is opened before the token is there');
      assert.equal(statuses[0].state, 'connecting');
      await tick();
      assert.equal(FakeSocket.all.length, 1);
      FakeSocket.all[0].open();
      assert.equal((FakeSocket.all[0].sent[0] as Extract<ClientMsg, { t: 'hello' }>).token, 'token-1');
    });

    test('a reconnect fetches a new token', async () => {
      let asked = 0;
      const { room, lastLive } = clocked({ credential: async () => `token-${++asked}` });
      room.open();
      await tick();
      FakeSocket.all[0].open();
      FakeSocket.all[0].deliver(welcome);
      FakeSocket.all[0].drop(1006);
      lastLive().fn();
      await tick();
      FakeSocket.all[1].open();
      assert.equal((FakeSocket.all[1].sent[0] as Extract<ClientMsg, { t: 'hello' }>).token, 'token-2');
    });

    test('closing while the token is being fetched means no socket is ever opened', async () => {
      const g = gate();
      const { room, statuses } = clocked({ credential: () => g.promise });
      room.open();
      room.close();
      g.resolve('late');
      await tick();
      assert.equal(FakeSocket.all.length, 0);
      assert.equal(statuses[statuses.length - 1].state, 'closed');
    });

    test('opening again while the first token is still coming makes one socket, from the newer attempt', async () => {
      const g = gate();
      let asked = 0;
      const { room } = clocked({ credential: () => (asked++, g.promise) });
      room.open();
      room.open();
      g.resolve('shared');
      await tick();
      assert.equal(asked, 1, 'one request for the token, shared');
      assert.equal(FakeSocket.all.length, 1, 'and one socket');
    });

    test('being offline, or the demo server being out of reach, is tried again after the usual delay', async () => {
      for (const code of ['offline', 'demo_unreachable', 'demo_refused']) {
        let fails = 1;
        const { room, statuses, lastLive } = clocked({ credential: () => (fails-- > 0 ? Promise.reject(code) : Promise.resolve('ok')) });
        room.open();
        await tick();
        assert.equal(statuses[statuses.length - 1].state, 'reconnecting', code);
        assert.equal(lastLive().ms, 1000);
        lastLive().fn();
        await tick();
        assert.equal(FakeSocket.all.length, 1, 'the second try got through');
      }
    });

    test('anything else a failed sign-in says is shown as it is, and is final', async () => {
      const { room, statuses } = clocked({ credential: () => Promise.reject('The server said something specific.') });
      room.open();
      await tick();
      assert.deepEqual(statuses[statuses.length - 1], { state: 'failed', message: 'The server said something specific.', code: 'credential' });
    });

    test('after a final failure, opening again tries again', async () => {
      let fail = true;
      const { room, statuses } = clocked({ credential: () => (fail ? Promise.reject('The server said something specific.') : Promise.resolve('ok')) });
      room.open();
      await tick();
      assert.equal(statuses[statuses.length - 1].state, 'failed');
      fail = false;
      room.open();
      await tick();
      assert.equal(FakeSocket.all.length, 1);
    });
  });

  test('works out the round trip from a pong', () => {
    const { room, statuses, sock } = remote();
    room.open();
    sock().open();
    sock().deliver(welcome);
    sock().deliver({ t: 'pong', at: 940, serverTime: 0 });
    assert.equal(statuses[statuses.length - 1].latencyMs, 60);
  });
});

const john: AgentRef = { handle: 'john', name: 'John', role: 'Shopping advisor', look: lookFromSeed('agent:john') };
describe('LocalRoom', () => {
  async function entered(t: TestContext) {
    let clock = 1_000_000;
    const room = new LocalRoom({ uid: 'me', name: 'Me', look: lookFromSeed('me'), now: () => (clock += 3), rand: () => 'r' });
    t.after(() => room.close());
    const got: ServerMsg[] = [];
    room.onMessage((m) => got.push(m));
    room.open();
    await tick();
    const chats = () => got.filter((m): m is Extract<ServerMsg, { t: 'chat' }> => m.t === 'chat').map((m) => m.msg);
    /** Sends a chat and waits for the saved copy. */
    const say = async (text: string, cid = `c${got.length}`) => {
      const before = chats().length;
      room.send({ t: 'chat', text, cid });
      await tick();
      assert.equal(chats().length, before + 1, `"${text}" was saved`);
      return chats()[before];
    };
    return { room, got, chats, say, welcome: got[0] as Extract<ServerMsg, { t: 'welcome' }> };
  }

  test('welcomes the person into the sample office, alone, with the chat as the server would send it', async (t) => {
    const { welcome } = await entered(t);
    assert.equal(welcome.t, 'welcome');
    assert.equal(welcome.you, 'me');
    assert.equal(welcome.role, 'owner');
    assert.deepEqual(welcome.players.map((p) => p.id), ['me'], 'agents are not in the office');
    assert.deepEqual(welcome.map.zones.map((z) => z.id), ['lobby', 'plan', 'review', 'z-me'], 'the lobby, the two rooms and the person’s own zone');
    assert.deepEqual(welcome.deskOwners, { 'desk-me': 'me' });
    assert.equal(welcome.history[0].kind, 'system');
    assert.equal(welcome.historyHasMore, false);
    assert.deepEqual(welcome.thinking, []);
    assert.equal(welcome.protocol, PROTOCOL_VERSION);
  });

  test('walls stop people just like on the server', async (t) => {
    const { room, got, welcome } = await entered(t);
    const me = welcome.players.find((p) => p.id === 'me')!;
    room.send({ t: 'move', x: 1.5, y: 1.5, dir: 'up', moving: true });
    assert.deepEqual(got[got.length - 1], { t: 'correct', x: me.x, y: me.y });
    const count = got.length;
    room.send({ t: 'move', x: me.x + 0.5, y: me.y, dir: 'right', moving: true });
    assert.equal(got.length, count, 'a step into free floor needs no correction');
  });

  test('sitting still at a desk keeps you seated, and walking away stands you up', async (t) => {
    const { room, got, welcome } = await entered(t);
    const desk = welcome.map.props.find((p) => p.id === 'desk-me')!;
    // Stand next to the desk's chair, sit, and report the same spot again, as the app does a moment later.
    room.send({ t: 'move', x: desk.x + 1.5, y: desk.y + 2.5, dir: 'up', moving: false });
    room.send({ t: 'sit', deskId: desk.id });
    room.send({ t: 'move', x: desk.x + 1.5, y: desk.y + 1.5, dir: 'up', moving: false });
    room.send({ t: 'sit', deskId: null });
    const standUp = got[got.length - 1] as Extract<ServerMsg, { t: 'correct' }>;
    assert.equal(standUp.t, 'correct', 'standing up puts you on a free tile next to the chair');
    assert.ok(standUp.y > desk.y + 1.5);
  });

  test('a message is saved with an id, the sender’s look, the agents it calls, and comes back with its cid', async (t) => {
    const { room, chats, say } = await entered(t);
    room.send({ t: 'chat', text: 'psst @John and @john and @sarah', cid: 'c1' });
    assert.equal(chats().length, 0, 'the answer comes after send returns, like over a network');
    await tick();
    const m = chats()[0];
    assert.equal(m.kind, 'human');
    assert.equal(m.from, 'me');
    assert.equal(m.fromName, 'Me');
    assert.deepEqual(m.mentions, ['john', 'sarah']);
    assert.equal(m.cid, 'c1');
    assert.ok(m.look);
    const next = await say('second');
    assert.ok(next.at > m.at && next.id > m.id, 'ids and times only go up');
  });

  test('a message the server would refuse is answered, not dropped', async (t) => {
    const { room, got } = await entered(t);
    room.send({ t: 'chat', text: '   ', cid: 'c7' });
    await tick();
    assert.deepEqual(got[got.length - 1], { t: 'error', code: 'bad_request', message: 'That message couldn’t be sent.', cid: 'c7' });
    room.send({ t: 'chat', scope: 'nearby', text: 'hi', cid: 'c8' } as unknown as ClientMsg);
    await tick();
    assert.equal((got[got.length - 1] as Extract<ServerMsg, { t: 'error' }>).cid, 'c8', 'the old nearby chat is refused too');
  });

  test('earlier messages come in pages from the newest, with no gaps and no repeats', async (t) => {
    const { room, got, say } = await entered(t);
    for (let i = 1; i <= 70; i++) await say(`message ${i}`);
    const asked = (before?: { at: number; id: string }, limit?: number) => {
      room.send({ t: 'history.get', reqId: `h${got.length}`, before, limit });
      return tick().then(() => got[got.length - 1] as Extract<ServerMsg, { t: 'history.page' }>);
    };
    const first = await asked(undefined, 50);
    assert.equal(first.t, 'history.page');
    assert.equal(first.messages.length, 50);
    assert.equal(first.messages[49].text, 'message 70');
    assert.equal(first.hasMore, true);
    const second = await asked({ at: first.messages[0].at, id: first.messages[0].id }, 50);
    assert.equal(second.messages.length, 21, '70 messages and the office’s own note, less the 50 already shown');
    assert.equal(second.messages[20].text, 'message 20');
    assert.equal(second.hasMore, false);
    assert.equal(second.messages[0].kind, 'system');
  });

  test('joining again shows the latest 30 and says there is more', async (t) => {
    const { room, got, say } = await entered(t);
    for (let i = 1; i <= 40; i++) await say(`message ${i}`);
    room.close();
    room.open();
    await tick();
    const again = got.filter((m): m is Extract<ServerMsg, { t: 'welcome' }> => m.t === 'welcome')[1];
    assert.equal(again.history.length, 30);
    assert.equal(again.history[29].text, 'message 40');
    assert.equal(again.historyHasMore, true);
  });

  test('a deleted message stays in the list as a tombstone', async (t) => {
    const { room, got, say } = await entered(t);
    const m = await say('oops');
    room.send({ t: 'chat.delete', id: m.id });
    await tick();
    assert.deepEqual(got[got.length - 1], { t: 'chat.deleted', id: m.id });
    room.send({ t: 'history.get', reqId: 'h1' });
    await tick();
    const page = got[got.length - 1] as Extract<ServerMsg, { t: 'history.page' }>;
    const gone = page.messages.find((x) => x.id === m.id)!;
    assert.equal(gone.deleted, true);
    assert.equal(gone.text, '');
  });

  test('an agent is started by the message that mentions it, answers once, and is shown while it works', async (t) => {
    const { room, got, chats, say } = await entered(t);
    const ask = await say('@john please recommend a phone');
    const statuses = () => got.filter((m): m is Extract<ServerMsg, { t: 'agent.status' }> => m.t === 'agent.status').map((m) => m.status);

    room.send({ t: 'agent.start', reqId: 'r1', replyTo: ask.id, agent: john, mode: 'fresh' });
    await tick();
    assert.equal(statuses().length, 1);
    assert.equal(statuses()[0].state, 'thinking');
    assert.equal(statuses()[0].byName, 'Me');
    assert.equal(statuses()[0].agent.name, 'John');

    room.send({ t: 'agent.reply', reqId: 'r1', replyTo: ask.id, agent: john, text: 'Try the Pixel 9.' });
    await tick();
    const reply = chats().find((m) => m.kind === 'agent')!;
    assert.equal(reply.id, agentReplyId(ask.id, 'john'));
    assert.equal(reply.from, 'agent:john');
    assert.equal(reply.fromName, 'John');
    assert.equal(reply.via, 'me');
    assert.equal(reply.viaName, 'Me');
    assert.equal(reply.replyTo, ask.id);
    assert.deepEqual(reply.mentions, []);
    assert.equal(statuses()[1].state, 'done');

    // Asking again for the same message does not produce a second answer.
    room.send({ t: 'agent.start', reqId: 'r2', replyTo: ask.id, agent: john, mode: 'rerun' });
    await tick();
    assert.equal(statuses()[2].state, 'done');
    assert.equal(chats().filter((m) => m.kind === 'agent').length, 1);
  });

  test('an agent that was not mentioned, or a message that is not yours, is refused with the request id', async (t) => {
    const { room, got, say } = await entered(t);
    const plain = await say('no mention here');
    room.send({ t: 'agent.start', reqId: 'r1', replyTo: plain.id, agent: john, mode: 'fresh' });
    await tick();
    const error = got[got.length - 1] as Extract<ServerMsg, { t: 'error' }>;
    assert.equal(error.t, 'error');
    assert.equal(error.reqId, 'r1');
    room.send({ t: 'agent.start', reqId: 'r2', replyTo: 'nope', agent: john, mode: 'fresh' });
    await tick();
    assert.equal((got[got.length - 1] as Extract<ServerMsg, { t: 'error' }>).reqId, 'r2');
  });

  test('a failed agent run ends without an answer', async (t) => {
    const { room, got, chats, say } = await entered(t);
    const ask = await say('@john hello');
    room.send({ t: 'agent.start', reqId: 'r1', replyTo: ask.id, agent: john, mode: 'fresh' });
    room.send({ t: 'agent.fail', reqId: 'r1' });
    await tick();
    const states = got.filter((m): m is Extract<ServerMsg, { t: 'agent.status' }> => m.t === 'agent.status').map((m) => m.status.state);
    assert.deepEqual(states, ['thinking', 'failed']);
    assert.equal(chats().filter((m) => m.kind === 'agent').length, 0);
  });

  test('a reply that is empty or too long fails the run instead of being posted', async (t) => {
    const { room, got, chats, say } = await entered(t);
    const ask = await say('@john hello');
    room.send({ t: 'agent.start', reqId: 'r1', replyTo: ask.id, agent: john, mode: 'fresh' });
    room.send({ t: 'agent.reply', reqId: 'r1', replyTo: ask.id, agent: john, text: 'x'.repeat(6001) });
    await tick();
    const last = got.filter((m): m is Extract<ServerMsg, { t: 'agent.status' }> => m.t === 'agent.status').pop()!;
    assert.equal(last.status.state, 'failed');
    assert.equal(chats().filter((m) => m.kind === 'agent').length, 0);
    // The server leaves a note in the conversation, and so does this.
    const note = chats().find((m) => m.id === agentFailureId(ask.id, 'john'))!;
    assert.equal(note.kind, 'system');
    assert.match(note.text, /couldn’t be posted/);
  });

  test('the sender’s own id comes back on the saved copy but is never kept: history does not have it', async (t) => {
    const { room, got, chats, say } = await entered(t);
    const m = await say('hello', 'c-mine');
    assert.equal(m.cid, 'c-mine', 'the echo carries it');
    room.send({ t: 'history.get', reqId: 'h1' });
    await tick();
    const page = got[got.length - 1] as Extract<ServerMsg, { t: 'history.page' }>;
    assert.equal(page.messages.find((x) => x.id === m.id)!.cid, undefined);
    assert.ok(chats().length >= 1);
  });

  test('a question is only answered while it is as recent as that way of asking allows', async (t) => {
    let clock = 1_000_000;
    const room = new LocalRoom({ uid: 'me', name: 'Me', look: lookFromSeed('me'), now: () => clock, rand: () => 'r' });
    t.after(() => room.close());
    const got: ServerMsg[] = [];
    room.onMessage((m) => got.push(m));
    room.open();
    await tick();
    room.send({ t: 'chat', text: '@john hello', cid: 'c1' });
    await tick();
    const ask = got.find((m): m is Extract<ServerMsg, { t: 'chat' }> => m.t === 'chat')!.msg;
    const start = async (reqId: string, mode: 'fresh' | 'resume' | 'rerun') => {
      room.send({ t: 'agent.start', reqId, replyTo: ask.id, agent: john, mode });
      await tick();
      return got[got.length - 1];
    };
    clock += 61_000;
    assert.equal(((await start('r1', 'fresh')) as Extract<ServerMsg, { t: 'error' }>).code, 'not_allowed', 'a fresh question is seconds old');
    assert.equal(((await start('r2', 'resume')) as Extract<ServerMsg, { t: 'agent.status' }>).status.state, 'thinking', 'a re-attach may be minutes old');
    clock += 16 * 60_000;
    assert.equal(((await start('r3', 'resume')) as Extract<ServerMsg, { t: 'error' }>).code, 'not_allowed');
    assert.equal(((await start('r4', 'rerun')) as Extract<ServerMsg, { t: 'agent.status' }>).status.state, 'queued', 'a run again may be a day old, and waits for the one before it');
  });

  test('a second run waits for the first, and takes its turn when the first ends', async (t) => {
    const { room, got, say } = await entered(t);
    const a = await say('@john first');
    const b = await say('@john second');
    const statuses = () => got.filter((m): m is Extract<ServerMsg, { t: 'agent.status' }> => m.t === 'agent.status').map((m) => `${m.status.reqId}:${m.status.state}`);
    room.send({ t: 'agent.start', reqId: 'r1', replyTo: a.id, agent: john, mode: 'fresh' });
    room.send({ t: 'agent.start', reqId: 'r2', replyTo: b.id, agent: john, mode: 'fresh' });
    await tick();
    assert.deepEqual(statuses(), ['r1:thinking', 'r2:queued']);
    room.send({ t: 'agent.reply', reqId: 'r1', replyTo: a.id, agent: john, text: 'one' });
    await tick();
    assert.deepEqual(statuses().slice(2), ['r1:done', 'r2:thinking']);
  });

  test('an answer that was taken back can be asked for again, and the new one replaces it', async (t) => {
    const { room, got, chats, say } = await entered(t);
    const ask = await say('@john hello');
    room.send({ t: 'agent.start', reqId: 'r1', replyTo: ask.id, agent: john, mode: 'fresh' });
    room.send({ t: 'agent.reply', reqId: 'r1', replyTo: ask.id, agent: john, text: 'first answer' });
    await tick();
    const first = chats().find((m) => m.kind === 'agent')!;
    room.send({ t: 'chat.delete', id: first.id });
    await tick();
    // Only "Run again" may ask once more.
    room.send({ t: 'agent.start', reqId: 'r2', replyTo: ask.id, agent: john, mode: 'fresh' });
    await tick();
    assert.equal((got[got.length - 1] as Extract<ServerMsg, { t: 'agent.status' }>).status.state, 'done', 'a plain start finds it answered');
    room.send({ t: 'agent.start', reqId: 'r3', replyTo: ask.id, agent: john, mode: 'rerun' });
    await tick();
    assert.equal((got[got.length - 1] as Extract<ServerMsg, { t: 'agent.status' }>).status.state, 'thinking');
    room.send({ t: 'agent.reply', reqId: 'r3', replyTo: ask.id, agent: john, text: 'second answer' });
    await tick();
    const revived = chats().filter((m) => m.kind === 'agent').pop()!;
    assert.equal(revived.id, first.id);
    assert.equal(revived.text, 'second answer');
    assert.ok(revived.at > first.at, 'saved again at a later time, which is how a client tells it from the removed one');
    room.send({ t: 'history.get', reqId: 'h1' });
    await tick();
    const page = got[got.length - 1] as Extract<ServerMsg, { t: 'history.page' }>;
    assert.equal(page.messages.filter((m) => m.id === first.id).length, 1, 'one row, not two');
    assert.equal(page.messages.find((m) => m.id === first.id)!.text, 'second answer');
  });

  test('nothing is sent before the office is open or after it is closed', async (t) => {
    const room = new LocalRoom({ uid: 'me', name: 'Me', look: lookFromSeed('me') });
    t.after(() => room.close());
    assert.equal(room.send({ t: 'ping', at: 1 }), false);
    room.open();
    await tick();
    assert.equal(room.send({ t: 'ping', at: 1 }), true);
    room.close();
    assert.equal(room.send({ t: 'ping', at: 1 }), false);
  });
});
