import assert from 'node:assert/strict';
import { describe, test } from 'bun:test';
import { DevAuthenticator, GuestAuthenticator, TokenError, createAuthenticator, isTokenProblem } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';

describe('DevAuthenticator', () => {
  test('parses dev tokens and rejects anything else', async () => {
    assert.deepEqual(await new DevAuthenticator().verify('dev:ann:Ann B'), { uid: 'dev-ann', name: 'Ann B', role: 'owner', provider: 'dev' });
    assert.deepEqual(await new DevAuthenticator().verify('dev:ann'), { uid: 'dev-ann', name: 'ann', role: 'owner', provider: 'dev' });
    await assert.rejects(new DevAuthenticator().verify('ann'), TokenError);
    await assert.rejects(new DevAuthenticator().verify('dev:'), TokenError);
  });

  test('a token may say which role the person has, and only a known one', async () => {
    const dev = new DevAuthenticator();
    assert.equal((await dev.verify('dev:bob@member:Bob')).role, 'member');
    assert.equal((await dev.verify('dev:bob@admin')).role, 'admin');
    assert.equal((await dev.verify('dev:bob@owner:Bob')).role, 'owner');
    await assert.rejects(dev.verify('dev:bob@founder:Bob'), TokenError);
    await assert.rejects(dev.verify('dev:bob@guest:Bob'), TokenError);
  });
});

describe('createAuthenticator', () => {
  const config = (over: Partial<ReturnType<typeof loadConfig>>) => ({ ...loadConfig(), devAuth: false, demo: false, guestJwtSecret: '', ...over });

  test('a demo server lets guests in, as the owners of the workspace', async () => {
    const auth = createAuthenticator(config({ demo: true, guestJwtSecret: 'a-secret-of-at-least-16-chars' }));
    const guest = new GuestAuthenticator('a-secret-of-at-least-16-chars');
    const { token, uid } = await guest.issue('Ann');
    assert.deepEqual(await auth.verify(token), { uid, name: 'Ann', role: 'owner', provider: 'guest' });
  });

  test('only guests and development tokens exist: Google and Firebase credentials are refused', async () => {
    const demo = createAuthenticator(config({ demo: true, guestJwtSecret: 'a-secret-of-at-least-16-chars' }));
    for (const token of ['google:eyJ.a.b', 'eyJhbGciOiJSUzI1NiJ9.e30.sig', 'dev:ann:Ann', '']) {
      await assert.rejects(demo.verify(token), (e) => isTokenProblem(e), token);
    }
    const dev = createAuthenticator(config({ devAuth: true }));
    assert.equal((await dev.verify('dev:ann:Ann')).provider, 'dev');
    await assert.rejects(dev.verify('demo:anything'), TokenError);
  });

  test('a server that is neither the demo nor in development lets nobody in', async () => {
    const none = createAuthenticator(config({}));
    await assert.rejects(none.verify('dev:ann:Ann'), TokenError);
    await assert.rejects(none.verify('demo:anything'), TokenError);
  });
});

describe('isTokenProblem', () => {
  test('a bad token is the person’s problem, anything else is ours', async () => {
    const guest = new GuestAuthenticator('a-secret-of-at-least-16-chars');
    const err = await guest.verify('demo:not-a-jwt').catch((e) => e);
    assert.equal(isTokenProblem(err), true);
    assert.equal(isTokenProblem(new TokenError('nope')), true);
    assert.equal(isTokenProblem(new Error('the database is down')), false);
    assert.equal(isTokenProblem('boom'), false);
  });
});
