import assert from 'node:assert/strict';
import { afterAll, beforeAll, describe, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { createCollabStore } from '../src/collab-store.ts';
import type { CollabStore } from '../src/collab-store.ts';
import { Demo } from '../src/demo/demo.ts';
import { builtinSeed } from '../src/demo/seed.ts';
import { setSilent } from '../src/log.ts';
import { Office } from '../src/office.ts';
import { PostgresStore } from '../src/store.ts';

setSilent(true);

describe('the demo on Postgres (the Cloud SQL path)', () => {
  let db: PGlite;
  let store: PostgresStore;
  let collab: CollabStore;
  let demo: Demo;

  beforeAll(async () => {
    db = new PGlite();
    store = new PostgresStore(db);
    await store.whenReady();
    collab = createCollabStore(store);
    demo = new Demo({ store, collabStore: collab, office: new Office(store, { projectName: '', maxPlayers: 10 }), ai: null, seed: builtinSeed() });
  });
  afterAll(async () => {
    demo.stop();
    await db.close();
  });

  test('seeds an empty database once, keeps what a restart finds, and a reset puts the seed back', async () => {
    await demo.start();
    const seed = builtinSeed();
    const state = async () => ({ people: (await store.listMembers('main')).length, tickets: (await collab.listIssues('main')).length, pages: (await collab.listPages('main')).length });
    assert.deepEqual(await state(), { people: seed.members.length, tickets: seed.tickets.length, pages: seed.pages.length });
    assert.ok(await store.getMessage('main', 'welcome-1'));

    // A visitor's work, then a restart (a second Demo over the same database): it is kept, not seeded again.
    await collab.putPage('main', { id: 'p-visitor', parent: null, title: 'Visitor page', body: 'x', order: 1, createdBy: 'guest-1', createdAt: 1, updatedBy: 'guest-1', updatedAt: 1 });
    await new Demo({ store, collabStore: collab, office: new Office(store, { projectName: '', maxPlayers: 10 }), ai: null, seed }).start();
    assert.equal((await collab.listPages('main')).length, seed.pages.length + 1);

    await demo.reset();
    assert.deepEqual(await state(), { people: seed.members.length, tickets: seed.tickets.length, pages: seed.pages.length });
    assert.equal(await collab.getPage('main', 'p-visitor'), null);
  });
});
