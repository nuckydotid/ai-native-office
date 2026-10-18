import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityLine, meters, newestFirst } from './activity.ts';

const info = { jobsLeftToday: 24, jobsLeftThisHour: 1, rolloutsLeftToday: 15, scansLeftToday: 0, concurrent: 2, maxConcurrent: 2 };

test('a meter says how much is left and turns red under a fifth', () => {
  const m = Object.fromEntries(meters(info).map((x) => [x.id, x]));
  assert.equal(m.jobs.text, '24 of 30 left');
  assert.equal(m.jobs.percent, 80);
  assert.equal(m.jobs.low, false);
  assert.equal(m.hour.low, true, '1 of 6 is under a fifth');
  assert.equal(m.scans.percent, 0);
  assert.equal(m.scans.low, true);
  assert.equal(m.running.low, true, 'everything that may run at once is running');
});

test('a meter never goes below zero, and a bigger allowance than the demo’s is drawn full', () => {
  const m = Object.fromEntries(meters({ ...info, jobsLeftToday: -3, rolloutsLeftToday: 99 }).map((x) => [x.id, x]));
  assert.equal(m.jobs.percent, 0);
  assert.equal(m.rollouts.percent, 100);
  assert.equal(m.rollouts.text, '99 of 99 left');
});

test('the audit trail is shown newest first', () => {
  const e = (id: string, at: number) => ({ id, at, by: { id: 'u', name: 'Ada', role: 'owner' }, action: 'a', detail: 'd' });
  assert.deepEqual(newestFirst([e('a', 1), e('c', 3), e('b', 2)]).map((x) => x.id), ['c', 'b', 'a']);
});

test('an audit line names the role of an owner or admin only', () => {
  assert.equal(activityLine({ detail: 'Ada started unit on #3', by: { id: 'u', name: 'Ada', role: 'owner' } }), 'Ada started unit on #3 (owner)');
  assert.equal(activityLine({ detail: 'Bo moved #3', by: { id: 'u', name: 'Bo', role: 'member' } }), 'Bo moved #3');
});
