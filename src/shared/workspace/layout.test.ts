import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildGrid, findPath, isBlocked } from './grid.ts';
import { COLS, MIN_WIDTH, PAGE_ROOM, buildOfficeMap, deskIdOf, mapKey, officeSize, pageRoomTargets, roomIdOfPage, zoneAt, zoneIdOf } from './layout.ts';
import type { OfficeMember } from './layout.ts';
import { isMapId } from './protocol.ts';
import { PROP_DEFS, deskSeat } from './props.ts';
import { TILE } from './types.ts';

const team = (n: number): OfficeMember[] => Array.from({ length: n }, (_, i) => ({ uid: `u${i}`, name: `Person ${i}`, joinedAt: 1000 + i }));

describe('office layout', () => {
  test('a lobby for nobody, a small room for one, and the size follows the team', () => {
    const none = buildOfficeMap([]);
    assert.deepEqual(none.zones.map((z) => z.id), ['lobby', 'plan', 'review'], 'the lobby and the two fixed rooms');
    assert.equal(none.width, MIN_WIDTH);
    assert.equal(buildOfficeMap(team(1)).zones.length, 4, 'the lobby, the two rooms and one member zone');
    // Grows to the right until a row is full, then downwards.
    assert.ok(officeSize(COLS).width > officeSize(2).width);
    assert.equal(officeSize(COLS + 1).width, officeSize(COLS).width);
    assert.ok(officeSize(COLS + 1).height > officeSize(COLS).height);
    // The biggest team the server lets in fits one canvas.
    const big = officeSize(100);
    assert.ok(big.width * TILE <= 4096 && big.height * TILE <= 4096, `${big.width}x${big.height}`);
  });

  test('every layer is as long as the map says, and every id is a valid map id', () => {
    for (const n of [0, 1, 3, 10, 11, 37]) {
      const m = buildOfficeMap(team(n));
      assert.equal(m.floor.length, m.width * m.height);
      assert.equal(m.wall.length, m.width * m.height);
      const ids = [...m.zones.map((z) => z.id), ...m.props.map((p) => p.id)];
      assert.equal(new Set(m.props.map((p) => p.id)).size, m.props.length, 'prop ids are unique');
      assert.equal(new Set(m.zones.map((z) => z.id)).size, m.zones.length, 'zone ids are unique');
      for (const id of ids) assert.ok(isMapId(id), id);
      for (const p of m.props) {
        const d = PROP_DEFS[p.kind];
        assert.ok(p.x >= 0 && p.y >= 0 && p.x + d.w <= m.width && p.y + d.h <= m.height, `${p.id} is inside the map`);
      }
    }
  });

  test('a zone never moves when someone joins, and the first to join has the first slot', () => {
    const small = buildOfficeMap(team(3));
    const large = buildOfficeMap(team(23));
    // (The lobby is the one thing that widens with the room: it spans it.)
    for (const z of small.zones.filter((q) => q.id !== 'lobby')) assert.deepEqual(large.zones.find((q) => q.id === z.id), z);
    for (const p of small.props.filter((q) => !q.id.startsWith('lobby-'))) assert.deepEqual(large.props.find((q) => q.id === p.id), p);
    const swapped = buildOfficeMap([...team(3)].reverse());
    assert.deepEqual(swapped, small, 'the order of the list does not matter, only when people joined');
    const tie = buildOfficeMap([
      { uid: 'b', name: 'B', joinedAt: 5 },
      { uid: 'a', name: 'A', joinedAt: 5 },
    ]);
    assert.ok(tie.zones.findIndex((z) => z.id === 'z-a') < tie.zones.findIndex((z) => z.id === 'z-b'));
  });

  test('zones do not overlap each other, and each holds its own desk', () => {
    const m = buildOfficeMap(team(14));
    const zones = m.zones.filter((z) => z.id !== 'lobby');
    for (const a of zones) {
      for (const b of zones) {
        if (a === b) continue;
        const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        assert.ok(apart, `${a.id} and ${b.id} overlap`);
      }
    }
    for (const u of team(14)) {
      const desk = m.props.find((p) => p.id === deskIdOf(u.uid))!;
      const seat = deskSeat(desk);
      assert.equal(zoneAt(m, seat.x + 0.5, seat.y + 0.5)?.id, zoneIdOf(u.uid));
    }
  });

  test('everyone can walk from where they arrive to every desk and back', () => {
    for (const n of [1, 2, 9, 10, 11, 25]) {
      const m = buildOfficeMap(team(n));
      const grid = buildGrid(m);
      for (const s of m.spawns) assert.equal(isBlocked(grid, Math.floor(s.x), Math.floor(s.y)), false, 'spawns are open floor');
      const from = m.spawns[0];
      for (const p of m.props.filter((q) => q.kind === 'desk')) {
        const seat = deskSeat(p);
        const there = findPath(grid, from, { x: seat.x + 0.5, y: seat.y + 0.5 });
        assert.ok(there, `n=${n}: no way to ${p.id}`);
        const back = findPath(grid, { x: seat.x + 0.5, y: seat.y + 0.5 }, from);
        assert.ok(back, `n=${n}: no way back from ${p.id}`);
      }
    }
  });

  test('a page can walk to its room: the middle or the door-side spot is reachable, from a spawn and from the lobby', () => {
    for (const n of [0, 1, 12]) {
      const m = buildOfficeMap(team(n));
      const grid = buildGrid(m);
      for (const page of ['plan', 'review'] as const) {
        const targets = pageRoomTargets(m, page);
        assert.equal(targets.length, 2, page);
        for (const from of [m.spawns[0], { x: m.spawns[1].x, y: m.spawns[1].y }]) {
          assert.ok(
            targets.some((t) => findPath(grid, from, t)?.length),
            `n=${n}: ${page} is unreachable from ${from.x},${from.y}`,
          );
        }
      }
      assert.deepEqual(pageRoomTargets(m, 'progress'), m.spawns, 'In Progress is the lobby');
      // An older team server’s map has no fixed rooms: the walk falls back to the lobby rather than nowhere.
      const oldMap = { ...m, zones: m.zones.filter((z) => z.id === 'lobby') }; // an older team server's map: no fixed rooms
      assert.deepEqual(pageRoomTargets(oldMap, 'plan'), m.spawns);
    }
  });

  test('every pipeline stage stands in a room the map has, and its door can be walked to', () => {
    const m = buildOfficeMap(team(3));
    const grid = buildGrid(m);
    assert.deepEqual(Object.keys(PAGE_ROOM), ['plan', 'design', 'build', 'test', 'release', 'deploy']);
    for (const [stage, page] of Object.entries(PAGE_ROOM)) {
      const id = roomIdOfPage(page);
      assert.ok(m.zones.some((z) => z.id === id), `${stage} stands in ${id}`);
      assert.ok(isMapId(id), `${id} is a room id the server accepts`);
      assert.ok(pageRoomTargets(m, page).some((t) => findPath(grid, m.spawns[0], t)?.length), `${stage}: ${id} is reachable from the spawn`);
    }
    assert.equal(roomIdOfPage('progress'), 'lobby');
  });

  test('ids made from any uid are safe, stable and kept apart', () => {
    assert.equal(mapKey('abc_DEF-123'), 'abc_DEF-123');
    const odd = mapKey('a b/c');
    assert.ok(isMapId(`desk-${odd}`));
    assert.notEqual(mapKey('a b'), mapKey('a_b'), 'a changed uid does not collide with the one it looks like');
    assert.equal(mapKey('a b'), mapKey('a b'));
    const long = mapKey('x'.repeat(200));
    assert.ok(isMapId(`chair-${long}`));
    assert.notEqual(mapKey('x'.repeat(200)), mapKey('x'.repeat(201)));
  });
});
