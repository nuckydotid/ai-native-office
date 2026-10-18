import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { joinAction, officeAddress } from './connect.ts';
import { sentence, socketUrl } from './team.ts';

describe('where the office is', () => {
  test('the office is the server that served the page, at its secure socket address', () => {
    assert.deepEqual(officeAddress('https://x.run.app'), { origin: 'https://x.run.app', url: 'wss://x.run.app/ws' });
    assert.equal(socketUrl('https://x.run.app/'), 'wss://x.run.app/ws');
    assert.equal(socketUrl('http://localhost:8080'), 'ws://localhost:8080/ws');
  });
});

describe('what can be pressed when joining failed', () => {
  test('asking again is offered for anything that can change meanwhile', () => {
    for (const code of ['not_a_member', 'removed', 'demo_unreachable', 'demo_refused', 'offline', undefined]) assert.equal(joinAction(code), 'retry', String(code));
  });

  test('nothing is offered when asking again changes nothing', () => {
    assert.equal(joinAction('update_required'), null);
  });
});

describe('words for what went wrong getting in', () => {
  test('a known code is a sentence, and anything else is kept as it is', () => {
    assert.match(sentence('demo_unreachable'), /Couldn’t reach the demo server/);
    assert.match(sentence(new Error('demo_refused')), /couldn’t let you in/);
    assert.equal(sentence(new Error('Something specific happened.')), 'Something specific happened.');
  });
});
