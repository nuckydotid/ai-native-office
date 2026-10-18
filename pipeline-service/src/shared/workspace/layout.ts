// Copied from Worktrees Studio (src/shared/workspace) by `npm run sync-core`. Do not edit here.
import { Floor, Wall } from './types.ts';
import type { MapProp, MapZone, PropKind, Vec, WorkspaceMap, WorkspacePage } from './types.ts';
import { clampCodePoints } from './text.ts';

/**
 * The office is built from the team: one lobby, and one zone for each member. It is a pure function of the member list, so the
 * team server and the offline practice office draw the same room, and the room grows (and shrinks) as people come and go.
 *
 *   ┌────────────────────── Lobby (full width) ──────────────────────┐
 *   │ reception · sofas · coffee      …widens as the team grows…      │
 *   ├─ spine ─┬────────────── corridor ───────────────────────────────┤
 *   │         │ zone 0 │ zone 1 │ zone 2 │ …  (COLS per row)          │
 *   │         ├────────┴────────┴────────┴─── corridor ───────────────┤
 *   │         │ zone COLS │ …                                         │
 *   └─────────┴───────────────────────────────────────────────────────┘
 *
 * A zone's place depends only on its slot (the member's index when sorted by join time), so adding someone never moves anyone else:
 * the map only grows to the right (until COLS wide) and downwards.
 */
export const OFFICE_MAP_ID = 'team-office';

/** Columns of zones per row. 100 members (the default player cap) fit in 10 rows: 74 x 93 tiles, well under a canvas's size limit. */
export const COLS = 10;
/** Walkable zone interior, in tiles. */
export const ZONE_INNER_W = 6;
export const ZONE_INNER_H = 5;
/** A zone's block: its interior plus one wall column on the left and one wall row at the bottom. */
export const ZONE_W = ZONE_INNER_W + 1;
export const ZONE_H = ZONE_INNER_H + 1;
/** The walkway above each row of zones. */
const CORRIDOR_H = 2;
/** One row of zones: its corridor and the block. */
export const ROW_H = CORRIDOR_H + ZONE_H;
/** The lobby's walkable height, below the top wall. */
export const LOBBY_H = 10;
/** The two fixed rooms in the front wing: Plan Room and Review Room (each a 6x5 interior with its walls). */
export const FRONT_ROOM_W = 7;
export const FRONT_ROOM_H = 6;
/** The wing: the two rooms and the corridor under them, above the lobby. */
const FRONT_H = FRONT_ROOM_H + CORRIDOR_H;
export const PLAN_ROOM_ID = 'plan';
export const REVIEW_ROOM_ID = 'review';
/** The walkway down the left edge that joins the lobby to every corridor. */
const SPINE_W = 2;
/** The least width the lobby needs for its furniture. */
export const MIN_WIDTH = 20;
/** Where the first zone block starts: hedge, spine. */
const ZONES_X = 1 + SPINE_W;
/** The first row of the lobby (the hedge is row 0, the top wall row 1, then the front wing). */
const LOBBY_Y = 2 + FRONT_H;

export interface OfficeMember {
  uid: string;
  name: string;
  joinedAt: number;
}

export interface OfficeSize {
  width: number;
  height: number;
  rows: number;
}

/** How big the office is for this many people. */
export function officeSize(members: number): OfficeSize {
  const rows = Math.ceil(members / COLS);
  const cols = Math.min(members, COLS);
  return { width: Math.max(MIN_WIDTH, ZONES_X + cols * ZONE_W + 1), height: LOBBY_Y + LOBBY_H + rows * ROW_H + 1, rows };
}

/** Members in slot order: who joined first has the first slot. */
export function orderMembers<T extends { uid: string; joinedAt: number }>(members: readonly T[]): T[] {
  return [...members].sort((a, b) => a.joinedAt - b.joinedAt || (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0));
}

