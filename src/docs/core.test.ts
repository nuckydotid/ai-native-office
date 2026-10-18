import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Page } from '../shared/pages/types.ts';
import { childPages, flattenPages, isDescendant, reconcileDraft } from './core.ts';

const page = (over: Partial<Page> & { id: string }): Page => ({
  parent: null,
  title: over.id,
  body: '',
  order: 0,
  createdBy: 'g-1',
  createdAt: 0,
  updatedBy: 'g-1',
  updatedAt: 0,
  ...over,
});

describe('the page tree', () => {
  test('parents come before their children, siblings in order', () => {
    const pages = [
      page({ id: 'c', parent: 'a', order: 1 }),
      page({ id: 'a', order: 2 }),
      page({ id: 'b', order: 1 }),
      page({ id: 'd', parent: 'a', order: 2 }),
    ];
    assert.deepEqual(
      flattenPages(pages).map((r) => `${r.page.id}:${r.depth}`),
      ['b:0', 'a:0', 'c:1', 'd:1'],
    );
  });

  test('a page whose parent is gone shows at the top level instead of disappearing', () => {
    const pages = [page({ id: 'orphan', parent: 'gone' })];
    assert.deepEqual(flattenPages(pages).map((r) => r.page.id), ['orphan']);
  });

  test('a cycle ends the walk instead of hanging it', () => {
    const pages = [page({ id: 'a', parent: 'b' }), page({ id: 'b', parent: 'a' })];
    const rows = flattenPages(pages);
    assert.equal(rows.length, 2, 'both pages appear once');
    assert.deepEqual(new Set(rows.map((r) => r.page.id)), new Set(['a', 'b']));
  });

  test('children are listed in order, and a descendant is anything below', () => {
    const pages = [page({ id: 'a' }), page({ id: 'b', parent: 'a' }), page({ id: 'c', parent: 'b' }), page({ id: 'x' })];
    assert.deepEqual(childPages(pages, 'a').map((p) => p.id), ['b']);
    assert.deepEqual(childPages(pages, null).map((p) => p.id), ['a', 'x']);
    assert.equal(isDescendant(pages, 'a', 'c'), true);
    assert.equal(isDescendant(pages, 'c', 'a'), false);
    assert.equal(isDescendant(pages, 'a', 'x'), false);
  });
});

describe('what happens to unsaved words when the page changes', () => {
  const base = { id: 'p-1', title: 'Plan', body: 'one', at: 1 };
  const stored = (over: Partial<typeof base> = {}) => ({ ...base, ...over });

  test('opening a page takes its stored words', () => {
    const r = reconcileDraft(null, stored(), null);
    assert.deepEqual(r.draft, { title: 'Plan', body: 'one' });
    assert.equal(r.theirs, false);
    assert.equal(reconcileDraft(base, null, { title: 'x', body: 'y' }).draft, null);
  });

  test('a change by someone else is taken when nothing here was typed', () => {
    const r = reconcileDraft(base, stored({ body: 'two', at: 2 }), { title: 'Plan', body: 'one' });
    assert.deepEqual(r.draft, { title: 'Plan', body: 'two' });
    assert.equal(r.base?.at, 2);
    assert.equal(r.theirs, false);
  });

  test('words that were typed are kept when someone else changed the page, and the person is told', () => {
    const mine = { title: 'Plan', body: 'one and my part' };
    const r = reconcileDraft(base, stored({ body: 'two', at: 2 }), mine);
    assert.deepEqual(r.draft, mine);
    assert.equal(r.base?.at, 1, 'still based on what the words were started from');
    assert.equal(r.theirs, true);
  });

  test('a save of my own words is not someone else changing the page', () => {
    const mine = { title: 'Plan', body: 'one and my part' };
    const r = reconcileDraft(base, stored({ body: 'one and my part', at: 2 }), mine);
    assert.equal(r.theirs, false);
    assert.equal(r.base?.at, 2);
  });
});
