import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ChatMessage } from '../../shared/workspace/types.ts';
import { CHAT_CAP, applyWelcomeTail, compareMessages, cursorOf, dropBefore, isFromOthers, kindOf, markDeleted, mergeKnown, mergeMessages, trimOldest } from './chatlog.ts';

const msg = (id: string, at: number, over: Partial<ChatMessage> = {}): ChatMessage => ({ id, kind: 'human', from: 'ann', fromName: 'Ann', text: `text ${id}`, at, ...over });
const ids = (list: ChatMessage[]) => list.map((m) => m.id);

describe('ordering and merging', () => {
  test('messages are ordered by time, then by id as plain text', () => {
    const list = mergeMessages([], [msg('b', 5), msg('a', 5), msg('z', 1), msg('B', 5)]);
    assert.deepEqual(ids(list), ['z', 'B', 'a', 'b'], 'upper case sorts before lower case, like the server’s "C" collation');
    assert.ok(compareMessages(msg('a', 1), msg('a', 2)) < 0);
  });

  test('a message is never added twice, and nothing changes when nothing is new', () => {
    const first = mergeMessages([], [msg('a', 1), msg('b', 2)]);
    assert.equal(mergeMessages(first, [msg('b', 2)]), first, 'the same array comes back');
    assert.equal(mergeMessages(first, []), first);
    assert.deepEqual(ids(mergeMessages(first, [msg('c', 3), msg('a', 1)])), ['a', 'b', 'c']);
  });

  test('older pages go in front, in order', () => {
    const list = mergeMessages([], [msg('m5', 50), msg('m6', 60)]);
    assert.deepEqual(ids(mergeMessages(list, [msg('m3', 30), msg('m4', 40)])), ['m3', 'm4', 'm5', 'm6']);
  });

  test('the copy with the sender’s cid keeps it, in either order', () => {
    const own = msg('a', 1, { cid: 'c1' });
    assert.equal(mergeMessages([msg('a', 1)], [own])[0].cid, 'c1');
    assert.equal(mergeMessages([own], [msg('a', 1)])[0].cid, 'c1');
  });

  test('a removed message stays removed whichever copy arrives last', () => {
    const gone = msg('a', 1, { deleted: true, text: '' });
    const live = msg('a', 1);
    assert.equal(mergeMessages([live], [gone])[0].deleted, true);
    const back = mergeMessages([gone], [live]);
    assert.equal(back[0].deleted, true);
    assert.equal(back[0].text, '', 'its words do not come back');
    assert.deepEqual(markDeleted([live], 'a')[0], { ...live, text: '', deleted: true, mentions: [] });
    const unchanged = [live];
    assert.equal(markDeleted(unchanged, 'nope'), unchanged);
  });
});

describe('a message that is saved again', () => {
  test('an answer that was taken back and asked for again replaces the removal, because it has a later time', () => {
    const gone = msg('a:q1:john', 20, { kind: 'agent', deleted: true, text: '' });
    const again = msg('a:q1:john', 500, { kind: 'agent', text: 'second answer' });
    const list = mergeMessages([msg('q1', 10), gone], [again]);
    assert.equal(list.find((m) => m.id === 'a:q1:john')!.text, 'second answer');
    assert.equal(list.find((m) => m.id === 'a:q1:john')!.deleted, undefined);
    // The same on a reconnect.
    const r = applyWelcomeTail({ chat: [msg('q1', 10), gone], historyHasMore: false }, [msg('q1', 10), again], false);
    assert.equal(r.chat.find((m) => m.id === 'a:q1:john')!.text, 'second answer');
  });

  test('a stale copy of the removed message, with its old time, never brings it back', () => {
    const gone = msg('a', 20, { deleted: true, text: '' });
    assert.equal(mergeMessages([gone], [msg('a', 20)])[0].deleted, true);
    assert.equal(mergeMessages([gone], [msg('a', 5)])[0].deleted, true);
  });

  test('a message saved again moves to its new time, and that counts as a change', () => {
    const note = msg('s:q:john', 30, { kind: 'system', from: 'system' });
    const list = mergeMessages([msg('a', 10), note, msg('b', 40)], [{ ...note, at: 1000 }]);
    assert.deepEqual(ids(list), ['a', 'b', 's:q:john']);
  });

  test('a note saved again is not taken for proof that nothing was missed', () => {
    // The person has a1, a2 and the note (time 30). While away, 40 messages came and the note was saved again at time 1000.
    const had = mergeMessages([], [msg('a1', 10), msg('a2', 20), msg('s:q:john', 30, { kind: 'system', from: 'system' })]);
    const tail = [...Array.from({ length: 30 }, (_, i) => msg(`b${String(i + 11).padStart(2, '0')}`, 100 + i)), msg('s:q:john', 1000, { kind: 'system', from: 'system' })];
    const r = applyWelcomeTail({ chat: had, historyHasMore: false }, tail, true);
    assert.equal(r.replaced, true, 'the only thing in common is not the same message, so the old list is thrown away');
    assert.equal(r.historyHasMore, true);
    assert.ok(!ids(r.chat).includes('a1'));
  });

  test('what is older than a point can be dropped', () => {
    const list = mergeMessages([], [msg('m1', 10), msg('m2', 20), msg('m3', 30)]);
    assert.deepEqual(ids(dropBefore(list, { at: 20, id: 'm2' })), ['m2', 'm3']);
    assert.equal(dropBefore(list, { at: 1, id: 'a' }), list, 'nothing to drop: the same array');
  });
});