/** An id fit for the map (letters, digits, `_`, `-`), the same for the same uid. Keeps the ids of `desk-` and `chair-` under 64. */
export function mapKey(uid: string): string {
  const clean = uid.replace(/[^A-Za-z0-9_-]/g, '_');
  if (clean === uid && clean.length <= 40) return clean;
  // A changed or long uid could collide with another: a short hash of the original keeps them apart.
  let h = 2166136261;
  for (let i = 0; i < uid.length; i++) h = Math.imul(h ^ uid.charCodeAt(i), 16777619);
  return `${clean.slice(0, 31)}_${(h >>> 0).toString(36)}`;
}

export const zoneIdOf = (uid: string) => `z-${mapKey(uid)}`;
export const deskIdOf = (uid: string) => `desk-${mapKey(uid)}`;

const CARPETS = [Floor.CarpetBlue, Floor.CarpetGreen, Floor.CarpetWarm, Floor.CarpetPurple] as const;
const ACCENTS = ['#7aa2f7', '#9ece6a', '#e0af68', '#a06fe0'] as const;

/** Where a slot's block starts (its wall column, and the first row of its interior). */
export function slotOrigin(slot: number): { x: number; y: number } {
  const col = slot % COLS;
  const row = Math.floor(slot / COLS);
  return { x: ZONES_X + col * ZONE_W, y: LOBBY_Y + LOBBY_H + row * ROW_H + CORRIDOR_H };
}

