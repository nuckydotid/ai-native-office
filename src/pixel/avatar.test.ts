import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { lookFromSeed } from '../shared/workspace/looks.ts';
import { HEAD_SIZES, figureUrl, headCacheKey, headScale, headUrl, safeLook } from './avatar.ts';
import { HEAD_ART } from './people.ts';

describe('avatars', () => {
  test('every avatar size is a whole number of screen pixels per art pixel', () => {
    for (const px of HEAD_SIZES) assert.equal(px % HEAD_ART, 0, `${px}px`);
    assert.deepEqual(HEAD_SIZES.map(headScale), [2, 3, 4]);
    assert.equal(headScale(5), 1, 'never less than one');
  });

  test('the cache key follows the look and the size', () => {
    const a = lookFromSeed('ann');
    assert.notEqual(headCacheKey(a, 24), headCacheKey(a, 36));
    assert.notEqual(headCacheKey(a, 24), headCacheKey(lookFromSeed('bob'), 24));
    assert.equal(headCacheKey(a, 24), headCacheKey({ ...a }, 24));
  });

  test('a missing or broken look falls back to one made from the id, the same every time', () => {
    const fallback = lookFromSeed('dev-ann');
    assert.deepEqual(safeLook(undefined, 'dev-ann'), fallback);
    assert.deepEqual(safeLook({ skin: 'red' }, 'dev-ann'), fallback);
    assert.deepEqual(safeLook({ ...fallback, hair: '#12' }, 'dev-ann'), fallback);
    const good = lookFromSeed('someone-else');
    assert.equal(safeLook(good, 'dev-ann'), good);
  });

  test('without a canvas (here) there is no picture, and no crash', () => {
    assert.equal(headUrl(lookFromSeed('ann'), 36), '');
    assert.equal(figureUrl(lookFromSeed('ann'), 'down', 4), '');
  });
});
