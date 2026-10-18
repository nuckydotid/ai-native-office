import assert from 'node:assert/strict';
import { afterAll, describe, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { buildOfficeMap } from '../src/shared/workspace/layout.ts';
import { lookFromSeed } from '../src/shared/workspace/looks.ts';
import type { ChatMessage } from '../src/shared/workspace/types.ts';
import { MemoryStore, PostgresStore } from '../src/store.ts';
import type { MemberDoc, SqlClient, Store } from '../src/store.ts';

const msg = (id: string, at: number, over: Partial<ChatMessage> = {}): ChatMessage => ({ id, at, kind: 'human', from: 'u', fromName: 'Ann', look: lookFromSeed('u'), text: id, mentions: [], ...over });
const member = (uid: string): MemberDoc => ({ uid, role: 'member', name: uid, look: lookFromSeed(uid), desk: null, joinedAt: 1, lastSeen: 2 });
const ids = (page: { messages: ChatMessage[] }) => page.messages.map((m) => m.id);

/** The same behaviour is required of both stores. Postgres runs on PGlite, a real Postgres engine in-process. */
function contract(name: string, make: () => Promise<{ store: Store; now: { t: number } }>) {
  describe(name, () => {
    test('workspace, members and map round-trip', async () => {
      const { store } = await make();
      assert.equal(await store.getWorkspace('main'), null);
      await store.putWorkspace({ id: 'main', name: 'Garden', createdAt: 5 });
      assert.deepEqual(await store.getWorkspace('main'), { id: 'main', name: 'Garden', createdAt: 5 });
      await store.putWorkspace({ id: 'main', name: 'Garden 2', createdAt: 99 });
      assert.deepEqual(await store.getWorkspace('main'), { id: 'main', name: 'Garden 2', createdAt: 5 }, 'a rename keeps the creation time');

      await store.putMember('main', member('a'));
      await store.putMember('main', { ...member('a'), desk: 'd1' });
      await store.putMember('main', member('b'));
      const members = await store.listMembers('main');
      assert.deepEqual(members.map((m) => m.uid).sort(), ['a', 'b']);
      assert.equal(members.find((m) => m.uid === 'a')?.desk, 'd1');
      assert.deepEqual(await store.listMembers('other'), []);

      assert.equal(await store.loadMap('main'), null);
      const map = buildOfficeMap([{ uid: 'ada', name: 'Ada', joinedAt: 1 }]);
      await store.saveMap('main', map);
      assert.deepEqual(await store.loadMap('main'), map);
    });

    test('a member can be deleted, and have only its lastSeen touched', async () => {
      const { store } = await make();
      const only = async (uid: string) => (await store.listMembers('main')).find((m) => m.uid === uid) ?? null;
      await store.putMember('main', { ...member('a'), role: 'admin', desk: 'd1' });
      assert.equal((await only('a'))?.role, 'admin');
      assert.equal(await only('nobody'), null);
      await store.touchMember('main', 'a', 777);
      assert.deepEqual(await only('a'), { ...member('a'), role: 'admin', desk: 'd1', lastSeen: 777 }, 'only lastSeen changed');
      await store.touchMember('main', 'nobody', 1);
      await store.deleteMember('main', 'a');
      assert.equal(await only('a'), null);
    });

    test('messages page back from the newest, oldest first within a page, with hasMore', async () => {
      const { store } = await make();
      for (let i = 1; i <= 5; i++) await store.appendMessage('main', msg(`m${i}`, i * 1000));
      const latest = await store.listMessages('main', { limit: 3 });
      assert.deepEqual([ids(latest), latest.hasMore], [['m3', 'm4', 'm5'], true]);
      const older = await store.listMessages('main', { before: { at: 3000, id: 'm3' }, limit: 3 });
      assert.deepEqual([ids(older), older.hasMore], [['m1', 'm2'], false], 'exactly the rest: nothing more');
      const exact = await store.listMessages('main', { before: { at: 3000, id: 'm3' }, limit: 2 });
      assert.deepEqual([ids(exact), exact.hasMore], [['m1', 'm2'], false], 'a page that ends exactly at the start is not "has more"');
      assert.deepEqual(await store.listMessages('other', { limit: 3 }), { messages: [], hasMore: false });
    });

    test('messages saved in the same instant keep a stable order, and the cursor never skips one', async () => {
      const { store } = await make();
      // Same `at`; ids that sort differently by case and punctuation: the order is by code unit, as in JavaScript and COLLATE "C".
      for (const id of ['b-2', 'B-1', 'a-1', 'a-10', 'a-9']) await store.appendMessage('main', msg(id, 5000));
      await store.appendMessage('main', msg('z-0', 4000));
      const all = await store.listMessages('main', { limit: 50 });
      assert.deepEqual(ids(all), ['z-0', 'B-1', 'a-1', 'a-10', 'a-9', 'b-2']);
      const walked: string[] = [];
      let before: { at: number; id: string } | undefined;
      for (;;) {
        const page = await store.listMessages('main', { before, limit: 2 });
        walked.unshift(...ids(page));
        if (!page.hasMore) break;
        before = { at: page.messages[0].at, id: page.messages[0].id };
      }
      assert.deepEqual(walked, ids(all), 'paging two at a time visits every message exactly once, in order');
    });

    test('getMessage, and saving a message again replaces it', async () => {
      const { store } = await make();
      assert.equal(await store.getMessage('main', 'x'), null);
      await store.appendMessage('main', msg('x', 1));
      await store.appendMessage('main', msg('x', 1, { text: 'edited' }));
      assert.equal((await store.getMessage('main', 'x'))?.text, 'edited');
      assert.equal((await store.listMessages('main', { limit: 10 })).messages.length, 1);
    });

    test('insertMessageOnce saves once, and only the person who took an answer back may replace it', async () => {
      const { store } = await make();
      assert.equal(await store.insertMessageOnce('main', msg('a:m1:john', 10, { kind: 'agent', text: 'first' })), true);
      assert.equal(await store.insertMessageOnce('main', msg('a:m1:john', 20, { kind: 'agent', text: 'second' })), false);
      assert.equal((await store.getMessage('main', 'a:m1:john'))?.text, 'first');
      await store.markMessageDeleted('main', 'a:m1:john', 'ann');
      assert.equal((await store.getMessage('main', 'a:m1:john'))?.deletedBy, 'ann', 'a tombstone remembers who deleted it');
      assert.equal(await store.insertMessageOnce('main', msg('a:m1:john', 30, { kind: 'agent', text: 'nope' })), false, 'nobody revives it by default');
      assert.equal(await store.insertMessageOnce('main', msg('a:m1:john', 30, { kind: 'agent', text: 'nope' }), { reviveBy: 'bob' }), false, 'not by someone who did not delete it');
      assert.equal((await store.getMessage('main', 'a:m1:john'))?.deleted, true);
      assert.equal(await store.insertMessageOnce('main', msg('a:m1:john', 40, { kind: 'agent', text: 'third' }), { reviveBy: 'ann' }), true, 'the one who took it back can ask again');
      const now = await store.getMessage('main', 'a:m1:john');
      assert.deepEqual([now?.text, now?.deleted, now?.deletedBy], ['third', undefined, undefined]);
    });

    test('a deleted message with no recorded deleter can never be revived', async () => {
      const { store } = await make();
      await store.insertMessageOnce('main', msg('a:m2:john', 10, { kind: 'agent', text: 'first' }));
      await store.markMessageDeleted('main', 'a:m2:john');
      assert.equal(await store.insertMessageOnce('main', msg('a:m2:john', 20, { kind: 'agent', text: 'again' }), { reviveBy: 'ann' }), false);
      assert.equal(await store.insertMessageOnce('main', msg('a:m2:john', 20, { kind: 'agent', text: 'again' }), { reviveBy: '' }), false);
    });

    test('insertMessage saves a message only if nothing, not even a deleted one, has that id', async () => {
      const { store } = await make();
      assert.equal(await store.insertMessage('main', msg('h1', 10, { text: 'first' })), true);
      assert.equal(await store.insertMessage('main', msg('h1', 20, { text: 'second' })), false);
      assert.equal((await store.getMessage('main', 'h1'))?.text, 'first');
      assert.equal((await store.getMessage('main', 'h1'))?.at, 10, 'it was not moved');
      await store.markMessageDeleted('main', 'h1', 'owner');
      assert.equal(await store.insertMessage('main', msg('h1', 30, { text: 'again' })), false, 'a deleted message does not come back');
      assert.equal((await store.getMessage('main', 'h1'))?.deleted, true);
    });

    test('a deleted message stays as a tombstone in the same place', async () => {
      const { store } = await make();
      for (let i = 1; i <= 3; i++) await store.appendMessage('main', msg(`m${i}`, i));
      const gone = await store.markMessageDeleted('main', 'm2');
      assert.deepEqual([gone?.deleted, gone?.text, gone?.from], [true, '', 'u']);
      const page = await store.listMessages('main', { limit: 10 });
      assert.deepEqual(ids(page), ['m1', 'm2', 'm3']);
      assert.equal(page.messages[1].deleted, true);
      assert.equal(await store.markMessageDeleted('main', 'nope'), null);
    });

    test('sessions round-trip, update state, and filter messages by session', async () => {
      const { store } = await make();
      assert.deepEqual(await store.listSessions('main'), []);
      await store.putSession('main', { id: 's1', room: 'design', state: 'active', createdAt: 100, createdBy: 'u1' });
      await store.putSession('main', { id: 's2', room: 'plaza', state: 'active', createdAt: 200, createdBy: 'u2' });
      assert.deepEqual(await store.listSessions('main'), [
        { id: 's1', room: 'design', state: 'active', createdAt: 100, createdBy: 'u1' },
        { id: 's2', room: 'plaza', state: 'active', createdAt: 200, createdBy: 'u2' },
      ]);

      await store.putSession('main', { id: 's1', room: 'design', state: 'archived', createdAt: 100, archivedAt: 150, createdBy: 'u1' });
      assert.deepEqual(await store.listSessions('main'), [
        { id: 's1', room: 'design', state: 'archived', createdAt: 100, archivedAt: 150, createdBy: 'u1' },
        { id: 's2', room: 'plaza', state: 'active', createdAt: 200, createdBy: 'u2' },
      ]);

      await store.appendMessage('main', msg('m-leg', 10));
      await store.appendMessage('main', msg('m-s1', 20, { session: 's1', room: 'design' }));
      await store.appendMessage('main', msg('m-s2', 30, { session: 's2', room: 'plaza' }));

      assert.deepEqual(ids(await store.listMessages('main', { limit: 10 })), ['m-leg', 'm-s1', 'm-s2']);
      assert.deepEqual(ids(await store.listMessages('main', { session: 's1', limit: 10 })), ['m-s1']);
      assert.deepEqual(ids(await store.listMessages('main', { session: 's2', limit: 10 })), ['m-s2']);
      assert.deepEqual(ids(await store.listMessages('main', { session: null, limit: 10 })), ['m-leg']);
      assert.deepEqual(ids(await store.listMessages('main', { session: 'legacy', limit: 10 })), ['m-leg']);

      await store.deleteSession('main', 's1');
      assert.deepEqual((await store.listSessions('main')).map((s) => s.id), ['s2']);
      assert.deepEqual(ids(await store.listMessages('main', { limit: 10 })), ['m-leg', 'm-s2']);

      await store.deleteSession('main', 'legacy');
      assert.deepEqual(ids(await store.listMessages('main', { limit: 10 })), ['m-s2']);
    });

    test('clearAll forgets everything, and the store is usable again afterwards', async () => {
      const { store } = await make();
      await store.putWorkspace({ id: 'main', name: 'Garden', createdAt: 5 });
      await store.putMember('main', member('a'));
      await store.putSession('main', { id: 's1', room: 'lobby', state: 'active', createdAt: 1, createdBy: 'a' });
      await store.appendMessage('main', msg('m1', 10, { session: 's1' }));
      await store.clearAll();
      assert.equal(await store.getWorkspace('main'), null);
      assert.deepEqual(await store.listMembers('main'), []);
      assert.deepEqual(await store.listSessions('main'), []);
      assert.equal(await store.getMessage('main', 'm1'), null);
      await store.putMember('main', member('b'));
      assert.deepEqual((await store.listMembers('main')).map((m) => m.uid), ['b']);
    });
  });
}

const engines: PGlite[] = [];
afterAll(async () => {
  for (const e of engines) await e.close();
});

contract('MemoryStore', async () => ({ store: new MemoryStore(), now: { t: 0 } }));
contract('PostgresStore (PGlite)', async () => {
  const db = new PGlite();
  engines.push(db);
  const now = { t: Date.now() };
  const store = new PostgresStore(db, async () => {}, () => now.t);
  await store.whenReady();
  return { store, now };
});

describe('MemoryStore', () => {
  test('keeps only the newest messages when it has a limit', async () => {
    const store = new MemoryStore(3);
    for (let i = 1; i <= 5; i++) await store.appendMessage('main', msg(`m${i}`, i));
    assert.deepEqual(ids(await store.listMessages('main', { limit: 10 })), ['m3', 'm4', 'm5']);
  });
});

describe('PostgresStore', () => {
  const day = 24 * 3600 * 1000;

  test('keeps the whole conversation by default', async () => {
    const db = new PGlite();
    engines.push(db);
    const now = { t: 1000 * day };
    const store = new PostgresStore(db, async () => {}, () => now.t);
    await store.whenReady();
    await store.appendMessage('main', msg('ancient', now.t - 900 * day));
    now.t += 5 * day;
    await store.appendMessage('main', msg('new', now.t));
    assert.deepEqual(ids(await store.listMessages('main', { limit: 10 })), ['ancient', 'new']);
  });

  test('with a retention limit, older chat is removed, at most once an hour', async () => {
    const db = new PGlite();
    engines.push(db);
    const now = { t: 100 * day };
    const store = new PostgresStore(db, async () => {}, () => now.t, 30 * day);
    await store.whenReady();
    await store.appendMessage('main', msg('old', now.t - 40 * day));
    await store.appendMessage('main', msg('recent', now.t - 1 * day));
    assert.deepEqual(ids(await store.listMessages('main', { limit: 10 })), ['old', 'recent'], 'not pruned yet: it just ran');
    now.t += 2 * 3600 * 1000;
    await store.appendMessage('main', msg('new', now.t));
    assert.deepEqual(ids(await store.listMessages('main', { limit: 10 })), ['recent', 'new']);
  });

  test('paging asks the database for the byte-wise order (a real Cloud SQL would otherwise sort by locale)', async () => {
    const db = new PGlite();
    engines.push(db);
    const seen: string[] = [];
    const spy: SqlClient = { query: (text, params) => (seen.push(text), db.query(text, params)) };
    const store = new PostgresStore(spy);
    await store.whenReady();
    await store.listMessages('main', { limit: 5 });
    await store.listMessages('main', { before: { at: 5, id: 'x' }, limit: 5 });
    const paging = seen.filter((q) => q.includes('FROM tm_message') && q.includes('ORDER BY'));
    assert.equal(paging.length, 2);
    for (const q of paging) assert.ok(q.includes('id COLLATE "C"'), q);
    // The cursor is one row comparison the index can use as a range, not an OR the planner has to scan for.
    const withCursor = paging.find((q) => q.includes('<'))!;
    assert.match(withCursor, /\(at, id COLLATE "C"\) < \(\$2::bigint, \$3::text COLLATE "C"\)/);
    assert.ok(!/\bOR\b/.test(withCursor.split('ORDER BY')[0]), withCursor);
    assert.ok(seen.some((q) => q.includes('CREATE INDEX IF NOT EXISTS tm_message_room_at_id')), 'the paging index is created');
  });

  test('a retention fraction, a failing prune and a failing index never stop the server starting or fail a save', async () => {
    const db = new PGlite();
    engines.push(db);
    const seen: { text: string; params?: unknown[] }[] = [];
    let failPrune = false;
    const flaky: SqlClient = {
      query: async (text, params) => {
        seen.push({ text, params });
        if (text.startsWith('CREATE INDEX')) throw new Error('canceling statement due to statement timeout');
        if (failPrune && text.startsWith('DELETE FROM tm_message')) throw new Error('canceling statement due to statement timeout');
        return db.query(text, params);
      },
    };
    const now = { t: 100 * day };
    // 0.1 days is not a whole number of milliseconds-per-day multiples a bigint accepts unless it is rounded.
    const store = new PostgresStore(flaky, async () => {}, () => now.t + 0.5, 0.1 * day);
    await store.whenReady();
    const prune = seen.find((q) => q.text.startsWith('DELETE FROM tm_message'))!;
    assert.ok(Number.isInteger(prune.params![0]), 'the cutoff is a whole number');
    failPrune = true;
    now.t += 2 * 3600 * 1000;
    await store.appendMessage('main', msg('saved-anyway', now.t));
    assert.deepEqual(ids(await store.listMessages('main', { limit: 5 })), ['saved-anyway'], 'the save counted although the prune failed');
  });

  test('starting twice on the same database is fine (tables are created if missing)', async () => {
    const db = new PGlite();
    engines.push(db);
    const a = new PostgresStore(db);
    await a.whenReady();
    await a.putWorkspace({ id: 'main', name: 'Garden', createdAt: 1 });
    const b = new PostgresStore(db);
    await b.whenReady();
    assert.equal((await b.getWorkspace('main'))?.name, 'Garden');
  });

  test('an unreachable database is reported by whenReady, not as an unhandled rejection', async () => {
    const store = new PostgresStore({ query: async () => Promise.reject(new Error('connection refused')) });
    await assert.rejects(store.whenReady(), /connection refused/);
    await assert.rejects(store.getWorkspace('main'), /connection refused/);
  });

  test('an emoji straddling the length limit is never saved as half an emoji', async () => {
    const db = new PGlite();
    engines.push(db);
    const store = new PostgresStore(db);
    await store.whenReady();
    // What the server's sanitizer produces at the limit is valid UTF-8, so Postgres jsonb accepts it.
    const { sanitizeText } = await import('../src/shared/workspace/protocol.ts');
    const text = sanitizeText(`${'x'.repeat(499)}${String.fromCodePoint(0x1f600)}${String.fromCodePoint(0x1f600)}`, 500);
    await store.appendMessage('main', msg('emoji', 1, { text }));
    assert.equal((await store.getMessage('main', 'emoji'))?.text, text);
  });
});
