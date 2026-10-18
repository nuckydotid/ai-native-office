import assert from 'node:assert/strict';
import { afterAll, beforeAll, describe, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { GuestAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { setSilent } from '../src/log.ts';
import { createTeamServer } from '../src/server.ts';
import type { TeamServer } from '../src/server.ts';
import { PostgresStore } from '../src/store.ts';
import { lookFromSeed } from '../src/shared/workspace/looks.ts';
import { PROTOCOL_VERSION } from '../src/shared/workspace/protocol.ts';

setSilent(true);

/** What the deployed server is made of: guest sign-in and the data in Postgres. */
describe('team server with guest sign-in and a Postgres database', () => {
  let server: TeamServer;
  let db: PGlite;
  let guests: GuestAuthenticator;
  let base = '';

  beforeAll(async () => {
    guests = new GuestAuthenticator('a-secret-of-at-least-16-chars');
    db = new PGlite();
    const store = new PostgresStore(db);
    await store.whenReady();
    const cfg = { ...loadConfig(), devAuth: false, store: 'postgres' as const, projectName: 'Garden', allowedOrigins: ['*'] };
    server = createTeamServer({ cfg, store, auth: guests });
    base = `127.0.0.1:${await server.listen(0)}`;
  });

  afterAll(async () => {
    await server.close();
    await db.close();
  });

  const board = (token?: string) => fetch(`http://${base}/board`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

  test('a guest’s token opens the board; a forged one and no token do not', async () => {
    const { token } = await guests.issue('Ann');
    assert.equal((await board(token)).status, 200);
    assert.equal((await board('demo:garbage')).status, 401);
    assert.equal((await board('google:anything')).status, 401);
    assert.equal((await board()).status, 401);
  });

  test('joining the office saves the guest in Postgres, and a saved guest can come back', async () => {
    const hello = (token: string) =>
      new Promise<{ t: string; role?: string; you?: string; code?: string }>((resolve, reject) => {
        const ws = new WebSocket(`ws://${base}/ws`);
        ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', token, workspaceId: 'main', name: 'Ann', look: lookFromSeed('ann'), protocol: PROTOCOL_VERSION }));
        ws.onmessage = (e) => {
          const m = JSON.parse(String(e.data));
          if (m.t === 'welcome' || m.t === 'error') {
            ws.close();
            resolve(m);
          }
        };
        ws.onerror = () => reject(new Error('socket error'));
      });

    const ann = await guests.issue('Ann');
    const first = await hello(ann.token);
    assert.equal(first.t, 'welcome');
    assert.equal(first.role, 'owner', 'a guest owns the demo’s workspace');
    assert.equal(first.you, ann.uid);

    const saved = await db.query<{ uid: string }>('SELECT uid FROM tm_member');
    assert.deepEqual(saved.rows.map((r) => r.uid), [ann.uid]);

    const again = await hello((await guests.issue('Ann', ann.uid)).token);
    assert.equal(again.t, 'welcome');
    assert.equal((await db.query('SELECT uid FROM tm_member')).rows.length, 1, 'the same guest is the same member');

    const refused = await hello('demo:garbage');
    assert.equal(refused.t, 'error');
    assert.equal(refused.code, 'auth_failed');
  });
});
