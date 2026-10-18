import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BOARD_LIMITS } from './types.ts';
import { cleanBody, parseIssueInput, parseIssuePatch } from './protocol.ts';

const EMOJI = String.fromCodePoint(0x1f600);
const HALF = String.fromCharCode(0xd83d);

describe('issue input', () => {
  test('a title is required, becomes one line, and is never empty after cleaning', () => {
    assert.equal(parseIssueInput({}), null);
    assert.equal(parseIssueInput({ title: '   ' }), null);
    assert.equal(parseIssueInput({ title: 42 }), null);
    assert.deepEqual(parseIssueInput({ title: '  Fix\n the\t leak  ' }), { title: 'Fix the leak' });
    assert.deepEqual(parseIssueInput({ title: `${HALF}Fix` }), { title: 'Fix' }, 'a half emoji is removed, not stored');
  });

  test('defaults are left out so the server can apply them', () => {
    assert.deepEqual(parseIssueInput({ title: 'A', status: 'todo', priority: 'medium', points: 0, labels: [], assignee: null }), { title: 'A' });
    assert.deepEqual(parseIssueInput({ title: 'A', status: 'backlog' }), { title: 'A' }, 'an older client’s backlog is the todo column (the server’s default)');
  });

  test('statuses and priorities are the known ones', () => {
    assert.deepEqual(parseIssueInput({ title: 'A', status: 'in_progress', priority: 'urgent' }), { title: 'A', status: 'in_progress', priority: 'urgent' });
    assert.equal(parseIssueInput({ title: 'A', status: 'doing' }), null);
    assert.equal(parseIssueInput({ title: 'A', priority: 'later' }), null);
  });

  test('labels are cleaned, deduplicated and capped', () => {
    assert.deepEqual(parseIssueInput({ title: 'A', labels: ['Bug', 'bug', ' UI ', ''] }), { title: 'A', labels: ['Bug', 'UI'] });
    assert.equal(parseIssueInput({ title: 'A', labels: Array.from({ length: BOARD_LIMITS.labels + 1 }, (_, i) => `l${i}`) }), null);
    assert.equal(parseIssueInput({ title: 'A', labels: [7] }), null);
  });

  test('points are whole numbers in range; something else is a refusal', () => {
    assert.deepEqual(parseIssueInput({ title: 'A', points: 8 }), { title: 'A', points: 8 });
    assert.equal(parseIssueInput({ title: 'A', points: -1 }), null);
    assert.equal(parseIssueInput({ title: 'A', points: 1.5 }), null);
    assert.equal(parseIssueInput({ title: 'A', points: BOARD_LIMITS.pointsMax + 1 }), null);
  });

  test('a body keeps newlines and tabs but not invisible characters', () => {
    const zero = String.fromCharCode(0x200b);
    assert.deepEqual(parseIssueInput({ title: 'A', body: 'one\n\ttwo' }), { title: 'A', body: 'one\n\ttwo' });
    assert.equal(parseIssueInput({ title: 'A', body: `one${zero}two` })?.body, 'onetwo');
    assert.equal(parseIssueInput({ title: 'A', body: 5 }), null);
    assert.equal(cleanBody('x'.repeat(BOARD_LIMITS.body + 50), BOARD_LIMITS.body).length, BOARD_LIMITS.body);
  });

  test('an assignee that is not an id is refused; null clears it', () => {
    assert.deepEqual(parseIssueInput({ title: 'A', assignee: 'g-123' }), { title: 'A', assignee: 'g-123' });
    assert.equal(parseIssueInput({ title: 'A', assignee: 'has space' }), null);
    assert.deepEqual(parseIssueInput({ title: 'A', assignee: null }), parseIssueInput({ title: 'A' }));
  });
});

describe('issue patch', () => {
  test('an empty patch changes nothing and is refused', () => {
    assert.equal(parseIssuePatch({}), null);
    assert.equal(parseIssuePatch(null), null);
  });

  test('only the fields that were sent come back', () => {
    assert.deepEqual(parseIssuePatch({ status: 'done' }), { status: 'done' });
    assert.deepEqual(parseIssuePatch({ assignee: null }), { assignee: null });
    assert.deepEqual(parseIssuePatch({ status: 'backlog' }), { status: 'todo' }, 'an older client’s backlog is the todo column');
    assert.deepEqual(parseIssuePatch({ title: 'New', priority: 'low' }), { title: 'New', priority: 'low' });
    assert.deepEqual(parseIssuePatch({ body: '' }), { body: '' });
  });

  test('an unknown field is dropped, a bad value refuses the whole patch', () => {
    assert.deepEqual(parseIssuePatch({ status: 'done', rank: 'gold' }), { status: 'done' });
    assert.equal(parseIssuePatch({ status: 'done', priority: 'whenever' }), null);
  });

  test('an order is a non-negative whole number inside the safe range', () => {
    assert.deepEqual(parseIssuePatch({ order: 10.4 }), { order: 10 });
    assert.equal(parseIssuePatch({ order: -1 }), null);
    assert.equal(parseIssuePatch({ order: Number.POSITIVE_INFINITY }), null);
  });
});
