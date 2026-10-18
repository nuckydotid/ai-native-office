import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripText } from './store.ts';

test('the strip is honest about the data and counts the runs left', () => {
  assert.equal(stripText(null), 'Demo workspace: synthetic data, resets nightly');
  assert.equal(stripText({ synthetic: true, runsLeft: 12, runsPerHour: 20, resetsAt: 0 }), 'Demo workspace: synthetic data, resets nightly, 12 AI runs left');
  assert.equal(stripText({ synthetic: true, runsLeft: 1, runsPerHour: 20, resetsAt: 0 }), 'Demo workspace: synthetic data, resets nightly, 1 AI run left');
  assert.equal(stripText({ synthetic: true, runsLeft: 0, runsPerHour: 20, resetsAt: 0 }), 'Demo workspace: synthetic data, resets nightly, 0 AI runs left');
});
