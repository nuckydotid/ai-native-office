import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assigneeName, column, prOpen, PRIORITY_META, STATUS_LABELS } from './core.ts';
import type { Issue } from '../shared/board/types.ts';

const issue = (over: Partial<Issue>): Issue => ({
  id: 'i-1',
  key: 1,
  title: 'A ticket',
  body: '',
  status: 'todo',
  priority: 'medium',
  assignee: null,
  labels: [],
  points: 0,
  order: 1024,
  docs: [],
  thread: null,
  branch: null,
  pr: null,
  createdBy: 'g-ada',
  createdAt: 0,
  updatedBy: 'g-ada',
  updatedAt: 0,
  ...over,
});

test('statuses read as words and priorities carry a color', () => {
  assert.equal(STATUS_LABELS.todo, 'To do');
  assert.equal(STATUS_LABELS.in_progress, 'In progress');
  assert.equal(STATUS_LABELS.review, 'In review');
  assert.equal(STATUS_LABELS.done, 'Done');
  assert.equal(PRIORITY_META.urgent.color, 'danger');
  assert.equal(PRIORITY_META.high.color, 'warning');
});

test('one page’s tickets, in board order', () => {
  const issues = [issue({ id: 'b', order: 2048 }), issue({ id: 'a', order: 1024 }), issue({ id: 'c', status: 'review' })];
  assert.deepEqual(
    column(issues, 'todo').map((i) => i.id),
    ['a', 'b'],
  );
  assert.deepEqual(
    column(issues, 'review').map((i) => i.id),
    ['c'],
  );
  assert.deepEqual(column(issues, 'done'), []);
});

test('the assignee is a name, or a plain sentence when they left', () => {
  const people = [{ uid: 'g-ada', name: 'Ada Lovelace' }];
  assert.equal(assigneeName(people, 'g-ada'), 'Ada Lovelace');
  assert.equal(assigneeName(people, 'g-gone'), 'Someone who left the team');
  assert.equal(assigneeName(people, null), null);
});

test('In Review lists open and draft pull requests, not merged or closed ones', () => {
  assert.equal(prOpen(issue({ pr: 'https://github.com/a/b/pull/1' })), true, 'a pull request with no state yet counts');
  assert.equal(prOpen(issue({ pr: 'https://github.com/a/b/pull/1', prInfo: { number: 1, title: 'x', state: 'open', updatedAt: 0 } })), true);
  assert.equal(prOpen(issue({ pr: 'https://github.com/a/b/pull/1', prInfo: { number: 1, title: 'x', state: 'draft', updatedAt: 0 } })), true);
  assert.equal(prOpen(issue({ pr: 'https://github.com/a/b/pull/1', prInfo: { number: 1, title: 'x', state: 'merged', updatedAt: 0 } })), false);
  assert.equal(prOpen(issue({ pr: 'https://github.com/a/b/pull/1', prInfo: { number: 1, title: 'x', state: 'closed', updatedAt: 0 } })), false);
  assert.equal(prOpen(issue({})), false);
});
