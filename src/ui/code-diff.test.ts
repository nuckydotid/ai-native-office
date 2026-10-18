import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collapseDiff, diffLines, diffStat } from './code-diff.ts';

test('a diff marks what was added and removed', () => {
  const lines = diffLines('a\nb\nc\n', 'a\nB\nc\nd\n');
  assert.deepEqual(lines.map((l) => `${l.kind[0]}:${l.text}`), ['s:a', 'r:b', 'a:B', 's:c', 'a:d']);
  assert.deepEqual(diffStat(lines), { added: 2, removed: 1 });
  const fresh = diffLines(null, 'one\ntwo\n');
  assert.deepEqual(diffStat(fresh), { added: 2, removed: 0 });
  assert.equal(fresh[0].before, undefined);
  assert.equal(fresh[1].after, 2);
  assert.deepEqual(diffStat(diffLines('x\n', '')), { added: 0, removed: 1 }, 'an empty new file removes everything');
  assert.deepEqual(diffLines('same\n', 'same\n').map((l) => l.kind), ['same']);
});

test('a long diff collapses to the changes and their neighbours', () => {
  const old = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') + '\n';
  const next = old.replace('line 20', 'line twenty');
  const collapsed = collapseDiff(diffLines(old, next), 2);
  assert.equal(collapsed[0].kind, 'gap');
  assert.ok(collapsed.length < 14, 'only the neighbourhood of the change is kept');
  assert.equal(collapsed.filter((l) => l.kind === 'add').length, 1);
  assert.equal(collapsed.at(-1)?.kind, 'gap');
  assert.deepEqual(collapseDiff(diffLines('a\n', 'a\n'), 2), [], 'no change, nothing to show');
});
