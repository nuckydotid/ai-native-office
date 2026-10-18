import { agentLook } from '../agents/format.ts';
import type { AgentFile } from '../agents/format.ts';
import { useAgents } from '../agents/store.ts';
import { PLAYER_SPEED, dirFromDelta, findPath, isBlocked, type Grid } from '../shared/workspace/grid.ts';
import { makePlayer } from '../shared/workspace/entities.ts';
import type { AgentStatus } from '../shared/workspace/protocol.ts';
import type { Dir, PlayerState, Vec, WorkspaceMap } from '../shared/workspace/types.ts';
import type { OfficeSession } from './session.ts';

/*
 * The team's agents as people in the office. The server knows nothing about this: an agent is a character drawn by this window
 * only, standing in the lobby until it is asked something, walking to the room the question was asked in while it works, and
 * thinking there until it answers. What it does comes from `agent.status` (the room it works in, and that it is working at all).
 */

const PREFIX = 'agent:';
export const agentPlayerId = (handle: string) => `${PREFIX}${handle}`;
/** Agents are drawn on every page and are not counted among the people in a room. */
export const isAgentId = (id: string) => id.startsWith(PREFIX);

/** An agent walks a little slower than a person does, so it reads as a colleague strolling over. */
const AGENT_SPEED = PLAYER_SPEED * 0.65;
/** The think bubble lasts a few seconds (`EMOTE_MS`): this is how often it is shown again while the agent is still working. */
const THINK_EVERY_MS = 2800;
/** After it has answered, an agent stays where it was a moment before it walks back. */
const LINGER_MS = 2500;

/** Where to walk in a room, best first: its middle, then just inside its door. An unknown room is the lobby. */
export function roomTargets(map: Pick<WorkspaceMap, 'zones' | 'spawns'>, room: string): Vec[] {
  const zone = map.zones.find((z) => z.id === room);
  if (!zone || room === 'lobby') return [...map.spawns];
  return [
    { x: zone.x + zone.w / 2, y: zone.y + zone.h / 2 },
    { x: zone.x + 2.5, y: zone.y + zone.h - 0.5 },
  ];
}

/** The nearest walkable tile centre to (x, y) that is not one the caller already took; the search mirrors `nearestFree`. */
function freeNear(grid: Grid, x: number, y: number, taken: ReadonlySet<string>, maxR = 12): Vec | null {
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  const free = (tx: number, ty: number) => !isBlocked(grid, tx, ty) && !taken.has(`${tx},${ty}`);
  if (free(cx, cy)) return { x: cx + 0.5, y: cy + 0.5 };
  for (let r = 1; r <= maxR; r++) {
    let best: Vec | null = null;
    let bestD = Infinity;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const tx = cx + dx;
        const ty = cy + dy;
        if (!free(tx, ty)) continue;
        const d = (tx + 0.5 - x) ** 2 + (ty + 0.5 - y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = { x: tx + 0.5, y: ty + 0.5 };
        }
      }
    }
    if (best) return best;
  }
  return null;
}

/** Agents wait three to a row; a name pill is about three tiles wide, so a row's agents stand this far apart. */
const HOME_COLUMNS = 3;
const HOME_STEP_X = 4.5;
const HOME_STEP_Y = 3;

/**
 * Where agent number `index` waits: three to a row around the lobby's first spawn point, far enough apart that the name
 * pills above their heads do not cover one another, each on a tile a person could stand on.
 * Agents on the same spot would be drawn on top of one another, so every agent before `index` is placed too and its tile is avoided;
 * that makes the spot a pure function of the index again while still keeping the agents apart.
 */
export function homeSpot(map: Pick<WorkspaceMap, 'spawns'>, grid: Grid, index: number): Vec {
  const spawns = map.spawns.length ? map.spawns : [{ x: 2.5, y: 2.5 }];
  const taken = new Set<string>();
  let spot = spawns[0];
  for (let i = 0; i <= index; i++) {
    const base = spawns[0];
    const wanted = { x: base.x + 1 + ((i % HOME_COLUMNS) - 1) * HOME_STEP_X, y: base.y + Math.floor(i / HOME_COLUMNS) * HOME_STEP_Y };
    spot =
      freeNear(grid, wanted.x, wanted.y, taken) ??
      freeNear(grid, base.x, base.y, taken) ??
      base;
    taken.add(`${Math.floor(spot.x)},${Math.floor(spot.y)}`);
  }
  return spot;
}

/** Moves `at` along `path` by `distance` tiles. `path` is shortened in place; `arrived` when nothing is left of it. */
export function stepAlong(at: Vec, path: Vec[], distance: number): { x: number; y: number; dir: Dir; arrived: boolean } {
  let { x, y } = at;
  let left = distance;
  let dir: Dir = 'down';
  while (left > 0 && path.length) {
    const next = path[0];
    const dx = next.x - x;
    const dy = next.y - y;
    const d = Math.hypot(dx, dy);
    if (d > 1e-6) dir = dirFromDelta(dx, dy, dir);
    if (d <= left) {
      x = next.x;
      y = next.y;
      left -= d;
      path.shift();
    } else {
      x += (dx / d) * left;
      y += (dy / d) * left;
      left = 0;
    }
  }
  return { x, y, dir, arrived: path.length === 0 };
}

interface Walker {
  path: Vec[];
  /** Where it is headed, for the status line and for not planning the same walk twice. */
  room: string;
}

interface Work {
  room: string;
  /** The last time the think bubble was started. */
  thoughtAt: number;
}

