import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { countAfter, nearBottom, planScroll } from './scroll.ts';

const reading = { firstId: 'm3', lastId: 'm9', nearBottom: false };
const atBottom = { ...reading, nearBottom: true };

describe('scroll planning', () => {
  test('the first messages show the newest', () => {
    assert.equal(planScroll({ firstId: null, lastId: null, nearBottom: true }, { firstId: 'm8', lastId: 'm9' }), 'bottom');
  });

  test('a new message follows the person who is at the bottom, and waits for the one who is reading', () => {
    assert.equal(planScroll(atBottom, { firstId: 'm3', lastId: 'm10' }), 'bottom');
    assert.equal(planScroll(reading, { firstId: 'm3', lastId: 'm10' }), 'unread');
    assert.equal(planScroll(reading, { firstId: 'm3', lastId: 'm10' }, { lastIsMine: true }), 'bottom', 'their own message is always shown');
  });

  test('older messages added above keep what is on screen where it is', () => {
    assert.equal(planScroll(reading, { firstId: 'm1', lastId: 'm9' }), 'anchor');
  });

  test('an old message trimmed while a new one arrives is still a new message', () => {
    assert.equal(planScroll(atBottom, { firstId: 'm4', lastId: 'm10' }), 'bottom');
    assert.equal(planScroll(reading, { firstId: 'm4', lastId: 'm10' }), 'unread');
  });

  test('starting again after a long break goes to the bottom', () => {
    assert.equal(planScroll(reading, { firstId: 'm20', lastId: 'm29' }, { replaced: true }), 'bottom');
  });

  test('a message that changed in place does not move anything', () => {
    assert.equal(planScroll(reading, { firstId: 'm3', lastId: 'm9' }), 'keep');
    assert.equal(planScroll(reading, { firstId: null, lastId: null }), 'keep');
  });

  test('near the bottom means within a few lines', () => {
    assert.equal(nearBottom({ scrollTop: 952, scrollHeight: 1500, clientHeight: 500 }), true);
    assert.equal(nearBottom({ scrollTop: 900, scrollHeight: 1500, clientHeight: 500 }), false);
    assert.equal(nearBottom({ scrollTop: 0, scrollHeight: 300, clientHeight: 500 }), true, 'a short list is always at the bottom');
  });

  test('counting what is new', () => {
    assert.equal(countAfter(['a', 'b', 'c', 'd'], 'b'), 2);
    assert.equal(countAfter(['a', 'b'], 'b'), 0);
    assert.equal(countAfter(['a', 'b'], 'gone'), 2);
    assert.equal(countAfter(['a', 'b'], null), 2);
  });
});
