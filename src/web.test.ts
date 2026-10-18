import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GuestError, createGuestProvider, demoOrigin, tokenExpiry } from './web.ts';

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (expSeconds: number) => `demo:${b64({ alg: 'HS256' })}.${b64({ sub: 'guest-abc123', exp: expSeconds })}.sig`;

function memory() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

function server(answer: () => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return answer();
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const NOW = 1_800_000_000_000;
const guestBody = (token: string) => new Response(JSON.stringify({ token, uid: 'guest-abc123', name: 'Guest 7' }), { status: 200 });

test('a guest is asked for once and then reused', async () => {
  const token = jwt(NOW / 1000 + 7 * 24 * 3600);
  const { calls, fetchImpl } = server(() => guestBody(token));
  const p = createGuestProvider({ origin: () => 'https://demo.example', fetch: fetchImpl, storage: () => memory(), now: () => NOW });
  assert.equal(await p.credential(), token);
  assert.equal(await p.credential(), token);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://demo.example/demo/guest');
  assert.equal(calls[0].init?.method, 'POST');
});

test('two callers at once share one request', async () => {
  const { calls, fetchImpl } = server(() => guestBody(jwt(NOW / 1000 + 7 * 24 * 3600)));
  const p = createGuestProvider({ origin: () => 'https://demo.example/', fetch: fetchImpl, storage: () => null, now: () => NOW });
  await Promise.all([p.guest(), p.guest(), p.credential()]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://demo.example/demo/guest');
});

test('the guest of the last visit is kept, unless it is about to end', async () => {
  const storage = memory();
  const good = jwt(NOW / 1000 + 24 * 3600);
  const { calls, fetchImpl } = server(() => guestBody(good));
  const first = createGuestProvider({ origin: () => 'x', fetch: fetchImpl, storage: () => storage, now: () => NOW });
  await first.guest();
  assert.equal(calls.length, 1);
  // A new page load: nothing in memory, the guest is in storage.
  const second = createGuestProvider({ origin: () => 'x', fetch: fetchImpl, storage: () => storage, now: () => NOW });
  assert.equal((await second.guest()).token, good);
  assert.equal(calls.length, 1);
  // A day and a half later it has ended: a new guest.
  const later = createGuestProvider({ origin: () => 'x', fetch: fetchImpl, storage: () => storage, now: () => NOW + 36 * 3600_000 });
  await later.guest();
  assert.equal(calls.length, 2);
});

test('a browser that keeps nothing still works', async () => {
  const { fetchImpl } = server(() => guestBody(jwt(NOW / 1000 + 24 * 3600)));
  const throwing = () => {
    throw new Error('blocked');
  };
  const p = createGuestProvider({ origin: () => 'x', fetch: fetchImpl, storage: throwing, now: () => NOW });
  assert.equal((await p.guest()).uid, 'guest-abc123');
  const broken = { getItem: throwing, setItem: throwing, removeItem: throwing };
  const q = createGuestProvider({ origin: () => 'x', fetch: fetchImpl, storage: () => broken, now: () => NOW });
  assert.equal((await q.guest()).uid, 'guest-abc123');
});

test('renew replaces the guest even when the token still looks good', async () => {
  let n = 0;
  const { calls, fetchImpl } = server(() => guestBody(jwt(NOW / 1000 + (++n + 1) * 24 * 3600)));
  const p = createGuestProvider({ origin: () => 'x', fetch: fetchImpl, storage: () => null, now: () => NOW });
  const a = await p.guest();
  const b = await p.renew();
  assert.notEqual(a.token, b.token);
  assert.equal((await p.guest()).token, b.token);
  assert.equal(calls.length, 2);
});

test('a refusal or an unreachable server says what happened', async () => {
  const refused = server(() => new Response(JSON.stringify({ error: 'full', message: 'The demo is full right now.' }), { status: 503 }));
  const p = createGuestProvider({ origin: () => 'x', fetch: refused.fetchImpl, storage: () => null, now: () => NOW });
  await assert.rejects(p.guest(), (e: Error) => e instanceof GuestError && e.message === 'The demo is full right now.');
  // The failure is not remembered: the next ask goes to the server again.
  await assert.rejects(p.guest(), GuestError);
  assert.equal(refused.calls.length, 2);

  const odd = server(() => new Response('{"token":"not-a-demo-token"}', { status: 200 }));
  const q = createGuestProvider({ origin: () => 'x', fetch: odd.fetchImpl, storage: () => null, now: () => NOW });
  await assert.rejects(q.guest(), /couldn’t let you in/);

  const down = (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;
  const r = createGuestProvider({ origin: () => 'x', fetch: down, storage: () => null, now: () => NOW });
  await assert.rejects(r.guest(), /Couldn’t reach the demo server/);
});

test('the token expiry is read from the JWT, and a token that is not one has none', () => {
  assert.equal(tokenExpiry(jwt(1_900_000_000)), 1_900_000_000_000);
  assert.equal(tokenExpiry('demo:garbage'), null);
  assert.equal(tokenExpiry(''), null);
});

test('the demo talks to the page’s own origin', () => {
  assert.equal(demoOrigin({ origin: 'https://studio.run.app', port: '', protocol: 'https:', hostname: 'studio.run.app' }), 'https://studio.run.app');
  assert.equal(demoOrigin(undefined), '');
});