export function buildOfficeMap(members: readonly OfficeMember[]): WorkspaceMap {
  const ordered = orderMembers(members);
  const { width: W, height: H, rows } = officeSize(ordered.length);
  const floor = new Array<number>(W * H).fill(Floor.Void);
  const wall = new Array<number>(W * H).fill(Wall.None);
  const props: MapProp[] = [];
  const zones: MapZone[] = [];

  const fill = (x: number, y: number, w: number, h: number, id: number) => {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) floor[yy * W + xx] = id;
  };
  const wallRun = (x: number, y: number, w: number, h: number, id: number) => {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) wall[yy * W + xx] = id;
  };
  const add = (id: string, kind: PropKind, x: number, y: number, variant = 0) => {
    props.push({ id, kind, x, y, variant });
  };

  /* ── The front wing: the Plan Room and the Review Room, fixed rooms reached from their pages ── */
  const planX = ZONES_X; // 3: wall column; interior 4..9
  const reviewX = ZONES_X + FRONT_ROOM_W + 2; // 12: wall column; interior 13..18
  const wingRooms: { id: string; name: string; x: number; carpet: number; color: string }[] = [
    { id: PLAN_ROOM_ID, name: 'Plan Room', x: planX, carpet: Floor.CarpetBlue, color: '#7aa2f7' },
    { id: REVIEW_ROOM_ID, name: 'Review Room', x: reviewX, carpet: Floor.CarpetPurple, color: '#a06fe0' },
  ];
  // The hall the two rooms stand in (rows 2..FRONT_H+1), so both have a way in and out.
  fill(1, 2, W - 2, FRONT_H + 1, Floor.Concrete);
  for (const room of wingRooms) {
    const { x } = room;
    const door = x + 3; // where the bottom wall opens, and the lobby's top wall under it
    fill(x, 2, FRONT_ROOM_W, FRONT_ROOM_H, room.carpet);
    wallRun(x, 2, 1, FRONT_ROOM_H, Wall.Glass);
    wallRun(x + FRONT_ROOM_W - 1, 2, 1, FRONT_ROOM_H, Wall.Glass);
    wallRun(x, 2 + FRONT_ROOM_H - 1, FRONT_ROOM_W, 1, Wall.Plaster);
    wall[(2 + FRONT_ROOM_H - 1) * W + door] = Wall.None; // the door
  }
  add('plan-rug', 'rugBlue', planX + 2, 4);
  add('plan-plant', 'plantBig', planX + 1, 2);
  add('plan-shelf', 'bookshelf', planX + 5, 6);
  // The sofas keep a way through the room: a wall of furniture would make its middle unreachable.
  add('review-sofa-1', 'sofa', reviewX + 1, 5, 0);
  add('review-sofa-2', 'sofa', reviewX + 4, 2, 2);
  add('review-plant', 'plantBig', reviewX + 1, 2);
  add('review-poster', 'poster', reviewX + 2, 2, 2);

  /* ── Lobby ── */
  const below = LOBBY_Y + LOBBY_H;
  const dy = FRONT_H; // every lobby prop keeps its place relative to the lobby, which sits under the wing
  fill(1, LOBBY_Y - 1, W - 2, LOBBY_H + 1, Floor.Wood);
  wallRun(1, LOBBY_Y - 1, W - 2, 1, Wall.Plaster);
  // The doors in the lobby's top wall, under the wing's rooms, so the hall reaches the lobby.
  for (const room of wingRooms) wall[(LOBBY_Y - 1) * W + room.x + 3] = Wall.None;
  // The spine down the left edge and a corridor above each row of zones. What is left of a short last row stays void.
  fill(1, below, SPINE_W, rows * ROW_H, Floor.Concrete);
  for (let r = 0; r < rows; r++) fill(1, below + r * ROW_H, W - 2, CORRIDOR_H, Floor.Concrete);
  zones.push({ id: 'lobby', name: 'Lobby', kind: 'lobby', x: 1, y: LOBBY_Y, w: W - 2, h: LOBBY_H, color: '#e6e8f0' });
  for (const room of wingRooms) {
    zones.push({ id: room.id, name: room.name, kind: 'open', x: room.x + 1, y: 2, w: ZONE_INNER_W, h: ZONE_INNER_H, color: room.color });
  }

  add('reception', 'reception', 3, 3 + dy);
  add('lobby-plant-1', 'plantBig', 2, 3 + dy);
  add('lobby-coffee', 'coffeeBar', 13, 3 + dy);
  add('lobby-cooler', 'cooler', 17, 3 + dy);
  add('lobby-rug', 'rugBlue', 8, 6 + dy);
  add('lobby-sofa-1', 'sofa', 3, 9 + dy, 0);
  add('lobby-sofa-2', 'sofa', 14, 9 + dy, 2);
  add('lobby-lamp-1', 'lamp', 7, 9 + dy);
  add('lobby-lamp-2', 'lamp', 18, 9 + dy);
  add('lobby-plant-2', 'plantBig', 1, 10 + dy);
  add('lobby-poster-1', 'poster', 9, LOBBY_Y - 1, 1);
  add('lobby-poster-2', 'poster', 11, LOBBY_Y - 1, 3);
  for (let x = 4, i = 0; x + 1 < W - 1; x += 4, i++) if (x < 8 || x > 12) add(`lobby-window-${i}`, 'window', x, LOBBY_Y - 1, i % 2);

  /* ── One zone per member ── */
  ordered.forEach((m, slot) => {
    const { x: bx, y: y0 } = slotOrigin(slot);
    const key = mapKey(m.uid);
    const carpet = CARPETS[slot % CARPETS.length];
    // The block: its left wall and bottom wall in the zone's own carpet, so no floor of another kind shows under them.
    fill(bx, y0, ZONE_W, ZONE_H, carpet);
    wallRun(bx, y0, 1, ZONE_H, Wall.Glass);
    wallRun(bx, y0 + ZONE_INNER_H, ZONE_W, 1, Wall.Plaster);
    // The last block of a row also closes its right side.
    if (slot + 1 >= ordered.length || (slot + 1) % COLS === 0) {
      fill(bx + ZONE_W, y0, 1, ZONE_H, carpet);
      wallRun(bx + ZONE_W, y0, 1, ZONE_H, Wall.Glass);
    }

    const first = bx + 1;
    add(deskIdOf(m.uid), 'desk', first + 1, y0 + 1, slot % 4);
    add(`chair-${key}`, 'chair', first + 2, y0 + 2, slot % 4);
    add(`plant-${key}`, 'plant', first, y0 + ZONE_INNER_H - 1, slot % 3);
    add(`shelf-${key}`, 'bookshelf', first + 3, y0 + ZONE_INNER_H - 1, slot % 2);
    add(`lamp-${key}`, 'lamp', first + ZONE_INNER_W - 1, y0 + ZONE_INNER_H - 1);

    zones.push({
      id: zoneIdOf(m.uid),
      name: `${clampCodePoints(m.name, 28)}’s zone`,
      kind: 'open',
      x: first,
      y: y0,
      w: ZONE_INNER_W,
      h: ZONE_INNER_H,
      color: ACCENTS[slot % ACCENTS.length],
    });
  });

  /* ── The shell is hedge ── */
  wallRun(0, 0, W, 1, Wall.Hedge);
  wallRun(0, H - 1, W, 1, Wall.Hedge);
  wallRun(0, 0, 1, H, Wall.Hedge);
  wallRun(W - 1, 0, 1, H, Wall.Hedge);
  fill(0, 0, W, 1, Floor.Grass);
  fill(0, H - 1, W, 1, Floor.Grass);
  fill(0, 0, 1, H, Floor.Grass);
  fill(W - 1, 0, 1, H, Floor.Grass);

  return {
    id: OFFICE_MAP_ID,
    name: 'Team office',
    width: W,
    height: H,
    floor,
    wall,
    zones,
    props,
    // Everyone arrives in the lobby, by the reception desk.
    spawns: [
      { x: 6.5, y: 7.5 + FRONT_H },
      { x: 7.5, y: 7.5 + FRONT_H },
      { x: 6.5, y: 8.5 + FRONT_H },
      { x: 7.5, y: 8.5 + FRONT_H },
      { x: 5.5, y: 7.5 + FRONT_H },
      { x: 5.5, y: 8.5 + FRONT_H },
    ],
  };
}

