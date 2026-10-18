import assert from 'node:assert/strict';
import { describe, test } from 'bun:test';
import { lookFromSeed } from '../src/shared/workspace/looks.ts';
import type { SessionInfo } from '../src/shared/workspace/types.ts';
import { Office } from '../src/office.ts';
import { MemoryStore } from '../src/store.ts';
import type { MemberDoc } from '../src/store.ts';

const member = (uid: string, joinedAt: number, desk: string | null = null): MemberDoc => ({
  uid, role: 'member', name: uid, look: lookFromSeed(uid), desk, joinedAt, lastSeen: joinedAt,
});
const session = (id: string, room: string, state: SessionInfo['state'], createdAt: number): SessionInfo => ({ id, room, state, createdAt, createdBy: 'ann' });

describe('an office saved before it was laid out from the team', () => {
  test('its chat moves to the lobby once, with one active session there, and old desks become each member’s own', async () => {
    const store = new MemoryStore();
    await store.putMember('main', member('ann', 1, 'desk-3'));
    await store.putMember('main', member('bo', 2));
    await store.putSession('main', session('s-front', 'frontend', 'active', 10));
    await store.putSession('main', session('s-war', 'war', 'archived', 11));
    await store.putSession('main', session('s-lobby', 'lobby', 'active', 12));
    await store.putSession('main', session('s-ann', 'z-ann', 'active', 13));

    const office = new Office(store, { projectName: 'Garden', maxPlayers: 10 });
    const room = await office.get();

    const byId = new Map(room.sessions);
    assert.equal(byId.get('s-front')?.room, 'lobby');
    assert.equal(byId.get('s-front')?.state, 'archived', 'the lobby already had an active session');
    assert.equal(byId.get('s-war')?.room, 'lobby');
    assert.equal(byId.get('s-lobby')?.state, 'active');
    assert.equal(byId.get('s-ann')?.room, 'z-ann', 'a member’s own zone keeps its chat');
    assert.equal(room.map.zones.length, 5, 'the lobby, the two fixed rooms and two member zones');
    assert.equal(room.deskOwners.get('desk-ann'), 'ann');
    assert.equal(room.deskOwners.get('desk-bo'), 'bo');
    assert.equal(room.deskOwners.has('desk-3'), false);

    // and it is saved, so the next start finds nothing left to move
    const saved = new Map((await store.listSessions('main')).map((s) => [s.id, s]));
    assert.equal(saved.get('s-front')?.room, 'lobby');
    assert.equal(saved.get('s-war')?.room, 'lobby');
    await office.shutdown();
  });
});