/** Keeps the agents' characters in the office's world and moves them. Exists only while a visit to the office does. */
export class AgentCast {
  private walking = new Map<string, Walker>();
  private working = new Map<string, Work>();
  /** Agents that finished and walk home at this time. */
  private homeAt = new Map<string, number>();
  private offs: (() => void)[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private last = 0;

  constructor(
    private session: OfficeSession,
    private roster: () => AgentFile[] = () => useAgents.getState().listing.agents,
    private now: () => number = () => performance.now(),
  ) {}

  start() {
    const { events } = this.session;
    this.offs.push(
      // A welcome starts the world again from nothing, so everyone is put back (and what is still being worked on is picked up).
      events.welcome.on((w) => {
        this.walking.clear();
        this.populate();
        for (const s of w.thinking ?? []) this.onStatus(s);
      }),
      events.status.on((s) => this.onStatus(s)),
      // The roster may arrive after the welcome, or change when an agent is edited.
      useAgents.subscribe((state, prev) => {
        if (state.listing !== prev.listing) this.populate();
      }),
    );
    this.populate();
    this.last = this.now();
    this.timer = setInterval(() => this.tick(), 60);
  }

  stop() {
    for (const off of this.offs.splice(0)) off();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.walking.clear();
    this.working.clear();
    this.homeAt.clear();
  }

  /** Puts the roster's agents in the world (the lobby, to start with) and takes out the ones that are gone. */
  private populate() {
    const { world } = this.session;
    const map = world.map;
    const grid = world.grid;
    if (!map || !grid) return;
    const agents = this.roster();
    const now = this.now();
    agents.forEach((agent, i) => {
      const id = agentPlayerId(agent.handle);
      const name = agent.displayName.trim() || agent.handle;
      const look = agentLook(agent);
      const there = world.players.get(id);
      if (there) {
        // An agent that was edited keeps its place and takes its new name and look.
        if (there.name !== name) there.name = name;
        if (JSON.stringify(there.look) !== JSON.stringify(look)) there.look = look;
        return;
      }
      const spot = homeSpot(map, grid, i);
      const player: PlayerState = makePlayer({ id, name, x: spot.x, y: spot.y, look });
      world.apply({ t: 'join', player }, now);
    });
    const keep = new Set(agents.map((a) => agentPlayerId(a.handle)));
    for (const id of [...world.players.keys()]) {
      if (isAgentId(id) && !keep.has(id)) {
        world.apply({ t: 'leave', id }, now);
        this.walking.delete(id);
      }
    }
  }

  private onStatus(s: AgentStatus) {
    const id = agentPlayerId(s.agent.handle);
    if (!this.session.world.players.has(id)) return;
    if (s.state === 'queued' || s.state === 'thinking') {
      const room = s.room ?? 'lobby';
      const known = this.working.get(id);
      this.homeAt.delete(id);
      this.working.set(id, { room, thoughtAt: known?.thoughtAt ?? 0 });
      if (!known || known.room !== room) this.walkTo(id, room);
      return;
    }
    // Answered (or could not): it thinks no more, and goes back after a moment.
    if (this.working.delete(id)) {
      this.patch(id, { emote: null });
      this.homeAt.set(id, this.now() + LINGER_MS);
    }
  }

  private walkTo(id: string, room: string) {
    const { world } = this.session;
    const map = world.map;
    const grid = world.grid;
    const me = world.players.get(id);
    if (!map || !grid || !me) return;
    for (const target of roomTargets(map, room)) {
      const path = findPath(grid, me, this.spread(id, target));
      if (path?.length) {
        this.walking.set(id, { path, room });
        return;
      }
    }
  }

  /** Two agents sent to the same room do not stand on the same tile. */
  private spread(id: string, target: Vec): Vec {
    const others = [...this.working.entries()].filter(([other]) => other !== id).length;
    const slot = [...this.working.keys()].indexOf(id);
    const n = slot < 0 ? others : slot;
    return { x: target.x + ((n % 3) - 1) * 1.1, y: target.y + Math.floor(n / 3) * 1.1 };
  }

  private patch(id: string, patch: Partial<PlayerState>) {
    this.session.world.apply({ t: 'patch', id, patch }, this.now());
  }

  /** One step of the agents' lives (every 60 ms while the cast runs). Public so a test can run time by hand. */
  tick() {
    const now = this.now();
    const dt = Math.min(0.25, (now - this.last) / 1000);
    this.last = now;
    const { world } = this.session;

    for (const [id, at] of this.homeAt) {
      if (now < at) continue;
      this.homeAt.delete(id);
      const map = world.map;
      const grid = world.grid;
      const index = this.roster().findIndex((a) => agentPlayerId(a.handle) === id);
      const me = world.players.get(id);
      if (!map || !grid || !me || index < 0) continue;
      const path = findPath(grid, me, homeSpot(map, grid, index));
      if (path?.length) this.walking.set(id, { path, room: 'lobby' });
    }

    for (const [id, walk] of this.walking) {
      const me = world.players.get(id);
      if (!me) {
        this.walking.delete(id);
        continue;
      }
      const step = stepAlong(me, walk.path, AGENT_SPEED * dt);
      this.patch(id, { x: step.x, y: step.y, dir: step.dir, moving: !step.arrived });
      if (step.arrived) this.walking.delete(id);
    }

    // An agent that is working thinks out loud now and then, wherever it is (on its way, or at its place in the room).
    for (const [id, work] of this.working) {
      if (now - work.thoughtAt < THINK_EVERY_MS) continue;
      work.thoughtAt = now;
      this.patch(id, { emote: { kind: 'think', at: Date.now() } });
    }
  }
}
