import { buildGrid, type Grid } from '../../shared/workspace/grid.ts';
import { applyEditOp, mapShapeOk, type ServerMsg } from '../../shared/workspace/protocol.ts';
import type { PlayerState, WorkspaceMap, WorkspacePage, WorkspaceRole } from '../../shared/workspace/types.ts';
import { Smoother } from './smoother.ts';

/** What a server message changed, so the caller only refreshes the screens that care. */
export type Change = 'welcome' | 'roster' | 'map' | 'desks' | 'moved' | 'correct' | 'role' | 'other';

/**
 * The office as this app knows it: the map, who is in it and where. The server (or the offline office) is the source of
 * truth; this applies its messages in order. The person's own figure is moved here directly, because waiting for the
 * server to answer every step would make walking feel sluggish; `correct` pulls it back if the server disagrees.
 */
export class ClientWorld {
  you: string | null = null;
  role: WorkspaceRole = 'guest';
  name = '';
  map: WorkspaceMap | null = null;
  grid: Grid | null = null;
  /** Goes up whenever the map changes, so the picture of the floor is redrawn. */
  mapVersion = 0;
  readonly players = new Map<string, PlayerState>();
  /** The page this person is on: everyone else is drawn only when they are on the same page. */
  page: WorkspacePage = 'progress';
  readonly deskOwners = new Map<string, string>();
  private smooth = new Map<string, Smoother>();

  get me(): PlayerState | null {
    return this.you ? (this.players.get(this.you) ?? null) : null;
  }

  apply(msg: ServerMsg, now: number): Change {
    switch (msg.t) {
      case 'welcome': {
        if (!mapShapeOk(msg.map)) return 'other';
        this.you = msg.you;
        this.role = msg.role;
        this.name = msg.workspace.name;
        this.map = msg.map;
        this.grid = buildGrid(msg.map);
        this.mapVersion += 1;
        this.players.clear();
        this.smooth.clear();
        for (const p of msg.players) this.addPlayer(p, now);
        this.deskOwners.clear();
        for (const [desk, owner] of Object.entries(msg.deskOwners)) this.deskOwners.set(desk, owner);
        return 'welcome';
      }
      case 'state': {
        for (const [id, x, y, dir, moving] of msg.p) {
          const p = this.players.get(id);
          if (!p || id === this.you) continue;
          p.x = x;
          p.y = y;
          p.dir = dir;
          p.moving = moving === 1;
          this.smooth.get(id)?.push(x, y, now);
        }
        return 'moved';
      }
      case 'join':
        this.addPlayer(msg.player, now);
        return 'roster';
      case 'leave':
        this.players.delete(msg.id);
        this.smooth.delete(msg.id);
        return 'roster';
      case 'patch': {
        const p = this.players.get(msg.id);
        if (!p) return 'other';
        Object.assign(p, msg.patch);
        if (msg.patch.x !== undefined || msg.patch.y !== undefined) this.smooth.get(msg.id)?.push(p.x, p.y, now);
        return 'roster';
      }
      case 'role':
        this.role = msg.role;
        return 'role';
      case 'desk.owner':
        if (msg.ownerId) this.deskOwners.set(msg.deskId, msg.ownerId);
        else this.deskOwners.delete(msg.deskId);
        return 'desks';
      case 'correct': {
        const me = this.me;
        if (me) {
          me.x = msg.x;
          me.y = msg.y;
        }
        return 'correct';
      }
      case 'map.set': {
        if (!mapShapeOk(msg.map)) return 'other';
        this.map = msg.map;
        this.grid = buildGrid(msg.map);
        this.mapVersion += 1;
        this.deskOwners.clear();
        for (const [desk, owner] of Object.entries(msg.deskOwners)) this.deskOwners.set(desk, owner);
        return 'map';
      }
      case 'map.edit':
        if (this.map && applyEditOp(this.map, msg.op)) {
          this.grid = buildGrid(this.map);
          this.mapVersion += 1;
          return 'map';
        }
        return 'other';
      default:
        return 'other';
    }
  }

  /** Where to draw someone right now (tile units). */
  position(id: string, now: number): { x: number; y: number } | null {
    const p = this.players.get(id);
    if (!p) return null;
    if (id === this.you) return { x: p.x, y: p.y };
    return this.smooth.get(id)?.at(now) ?? { x: p.x, y: p.y };
  }

  private addPlayer(p: PlayerState, now: number) {
    this.players.set(p.id, p);
    this.smooth.set(p.id, new Smoother(p.x, p.y, now));
  }
}
