// Copied from Worktrees Studio (src/shared/workspace) by `npm run sync-core`. Do not edit here.
import { PROP_DEFS } from './props.ts';
import type { Vec, WorkspaceMap } from './types.ts';

export interface Grid {
  w: number;
  h: number;
  blocked: Uint8Array;
}

export const PLAYER_RADIUS = 0.28;
export const PLAYER_SPEED = 4.6; // tiles / second

/** Build the collision grid from floor voids, walls and solid props. */
export function buildGrid(map: WorkspaceMap): Grid {
  const { width: w, height: h } = map;
  const blocked = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (map.floor[i] === 0 || map.wall[i] !== 0) blocked[i] = 1;
  }
  for (const p of map.props) {
    const def = PROP_DEFS[p.kind];
    if (!def?.solid) continue;
    for (let dy = 0; dy < def.h; dy++) {
      for (let dx = 0; dx < def.w; dx++) {
        const x = p.x + dx;
        const y = p.y + dy;
        if (x >= 0 && y >= 0 && x < w && y < h) blocked[y * w + x] = 1;
      }
    }
  }
  return { w, h, blocked };
}

export function isBlocked(g: Grid, tx: number, ty: number): boolean {
  if (tx < 0 || ty < 0 || tx >= g.w || ty >= g.h) return true;
  return g.blocked[ty * g.w + tx] === 1;
}

/** Whether a circle of radius r centred at (x, y) (tile units) fits. */
export function canStand(g: Grid, x: number, y: number, r = PLAYER_RADIUS): boolean {
  const x0 = Math.floor(x - r);
  const x1 = Math.floor(x + r);
  const y0 = Math.floor(y - r);
  const y1 = Math.floor(y + r);
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      if (isBlocked(g, tx, ty)) return false;
    }
  }
  return true;
}

/** Move with axis-separated sliding collision. */
export function moveWithCollision(
  g: Grid,
  x: number,
  y: number,
  dx: number,
  dy: number,
  r = PLAYER_RADIUS,
): Vec {
  let nx = x;
  let ny = y;
  if (dx !== 0 && canStand(g, x + dx, y, r)) nx = x + dx;
  if (dy !== 0 && canStand(g, nx, y + dy, r)) ny = y + dy;
  return { x: nx, y: ny };
}

/** Find the nearest walkable tile centre to (x, y). */
export function nearestFree(g: Grid, x: number, y: number, maxR = 12): Vec | null {
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  if (!isBlocked(g, cx, cy)) return { x: cx + 0.5, y: cy + 0.5 };
  for (let r = 1; r <= maxR; r++) {
    let best: Vec | null = null;
    let bestD = Infinity;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const tx = cx + dx;
        const ty = cy + dy;
        if (isBlocked(g, tx, ty)) continue;
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

class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];
  get size() {
    return this.keys.length;
  }
  push(key: number, val: number) {
    const k = this.keys;
    const v = this.vals;
    k.push(key);
    v.push(val);
    let i = k.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [k[p], k[i]] = [k[i], k[p]];
      [v[p], v[i]] = [v[i], v[p]];
      i = p;
    }
  }
  pop(): number {
    const k = this.keys;
    const v = this.vals;
    const top = v[0];
    const lastK = k.pop()!;
    const lastV = v.pop()!;
    if (k.length > 0) {
      k[0] = lastK;
      v[0] = lastV;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < k.length && k[l] < k[m]) m = l;
        if (r < k.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]];
        [v[m], v[i]] = [v[i], v[m]];
        i = m;
      }
    }
    return top;
  }
}

const SQRT2 = Math.SQRT2;
const NEIGHBORS: [number, number, number][] = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, SQRT2],
  [-1, 1, SQRT2],
  [1, -1, SQRT2],
  [-1, -1, SQRT2],
];

/**
 * A* over the tile grid (8-directional, no corner cutting). Returns tile-centre
 * waypoints from the tile after `from` through `to`, or null if unreachable.
 * If the target tile is blocked, routes to the nearest free tile.
 */
export function findPath(g: Grid, from: Vec, to: Vec, maxNodes = Math.max(6000, g.w * g.h)): Vec[] | null {
  const sx = Math.floor(from.x);
  const sy = Math.floor(from.y);
  let tx = Math.floor(to.x);
  let ty = Math.floor(to.y);
  if (isBlocked(g, tx, ty)) {
    const alt = nearestFree(g, to.x, to.y, 6);
    if (!alt) return null;
    tx = Math.floor(alt.x);
    ty = Math.floor(alt.y);
  }
  if (sx === tx && sy === ty) return [{ x: tx + 0.5, y: ty + 0.5 }];

  const N = g.w * g.h;
  const gScore = new Float32Array(N).fill(Infinity);
  const came = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  const open = new MinHeap();
  const start = sy * g.w + sx;
  const goal = ty * g.w + tx;
  gScore[start] = 0;
  open.push(0, start);
  let expanded = 0;

  const heuristic = (i: number) => {
    const x = i % g.w;
    const y = (i / g.w) | 0;
    const dx = Math.abs(x - tx);
    const dy = Math.abs(y - ty);
    return dx + dy + (SQRT2 - 2) * Math.min(dx, dy);
  };

  while (open.size > 0 && expanded < maxNodes) {
    const cur = open.pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    expanded++;
    if (cur === goal) break;
    const cx = cur % g.w;
    const cy = (cur / g.w) | 0;
    for (const [dx, dy, cost] of NEIGHBORS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (isBlocked(g, nx, ny)) continue;
      if (dx !== 0 && dy !== 0 && (isBlocked(g, cx + dx, cy) || isBlocked(g, cx, cy + dy))) {
        continue;
      }
      const ni = ny * g.w + nx;
      if (closed[ni]) continue;
      const ng = gScore[cur] + cost;
      if (ng < gScore[ni]) {
        gScore[ni] = ng;
        came[ni] = cur;
        open.push(ng + heuristic(ni), ni);
      }
    }
  }
  if (came[goal] === -1) return null;

  const raw: Vec[] = [];
  for (let i = goal; i !== start; i = came[i]) {
    raw.push({ x: (i % g.w) + 0.5, y: ((i / g.w) | 0) + 0.5 });
  }
  raw.reverse();
  return smoothPath(g, from, raw);
}

/** String-pull: drop waypoints that have a clear straight line to a later one. */
function smoothPath(g: Grid, from: Vec, path: Vec[]): Vec[] {
  if (path.length <= 2) return path;
  const out: Vec[] = [];
  let anchor = from;
  let i = 0;
  while (i < path.length) {
    let far = i;
    for (let j = path.length - 1; j > i; j--) {
      if (lineClear(g, anchor, path[j])) {
        far = j;
        break;
      }
    }
    out.push(path[far]);
    anchor = path[far];
    i = far + 1;
  }
  return out;
}

/** Whether a circle can sweep from a to b without touching blocked tiles. */
export function lineClear(g: Grid, a: Vec, b: Vec, r = PLAYER_RADIUS): boolean {
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  const steps = Math.max(1, Math.ceil(dist / 0.2));
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    if (!canStand(g, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, r)) return false;
  }
  return true;
}

export function dist(a: Vec, b: Vec): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function dirFromDelta(dx: number, dy: number, prev: 'down' | 'left' | 'right' | 'up' = 'down') {
  if (dx === 0 && dy === 0) return prev;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'right' : 'left';
  return dy > 0 ? 'down' : 'up';
}
