import assert from 'node:assert/strict';
import { describe, test } from 'bun:test';
import { lookFromSeed } from '../src/shared/workspace/looks.ts';
import { RUN_HARD_CAP_MS, RUN_ORPHAN_MS, RunBook } from '../src/runs.ts';

const base = (uid: string, reqId: string, at = 0) => ({ runId: `run-${reqId}`, uid, byName: uid, reqId, replyTo: 'm1', agent: { handle: 'sarah', name: 'Sarah', look: lookFromSeed('sarah') }, startedAt: at, owner: {}, offlineSince: null, failures: 0 });

describe('RunBook', () => {
  test('a person’s runs think together up to the concurrency, and the rest are queued in arrival order', () => {
    const together = new RunBook();
    assert.deepEqual(together.add(base('ann', 'a')).map((r) => [r.reqId, r.state]), [['a', 'thinking']]);
    assert.deepEqual(together.add(base('ann', 'b')).map((r) => [r.reqId, r.state]), [['b', 'thinking']]);
    assert.deepEqual(together.add(base('ann', 'c')).map((r) => [r.reqId, r.state]), [['c', 'thinking']]);
    assert.deepEqual(together.add(base('ann', 'd')).map((r) => [r.reqId, r.state]), [['d', 'queued']]);
    assert.deepEqual(together.remove(together.get('ann', 'b')!)?.map((r) => [r.reqId, r.state]), [['d', 'thinking']], 'a slot freed is given to the next');
  });

  test('with one at a time, the first is thinking and the rest are queued, in arrival order', () => {
    const book = new RunBook(1);
    assert.deepEqual(book.add(base('ann', 'a')).map((r) => [r.reqId, r.state]), [['a', 'thinking']]);
    assert.deepEqual(book.add(base('ann', 'b')).map((r) => [r.reqId, r.state]), [['b', 'queued']]);
    assert.deepEqual(book.add(base('ann', 'c')).map((r) => [r.reqId, r.state]), [['c', 'queued']]);
    assert.deepEqual(book.byUser('ann').map((r) => r.reqId), ['a', 'b', 'c']);
    assert.equal(book.add(base('bob', 'z')).at(0)?.state, 'thinking', 'another person has their own line');
    assert.equal(book.size, 4);
    assert.equal(book.count('ann'), 3);
  });

  test('ending a run promotes the next one, and only that one is reported as changed', () => {
    const book = new RunBook(1);
    const [a] = book.add(base('ann', 'a'));
    book.add(base('ann', 'b'));
    book.add(base('ann', 'c'));
    assert.deepEqual(book.remove(a)?.map((r) => [r.reqId, r.state]), [['b', 'thinking']]);
    const b = book.get('ann', 'b')!;
    assert.deepEqual(book.remove(b)?.map((r) => r.reqId), ['c']);
    assert.equal(book.remove(book.get('ann', 'c')!)?.length, 0);
    assert.equal(book.size, 0);
    assert.equal(book.remove(a), null, 'ending a run twice does nothing');
  });

  test('what everyone is told about a run leaves out the request id; the person who started it gets it', () => {
    const book = new RunBook();
    const [a] = book.add(base('ann', 'req-secret'));
    assert.equal('reqId' in book.status(a), false);
    assert.equal(book.statusFor(a).reqId, 'req-secret');
    assert.deepEqual(book.statuses('bob').map((s) => s.reqId), [undefined]);
    assert.deepEqual(book.statuses('ann').map((s) => s.reqId), ['req-secret']);
  });

  test('runs are found by person and request, and by the connection that owns them', () => {
    const book = new RunBook();
    const mine = {};
    book.add({ ...base('ann', 'a'), owner: mine });
    book.add({ ...base('ann', 'b'), owner: {} });
    assert.equal(book.get('bob', 'a'), undefined, 'someone else’s request id means nothing');
    assert.deepEqual(book.ownedBy(mine).map((r) => r.reqId), ['a']);
  });

  test('a run expires after the hard cap, or after its person has been gone too long', () => {
    const book = new RunBook();
    book.add(base('ann', 'long', 0));
    book.add({ ...base('bob', 'gone', 0), owner: null, offlineSince: 1000 });
    book.add({ ...base('cy', 'ok', 0), owner: null, offlineSince: 1000 });
    assert.deepEqual(book.expired(RUN_ORPHAN_MS).map((e) => e.run.reqId), [], 'not yet');
    assert.deepEqual(book.expired(1000 + RUN_ORPHAN_MS + 1).map((e) => [e.run.reqId, e.reason]), [['gone', 'offline'], ['ok', 'offline']]);
    assert.deepEqual(book.expired(RUN_HARD_CAP_MS + 1).map((e) => [e.run.reqId, e.reason]).sort(), [['gone', 'too_long'], ['long', 'too_long'], ['ok', 'too_long']]);
  });

  test('a status says whether the person is offline, but only while the run is still working', () => {
    const book = new RunBook();
    const [r] = book.add({ ...base('ann', 'a'), owner: null, offlineSince: 5 });
    assert.equal(book.status(r).offline, true);
    assert.equal(book.status(r, 'done').offline, undefined);
    assert.deepEqual([book.status(r, 'failed', 'invalid').state, book.status(r, 'failed', 'invalid').reason], ['failed', 'invalid']);
    assert.equal(book.statuses().length, 1);
  });
});