describe('the cap', () => {
  test('the oldest are dropped, and the screen is told so', () => {
    const list = Array.from({ length: CHAT_CAP + 3 }, (_, i) => msg(`m${String(i).padStart(5, '0')}`, i));
    const { list: kept, trimmed } = trimOldest(list);
    assert.equal(kept.length, CHAT_CAP);
    assert.equal(kept[0].id, 'm00003');
    assert.equal(trimmed, true);
    assert.equal(trimOldest(kept).trimmed, false);
  });

  test('"Load earlier" continues from the oldest message', () => {
    assert.deepEqual(cursorOf([msg('m3', 30), msg('m4', 40)]), { at: 30, id: 'm3' });
    assert.equal(cursorOf([]), undefined);
  });
});

describe('joining again', () => {
  const tail = [msg('m8', 80), msg('m9', 90)];

  test('the first visit just shows the latest messages', () => {
    const r = applyWelcomeTail({ chat: [], historyHasMore: false }, tail, true);
    assert.deepEqual(ids(r.chat), ['m8', 'm9']);
    assert.equal(r.historyHasMore, true);
    assert.equal(r.replaced, false, 'nothing was replaced, there was nothing');
  });

  test('after a short break the messages are merged and what was loaded stays', () => {
    const had = mergeMessages([], [msg('m1', 10), msg('m2', 20), msg('m8', 80)]);
    const r = applyWelcomeTail({ chat: had, historyHasMore: false }, tail, true);
    assert.deepEqual(ids(r.chat), ['m1', 'm2', 'm8', 'm9']);
    assert.equal(r.historyHasMore, false, 'the person had already loaded back to the start; the tail does not say otherwise');
    assert.equal(r.replaced, false);
  });

  test('after a long break nothing matches, so the list is replaced rather than left with a hole', () => {
    const had = mergeMessages([], [msg('m1', 10), msg('m2', 20)]);
    const r = applyWelcomeTail({ chat: had, historyHasMore: false }, tail, true);
    assert.deepEqual(ids(r.chat), ['m8', 'm9']);
    assert.equal(r.historyHasMore, true);
    assert.equal(r.replaced, true);
  });
});

describe('what a message is', () => {
  test('old rows without a kind', () => {
    assert.equal(kindOf({ from: 'ann' }), 'human');
    assert.equal(kindOf({ from: 'system', scope: 'system' }), 'system');
    assert.equal(kindOf({ from: 'agent:john' }), 'agent');
    assert.equal(kindOf({ from: 'ann', kind: 'agent' }), 'agent');
  });

  test('who counts as someone else', () => {
    assert.equal(isFromOthers(msg('a', 1), 'bob'), true);
    assert.equal(isFromOthers(msg('a', 1, { from: 'bob' }), 'bob'), false);
    assert.equal(isFromOthers(msg('a', 1, { kind: 'system', from: 'system' }), 'bob'), false);
    assert.equal(isFromOthers(msg('a', 1, { deleted: true }), 'bob'), false);
  });
});

describe('checking against the server', () => {
  const held = [msg('a', 10), msg('b', 20), msg('c', 30)];

  test('a removal of a held message is applied, and nothing the list does not hold is added', () => {
    const out = mergeKnown(held, [msg('x', 1), msg('b', 20, { text: '', deleted: true }), msg('y', 25), msg('c', 30)]);
    assert.deepEqual(out.map((m) => m.id), ['a', 'b', 'c']);
    assert.equal(out[1].deleted, true);
  });

  test('a page that holds nothing in common changes nothing (same list back)', () => {
    assert.equal(mergeKnown(held, [msg('x', 1), msg('y', 2)]), held);
  });

  test('a stale copy of a removed message does not bring it back', () => {
    const removed = [msg('a', 10), msg('b', 20, { text: '', deleted: true })];
    const out = mergeKnown(removed, [msg('b', 20)]);
    assert.equal(out.find((m) => m.id === 'b')!.deleted, true);
  });
});
