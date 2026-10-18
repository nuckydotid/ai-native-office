import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { newAgent } from '../agents/format.ts';
import type { AgentFile } from '../agents/format.ts';
import { makePlayer } from '../shared/workspace/entities.ts';
import { deskIdOf, buildOfficeMap } from '../shared/workspace/layout.ts';
import { lookFromSeed } from '../shared/workspace/looks.ts';
import type { AgentStatus, WelcomeMsg } from '../shared/workspace/protocol.ts';
import { ClientWorld } from './core/world.ts';
import { AgentCast, agentPlayerId, homeSpot, isAgentId, roomTargets, stepAlong } from './cast.ts';
import { Emitter } from './net/room.ts';
import type { OfficeSession } from './session.ts';

const map = buildOfficeMap([
  { uid: 'me', name: 'Me', joinedAt: 1 },
  { uid: 'ann', name: 'Ann', joinedAt: 2 },
]);
const me = makePlayer({ id: 'me', name: 'Me', x: 6.5, y: 7.5, look: lookFromSeed('me') });

const welcome = (thinking: AgentStatus[] = []): WelcomeMsg => ({
  t: 'welcome', you: 'me', role: 'owner', workspace: { id: 'main', name: 'HQ' }, map: structuredClone(map),
  players: [structuredClone(me)], deskOwners: { [deskIdOf('me')]: 'me' }, history: [], thinking, serverTime: 0,
});

const status = (handle: string, state: AgentStatus['state'], room = 'lobby'): AgentStatus => ({
  runId: `r-${handle}`, reqId: 'q1', agent: { handle, name: handle, look: lookFromSeed(handle) }, by: 'me', byName: 'Me', replyTo: 'm1', state, room,
});

/** The parts of a visit that the cast uses. */
function fakeSession() {
  const world = new ClientWorld();
  const events = { welcome: new Emitter<WelcomeMsg>(), status: new Emitter<AgentStatus>() };
  const session = { world, events } as unknown as OfficeSession;
  const hello = (thinking: AgentStatus[] = []) => {
    const msg = welcome(thinking);
    world.apply(msg, 0);
    events.welcome.emit(msg);
  };
  return { world, events, session, hello };
}

const agents = (...handles: string[]): AgentFile[] => handles.map((h) => newAgent(h, h.toUpperCase()));

describe('agent characters', () => {
  test('an agent id is told apart from a person’s', () => {
    assert.equal(agentPlayerId('librarian'), 'agent:librarian');
    assert.equal(isAgentId('agent:librarian'), true);
    assert.equal(isAgentId('guest-abc'), false);
  });

  test('a room is walked to at its middle, and an unknown room is the lobby', () => {
    const plan = map.zones.find((z) => z.id === 'plan');
    if (plan) {
      const [middle] = roomTargets(map, 'plan');
      assert.deepEqual(middle, { x: plan.x + plan.w / 2, y: plan.y + plan.h / 2 });
    }
    assert.deepEqual(roomTargets(map, 'nowhere'), map.spawns);
    assert.deepEqual(roomTargets(map, 'lobby'), map.spawns);
  });

  test('agents wait on different free tiles', () => {
    const w = new ClientWorld();
    w.apply(welcome(), 0);
    const spots = [0, 1, 2, 3, 4, 5].map((i) => homeSpot(map, w.grid!, i));
    assert.equal(new Set(spots.map((s) => `${s.x},${s.y}`)).size, spots.length);
    // A name pill is about three tiles wide and one tall: two agents never stand where their pills would touch.
    for (const a of spots) for (const b of spots) if (a !== b) assert.ok(Math.abs(a.x - b.x) >= 3.5 || Math.abs(a.y - b.y) >= 2, 'name pills stay apart');
  });

  test('a walk moves along its path and says which way it faces', () => {
    const path = [{ x: 1, y: 0 }, { x: 1, y: 2 }];
    const first = stepAlong({ x: 0, y: 0 }, path, 0.5);
    assert.deepEqual([first.x, first.y, first.dir, first.arrived], [0.5, 0, 'right', false]);
    const second = stepAlong({ x: first.x, y: first.y }, path, 1);
    assert.equal(second.x, 1);
    assert.ok(Math.abs(second.y - 0.5) < 1e-9);
    assert.equal(second.dir, 'down');
    const last = stepAlong({ x: second.x, y: second.y }, path, 10);
    assert.deepEqual([last.x, last.y, last.arrived], [1, 2, true]);
  });

  test('a welcome puts the roster in the lobby, again after every welcome', () => {
    const t = fakeSession();
    const cast = new AgentCast(t.session, () => agents('libby', 'scribe'), () => 0);
    cast.start();
    t.hello();
    assert.equal(t.world.players.size, 3);
    assert.ok(t.world.players.has('agent:libby'));
    // A second welcome starts the world over; the agents are back.
    t.hello();
    assert.equal(t.world.players.size, 3);
    cast.stop();
  });

  test('an agent that works walks to the room, thinks, and walks home after it answers', () => {
    const t = fakeSession();
    let now = 0;
    const cast = new AgentCast(t.session, () => agents('libby'), () => now);
    try {
      cast.start();
      t.hello();
      const libby = () => t.world.players.get('agent:libby')!;
      const home = { x: libby().x, y: libby().y };
      const plan = map.zones.find((z) => z.id === 'plan');
      assert.ok(plan, 'the map has a Plan room');
      t.events.status.emit(status('libby', 'thinking', 'plan'));
      for (let i = 0; i < 2000 && (i === 0 || libby().moving); i++) {
        now += 60;
        cast.tick();
      }
      assert.ok(libby().x >= plan.x && libby().x < plan.x + plan.w && libby().y >= plan.y && libby().y < plan.y + plan.h, 'it is in the Plan room');
      assert.equal(libby().emote?.kind, 'think');
      const there = { x: libby().x, y: libby().y };

      t.events.status.emit(status('libby', 'done', 'plan'));
      assert.equal(libby().emote, null, 'it thinks no more');
      // It lingers for a moment, then walks back to where it waits.
      for (let i = 0; i < 2000 && (i < 60 || libby().moving); i++) {
        now += 60;
        cast.tick();
      }
      assert.notDeepEqual({ x: libby().x, y: libby().y }, there);
      assert.ok(Math.hypot(libby().x - home.x, libby().y - home.y) < 1.5, 'it is back by its spot');
    } finally {
      cast.stop();
    }
  });

  test('an agent that is still working when the page loads is found at work', () => {
    const t = fakeSession();
    let now = 0;
    const cast = new AgentCast(t.session, () => agents('libby'), () => now);
    try {
      cast.start();
      t.hello([status('libby', 'thinking', 'review')]);
      for (let i = 0; i < 2000 && (i === 0 || t.world.players.get('agent:libby')!.moving); i++) {
        now += 60;
        cast.tick();
      }
      const review = map.zones.find((z) => z.id === 'review');
      const p = t.world.players.get('agent:libby')!;
      assert.ok(review && p.x >= review.x && p.x < review.x + review.w, 'it is in the Review room');
    } finally {
      cast.stop();
    }
  });
});
