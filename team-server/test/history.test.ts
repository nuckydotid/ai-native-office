import assert from 'node:assert/strict';
import { afterAll, beforeAll, describe, test } from 'bun:test';
import { lookFromSeed } from '../src/shared/workspace/looks.ts';
import type { ServerMsg } from '../src/shared/workspace/protocol.ts';
import type { ChatMessage } from '../src/shared/workspace/types.ts';
import { setSilent } from '../src/log.ts';
import type { TeamServer } from '../src/server.ts';
import { MemoryStore } from '../src/store.ts';
import type { Store } from '../src/store.ts';
import { Bot, sleep, startDevServer } from './bot.ts';

setSilent(true);

const human = (i: number, from = 'dev-seed'): ChatMessage => ({
  id: `m${String(i).padStart(3, '0')}`,
  kind: 'human',
  from,
  fromName: 'Seed',
  look: lookFromSeed('seed'),
  text: `message ${i}`,
  at: 1000 + i,
  mentions: [],
});

type Page = Extract<ServerMsg, { t: 'history.page' }>;

describe('saved history', () => {
  let server: TeamServer;
  let store: MemoryStore;
  let url = '';
  const bots: Bot[] = [];

  beforeAll(async () => {
    store = new MemoryStore();
    await store.putSession('main', { id: 's1', room: 'lobby', state: 'active', createdAt: 1000, createdBy: 'seed' });
    // 70 messages, two of them sharing the same instant (the order must still be stable).
    for (let i = 1; i <= 70; i++) await store.appendMessage('main', i === 36 ? { ...human(i), at: 1000 + 35, session: 's1', room: 'lobby' } : { ...human(i), session: 's1', room: 'lobby' });
    ({ server, url } = await startDevServer({}, { store }));
  });
  afterAll(async () => {
    for (const b of bots) b.ws?.terminate();
    await server.close();
  });

  const join = async (uid: string) => {
    const b = new Bot(uid, url);
    bots.push(b);
    return b.connect();
  };

  test('a joiner gets the latest 30 and is told there are more', async () => {
    const a = await join('h1');
    assert.equal(a.welcome.history.length, 30);
    assert.equal(a.welcome.history[0].id, 'm041');
    assert.equal(a.welcome.history.at(-1)?.id, 'm070');
    assert.equal(a.welcome.historyHasMore, true);
  });

  test('"load earlier" pages back to the very first message, in order, with no repeats', async () => {
    const a = await join('h2');
    const seen: string[] = a.welcome.history.map((m) => m.id);
    let oldest = a.welcome.history[0];
    let hasMore = a.welcome.historyHasMore;
    let n = 0;
    while (hasMore) {
      a.send({ t: 'history.get', reqId: `p${n}`, before: { at: oldest.at, id: oldest.id }, limit: 30 });
      const page = await a.waitFor<Page>((m) => m.t === 'history.page' && m.reqId === `p${n}`);
      assert.equal(page.error, undefined);
      assert.ok(page.messages.length > 0);
      seen.unshift(...page.messages.map((m) => m.id));
      oldest = page.messages[0];
      hasMore = page.hasMore;
      n += 1;
    }
    assert.equal(seen.length, 70);
    assert.equal(new Set(seen).size, 70, 'nothing twice');
    assert.equal(seen[0], 'm001');
    // m036 was saved at the same instant as m035: it still sits right after it.
    assert.ok(seen.indexOf('m036') > seen.indexOf('m035') && seen.indexOf('m036') < seen.indexOf('m037'));
  });

  test('asking for history without a cursor is "load latest"', async () => {
    const a = await join('h3');
    await a.say('a brand new one');
    a.send({ t: 'history.get', reqId: 'latest', limit: 5 });
    const page = await a.waitFor<Page>((m) => m.t === 'history.page' && m.reqId === 'latest');
    assert.equal(page.messages.length, 5);
    assert.equal(page.messages.at(-1)?.text, 'a brand new one');
    assert.equal(page.hasMore, true);
  });

  test('history requests are rate limited and answered', async () => {
    const a = await join('h4');
    for (let i = 0; i < 12; i++) a.send({ t: 'history.get', reqId: `x${i}`, limit: 1 });
    await sleep(300);
    assert.ok(a.inbox.some((m) => m.t === 'error' && m.code === 'rate_limited' && m.reqId?.startsWith('x')));
  });
});

/** A store whose writes can be made to fail, to check that nothing is shown that was not saved. */
class FlakyStore extends MemoryStore {
  failAppend = false;
  override async appendMessage(wid: string, msg: ChatMessage) {
    if (this.failAppend) throw new Error('database unavailable');
    return super.appendMessage(wid, msg);
  }
  override async insertMessage(wid: string, msg: ChatMessage) {
    if (this.failAppend) throw new Error('database unavailable');
    return super.insertMessage(wid, msg);
  }
  failList = false;
  override async listMessages(wid: string, opts: Parameters<Store['listMessages']>[1]) {
    if (this.failList) throw new Error('database unavailable');
    return super.listMessages(wid, opts);
  }
}

describe('when the database fails', () => {
  test('a message that was not saved is not shown to anyone, and the sender is told which one', async () => {
    const store = new FlakyStore();
    const { server, url } = await startDevServer({}, { store });
    const a = await new Bot('f1', url).connect();
    const b = await new Bot('f2', url).connect();
    store.failAppend = true;
    a.send({ t: 'chat', text: 'lost', cid: 'lost-1' });
    const err = await a.waitFor<Extract<ServerMsg, { t: 'error' }>>((m) => m.t === 'error' && m.cid === 'lost-1');
    assert.equal(err.code, 'not_saved');
    await b.expectNone((m) => m.t === 'chat' && m.msg.text === 'lost');
    // The retry works once the database is back, and is saved once.
    store.failAppend = false;
    a.send({ t: 'chat', text: 'lost', cid: 'lost-1' });
    await b.waitFor((m) => m.t === 'chat' && m.msg.text === 'lost');
    assert.equal((await store.listMessages('main', { limit: 10 })).messages.filter((m) => m.text === 'lost').length, 1);
    a.ws.terminate();
    b.ws.terminate();
    await server.close();
  });

  test('a history page that cannot be loaded says so, and can be asked for again', async () => {
    const store = new FlakyStore();
    const { server, url } = await startDevServer({}, { store });
    const a = await new Bot('f3', url).connect();
    store.failList = true;
    a.send({ t: 'history.get', reqId: 'h1', limit: 10 });
    const page = await a.waitFor<Page>((m) => m.t === 'history.page' && m.reqId === 'h1');
    assert.deepEqual([page.error, page.hasMore, page.messages.length], ['unavailable', true, 0]);
    a.ws.terminate();
    await server.close();
  });
});