/**
 * Where a page's room can be walked to, best first: the room's middle, then the spot just inside its door. The `progress` page (Build) is
 * the office itself, so it is the lobby's spawns. A page whose room is not on this map (an older team server) falls back
 * to the lobby, so a walk is never sent nowhere.
 */
export function pageRoomTargets(map: Pick<WorkspaceMap, 'zones' | 'spawns'>, page: WorkspacePage): Vec[] {
  const zone = page === 'progress' ? undefined : map.zones.find((z) => z.id === page);
  if (!zone) return [...map.spawns];
  return [
    { x: zone.x + zone.w / 2, y: zone.y + zone.h / 2 },
    { x: zone.x + 2.5, y: zone.y + zone.h - 0.5 },
  ];
}

/**
 * The room each stage page of the delivery pipeline stands in. The rooms are the three the office has (the Plan Room, the lobby and
 * the Review Room), so the stages share them: planning and design happen in the Plan Room, building in the lobby among the desks, and
 * testing, releasing and deploying in the Review Room. The wire still carries one of the three `WorkspacePage` values, so an older
 * server and the saved conversations keep working.
 */
export const PAGE_ROOM = {
  plan: 'plan',
  design: 'plan',
  build: 'progress',
  test: 'review',
  release: 'review',
  deploy: 'review',
} as const satisfies Record<string, WorkspacePage>;

/** The id of the room a page's room is: the lobby for the page that is the office itself. */
export const roomIdOfPage = (page: WorkspacePage): string => (page === 'progress' ? 'lobby' : page);

/** Zone containing a tile position (smallest area wins). */
export function zoneAt(map: Pick<WorkspaceMap, 'zones'>, x: number, y: number): MapZone | null {
  let best: MapZone | null = null;
  for (const z of map.zones) {
    if (x >= z.x && y >= z.y && x < z.x + z.w && y < z.y + z.h) {
      if (!best || z.w * z.h < best.w * best.h) best = z;
    }
  }
  return best;
}
