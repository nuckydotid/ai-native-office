import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { PAGES_LIMITS } from './types.ts';
import { cleanTitle, parsePageInput, parsePagePatch } from './protocol.ts';

const EMOJI = String.fromCodePoint(0x1f600);

describe('page input', () => {
  test('a title is required and becomes one line', () => {
    assert.equal(parsePageInput({}), null);
    assert.equal(parsePageInput({ title: '\n\t ' }), null);
    assert.deepEqual(parsePageInput({ title: ' Getting   started ' }), { title: 'Getting started' });
  });

  test('a title is capped by code points, never cutting an emoji in half', () => {
    const title = cleanTitle(`${'x'.repeat(PAGES_LIMITS.title - 1)}${EMOJI}`);
    assert.equal(title.length, PAGES_LIMITS.title - 1 + EMOJI.length, 'the emoji is whole');
  });

  test('a body keeps Markdown and newlines; a parent is an id or null', () => {
    assert.deepEqual(parsePageInput({ title: 'Runbook', body: '# Steps\n\n1. Do it' }), { title: 'Runbook', body: '# Steps\n\n1. Do it' });
    assert.deepEqual(parsePageInput({ title: 'Child', parent: 'p-1' }), { title: 'Child', parent: 'p-1' });
    assert.deepEqual(parsePageInput({ title: 'Top', parent: null }), { title: 'Top' });
    assert.equal(parsePageInput({ title: 'Child', parent: 'not a/path' }), null);
  });

  test('a body longer than the limit is cut, not refused', () => {
    const body = parsePageInput({ title: 'Long', body: 'x'.repeat(PAGES_LIMITS.body + 10) })?.body;
    assert.equal(body?.length, PAGES_LIMITS.body);
  });
});

describe('page patch', () => {
  test('an empty patch is refused; one field is enough', () => {
    assert.equal(parsePagePatch({}), null);
    assert.deepEqual(parsePagePatch({ title: 'Renamed' }), { title: 'Renamed' });
    assert.deepEqual(parsePagePatch({ parent: null }), { parent: null });
    assert.deepEqual(parsePagePatch({ order: 20.7 }), { order: 21 });
  });

  test('a bad value refuses the whole patch', () => {
    assert.equal(parsePagePatch({ title: 'ok', order: -5 }), null);
    assert.equal(parsePagePatch({ body: 5 }), null);
    assert.deepEqual(parsePagePatch({ body: '', title: 'ok' }), { body: '', title: 'ok' });
  });
});
