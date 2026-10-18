import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildOfficeMap, deskIdOf } from '../../shared/workspace/layout.ts';
import { lookFromSeed } from '../../shared/workspace/looks.ts';
import { makePlayer } from '../../shared/workspace/entities.ts';
import type { ServerMsg } from '../../shared/workspace/protocol.ts';
import { Smoother } from './smoother.ts';
import { ClientWorld } from './world.ts';

describe('Smoother', () => {
  test('glides to the newest report over about one server tick', () => {
    const s = new Smoother(0, 0, 0);
    s.push(1, 0, 100);
    assert.equal(s.at(100).x, 0);
    assert.ok(Math.abs(s.at(150).x - 0.5) < 1e-9);
    assert.equal(s.at(200).x, 1);
    assert.equal(s.at(900).x, 1);
  });

  test('a long jump is shown at once', () => {
    const s = new Smoother(0, 0, 0);
    s.push(20, 20, 100);
    assert.deepEqual(s.at(100), { x: 20, y: 20 });
  });

  test('a new report in mid-glide starts from where the figure is drawn', () => {
    const s = new Smoother(0, 0, 0);
    s.push(2, 0, 100);
    const mid = s.at(150).x;
    s.push(2, 1, 150);
    assert.ok(Math.abs(s.at(150).x - mid) < 1e-9);
  });
});

describe('ClientWorld', () => {
  const map = buildOfficeMap([
    { uid: 'me', name: 'Me', joinedAt: 1 },
    { uid: 'ann', name: 'Ann', joinedAt: 2 },
  ]);
  const me = makePlayer({ id: 'me', name: 'Me', x: 6.5, y: 7.5, look: lookFromSeed('me') });
  const ann = makePlayer({ id: 'ann', name: 'Ann', x: 10.5, y: 10.5, look: lookFromSeed('ann') });
  const welcome = (): ServerMsg => ({
    t: 'welcome', you: 'me', role: 'owner', workspace: { id: 'main', name: 'HQ' }, map: structuredClone(map),
    players: [structuredClone(me), structuredClone(ann)], deskOwners: { [deskIdOf('ann')]: 'ann' }, history: [], serverTime: 0,
  });

  test('welcome sets up the map, the people and the desks', () => {
    const w = new ClientWorld();
    assert.equal(w.apply(welcome(), 0), 'welcome');
    assert.equal(w.you, 'me');
    assert.equal(w.players.size, 2);
    assert.equal(w.deskOwners.get(deskIdOf('ann')), 'ann');
    assert.ok(w.grid);
  });

  test('other people glide; the person themself does not', () => {
    const w = new ClientWorld();
    w.apply(welcome(), 0);
    assert.equal(w.apply({ t: 'state', time: 0, p: [['ann', 11.5, 10.5, 'right', 1], ['me', 1, 1, 'down', 0]] }, 100), 'moved');
    assert.ok(Math.abs((w.position('ann', 150)?.x ?? 0) - 11) < 1e-9);
    assert.deepEqual(w.position('me', 150), { x: 6.5, y: 7.5 });
  });

  test('a correction pulls the person back', () => {
    const w = new ClientWorld();
    w.apply(welcome(), 0);
    w.me!.x = 40;
    assert.equal(w.apply({ t: 'correct', x: 7.5, y: 7.5 }, 10), 'correct');
    assert.equal(w.me!.x, 7.5);
  });

  test('join, patch and leave keep the roster', () => {
    const w = new ClientWorld();
    w.apply(welcome(), 0);
    const guest = makePlayer({ id: 'g', name: 'Guest', x: 5, y: 5, look: lookFromSeed('g') });
    assert.equal(w.apply({ t: 'join', player: guest }, 1), 'roster');
    w.apply({ t: 'patch', id: 'g', patch: { status: 'focus' } }, 2);
    assert.equal(w.players.get('g')?.status, 'focus');
    w.apply({ t: 'leave', id: 'g' }, 3);
    assert.equal(w.players.has('g'), false);
  });

  test('a new map keeps the people, replaces the desks and redraws the floor', () => {
    const w = new ClientWorld();
    w.apply(welcome(), 0);
    const before = w.mapVersion;
    const bigger = buildOfficeMap([
      { uid: 'me', name: 'Me', joinedAt: 1 },
      { uid: 'ann', name: 'Ann', joinedAt: 2 },
      { uid: 'bo', name: 'Bo', joinedAt: 3 },
    ]);
    assert.equal(w.apply({ t: 'map.set', map: bigger, deskOwners: { [deskIdOf('bo')]: 'bo' } }, 5), 'map');
    assert.equal(w.mapVersion, before + 1);
    assert.equal(w.map?.zones.length, bigger.zones.length);
    assert.equal(w.players.size, 2);
    assert.equal(w.deskOwners.size, 1);
    assert.equal(w.deskOwners.get(deskIdOf('bo')), 'bo');
  });

  test('a map whose layers do not match its size is refused', () => {
    const w = new ClientWorld();
    w.apply(welcome(), 0);
    const broken = { ...structuredClone(map), floor: [1, 2, 3] };
    assert.equal(w.apply({ t: 'map.set', map: broken, deskOwners: {} }, 5), 'other');
    assert.equal(w.map?.width, map.width);
  });

  test('a change of role is kept, and chat messages leave the world alone', () => {
    const w = new ClientWorld();
    w.apply(welcome(), 0);
    assert.equal(w.apply({ t: 'role', role: 'admin' }, 1), 'role');
    assert.equal(w.role, 'admin');
    assert.equal(w.apply({ t: 'chat', msg: { id: 'a', from: 'ann', fromName: 'Ann', text: 'hi', at: 1 } }, 2), 'other');
  });

  test('a map edit rebuilds the walls people bump into', () => {
    const w = new ClientWorld();
    w.apply(welcome(), 0);
    const before = w.mapVersion;
    assert.equal(w.apply({ t: 'map.edit', by: 'me', op: { op: 'wall', cells: [[5, 5, 1]] } }, 1), 'map');
    assert.equal(w.mapVersion, before + 1);
    assert.equal(w.grid!.blocked[5 * w.grid!.w + 5], 1);
  });
});
