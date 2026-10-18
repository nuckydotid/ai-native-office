import { zoneIdOf } from './shared/workspace/layout.ts';
import type { SessionInfo } from './shared/workspace/types.ts';
import { AuthzError } from './auth.ts';
import type { Config } from './config.ts';
import { RING_MAX_MESSAGES, Room } from './room.ts';
import { OFFICE_ID } from './store.ts';
import type { Store } from './store.ts';
import type { AiServices } from './ai/services.ts';
import type { Pipeline } from './pipeline/service.ts';

/** The project's one virtual office, loaded on first use. Who a person is has been decided by the sign-in before this. */
export class Office {
  private room: Promise<Room> | null = null;
  private loaded: Room | null = null;
  /** Agents that run on the server, when there are any: every room this office loads is given them. */
  ai: AiServices | null = null;
  /** The delivery pipeline, when it is on: every room this office loads is given it. */
  pipeline: Pipeline | null = null;

  constructor(
    private store: Store,
    private cfg: Pick<Config, 'projectName' | 'maxPlayers'>,
  ) {}

  /** The room, unless it is full (someone who is in it already may come back). */
  async enter(uid: string): Promise<Room> {
    const room = await this.get();
    if (!room.clients.has(uid) && room.clients.size >= this.cfg.maxPlayers) throw new AuthzError('room_full', 'This office is full.');
    return room;
  }

  /** The room if it is loaded already (nothing is loaded just to tell nobody something). */
  current(): Room | null {
    return this.loaded;
  }

  /** The room, loading it from the store on first use. */
  get(): Promise<Room> {
    this.room ??= this.create().catch((e) => {
      this.room = null;
      throw e;
    });
    return this.room;
  }

  private async create(): Promise<Room> {
    let doc = await this.store.getWorkspace(OFFICE_ID);
    if (!doc) {
      doc = { id: OFFICE_ID, name: this.cfg.projectName || 'Team office', createdAt: Date.now() };
      await this.store.putWorkspace(doc);
    }
    const [members, page, storedSessions, threads] = await Promise.all([
      this.store.listMembers(OFFICE_ID),
      this.store.listMessages(OFFICE_ID, { limit: RING_MAX_MESSAGES }),
      this.store.listSessions(OFFICE_ID),
      this.store.listThreads(OFFICE_ID),
    ]);
    // The office is laid out from the team now (a lobby and a zone each). Chat that belonged to a room of the old fixed map
    // (Frontend Lab, War Room …) has no room to be in any more: it moves to the lobby, once.
    const rooms = new Set(['lobby', 'plan', 'review', ...members.map((m) => zoneIdOf(m.uid))]);
    // A room has one active session: the ones that move in are archived when the lobby already has its own.
    let lobbyActive = storedSessions.some((s) => s.room === 'lobby' && s.state === 'active');
    const sessions: SessionInfo[] = [];
    for (const s of storedSessions) {
      if (rooms.has(s.room)) {
        sessions.push(s);
        continue;
      }
      const moved: SessionInfo = { ...s, room: 'lobby' };
      if (moved.state === 'active') {
        if (lobbyActive) Object.assign(moved, { state: 'archived', archivedAt: Date.now() });
        else lobbyActive = true;
      }
      await this.store.putSession(OFFICE_ID, moved);
      sessions.push(moved);
    }
    if (!sessions.some((s) => s.id === 'legacy')) {
      const legacyPage = await this.store.listMessages(OFFICE_ID, { session: null, limit: 1 });
      if (legacyPage.messages.length > 0) {
        const legacySession: SessionInfo = {
          id: 'legacy',
          room: 'lobby',
          state: 'archived',
          createdAt: legacyPage.messages[0].at,
          archivedAt: Date.now(),
          createdBy: 'system',
          legacy: true,
        };
        await this.store.putSession(OFFICE_ID, legacySession);
        sessions.push(legacySession);
      }
    }
    const room = new Room(doc, members, page.messages, page.hasMore, this.store, this.cfg, sessions, threads);
    room.attachAi(this.ai);
    room.attachPipeline(this.pipeline);
    return (this.loaded = room);
  }

  /** Forgets the loaded room (everyone connected is sent away and will come back to a fresh one): used after the demo's store was cleared. */
  async reset() {
    const room = this.loaded;
    this.room = null;
    this.loaded = null;
    if (room) await room.stop();
  }

  async shutdown() {
    if (this.room) await (await this.room.catch(() => null))?.stop();
  }

  stats() {
    return { online: this.loaded?.clients.size ?? 0 };
  }
}
