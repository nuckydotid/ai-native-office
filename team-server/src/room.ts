import { buildOfficeMap, deskIdOf, zoneAt, zoneIdOf } from './shared/workspace/layout.ts';
import { THREAD_ERROR_TEXT, THREAD_LIMITS, canTransition, isLive } from './shared/workspace/threads.ts';
import { agentFailureId, agentReplyId, extractMentions } from './shared/workspace/chat.ts';
import { makePlayer } from './shared/workspace/entities.ts';
import { PLAYER_SPEED, buildGrid, canStand, dist, nearestFree } from './shared/workspace/grid.ts';
import type { Grid } from './shared/workspace/grid.ts';
import { deskSeat } from './shared/workspace/props.ts';
import { LIMITS, PROTOCOL_VERSION, clampCodePoints, cleanAgentText, codePointLength, sanitizeText } from './shared/workspace/protocol.ts';
import type { AgentRef, AgentStatus, ClientMsg, PosTuple, ServerMsg } from './shared/workspace/protocol.ts';
import { AI_LIMITS } from './shared/ai/types.ts';
import type { RunFinal, RunKind, RunRequest } from './shared/ai/types.ts';
import type { AgentDef } from './ai/agents.ts';
import type { AiServices } from './ai/services.ts';
import { PipelineError } from './pipeline/service.ts';
import type { Pipeline } from './pipeline/service.ts';
import type { Artifact } from './shared/pipeline/types.ts';
import { scrubSecrets } from './shared/workspace/secrets.ts';
import type { Appearance, ChatCard, ChatMessage, Dir, PlayerState, SessionInfo, Vec, WorkThread, WorkspaceMap, WorkspaceRole } from './shared/workspace/types.ts';
import type { Config } from './config.ts';
import { log } from './log.ts';
import { TokenBucket } from './ratelimit.ts';
import { MAX_RUNS_PER_ROOM, MAX_RUNS_PER_USER, RunBook } from './runs.ts';
import type { Run } from './runs.ts';
import { OFFICE_ID, compareMessages } from './store.ts';
import type { MemberDoc, Store, StoredMessage, WorkspaceDoc } from './store.ts';

export interface Transport {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface Client {
  uid: string;
  role: WorkspaceRole;
  transport: Transport;
  send(msg: ServerMsg): void;
  buckets: { move: TokenBucket; chat: TokenBucket; emote: TokenBucket; edit: TokenBucket; misc: TokenBucket; history: TokenBucket; agent: TokenBucket; session: TokenBucket };
  lastMoveAt: number;
}

export interface JoinInfo {
  uid: string;
  name: string;
  look: Appearance;
  role: WorkspaceRole;
}

/** How many of the newest messages are kept in memory: a joining person's first page comes from here, never from the database. */
export const RING_MAX_MESSAGES = 40;
const TICK_MS = 100;
const RING_MAX = RING_MAX_MESSAGES;
const WELCOME_MESSAGES = 30;
const DEFAULT_PAGE = 30;
/** One database call may take this long before the person is told the message was not saved. */
/**
 * How long one database call, and one queued job (up to three calls in a row), may take. Fields so that tests can shorten them;
 * nothing else changes them.
 */
export const timing = { storeMs: 5000, jobMs: 17_000 };
const QUEUE_CAP = 100;
/** No one person may hold more than this many places in the queue, so one person can't block the room for everyone. */
const QUEUE_PER_USER = 8;
/** How long a client's own id for a send is remembered, to recognise a retry of a message that was in fact saved. */
const CID_TTL_MS = 60_000;
/** How long after an agent's answer its asker may still take it back ("Undo"). The app offers 30 seconds. */
const UNDO_MS = LIMITS.undoMs;
/** How old a mention may be for each way of starting a run. */
const START_MAX_AGE = LIMITS.startMaxAgeMs;
const REPLY_BYTES_PER_HOUR = 200 * 1024;
const FAILURE_LINES_PER_HOUR = 10;
const SWEEP_MS = 1000;
/** `Run.owner` of a run the server drives itself: not a connection, so a person leaving never makes it wait for them. */
const SERVER_OWNER = Object.freeze({});

/**
 * Which pipeline the agent service runs for a mention: the Planner Agent plans, the Reviewer Agent checks, the Designer, Developer, QA
 * and Release Agents each draft their stage's artifact, and everyone else answers a question.
 */
const runKindFor = (handle: string): RunKind =>
  handle === 'planner' ? 'plan' : handle === 'reviewer' ? 'review' : handle === 'designer' ? 'design' : handle === 'developer' ? 'implement' : handle === 'qa' ? 'tests' : handle === 'release' ? 'release_pack' : 'mention';

/** A ticket named in a question (`#12`), for a pipeline agent that was mentioned in a room instead of started from a stage page. */
const ticketNamed = (question: string): number | null => {
  const m = /(?:^|[\s(])#(\d{1,6})\b/.exec(question);
  return m ? Number(m[1]) : null;
};

/** What starts a server-run agent: from a mention in a room, or from a button (minutes, import). */
export interface AiRunStart {
  uid: string;
  byName: string;
  handle: string;
  kind: RunKind;
  room: string;
  session: string;
  /** The message the answer is a reply to (a person's mention, or a made-up id for a button). */
  replyTo: string;
  question: string;
  /** The client's own id for a run it asked for with `agent.start`; made up for a button. */
  reqId?: string;
  /** The ticket a pipeline run works on (an id or a number), when a stage page started it. */
  ticket?: string;
}
export type AiRunResult = { ok: true; runId: string } | { ok: false; code: string; message: string };

/** What a failure note needs to know about a run (a run that has already ended is described by the same fields). */
type RunLike = Pick<Run, 'uid' | 'byName' | 'agent' | 'replyTo' | 'reqId' | 'room' | 'session'>;


const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timed out')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });

const randomPart = () => Math.floor(Math.random() * 36 ** 6).toString(36).padStart(6, '0');
/** Sorts like the (at, id) order the database pages by, because `at` only grows. */
const messageId = (at: number) => `${at.toString(36).padStart(9, '0')}-${randomPart()}`;

/** Counts something per person per hour. */
class HourlyQuota {
  private windows = new Map<string, { start: number; used: number }>();
  /** Adds `n` if that stays within `limit`. */
  take(key: string, n: number, limit: number, now = Date.now()): boolean {
    let w = this.windows.get(key);
    if (!w || now - w.start > 3600_000) this.windows.set(key, (w = { start: now, used: 0 }));
    if (w.used + n > limit) return false;
    w.used += n;
    return true;
  }
  /** Whether `n` more would fit, without counting it. */
  fits(key: string, n: number, limit: number, now = Date.now()): boolean {
    const w = this.windows.get(key);
    return !w || now - w.start > 3600_000 || w.used + n <= limit;
  }
}

/** What a queued job is told: `cancelled` once it ran out of time, so that it stops changing anything. */
interface Ctx {
  cancelled: boolean;
}
interface Queued {
  job: (ctx: Ctx) => Promise<void>;
  uid?: string;
  onTimeout?: () => void;
}

export class Room {
  readonly players = new Map<string, PlayerState>();
  readonly clients = new Map<string, Client>();
  readonly deskOwners = new Map<string, string>();
  readonly members = new Map<string, MemberDoc>();
  readonly runs = new RunBook();
  readonly sessions = new Map<string, SessionInfo>();
  /** Worktree tabs (all of them, including archived: their chat stays readable). */
  readonly threads = new Map<string, WorkThread>();
  /** Per-session rings (small LRU of loaded sessions). */
  private sessionRings = new Map<string, { messages: ChatMessage[]; olderThanRing: boolean }>();
  private lastAt: number;
  private grid: Grid;
  private lastSent = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private lastTick = Date.now();
  /** What the current map was laid out from (who, in what order, under what name), so a join that changes nothing lays out nothing. */
  private layoutKey = '';
  private deskIndex = new Map<string, { x: number; y: number }>();
  // One conversation, one writer: saving, broadcasting, deleting and agent replies happen one at a time, in order.
  private queue: Queued[] = [];
  private queuedBy = new Map<string, number>();
  private draining = false;
  private cidIds = new Map<string, { id: string; at: number }>();
  /** People whose removal is being written: they can't join meanwhile. */
  private removing = new Set<string>();
  private replyBytes = new HourlyQuota();
  private failureLines = new HourlyQuota();
  /** The AI side (agents that run on the server), when this server has one. */
  private ai: AiServices | null = null;
  private pipeline: Pipeline | null = null;
  /** A scripted conversation is being replayed (the demo's sample standup): one at a time. */
  private replaying = false;

  /** The office: a lobby and one zone for each member. It is derived from `members` (see `relayout`), never saved. */
  public map: WorkspaceMap;

  constructor(
    readonly doc: WorkspaceDoc,
    members: MemberDoc[],
    tail: ChatMessage[],
    /** There are saved messages older than `tail`. */
    olderThanTail: boolean,
    private store: Store,
    readonly cfg: Pick<Config, 'maxPlayers'>,
    sessions: SessionInfo[] = [],
    threads: WorkThread[] = [],
  ) {
    for (const s of sessions) this.sessions.set(s.id, s);
    if (this.sessions.size === 0 && tail.length > 0) {
      for (const m of tail) {
        if (m.session && !this.sessions.has(m.session)) {
          this.sessions.set(m.session, {
            id: m.session,
            room: m.room ?? 'lobby',
            state: 'active',
            createdAt: m.at,
            createdBy: m.from,
          });
        }
      }
      if (this.sessions.size === 0) {
        this.sessions.set('legacy', {
          id: 'legacy',
          room: 'lobby',
          state: 'archived',
          createdAt: tail[0]?.at ?? 0,
          createdBy: 'system',
          legacy: true,
        });
      }
    }
    for (const m of tail) {
      const sessId = m.session ?? 'legacy';
      this.pushSessionRing(sessId, m);
    }
    if (olderThanTail) {
      for (const sr of this.sessionRings.values()) sr.olderThanRing = true;
    }
    // `at` never goes backwards, even if the clock does or a newer revision saved messages "in the future".
    this.lastAt = tail.reduce((max, m) => Math.max(max, m.at), 0);
    for (const m of members) this.members.set(m.uid, m);
    // A tab's chat is a session of its own that belongs to no room's conversation (it is not in the sessions table).
    for (const t of threads) {
      this.threads.set(t.id, t);
      this.sessions.set(t.session, this.sessionOf(t));
    }
    this.map = this.layout();
    this.layoutKey = this.memberKey();
    this.grid = buildGrid(this.map);
    this.reindexDesks();
    this.rebuildDeskOwners();
    // Runs are swept on their own timer, not by the position tick (which sleeps when nobody is connected).
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_MS);
    (this.sweepTimer as { unref?: () => void }).unref?.();
  }

  /* ───────────── lifecycle ───────────── */

  start() {
    if (this.timer) return;
    this.lastTick = Date.now();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.timer = this.sweepTimer = null;
    for (const c of this.clients.values()) {
      c.transport.close(1012, 'server restarting');
    }
  }

  private reindexDesks() {
    this.deskIndex.clear();
    for (const p of this.map.props) if (p.kind === 'desk') this.deskIndex.set(p.id, p);
  }

  /** Everyone owns the desk in their own zone. Returns the members whose desk changed (they are saved by the caller). */
  private rebuildDeskOwners(): MemberDoc[] {
    this.deskOwners.clear();
    const changed: MemberDoc[] = [];
    for (const m of this.members.values()) {
      const desk = deskIdOf(m.uid);
      this.deskOwners.set(desk, m.uid);
      if (m.desk !== desk) {
        m.desk = desk;
        changed.push(m);
      }
    }
    return changed;
  }

  private memberKey() {
    return [...this.members.values()].map((m) => `${m.uid}\n${m.name}\n${m.joinedAt}`).sort().join('\n\n');
  }

  /** The lobby and a zone for each member, in the order they joined. */
  private layout(): WorkspaceMap {
    return buildOfficeMap([...this.members.values()].map((m) => ({ uid: m.uid, name: m.name, joinedAt: m.joinedAt })));
  }

  /**
   * Lays the office out again from the team, after someone came, left or changed their name. A zone's place depends only on its
   * slot, so the room grows without moving anyone. Everyone connected is sent the new map.
   */
  private relayout() {
    const key = this.memberKey();
    if (key === this.layoutKey) return;
    this.layoutKey = key;
    this.map = this.layout();
    this.grid = buildGrid(this.map);
    this.reindexDesks();
    for (const m of this.rebuildDeskOwners()) void this.store.putMember(this.doc.id, m).catch(() => {});
    for (const [uid, p] of this.players) {
      const desk = deskIdOf(uid);
      if (p.desk !== desk && this.members.has(uid)) p.desk = desk;
    }
    this.settlePlayers();
    this.broadcast({ t: 'map.set', map: this.map, deskOwners: Object.fromEntries(this.deskOwners) });
  }

  /** Anyone standing in a wall (or at a desk that is gone) after the map changed is moved to the nearest open spot. */
  private settlePlayers() {
    for (const pl of this.players.values()) {
      if (pl.sitting && !this.deskIndex.has(pl.sitting)) {
        pl.sitting = null;
        this.broadcast({ t: 'patch', id: pl.id, patch: { sitting: null } }, pl.id);
      }
      if (pl.sitting) continue;
      if (canStand(this.grid, pl.x, pl.y)) continue;
      const free = nearestFree(this.grid, pl.x, pl.y, 8) ?? this.map.spawns[0];
      pl.x = free.x;
      pl.y = free.y;
      this.clients.get(pl.id)?.send({ t: 'correct', x: free.x, y: free.y });
    }
  }

  /* ───────────── the queue ───────────── */

  /**
   * Runs `job` after the ones before it. Answers `onBusy` instead when the queue is full or `uid` already holds its share of it,
   * and `onTimeout` if the job takes longer than `JOB_MS` (it is then told `cancelled` and must stop changing anything).
   */
  private enqueue(job: Queued['job'], opts: { uid?: string; onBusy?: () => void; onTimeout?: () => void } = {}) {
    const { uid, onBusy, onTimeout } = opts;
    if (this.queue.length >= QUEUE_CAP || (uid && (this.queuedBy.get(uid) ?? 0) >= QUEUE_PER_USER)) return onBusy?.();
    if (uid) this.queuedBy.set(uid, (this.queuedBy.get(uid) ?? 0) + 1);
    this.queue.push({ job, uid, onTimeout });
    void this.drain();
  }

  private async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      for (let item = this.queue.shift(); item; item = this.queue.shift()) {
        const ctx: Ctx = { cancelled: false };
        try {
          // A job that hangs must not freeze the room for everyone; its own database calls have shorter limits.
          await withTimeout(item.job(ctx), timing.jobMs);
        } catch (e) {
          ctx.cancelled = true;
          log.error('chat job failed', { err: String(e) });
          item.onTimeout?.();
        } finally {
          if (item.uid) {
            const left = (this.queuedBy.get(item.uid) ?? 1) - 1;
            if (left > 0) this.queuedBy.set(item.uid, left);
            else this.queuedBy.delete(item.uid);
          }
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private nextAt() {
    this.lastAt = Math.max(Date.now(), this.lastAt + 1);
    return this.lastAt;
  }

  private sessionOf(t: WorkThread): SessionInfo {
    return { id: t.session, room: t.zone, state: 'active', createdAt: t.createdAt, createdBy: t.owner, thread: t.id };
  }

  getActiveSession(room: string): SessionInfo | undefined {
    for (const s of this.sessions.values()) {
      if (s.thread) continue;
      if (s.room === room && s.state === 'active') return s;
    }
    return undefined;
  }

  hasArchivedSession(room: string): boolean {
    for (const s of this.sessions.values()) {
      if (!s.thread && s.room === room && s.state === 'archived' && !s.legacy) return true;
    }
    return false;
  }

  private getSessionRing(sessionId: string) {
    return this.sessionRings.get(sessionId);
  }

  private async ensureSessionRing(sessionId: string) {
    let ring = this.sessionRings.get(sessionId);
    if (ring) return ring;
    const page = await withTimeout(
      this.store.listMessages(OFFICE_ID, { session: sessionId, limit: RING_MAX }),
      timing.storeMs,
    ).catch(() => ({ messages: [], hasMore: false }));
    ring = { messages: page.messages, olderThanRing: page.hasMore };
    this.sessionRings.set(sessionId, ring);
    if (this.sessionRings.size > 20) {
      const firstKey = this.sessionRings.keys().next().value;
      if (firstKey && firstKey !== sessionId) this.sessionRings.delete(firstKey);
    }
    return ring;
  }

  /**
   * Keeps the newest messages in order for a session.
   */
  private pushSessionRing(sessionId: string, msg: ChatMessage) {
    let ring = this.sessionRings.get(sessionId);
    if (!ring) {
      ring = { messages: [], olderThanRing: false };
      this.sessionRings.set(sessionId, ring);
    }
    const i = ring.messages.findIndex((m) => m.id === msg.id);
    if (i >= 0) {
      if (ring.messages[i].at === msg.at) {
        ring.messages[i] = msg;
        return;
      }
      ring.messages.splice(i, 1);
    } else if (ring.messages.length >= RING_MAX && compareMessages(msg, ring.messages[0]) < 0) {
      return;
    }
    let at = ring.messages.length;
    while (at > 0 && compareMessages(ring.messages[at - 1], msg) > 0) at--;
    ring.messages.splice(at, 0, msg);
    if (ring.messages.length > RING_MAX) {
      ring.messages.shift();
      ring.olderThanRing = true;
    }
  }

  private async getMessage(id: string): Promise<StoredMessage | null> {
    for (const sr of this.sessionRings.values()) {
      const hit = sr.messages.find((m) => m.id === id);
      if (hit) return hit;
    }
    return await withTimeout(this.store.getMessage(OFFICE_ID, id), timing.storeMs);
  }

  /* ───────────── connections ───────────── */

  /** What two names are compared by: ignoring case, and look-alike forms (full-width letters, ligatures). */
  private nameKey = (name: string) => name.normalize('NFKC').toLowerCase();

  private uniqueName(name: string, uid: string): string {
    const taken = new Set<string>();
    for (const m of this.members.values()) if (m.uid !== uid) taken.add(this.nameKey(m.name));
    for (const p of this.players.values()) if (p.id !== uid) taken.add(this.nameKey(p.name));
    if (!taken.has(this.nameKey(name))) return name;
    for (let i = 2; i < 1000; i++) {
      const candidate = `${clampCodePoints(name, LIMITS.name - String(i).length - 1)} ${i}`;
      if (!taken.has(this.nameKey(candidate))) return candidate;
    }
    return name;
  }

  join(client: Client, info: JoinInfo) {
    // A person being removed (a guest who was away) does not come back in the middle of it.
    if (this.removing.has(info.uid)) {
      client.send({ t: 'error', code: 'not_a_member', message: 'You’re no longer on this team.' });
      client.transport.close(4003, 'not a member');
      return;
    }
    const existing = this.clients.get(info.uid);
    if (existing) {
      existing.send({ t: 'error', code: 'replaced', message: 'You joined from another window, so this one was disconnected.' });
      existing.transport.close(4001, 'signed in elsewhere');
      this.leave(existing);
    }
    let m = this.members.get(info.uid);
    const now = Date.now();
    const name = this.uniqueName(info.name, info.uid);
    if (!m) {
      m = { uid: info.uid, role: info.role, name, look: info.look, desk: null, joinedAt: now, lastSeen: now };
      this.members.set(info.uid, m);
    } else {
      m.name = name;
      m.look = info.look;
      m.role = info.role;
      m.lastSeen = now;
    }
    client.role = m.role;
    // A new member gets their zone, and a changed name is written on the door: everyone already here is sent the new map.
    this.relayout();
    void this.store.putMember(this.doc.id, m).catch((e) => log.error('putMember failed', { err: String(e) }));

    const spawn = this.pickSpawn();
    const p = makePlayer({ id: info.uid, name, x: spawn.x, y: spawn.y, look: info.look, desk: m.desk });
    p.desk = m.desk;
    this.players.set(info.uid, p);
    this.clients.set(info.uid, client);

    const spawnZone = zoneAt(this.map, p.x, p.y);
    const initialRoom = spawnZone?.id ?? (this.map.zones.some((z) => z.id === 'lobby') ? 'lobby' : (this.map.zones[0]?.id ?? 'lobby'));
    let initialSession = this.getActiveSession(initialRoom);
    if (!initialSession && initialRoom === 'lobby' && this.sessions.has('legacy')) {
      initialSession = this.sessions.get('legacy');
    }
    const ring = initialSession ? this.getSessionRing(initialSession.id) : undefined;
    const tail = ring ? ring.messages.slice(-WELCOME_MESSAGES) : [];
    const historyHasMore = ring ? (ring.messages.length > tail.length || ring.olderThanRing) : false;

    client.send({
      t: 'welcome',
      you: info.uid,
      role: m.role,
      workspace: { id: this.doc.id, name: this.doc.name },
      map: this.map,
      players: [...this.players.values()],
      deskOwners: Object.fromEntries(this.deskOwners),
      room: initialRoom,
      sessions: [...this.sessions.values()].filter((x) => !x.thread),
      threads: [...this.threads.values()].filter((t) => t.state !== 'archived'),
      history: tail,
      historyHasMore,
      thinking: this.runs.statuses(info.uid),
      protocol: PROTOCOL_VERSION,
      serverTime: Date.now(),
    });
    this.broadcast({ t: 'join', player: p }, info.uid);
    if (m.desk) this.broadcast({ t: 'desk.owner', deskId: m.desk, ownerId: info.uid }, info.uid);
    log.info('player joined', { room: this.doc.id, uid: info.uid, online: this.clients.size });
    this.start();
  }

  leave(client: Client) {
    if (this.clients.get(client.uid) !== client) return;
    this.clients.delete(client.uid);
    const p = this.players.get(client.uid);
    this.players.delete(client.uid);
    this.lastSent.delete(client.uid);
    if (this.members.has(client.uid)) {
      // Only `lastSeen`: a role or desk changed while the person was here must not be written back from this stale copy.
      const m = this.members.get(client.uid)!;
      m.lastSeen = Date.now();
      void this.store.touchMember(this.doc.id, client.uid, m.lastSeen).catch(() => {});
    }
    // The person's agent runs wait for their app to come back (a new window, or the same one after a reconnect).
    for (const run of this.runs.ownedBy(client)) {
      run.owner = null;
      run.offlineSince = Date.now();
      this.broadcastStatus(run);
    }
    if (p) this.broadcast({ t: 'leave', id: p.id });
    log.info('player left', { room: this.doc.id, uid: client.uid, online: this.clients.size });
  }

  private pickSpawn() {
    const spawns = this.map.spawns;
    const taken = [...this.players.values()];
    for (const s of spawns) {
      if (!taken.some((p) => dist(p, s) < 0.8)) return s;
    }
    const s = spawns[Math.floor(Math.random() * spawns.length)] ?? { x: 2.5, y: 2.5 };
    return nearestFree(this.grid, s.x + Math.random() - 0.5, s.y + Math.random() - 0.5, 4) ?? s;
  }

  /* ───────────── the people (called by the demo's guest sweep) ───────────── */

  /** The people with a zone in the office, and whether each is connected. */
  listMembers() {
    return [...this.members.values()].map((m) => ({ uid: m.uid, name: m.name, role: m.role, lastSeen: m.lastSeen, online: this.clients.has(m.uid) }));
  }

  /** Removes someone from the office: their desk, their agent runs and their connection go with them. The database is written first. */
  async removeMember(uid: string) {
    if (!this.members.has(uid)) return false;
    this.removing.add(uid);
    try {
      await this.store.deleteMember(this.doc.id, uid);
    } finally {
      this.removing.delete(uid);
    }
    this.members.delete(uid);
    // Their zone goes with them, and the room closes up behind it.
    this.relayout();
    for (const run of this.runs.byUser(uid)) this.finishRun(run, 'failed', 'removed');
    const c = this.clients.get(uid);
    if (c) {
      c.send({ t: 'error', code: 'removed', message: 'You were removed from this team.' });
      c.transport.close(4003, 'removed');
    }
    return true;
  }

  /* ───────────── tick ───────────── */

  private tick() {
    const now = Date.now();
    this.lastTick = now;
    if (this.clients.size === 0) return;

    const tuples: PosTuple[] = [];
    for (const p of this.players.values()) {
      const key = `${p.x.toFixed(2)}|${p.y.toFixed(2)}|${p.dir}|${p.moving ? 1 : 0}`;
      if (this.lastSent.get(p.id) !== key) {
        this.lastSent.set(p.id, key);
        tuples.push([p.id, +p.x.toFixed(3), +p.y.toFixed(3), p.dir, p.moving ? 1 : 0]);
      }
    }
    if (tuples.length === 0) return;
    for (const c of this.clients.values()) {
      const mine = tuples.filter((t) => t[0] !== c.uid);
      if (mine.length) c.send({ t: 'state', time: now, p: mine });
    }
  }

  private broadcast(msg: ServerMsg, exceptUid?: string) {
    const data = JSON.stringify(msg);
    for (const c of this.clients.values()) {
      if (c.uid === exceptUid) continue;
      c.transport.send(data);
    }
  }

  /* ───────────── message handling ───────────── */

  handle(client: Client, msg: ClientMsg) {
    // Only the person's current connection speaks for them: a window that was replaced (or a late frame after leaving) does not.
    if (this.clients.get(client.uid) !== client) return;
    const p = this.players.get(client.uid);
    if (!p) return;
    switch (msg.t) {
      case 'move':
        if (client.buckets.move.take()) this.onMove(client, p, msg);
        return;
      case 'sit':
        if (client.buckets.misc.take()) this.onSit(client, p, msg.deskId);
        return;
      case 'emote':
        if (!client.buckets.emote.take()) return;
        p.emote = { kind: msg.emote, at: Date.now() };
        this.broadcast({ t: 'patch', id: p.id, patch: { emote: p.emote } }, p.id);
        return;
      case 'page.set':
        if (!client.buckets.misc.take()) return;
        p.page = msg.page;
        this.broadcast({ t: 'patch', id: p.id, patch: { page: p.page } }, p.id);
        return;
      case 'status':
        if (!client.buckets.misc.take()) return;
        p.status = msg.status;
        p.statusText = msg.text ?? '';
        this.broadcast({ t: 'patch', id: p.id, patch: { status: p.status, statusText: p.statusText } }, p.id);
        return;
      case 'activity':
        if (!client.buckets.misc.take()) return;
        p.activity = msg.activity;
        this.broadcast({ t: 'patch', id: p.id, patch: { activity: p.activity } }, p.id);
        return;
      case 'chat':
        if (!client.buckets.chat.take()) return client.send({ t: 'error', code: 'rate_limited', message: 'You’re sending messages too fast. Wait a moment.', cid: msg.cid });
        this.enqueue((ctx) => this.onChat(ctx, client, p, msg), {
          uid: client.uid,
          onBusy: () => client.send({ t: 'error', code: 'busy', message: 'The chat is busy. Try again in a moment.', cid: msg.cid }),
          onTimeout: () => client.send({ t: 'error', code: 'not_saved', message: 'Your message wasn’t saved in time. Try sending it again.', cid: msg.cid }),
        });
        return;
      case 'history.get':
        if (!client.buckets.history.take()) return client.send({ t: 'error', code: 'rate_limited', message: 'Too many requests. Try again in a moment.', reqId: msg.reqId });
        void this.onHistory(client, msg);
        return;
      case 'chat.delete':
        if (!client.buckets.misc.take()) return client.send({ t: 'error', code: 'rate_limited', message: 'Too many requests. Try again in a moment.' });
        this.enqueue((ctx) => this.onDelete(ctx, client, msg.id), {
          uid: client.uid,
          onBusy: () => client.send({ t: 'error', code: 'busy', message: 'The chat is busy. Try again in a moment.' }),
          onTimeout: () => client.send({ t: 'error', code: 'unavailable', message: 'The chat history didn’t answer in time. Try again.' }),
        });
        return;
      case 'agent.start': {
        // Every start that is not a run this person already has counts against the budget (a reconnect that takes its runs
        // back costs one token each, which the burst allows); each one costs database reads in the queue.
        if (!this.runs.get(client.uid, msg.reqId) && !client.buckets.agent.take()) {
          return client.send({ t: 'error', code: 'rate_limited', message: 'Too many agent requests. Wait a moment.', reqId: msg.reqId });
        }
        this.enqueue((ctx) => this.onAgentStart(ctx, client, p, msg), {
          uid: client.uid,
          onBusy: () => client.send({ t: 'error', code: 'busy', message: 'The chat is busy. Try again in a moment.', reqId: msg.reqId }),
          onTimeout: () => client.send({ t: 'error', code: 'unavailable', message: 'The chat history didn’t answer in time. Try again.', reqId: msg.reqId }),
        });
        return;
      }
      case 'agent.reply': {
        // An answer to a run that is going costs nothing; one without a run (a late answer) is looked up in the database, so it counts.
        if (!this.runs.get(client.uid, msg.reqId) && !client.buckets.agent.take()) {
          return client.send({ t: 'error', code: 'rate_limited', message: 'Too many agent requests. Wait a moment.', reqId: msg.reqId });
        }
        this.enqueue((ctx) => this.onAgentReply(ctx, client, p, msg), {
          uid: client.uid,
          onBusy: () => client.send({ t: 'error', code: 'busy', message: 'The chat is busy. Try again in a moment.', reqId: msg.reqId }),
          onTimeout: () => client.send({ t: 'error', code: 'not_saved', message: 'The answer wasn’t saved in time. It will be tried again.', reqId: msg.reqId }),
        });
        return;
      }
      case 'agent.fail': {
        const run = this.runs.get(client.uid, msg.reqId);
        if (run) this.finishRun(run, 'failed');
        else client.send({ t: 'error', code: 'not_found', message: 'Nothing is waiting for that answer any more.', reqId: msg.reqId });
        return;
      }
      case 'session.new':
        if (!client.buckets.session.take()) return client.send({ t: 'error', code: 'rate_limited', message: 'Too many session requests. Wait a moment.', reqId: msg.reqId });
        this.enqueue((ctx) => this.onSessionNew(ctx, client, msg.room, msg.reqId), {
          uid: client.uid,
          onBusy: () => client.send({ t: 'error', code: 'busy', message: 'The chat is busy. Try again in a moment.', reqId: msg.reqId }),
          onTimeout: () => client.send({ t: 'error', code: 'unavailable', message: 'The request timed out. Try again.', reqId: msg.reqId }),
        });
        return;
      case 'session.archive':
        if (!client.buckets.session.take()) return client.send({ t: 'error', code: 'rate_limited', message: 'Too many session requests. Wait a moment.', reqId: msg.reqId });
        this.enqueue((ctx) => this.onSessionArchive(ctx, client, msg.room, msg.reqId), {
          uid: client.uid,
          onBusy: () => client.send({ t: 'error', code: 'busy', message: 'The chat is busy. Try again in a moment.', reqId: msg.reqId }),
          onTimeout: () => client.send({ t: 'error', code: 'unavailable', message: 'The request timed out. Try again.', reqId: msg.reqId }),
        });
        return;
      case 'session.delete':
        if (!client.buckets.session.take()) return client.send({ t: 'error', code: 'rate_limited', message: 'Too many session requests. Wait a moment.', reqId: msg.reqId });
        this.enqueue((ctx) => this.onSessionDelete(ctx, client, msg.session, msg.reqId), {
          uid: client.uid,
          onBusy: () => client.send({ t: 'error', code: 'busy', message: 'The chat is busy. Try again in a moment.', reqId: msg.reqId }),
          onTimeout: () => client.send({ t: 'error', code: 'unavailable', message: 'The request timed out. Try again.', reqId: msg.reqId }),
        });
        return;
      case 'desk.claim':
        if (client.buckets.misc.take()) this.onClaim(client);
        return;
      case 'thread.new':
        if (!client.buckets.misc.take()) return client.send({ t: 'error', code: 'rate_limited', message: 'Too many requests. Wait a moment.', reqId: msg.reqId });
        void this.onThreadNew(client, p, msg);
        return;
      case 'thread.patch':
        if (client.buckets.misc.take()) this.onThreadPatch(client, msg.id, msg.patch);
        return;
      case 'thread.say':
        if (!client.buckets.misc.take()) return client.send({ t: 'error', code: 'rate_limited', message: 'Too many requests. Wait a moment.', cid: msg.cid });
        this.enqueue((ctx) => this.onThreadSay(ctx, client, p, msg), {
          uid: client.uid,
          onBusy: () => client.send({ t: 'error', code: 'busy', message: 'The chat is busy. Try again in a moment.', cid: msg.cid }),
          onTimeout: () => client.send({ t: 'error', code: 'not_saved', message: 'The message wasn’t saved in time.', cid: msg.cid }),
        });
        return;
      case 'card.answer':
      case 'card.decide':
        if (!client.buckets.misc.take()) return client.send({ t: 'error', code: 'rate_limited', message: 'Too many requests. Wait a moment.' });
        this.enqueue((ctx) => this.onCard(ctx, client, msg), { uid: client.uid, onBusy: () => client.send({ t: 'error', code: 'busy', message: 'The chat is busy. Try again in a moment.' }) });
        return;
      case 'thread.archive':
        if (client.buckets.misc.take()) this.onThreadArchive(client, msg.id);
        return;
      case 'edit':
        if (client.buckets.edit.take()) this.onEdit(client);
        return;
      case 'ping':
        client.send({ t: 'pong', at: msg.at, serverTime: Date.now() });
        return;
      case 'hello':
        return;
    }
  }

  private onMove(client: Client, p: PlayerState, m: { x: number; y: number; dir: Dir; moving: boolean }) {
    const now = Date.now();
    const dt = Math.max(0.02, Math.min(1, (now - client.lastMoveAt) / 1000));
    client.lastMoveAt = now;
    if (p.sitting && !m.moving && dist(p, m) < 0.05) return;
    const maxStep = PLAYER_SPEED * dt * 1.6 + 0.4;
    if (dist(p, m) > maxStep || !canStand(this.grid, m.x, m.y)) {
      client.send({ t: 'correct', x: p.x, y: p.y });
      return;
    }
    if (p.sitting) {
      p.sitting = null;
      this.broadcast({ t: 'patch', id: p.id, patch: { sitting: null } }, p.id);
    }
    p.x = m.x;
    p.y = m.y;
    p.dir = m.dir;
    p.moving = m.moving;
  }

  private onSit(client: Client, p: PlayerState, deskId: string | null) {
    if (deskId === null) {
      if (!p.sitting) return;
      const free = nearestFree(this.grid, p.x, p.y + 1, 3);
      p.sitting = null;
      if (free) {
        p.x = free.x;
        p.y = free.y;
      }
      this.broadcast({ t: 'patch', id: p.id, patch: { sitting: null } }, p.id);
      client.send({ t: 'correct', x: p.x, y: p.y });
      return;
    }
    const desk = this.deskIndex.get(deskId);
    if (!desk) return;
    const seat = deskSeat(desk);
    const sx = seat.x + 0.5;
    const sy = seat.y + 0.5;
    if (dist(p, { x: sx, y: sy }) > 3) {
      client.send({ t: 'correct', x: p.x, y: p.y });
      return;
    }
    p.x = sx;
    p.y = sy;
    p.dir = 'up';
    p.moving = false;
    p.sitting = deskId;
    this.broadcast({ t: 'patch', id: p.id, patch: { sitting: deskId } }, p.id);
  }

  /* ───────────── chat ───────────── */

  /** Sends the saved message to everyone; the sender's copy also carries the `cid` they gave it. */
  private broadcastChat(msg: ChatMessage, senderUid?: string, cid?: string) {
    const plain = JSON.stringify({ t: 'chat', msg } satisfies ServerMsg);
    const mine = cid && senderUid ? JSON.stringify({ t: 'chat', msg: { ...msg, cid } } satisfies ServerMsg) : plain;
    for (const c of this.clients.values()) c.transport.send(c.uid === senderUid ? mine : plain);
  }

  private async onChat(ctx: Ctx, client: Client, p: PlayerState, m: Extract<ClientMsg, { t: 'chat' }>) {
    const key = m.cid ? `${client.uid}:${m.cid}` : '';
    const remembered = key ? this.cidIds.get(key) : undefined;
    const earlier = remembered && Date.now() - remembered.at <= CID_TTL_MS ? remembered.id : undefined;
    // A retry of a send that was in fact saved: confirm it again instead of saving a second copy.
    if (earlier) {
      let known: StoredMessage | null = null;
      try {
        known = await this.getMessage(earlier);
      } catch (e) {
        log.error('looking up an earlier send failed', { err: String(e) });
        return client.send({ t: 'error', code: 'not_saved', message: 'Your message wasn’t saved. Try sending it again.', cid: m.cid });
      }
      if (ctx.cancelled) return;
      if (known) {
        // Saved, but everyone else may never have been told (the first attempt ran out of time): tell them now. A message that is
        // older than the recent ones was told long ago, and a deleted one is not shown again: those only confirm to the sender.
        const sr = known.session ? this.getSessionRing(known.session) : undefined;
        const inRing = sr ? sr.messages.some((x) => x.id === earlier) : false;
        const recent = !sr || sr.messages.length < RING_MAX || compareMessages(known, sr.messages[0]) >= 0;
        if (!inRing && recent && !known.deleted) {
          if (known.session) this.pushSessionRing(known.session, known);
          this.broadcastChat(known, client.uid, m.cid);
        } else {
          client.send({ t: 'chat', msg: { ...known, cid: m.cid } });
        }
        return;
      }
    }

    // A message in a worktree tab goes to that tab's own session, in the zone the tab belongs to.
    const thread = m.thread ? this.threads.get(m.thread) : undefined;
    if (m.thread && (!thread || thread.state === 'archived')) {
      return client.send({ t: 'error', code: 'unknown_thread', message: 'That worktree is no longer open.', cid: m.cid });
    }
    const room = thread ? thread.zone : (m.room ?? (zoneAt(this.map, p.x, p.y)?.id ?? 'lobby'));
    if (!this.map.zones.some((z) => z.id === room) && room !== 'lobby') {
      return client.send({ t: 'error', code: 'unknown_room', message: 'Unknown room.', cid: m.cid });
    }

    let active = thread ? this.sessions.get(thread.session) : this.getActiveSession(room);
    if (!active) {
      if (this.hasArchivedSession(room)) {
        return client.send({ t: 'error', code: 'no_session', message: 'This room’s chat is closed. The owner can start a new session.', cid: m.cid });
      }
      const now = Date.now();
      active = {
        id: messageId(this.nextAt()),
        room,
        state: 'active',
        createdAt: now,
        createdBy: client.uid,
      };
      try {
        await withTimeout(this.store.putSession(OFFICE_ID, active), timing.storeMs);
        this.sessions.set(active.id, active);
        this.broadcast({ t: 'session.update', session: { ...active } });
      } catch (e) {
        log.error('creating session failed', { err: String(e) });
        return client.send({ t: 'error', code: 'not_saved', message: 'Couldn’t start a session. Try again.', cid: m.cid });
      }
    }

    const at = this.nextAt();
    const id = earlier ?? messageId(at);
    if (key) {
      this.cidIds.set(key, { id, at: Date.now() });
      if (this.cidIds.size > 500) this.cidIds.delete(this.cidIds.keys().next().value as string);
    }
    // Agents are asked from a tab only by the person whose tab it is (and not yet from a tab: that arrives with the agent turns).
    const msg: ChatMessage = {
      id, kind: 'human', from: p.id, fromName: p.name, look: p.look, text: m.text, at,
      mentions: thread ? [] : extractMentions(m.text), room, session: active.id,
      ...(thread ? { thread: thread.id } : {}),
    };
    let saved: boolean;
    try {
      saved = await withTimeout(this.store.insertMessage(OFFICE_ID, msg), timing.storeMs);
    } catch (e) {
      log.error('saving a chat message failed', { err: String(e), uid: client.uid });
      client.send({ t: 'error', code: 'not_saved', message: 'Your message wasn’t saved. Try sending it again.', cid: m.cid });
      return;
    }
    // Too late: the person has been told it wasn't saved. If it was, their retry finds it by its id and tells everyone then.
    if (ctx.cancelled) return;
    if (!saved) return client.send({ t: 'error', code: 'not_saved', message: 'Your message wasn’t saved. Try sending it again.', cid: m.cid });
    this.pushSessionRing(active.id, msg);
    this.broadcastChat(msg, client.uid, m.cid);
  }

  private async onHistory(client: Client, m: Extract<ClientMsg, { t: 'history.get' }>) {
    const room = m.room ?? 'lobby';
    let sessionId = m.session;
    if (!sessionId) {
      const active = this.getActiveSession(room);
      sessionId = active?.id;
      if (!sessionId && room === 'lobby' && this.sessions.has('legacy')) {
        sessionId = 'legacy';
      }
    }
    try {
      const page = await withTimeout(this.store.listMessages(OFFICE_ID, { session: sessionId ?? null, before: m.before, limit: m.limit ?? DEFAULT_PAGE }), timing.storeMs);
      client.send({ t: 'history.page', reqId: m.reqId, room, session: sessionId ?? '', messages: page.messages, hasMore: page.hasMore });
    } catch (e) {
      log.error('loading chat history failed', { err: String(e) });
      client.send({ t: 'history.page', reqId: m.reqId, room, session: sessionId ?? '', messages: [], hasMore: true, error: 'unavailable' });
    }
  }

  private async onDelete(ctx: Ctx, client: Client, id: string) {
    let msg: StoredMessage | null;
    try {
      msg = await this.getMessage(id);
    } catch {
      return client.send({ t: 'error', code: 'unavailable', message: 'Couldn’t reach the chat history. Try again.' });
    }
    if (ctx.cancelled) return;
    if (!msg || msg.deleted) return client.send({ t: 'error', code: 'not_found', message: 'That message is already gone.' });
    const admin = client.role === 'owner' || client.role === 'admin';
    // The person whose computer ran an agent can take its answer back, for a minute after it was posted (the "Undo").
    const undo = msg.kind === 'agent' && msg.via === client.uid && Date.now() - msg.at <= UNDO_MS;
    if (!admin && !undo) return client.send({ t: 'error', code: 'forbidden', message: 'Only the team’s admins can delete messages.' });
    try {
      const gone = await withTimeout(this.store.markMessageDeleted(OFFICE_ID, id, client.uid), timing.storeMs);
      if (ctx.cancelled) return;
      if (gone) {
        const sessionKey = gone.session ?? (this.sessions.has('legacy') ? 'legacy' : undefined);
        if (sessionKey) this.pushSessionRing(sessionKey, gone);
      }
    } catch (e) {
      log.error('deleting a chat message failed', { err: String(e) });
      return client.send({ t: 'error', code: 'not_saved', message: 'The message wasn’t deleted. Try again.' });
    }
    log.info('message deleted', { by: client.uid, id, author: msg.from });
    this.broadcast({ t: 'chat.deleted', id });
  }

  /* ───────────── worktree tabs ───────────── */

  private liveThreads() {
    return [...this.threads.values()].filter((t) => isLive(t.state));
  }

  private async onThreadNew(client: Client, p: PlayerState, m: Extract<ClientMsg, { t: 'thread.new' }>) {
    const refuse = (code: string, message: string) => client.send({ t: 'error', code, message, reqId: m.reqId });
    const member = this.members.get(client.uid);
    if (!member) return refuse('not_a_member', 'You’re no longer on this team.');
    // A tab belongs to the zone of the person who makes it: nobody opens one in someone else's zone or in the lobby.
    if (m.room !== zoneIdOf(client.uid) || !this.map.zones.some((z) => z.id === m.room)) {
      return refuse('forbidden', 'A worktree can only be opened in your own zone.');
    }
    const live = this.liveThreads();
    if (live.length >= THREAD_LIMITS.total) return refuse('thread_limit', 'This office has too many open worktrees.');
    const mine = live.filter((t) => t.owner === client.uid);
    if (mine.length >= THREAD_LIMITS.perOwner) return refuse('thread_limit', 'You have too many open worktrees. Archive one first.');
    if (mine.some((t) => t.branch === m.branch)) return refuse('branch_exists', 'You already have a worktree on that branch.');
    const at = this.nextAt();
    const id = `w-${at.toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')}`;
    const thread: WorkThread = {
      id, zone: m.room, owner: client.uid, ownerName: member.name || p.name, name: m.name, branch: m.branch, base: m.base,
      state: 'creating', step: 'Getting ready', ticket: null, docs: [], session: `${id}-s`, createdAt: at, updatedAt: at,
    };
    try {
      await withTimeout(this.store.putThread(OFFICE_ID, thread), timing.storeMs);
    } catch (e) {
      log.error('saving a worktree failed', { err: String(e) });
      return refuse('not_saved', 'The worktree wasn’t saved. Try again.');
    }
    this.threads.set(id, thread);
    this.sessions.set(thread.session, this.sessionOf(thread));
    client.send({ t: 'thread.update', thread: { ...thread }, reqId: m.reqId });
    this.broadcast({ t: 'thread.update', thread: { ...thread } }, client.uid);
  }

  private saveThread(t: WorkThread) {
    t.updatedAt = Math.max(Date.now(), t.updatedAt + 1);
    void this.store.putThread(OFFICE_ID, t).catch((e) => log.error('saving a worktree failed', { err: String(e), id: t.id }));
    this.broadcast({ t: 'thread.update', thread: { ...t } });
  }

  private onThreadPatch(client: Client, id: string, patch: import('./shared/workspace/types.ts').ThreadPatch) {
    const t = this.threads.get(id);
    if (!t) return client.send({ t: 'error', code: 'unknown_thread', message: 'That worktree is no longer open.' });
    if (t.owner !== client.uid) {
      return client.send({ t: 'error', code: 'forbidden', message: `Only ${t.ownerName} can change this worktree.` });
    }
    if (patch.state && !canTransition(t.state, patch.state)) {
      return client.send({ t: 'error', code: 'bad_state', message: 'That worktree can’t go there from where it is.' });
    }
    if (patch.state === 'creating' && t.state === 'failed' && this.liveThreads().length > THREAD_LIMITS.total) {
      return client.send({ t: 'error', code: 'thread_limit', message: 'This office has too many open worktrees.' });
    }
    if (patch.state) t.state = patch.state;
    if (patch.name !== undefined) t.name = patch.name;
    if (patch.ticket !== undefined) t.ticket = patch.ticket;
    if (patch.docs !== undefined) t.docs = patch.docs;
    if (patch.purpose !== undefined) t.purpose = patch.purpose;
    if (patch.step !== undefined) {
      if (patch.step === null) delete t.step;
      else t.step = patch.step;
    }
    if (patch.error !== undefined) {
      if (patch.error === null) delete t.error;
      else t.error = patch.error;
    } else if (patch.state && patch.state !== 'failed') {
      delete t.error;
    }
    if (t.state === 'failed' && !t.error) t.error = { code: 'unknown', message: THREAD_ERROR_TEXT.unknown };
    this.saveThread(t);
  }

  private onThreadArchive(client: Client, id: string) {
    const t = this.threads.get(id);
    if (!t) return client.send({ t: 'error', code: 'unknown_thread', message: 'That worktree is no longer open.' });
    // The person whose tab it is, or an admin (to tidy up after someone who has left).
    if (t.owner !== client.uid && client.role !== 'owner' && client.role !== 'admin') {
      return client.send({ t: 'error', code: 'forbidden', message: `Only ${t.ownerName} can archive this worktree.` });
    }
    if (t.state === 'archived') return;
    t.state = 'archived';
    delete t.step;
    this.saveThread(t);
  }

  /** The owner's agent speaks in the tab (the project manager's question, a result), saved like any message, with its card. */
  private async onThreadSay(ctx: Ctx, client: Client, p: PlayerState, m: Extract<ClientMsg, { t: 'thread.say' }>) {
    const refuse = (code: string, message: string) => client.send({ t: 'error', code, message, cid: m.cid });
    const t = this.threads.get(m.thread);
    if (!t || t.state === 'archived') return refuse('unknown_thread', 'That worktree is no longer open.');
    if (t.owner !== client.uid) return refuse('forbidden', `Only ${t.ownerName} can ask agents in this worktree.`);
    // Cleaned and scrubbed like an agent's answer in the room: what the model wrote is not trusted.
    const clean = cleanAgentText(m.text);
    let text = clean === null ? null : scrubSecrets(clean).text;
    if (text !== null && codePointLength(text) > LIMITS.agentText) text = null;
    if (text === null) return refuse('invalid', 'That message can’t be posted.');
    const at = this.nextAt();
    const msg: ChatMessage = {
      id: messageId(at), kind: 'agent', from: `agent:${m.agent.handle}`, fromName: m.agent.name, look: m.agent.look, text, at, mentions: [],
      via: client.uid, viaName: p.name, room: t.zone, session: t.session, thread: t.id, ...(m.ui ? { ui: m.ui } : {}),
    };
    let saved: boolean;
    try {
      saved = await withTimeout(this.store.insertMessage(OFFICE_ID, msg), timing.storeMs);
    } catch (e) {
      log.error('saving a worktree message failed', { err: String(e) });
      return refuse('not_saved', 'The message wasn’t saved. Try again.');
    }
    if (ctx.cancelled) return;
    if (!saved) return refuse('not_saved', 'The message wasn’t saved. Try again.');
    this.pushSessionRing(t.session, msg);
    this.broadcastChat(msg, client.uid, m.cid);
  }

  /** The owner answers a question card or decides a plan card; everyone sees which option was taken. */
  private async onCard(ctx: Ctx, client: Client, m: Extract<ClientMsg, { t: 'card.answer' | 'card.decide' }>) {
    const refuse = (code: string, message: string) => client.send({ t: 'error', code, message });
    // A decision without a worktree tab is on a proposal card in a room.
    if (m.t === 'card.decide' && m.thread === undefined) return this.onProposal(ctx, client, m);
    if (!m.thread) return refuse('bad_message', 'That answer is not for a card in a worktree tab.');
    const t = this.threads.get(m.thread);
    if (!t || t.state === 'archived') return refuse('unknown_thread', 'That worktree is no longer open.');
    if (t.owner !== client.uid) return refuse('forbidden', `Only ${t.ownerName} can answer here.`);
    let stored: StoredMessage | null;
    try {
      stored = await this.getMessage(m.message);
    } catch {
      return refuse('unavailable', 'Couldn’t reach the chat history. Try again.');
    }
    if (ctx.cancelled) return;
    const card = stored?.ui;
    if (!stored || stored.deleted || stored.thread !== t.id || !card) return refuse('not_found', 'That question is no longer there.');
    let next: ChatCard;
    if (m.t === 'card.answer') {
      if (card.kind !== 'ask') return refuse('not_found', 'That isn’t a question.');
      if (card.answered) return refuse('already_answered', 'That question has already been answered.');
      const known = new Set(card.options.map((o) => o.id));
      // Nothing picked means the owner answered in words.
      const okPick = m.picked.length === 0 || (card.mode === 'choice' ? m.picked.length === 1 : card.mode === 'multi');
      if (!okPick || !m.picked.every((id) => known.has(id))) return refuse('bad_answer', 'That isn’t one of the options.');
      next = { ...card, answered: m.picked };
    } else {
      if (card.kind !== 'plan') return refuse('not_found', 'That isn’t a plan.');
      if (card.decided) return refuse('already_answered', 'That plan has already been decided.');
      const known = new Set(card.plan.agents.map((a) => a.handle));
      if (!m.chosen.every((h) => known.has(h)) || (m.decision === 'proceeded' && m.chosen.length === 0)) {
        return refuse('bad_answer', 'Pick at least one of the recommended agents.');
      }
      next = { ...card, decided: m.decision, chosen: m.decision === 'proceeded' ? m.chosen : [] };
    }
    const updated: StoredMessage = { ...stored, ui: next };
    try {
      await withTimeout(this.store.appendMessage(OFFICE_ID, updated), timing.storeMs);
    } catch (e) {
      log.error('saving a card answer failed', { err: String(e) });
      return refuse('not_saved', 'The answer wasn’t saved. Try again.');
    }
    this.pushSessionRing(t.session, updated);
    this.broadcast({ t: 'card', id: updated.id, thread: t.id, ui: next });
  }

  /** Tells everyone connected that the board or the docs changed (their pages read them again). */
  broadcastSync(kind: 'board' | 'pages' | 'pipeline', ids: string[]) {
    this.broadcast({ t: 'sync', kind, ids: ids.slice(0, 50) });
  }

  /* ───────────── sessions ───────────── */

  private async onSessionNew(ctx: Ctx, client: Client, room: string, reqId: string) {
    if (!this.mayManage(client.uid, client.role, room)) {
      return client.send({ t: 'error', code: 'forbidden', message: 'Only the founder in the shared rooms, or the owner of a zone, can start a new session.', reqId });
    }
    if (!this.map.zones.some((z) => z.id === room) && room !== 'lobby') {
      return client.send({ t: 'error', code: 'unknown_room', message: 'Unknown room.', reqId });
    }
    const active = this.getActiveSession(room);
    const now = Date.now();
    if (active) {
      active.state = 'archived';
      active.archivedAt = now;
      try {
        await withTimeout(this.store.putSession(OFFICE_ID, active), timing.storeMs);
      } catch (e) {
        log.error('archiving session failed', { err: String(e) });
        return client.send({ t: 'error', code: 'not_saved', message: 'Couldn’t archive session. Try again.', reqId });
      }
      if (ctx.cancelled) return;
      this.broadcast({ t: 'session.update', session: { ...active } });
    }
    const newSession: SessionInfo = {
      id: messageId(this.nextAt()),
      room,
      state: 'active',
      createdAt: now,
      createdBy: client.uid,
    };
    try {
      await withTimeout(this.store.putSession(OFFICE_ID, newSession), timing.storeMs);
    } catch (e) {
      log.error('creating new session failed', { err: String(e) });
      return client.send({ t: 'error', code: 'not_saved', message: 'Couldn’t create session. Try again.', reqId });
    }
    if (ctx.cancelled) return;
    this.sessions.set(newSession.id, newSession);
    this.sessionRings.set(newSession.id, { messages: [], olderThanRing: false });
    this.broadcast({ t: 'session.update', session: { ...newSession } });
  }

  private async onSessionArchive(ctx: Ctx, client: Client, room: string, reqId: string) {
    if (!this.mayManage(client.uid, client.role, room)) {
      return client.send({ t: 'error', code: 'forbidden', message: 'Only the founder in the shared rooms, or the owner of a zone, can archive sessions.', reqId });
    }
    if (!this.map.zones.some((z) => z.id === room) && room !== 'lobby') {
      return client.send({ t: 'error', code: 'unknown_room', message: 'Unknown room.', reqId });
    }
    const active = this.getActiveSession(room);
    if (!active) {
      return client.send({ t: 'error', code: 'not_found', message: 'No active session in this room.', reqId });
    }
    active.state = 'archived';
    active.archivedAt = Date.now();
    try {
      await withTimeout(this.store.putSession(OFFICE_ID, active), timing.storeMs);
    } catch (e) {
      log.error('archiving session failed', { err: String(e) });
      return client.send({ t: 'error', code: 'not_saved', message: 'Couldn’t archive session. Try again.', reqId });
    }
    if (ctx.cancelled) return;
    this.broadcast({ t: 'session.update', session: { ...active } });
  }

  private async onSessionDelete(ctx: Ctx, client: Client, sessionId: string, reqId: string) {
    const target = this.sessions.get(sessionId);
    if (!target) {
      return client.send({ t: 'error', code: 'not_found', message: 'Session not found.', reqId });
    }
    const room = target.room;
    if (!this.mayManage(client.uid, client.role, room)) {
      return client.send({ t: 'error', code: 'forbidden', message: 'Only the founder in the shared rooms, or the owner of a zone, can delete sessions.', reqId });
    }
    try {
      await withTimeout(this.store.deleteSession(OFFICE_ID, sessionId), timing.storeMs);
    } catch (e) {
      log.error('deleting session failed', { err: String(e) });
      return client.send({ t: 'error', code: 'not_saved', message: 'Couldn’t delete session. Try again.', reqId });
    }
    if (ctx.cancelled) return;
    this.sessions.delete(sessionId);
    this.sessionRings.delete(sessionId);
    const droppedRuns = this.runs.dropSession(sessionId);
    for (const r of droppedRuns) {
      r.server?.abort();
      this.broadcastStatus(r, 'failed', 'session_deleted');
    }
    this.broadcast({ t: 'session.removed', id: sessionId, room });
  }

  /* ───────────── agents ───────────── */

  /** Tells everyone about a run. The person who started it also gets the request id, which nobody else needs. */
  private broadcastStatus(run: Run, state?: AgentStatus['state'], reason?: string) {
    const others = JSON.stringify({ t: 'agent.status', status: this.runs.status(run, state, reason) } satisfies ServerMsg);
    const owner = JSON.stringify({ t: 'agent.status', status: this.runs.statusFor(run, state, reason) } satisfies ServerMsg);
    for (const c of this.clients.values()) c.transport.send(c.uid === run.uid ? owner : others);
  }

  /** Ends a run: everyone is told, and that person's next queued run starts. Ending a run that has already ended does nothing. */
  private finishRun(run: Run, state: AgentStatus['state'], reason?: string) {
    const changed = this.runs.remove(run);
    if (!changed) return;
    // A server-run agent that is still on the phone to the agent service is hung up on.
    if (state !== 'done') run.server?.abort();
    this.broadcastStatus({ ...run, offlineSince: null }, state, reason);
    for (const r of changed) this.broadcastStatus(r);
  }

  /** Saves a short note in the conversation, so that history shows why an agent never answered. */
  private postFailureLine(run: RunLike, text: string) {
    this.enqueue(
      async (ctx) => {
        // Not if the run has since been taken over again, or its answer arrived after all.
        if (this.runs.get(run.uid, run.reqId)) return;
        try {
          const replied = await this.getMessage(agentReplyId(run.replyTo, run.agent.handle));
          if (replied && !replied.deleted) return;
        } catch {
          // Go on: a note that wasn't needed is better than no note when one was.
        }
        if (ctx.cancelled) return;
        if (!this.failureLines.take(run.uid, 1, FAILURE_LINES_PER_HOUR)) return;
        const msg: ChatMessage = {
          id: agentFailureId(run.replyTo, run.agent.handle),
          kind: 'system',
          from: 'system',
          fromName: 'Office',
          text,
          at: this.nextAt(),
          mentions: [],
          replyTo: run.replyTo,
          via: run.uid,
          viaName: run.byName,
          room: run.room,
          session: run.session,
        };
        try {
          await withTimeout(this.store.appendMessage(OFFICE_ID, msg), timing.storeMs);
        } catch (e) {
          log.error('saving a failure note failed', { err: String(e) });
          return;
        }
        if (ctx.cancelled) return;
        if (run.session) this.pushSessionRing(run.session, msg);
        this.broadcastChat(msg);
      },
      { uid: run.uid },
    );
  }

  private failureText(run: RunLike, reason: string) {
    const agent = run.agent.name;
    switch (reason) {
      case 'too_long':
        return `${agent} ran out of time answering ${run.byName}.`;
      case 'offline':
        return `${run.byName}’s computer went offline before ${agent} could answer.`;
      case 'quota':
        return `${agent} has answered a lot lately, so this answer was not posted.`;
      case 'not_saved':
        return `${agent}’s answer couldn’t be saved.`;
      case 'ai_budget':
        return `${agent} can’t answer: the demo’s AI budget for today is used up. It refills after the nightly reset.`;
      case 'ai_unavailable':
        return `${agent} couldn’t reach Gemini just now. Try again in a moment.`;
      case 'ai_invalid':
        return `${agent} couldn’t use that request.`;
      case 'ai_error':
        return `${agent} ran into a problem and couldn’t answer. Try again.`;
      case 'ai_empty':
        return `${agent} had nothing to say.`;
      default:
        return `${agent}’s answer couldn’t be posted (it was empty or too long).`;
    }
  }

  /** Who runs a room: the founder in the shared rooms (lobby, Plan Room, Review Room), a member in their own zone. */
  private mayManage(uid: string, role: WorkspaceRole, room: string): boolean {
    if (room === 'lobby' || room === 'plan' || room === 'review') return role === 'owner';
    return room === zoneIdOf(uid);
  }

  /** Who may ask an agent in a room: the founder in the Plan and Review Rooms, anyone in the lobby, the member in their own zone. */
  private mayAskAgent(uid: string, role: WorkspaceRole, room: string): boolean {
    if (room === 'plan' || room === 'review') return role === 'owner';
    if (room === 'lobby') return true;
    return room === zoneIdOf(uid);
  }

  /** Is `replyTo` a mention of `handle` that this person sent, recent enough, and in a room they run? Returns why not, or null. */
  private async checkMention(uid: string, role: WorkspaceRole, replyTo: string, handle: string, maxAge: number): Promise<{ ok: true; mention: ChatMessage } | { ok: false; code: string; message: string }> {
    let mention: ChatMessage | null;
    try {
      mention = await this.getMessage(replyTo);
    } catch {
      return { ok: false, code: 'unavailable', message: 'Couldn’t reach the chat history. Try again.' };
    }
    if (!mention || mention.deleted || mention.kind !== 'human' || mention.from !== uid || !(mention.mentions ?? []).includes(handle)) {
      return { ok: false, code: 'not_allowed', message: 'That message doesn’t ask this agent anything.' };
    }
    if (Date.now() - mention.at > maxAge) return { ok: false, code: 'not_allowed', message: 'That question is too old to answer now.' };
    const room = mention.room ?? 'lobby';
    if (!this.mayAskAgent(uid, role, room)) {
      return { ok: false, code: 'not_allowed', message: room === 'plan' || room === 'review' ? 'Only the founder asks agents in this room.' : 'Only the owner of this zone asks agents here.' };
    }
    const active = this.getActiveSession(room);
    if (!mention.session || !active || active.id !== mention.session) {
      return { ok: false, code: 'gone', message: 'The session for that question has ended or is no longer active.' };
    }
    return { ok: true, mention };
  }

  /** Is `client` still the person's connection, and are they still on the team? (They may have left while a job was waiting.) */
  private current(client: Client) {
    return this.clients.get(client.uid) === client && this.members.has(client.uid);
  }

  private async onAgentStart(ctx: Ctx, client: Client, p: PlayerState, m: Extract<ClientMsg, { t: 'agent.start' }>) {
    const refuse = (code: string, message: string) => client.send({ t: 'error', code, message, reqId: m.reqId });
    const send = (status: AgentStatus['state'], reason?: string) =>
      client.send({ t: 'agent.status', status: { runId: agentReplyId(m.replyTo, m.agent.handle), reqId: m.reqId, agent: m.agent, by: client.uid, byName: p.name, replyTo: m.replyTo, state: status, ...(reason ? { reason } : {}) } });

    // 1. A run this person already has: take it over for this connection (a reconnect, or a new window) and say how it stands.
    const existing = this.runs.get(client.uid, m.reqId);
    if (existing) {
      if (!this.current(client)) return;
      // A server-run agent keeps going whoever is connected: the person only gets told how it stands.
      if (!existing.server) {
        existing.owner = client;
        existing.offlineSince = null;
      }
      this.broadcastStatus(existing);
      return;
    }
    // 2. Already answered (or already failed): say so. Never "thinking" for a run that is over.
    try {
      const answered = await this.getMessage(agentReplyId(m.replyTo, m.agent.handle));
      if (answered) {
        if (ctx.cancelled || !this.current(client)) return;
        // Answered, and then taken back: only the asker's own "Run again" may ask again. An admin's delete is final.
        if (answered.deleted && m.mode === 'rerun' && answered.deletedBy !== client.uid) return refuse('not_allowed', 'An admin removed that answer, so it can’t be asked again.');
        if (!answered.deleted || m.mode !== 'rerun') return send('done');
      }
      if (m.mode !== 'rerun') {
        const failed = await this.getMessage(agentFailureId(m.replyTo, m.agent.handle));
        if (failed && !failed.deleted) {
          if (ctx.cancelled || !this.current(client)) return;
          return send('failed', 'earlier_failure');
        }
      }
    } catch {
      return refuse('unavailable', 'Couldn’t reach the chat history. Try again.');
    }
    // 3. It must be a recent mention of this agent that this person sent.
    const check = await this.checkMention(client.uid, client.role, m.replyTo, m.agent.handle, START_MAX_AGE[m.mode]);
    // The person may have left, or been removed, while these were being looked up: then there is nothing to start.
    if (ctx.cancelled || !this.current(client)) return;
    if (!check.ok) return refuse(check.code, check.message);
    // The agent runs on the server (Gemini through the agent service): this person's app has nothing to run.
    if (this.ai) {
      if (!ctx.cancelled && this.current(client)) {
        const started = await this.startAiRun({
          uid: client.uid, byName: p.name, handle: m.agent.handle, kind: runKindFor(m.agent.handle), room: check.mention.room ?? 'lobby',
          session: check.mention.session ?? '', replyTo: m.replyTo, question: check.mention.text, reqId: m.reqId,
        });
        if (!started.ok) refuse(started.code, started.message);
      }
      return;
    }
    // 4. Limits.
    if (this.runs.get(client.uid, m.reqId)) return;
    if (this.runs.count(client.uid) >= MAX_RUNS_PER_USER) return refuse('too_many_runs', 'You already have agents working on three answers. Wait for one to finish.');
    if (this.runs.size >= MAX_RUNS_PER_ROOM) return refuse('busy', 'Agents are busy answering other people. Try again in a minute.');

    const now = Date.now();
    const changed = this.runs.add({
      runId: messageId(now),
      uid: client.uid,
      byName: p.name,
      reqId: m.reqId,
      replyTo: m.replyTo,
      agent: m.agent,
      startedAt: now,
      owner: client,
      offlineSince: null,
      failures: 0,
      room: check.mention.room ?? 'lobby',
      session: check.mention.session,
    });
    for (const r of changed) this.broadcastStatus(r);
  }

  private async onAgentReply(ctx: Ctx, client: Client, p: PlayerState, m: Extract<ClientMsg, { t: 'agent.reply' }>) {
    const refuse = (code: string, message: string) => client.send({ t: 'error', code, message, reqId: m.reqId });
    let run = this.runs.get(client.uid, m.reqId);
    if (run && (run.replyTo !== m.replyTo || run.agent.handle !== m.agent.handle)) return refuse('not_allowed', 'That answer belongs to a different question.');
    const replyId = agentReplyId(m.replyTo, m.agent.handle);
    let replyRoom = run?.room ?? 'lobby';
    let replySession = run?.session;
    if (!run) {
      // A late answer (the run expired while the app was away, or the server restarted): fine as long as the question is a recent
      // one of theirs that nobody has answered yet. A question that has an answer, even a deleted one, gets no second.
      const check = await this.checkMention(client.uid, client.role, m.replyTo, m.agent.handle, START_MAX_AGE.resume);
      if (!check.ok) return refuse(check.code, check.message);
      replyRoom = check.mention.room ?? 'lobby';
      replySession = check.mention.session;
      try {
        if (await this.getMessage(replyId)) return refuse('not_allowed', 'That question has already been answered.');
      } catch {
        return refuse('unavailable', 'Couldn’t reach the chat history. Try again.');
      }
      if (ctx.cancelled || !this.current(client)) return;
    } else {
      // The session may have been archived or deleted while the run was in flight.
      const active = this.getActiveSession(replyRoom);
      if (!replySession || !active || active.id !== replySession) {
        this.runs.remove(run);
        return refuse('gone', 'The session for that question has ended or is no longer active.');
      }
    }
    const asked: RunLike = run ?? { uid: client.uid, byName: p.name, agent: m.agent, replyTo: m.replyTo, reqId: m.reqId, room: replyRoom, session: replySession };

    // Cleaned, then scrubbed; scrubbing can make the text longer, so the limit is checked once more.
    const clean = cleanAgentText(m.text);
    let text = clean === null ? null : scrubSecrets(clean).text;
    if (text !== null && codePointLength(text) > LIMITS.agentText) text = null;
    if (text === null) return this.rejectReply(client, run, asked, 'invalid');
    const bytes = Buffer.byteLength(text);
    if (!this.replyBytes.fits(client.uid, bytes, REPLY_BYTES_PER_HOUR)) return this.rejectReply(client, run, asked, 'quota');

    const msg: ChatMessage = {
      id: replyId,
      kind: 'agent',
      from: `agent:${m.agent.handle}`,
      fromName: m.agent.name,
      look: m.agent.look,
      text,
      at: this.nextAt(),
      mentions: [],
      replyTo: m.replyTo,
      runId: run?.runId,
      via: client.uid,
      viaName: p.name,
      room: replyRoom,
      session: replySession,
    };
    let saved: boolean;
    try {
      // Only the person who took an answer back may replace it (their "Run again"); never someone else's deletion.
      saved = await withTimeout(this.store.insertMessageOnce(OFFICE_ID, msg, { reviveBy: client.uid }), timing.storeMs);
    } catch (e) {
      log.error('saving an agent reply failed', { err: String(e) });
      if (run && ++run.failures < 2) return refuse('not_saved', 'The answer wasn’t saved. It will be tried again.');
      return this.rejectReply(client, run, asked, 'not_saved');
    }
    // Too late: the app has been told it wasn't saved and will send it again, which finds it saved (below).
    if (ctx.cancelled) return;
    if (saved) {
      this.replyBytes.take(client.uid, bytes, REPLY_BYTES_PER_HOUR);
      if (replySession) this.pushSessionRing(replySession, msg);
      this.broadcastChat(msg);
    } else {
      // Already saved: an earlier attempt that ran out of time, or an answer someone else's run had given. Make sure everyone has it.
      try {
        const stored = await this.getMessage(replyId);
        const sr = replySession ? this.getSessionRing(replySession) : undefined;
        if (!ctx.cancelled && stored && !stored.deleted && (!sr || !sr.messages.some((x) => x.id === replyId))) {
          if (replySession) this.pushSessionRing(replySession, stored);
          this.broadcastChat(stored);
        }
      } catch {
        // The answer is saved; it appears for everyone the next time the history is loaded.
      }
    }
    run = this.runs.get(client.uid, m.reqId);
    if (run) this.finishRun(run, 'done');
    else client.send({ t: 'agent.status', status: { runId: replyId, reqId: m.reqId, agent: m.agent, by: client.uid, byName: p.name, replyTo: m.replyTo, state: 'done', room: replyRoom, session: replySession } });
  }

  /** An answer that cannot be posted ends its run with a note in the conversation (and the person who sent it is told why). */
  private rejectReply(client: Client, run: Run | undefined, asked: RunLike, reason: string) {
    if (run) this.finishRun(run, 'failed', reason);
    else client.send({ t: 'error', code: reason === 'invalid' ? 'bad_request' : reason, message: this.failureText(asked, reason), reqId: asked.reqId });
    this.postFailureLine(asked, this.failureText(asked, reason));
  }

  /** Gives up on runs that took too long or whose app never came back. */
  private sweep() {
    for (const { run, reason } of this.runs.expired(Date.now())) {
      this.finishRun(run, 'expired', reason);
      this.postFailureLine(run, this.failureText(run, reason));
    }
  }


  /* ───────────── agents that run on the server ───────────── */

  /** Gives this room its AI side. Without one, agents still run on people's own computers as before. */
  attachAi(ai: AiServices | null) {
    this.ai = ai;
  }

  /** Gives this room the delivery pipeline: what a pipeline agent drafts is kept there, and accepting a card accepts it. */
  attachPipeline(pipeline: Pipeline | null) {
    this.pipeline = pipeline;
  }

  /** The room's active conversation, started now when there is none (and no earlier one was closed: then it stays closed). */
  async openSession(room: string, createdBy: string): Promise<SessionInfo | null> {
    const active = this.getActiveSession(room);
    if (active) return active;
    if (this.hasArchivedSession(room)) return null;
    const session: SessionInfo = { id: messageId(this.nextAt()), room, state: 'active', createdAt: Date.now(), createdBy };
    await withTimeout(this.store.putSession(OFFICE_ID, session), timing.storeMs);
    this.sessions.set(session.id, session);
    this.broadcast({ t: 'session.update', session: { ...session } });
    return session;
  }

  /** The newest messages of a session as a run's conversation: no tombstones, no empty lines, each line cut to size. */
  private async historyFor(sessionId: string): Promise<RunRequest['history']> {
    const ring = await this.ensureSessionRing(sessionId);
    return ring.messages
      .filter((m) => !m.deleted && m.text)
      .slice(-AI_LIMITS.history)
      .map((m) => ({ id: m.id, from: m.from, name: m.fromName, text: clampCodePoints(m.text, AI_LIMITS.historyLine), at: m.at, kind: m.kind ?? 'human' }));
  }

  /**
   * Starts an agent that runs on the server. It is counted against the person's runs and the demo's budget like any other, shown
   * to everyone as `thinking` (with what it is doing), and ends with its answer in the conversation.
   */
  async startAiRun(s: AiRunStart): Promise<AiRunResult> {
    const ai = this.ai;
    if (!ai) return { ok: false, code: 'unavailable', message: 'Agents that run on the server are not set up here.' };
    const def = ai.agents.get(s.handle);
    if (!def) return { ok: false, code: 'unknown_agent', message: `There is no agent called @${s.handle} here.` };
    if (!s.session || !this.sessions.has(s.session)) return { ok: false, code: 'gone', message: 'The session for that question has ended or is no longer active.' };
    const reqId = s.reqId ?? `srv-${randomPart()}${randomPart()}`;
    if (this.runs.get(s.uid, reqId)) return { ok: true, runId: this.runs.get(s.uid, reqId)!.runId };
    if (this.runs.count(s.uid) >= MAX_RUNS_PER_USER) return { ok: false, code: 'too_many_runs', message: 'You already have agents working on three answers. Wait for one to finish.' };
    if (this.runs.size >= MAX_RUNS_PER_ROOM) return { ok: false, code: 'busy', message: 'Agents are busy answering other people. Try again in a minute.' };
    const spent = ai.budget.take(s.uid);
    if (!spent.ok) {
      return {
        ok: false,
        code: 'budget',
        message: spent.reason === 'guest' ? 'You have used your AI runs for this hour. They come back soon, and the recorded demo shows the whole flow.' : 'The demo’s AI budget for today is used up. It refills after the nightly reset, and the recorded demo shows the whole flow.',
      };
    }
    const now = Date.now();
    const agent: AgentRef = { handle: def.handle, name: def.displayName, role: def.role, look: def.look };
    const ctrl = new AbortController();
    const changed = this.runs.add({
      runId: messageId(now), uid: s.uid, byName: s.byName, reqId, replyTo: s.replyTo, agent, startedAt: now,
      owner: SERVER_OWNER, offlineSince: null, failures: 0, room: s.room, session: s.session, server: ctrl,
    });
    for (const r of changed) this.broadcastStatus(r);
    const run = this.runs.get(s.uid, reqId)!;
    void this.driveAiRun(run, def, s);
    return { ok: true, runId: run.runId };
  }

  /** Asks the agent service and turns what comes back into the room's conversation. Never throws: every way it can end ends the run. */
  private async driveAiRun(run: Run, def: AgentDef, s: AiRunStart) {
    const ai = this.ai!;
    const ctrl = run.server!;
    const fail = (reason: string, refund: boolean) => {
      if (refund) ai.budget.refund(run.uid);
      if (!this.runs.get(run.uid, run.reqId)) return;
      this.finishRun(run, 'failed', reason);
      this.postFailureLine(run, this.failureText(run, reason));
    };
    try {
      const [context, history] = await Promise.all([ai.context(), this.historyFor(s.session)]);
      if (ctrl.signal.aborted) return;
      // A pipeline agent works on one ticket: the one a stage page named, or one the question names (`#12`).
      const named = s.ticket ?? (this.pipeline ? ticketNamed(s.question) : null);
      const held = this.pipeline && named !== null ? await this.pipeline.ticketContext(String(named)).catch(() => null) : null;
      const req: RunRequest = {
        runId: run.runId,
        kind: s.kind,
        agent: { handle: def.handle, displayName: def.displayName, role: def.role, persona: def.persona, skills: def.skills },
        asker: { uid: s.uid, name: s.byName },
        room: s.room,
        question: s.question,
        history,
        context,
        attachments: [],
        ...(held ? { ticket: held.ticket, artifacts: held.artifacts } : {}),
        webBase: ai.webBase,
      };
      let final: RunFinal | null = null;
      let problem: { code: string; message: string } | null = null;
      await ai.client.run(
        req,
        (ev) => {
          if (ev.event === 'status') {
            run.phase = ev.data.phase;
            this.broadcastStatus(run);
          } else if (ev.event === 'step') {
            run.step = ev.data.summary || ev.data.tool;
            this.broadcastStatus(run);
          } else if (ev.event === 'final') final = ev.data;
          else problem = ev.data;
        },
        ctrl.signal,
      );
      // Ended while it was away (the session was deleted, the person removed, the run expired): nothing to say any more.
      if (ctrl.signal.aborted || !this.runs.get(run.uid, run.reqId)) return;
      if (problem) {
        const code = (problem as { code: string }).code;
        log.warn('a server-run agent failed', { agent: def.handle, code });
        return fail(code === 'budget' ? 'ai_budget' : code === 'model_unavailable' ? 'ai_unavailable' : code === 'invalid' ? 'ai_invalid' : 'ai_error', code !== 'invalid');
      }
      if (!final) return fail('ai_error', true);
      const posted = await this.postAiReply(run, def, final, held?.ticket.id ?? null);
      if (!posted) return fail('not_saved', false);
      const live = this.runs.get(run.uid, run.reqId);
      if (live) this.finishRun(live, 'done');
    } catch (e) {
      if (ctrl.signal.aborted) return;
      log.error('a server-run agent crashed', { agent: def.handle, err: String(e) });
      fail('ai_error', true);
    }
  }

  /** Saves the agent's answer (once: its id is fixed by the question and the agent) and tells the room. */
  private postAiReply(run: Run, def: AgentDef, final: RunFinal, ticketId: string | null): Promise<boolean> {
    return new Promise((resolve) => {
      this.enqueue(
        async (ctx) => {
          if (!run.session || !this.sessions.has(run.session)) return resolve(false);
          // What a pipeline agent drafted is kept as drafts on the ticket, and offered in one card. The agent cannot name an id: the server does.
          let kept: Artifact[] = [];
          let note = '';
          if (final.artifacts?.length) {
            if (!this.pipeline || !ticketId) {
              note = '\n\n(I drafted something, but there is no ticket to keep it on. Start from the ticket on its stage page, or name it as #12.)';
            } else {
              const problems: string[] = [];
              for (const draft of final.artifacts) {
                try {
                  kept.push(await this.pipeline.submit(ticketId, { id: `agent:${def.handle}`, name: def.displayName, agent: true }, draft, run.runId));
                } catch (e) {
                  problems.push(e instanceof PipelineError ? e.message : 'One draft could not be kept.');
                }
              }
              if (problems.length) note = `\n\nNot kept: ${problems.join(' ')}`;
            }
          }
          const text = scrubSecrets(final.text + note).text;
          if (!text || codePointLength(text) > LIMITS.agentText) return resolve(false);
          // A proposal belongs in a room (a person can accept it here) and so does a plan card (a person reads it); the other cards are for worktree tabs.
          const card: ChatCard | undefined = kept.length
            ? {
                kind: 'proposal',
                id: 'pr-pending',
                title: kept.length === 1 ? `Review the ${kept[0].kind.replace('_', ' ')} ${def.displayName} drafted` : `Review what ${def.displayName} drafted`,
                items: kept.map((a, i) => ({ id: `item-${i + 1}`, type: 'artifact' as const, title: `${a.kind.replace('_', ' ')} v${a.version}: ${a.title}`.slice(0, 200), body: a.body.slice(0, 600), artifactId: a.id, artifactKind: a.kind })),
              }
            : final.cards.find((c) => c.kind === 'proposal' || c.kind === 'plan');
          let ui: ChatCard | undefined;
          if (card) {
            try {
              ui = { ...(JSON.parse(scrubSecrets(JSON.stringify(card)).text) as ChatCard), id: `pr-${randomPart()}${randomPart()}` } as ChatCard;
            } catch {
              ui = undefined;
            }
          }
          const citations = final.citations.map((c) => ({ ...c, title: scrubSecrets(c.title).text, ...(c.quote ? { quote: scrubSecrets(c.quote).text } : {}) }));
          const msg: ChatMessage = {
            id: agentReplyId(run.replyTo, def.handle),
            kind: 'agent',
            from: `agent:${def.handle}`,
            fromName: def.displayName,
            look: def.look,
            text,
            at: this.nextAt(),
            mentions: [],
            replyTo: run.replyTo,
            runId: run.runId,
            via: run.uid,
            viaName: run.byName,
            room: run.room,
            session: run.session,
            ...(citations.length ? { citations } : {}),
            ...(ui ? { ui } : {}),
          };
          let saved: boolean;
          try {
            saved = await withTimeout(this.store.insertMessageOnce(OFFICE_ID, msg, { reviveBy: run.uid }), timing.storeMs);
          } catch (e) {
            log.error('saving a server-run agent reply failed', { err: String(e) });
            return resolve(false);
          }
          if (ctx.cancelled) return resolve(false);
          if (saved) {
            this.pushSessionRing(run.session, msg);
            this.broadcastChat(msg);
          }
          // Not saved means this question already has this agent's answer: fine, the run is over.
          resolve(true);
        },
        { uid: run.uid, onBusy: () => resolve(false), onTimeout: () => resolve(false) },
      );
    });
  }

  /** A person accepts some (or none) of the items of a proposal: the server creates them as that person and shows what was made. */
  private async onProposal(ctx: Ctx, client: Client, m: Extract<ClientMsg, { t: 'card.decide' }>) {
    const refuse = (code: string, message: string) => client.send({ t: 'error', code, message });
    const ai = this.ai;
    if (!ai) return refuse('unavailable', 'Proposals are not available on this server.');
    let stored: StoredMessage | null;
    try {
      stored = await this.getMessage(m.message);
    } catch {
      return refuse('unavailable', 'Couldn’t reach the chat history. Try again.');
    }
    if (ctx.cancelled) return;
    const card = stored?.ui;
    if (!stored || stored.deleted || !card || card.kind !== 'proposal' || !stored.session) return refuse('not_found', 'That proposal is no longer there.');
    if (card.decided) return refuse('already_answered', 'That proposal has already been decided.');
    if (client.role !== 'owner' && client.role !== 'admin' && stored.via !== client.uid) return refuse('forbidden', 'Only the person who asked, or an admin, can decide this.');
    const known = new Set(card.items.map((i) => i.id));
    if (!m.chosen.every((id) => known.has(id)) || (m.decision === 'proceeded' && m.chosen.length === 0)) return refuse('bad_answer', 'Pick at least one of the proposed items.');
    const created: { item: string; ref: string }[] = [];
    const who = { uid: client.uid, name: this.members.get(client.uid)?.name ?? 'Guest', role: client.role };
    if (m.decision === 'proceeded') {
      for (const id of m.chosen) {
        const item = card.items.find((i) => i.id === id)!;
        try {
          // An artifact is not created, it is accepted: the pipeline binds the approval to its digest.
          if (item.type === 'artifact' && item.artifactId && this.pipeline) created.push({ item: id, ref: (await this.pipeline.decide(item.artifactId, who, 'accepted')).id });
          else created.push({ item: id, ref: (await ai.apply(client.uid, item)).ref });
        } catch (e) {
          log.warn('creating an accepted proposal item failed', { item: id, err: String(e) });
          if (e instanceof PipelineError) return refuse(e.code, e.message);
        }
      }
      if (created.length === 0) return refuse('not_saved', 'Nothing could be created. Try again.');
    } else if (this.pipeline) {
      // Dismissing a proposal of artifacts rejects them, so they stop waiting for a decision.
      for (const item of card.items) if (item.type === 'artifact' && item.artifactId) await this.pipeline.decide(item.artifactId, who, 'rejected').catch(() => undefined);
    }
    const next: ChatCard = { ...card, decided: m.decision, chosen: m.decision === 'proceeded' ? m.chosen : [], ...(created.length ? { created } : {}) };
    const updated: StoredMessage = { ...stored, ui: next };
    try {
      await withTimeout(this.store.appendMessage(OFFICE_ID, updated), timing.storeMs);
    } catch (e) {
      log.error('saving a proposal decision failed', { err: String(e) });
      return refuse('not_saved', 'The answer wasn’t saved. Try again.');
    }
    this.pushSessionRing(stored.session, updated);
    this.broadcast({ t: 'card', id: updated.id, session: stored.session, ui: next });
  }

  /**
   * Plays a scripted conversation into a room's conversation, one line every `gapMs`, as the people who "said" it (the demo's sample
   * standup). Lines go through the same queue as anyone's chat, so real messages interleave in order.
   */
  async replay(room: string, byUid: string, lines: { uid: string; text: string }[], gapMs = 1800): Promise<{ ok: true; session: string } | { ok: false; code: string; message: string }> {
    if (this.replaying) return { ok: false, code: 'busy', message: 'The sample standup is already playing.' };
    if (!this.map.zones.some((z) => z.id === room) && room !== 'lobby') return { ok: false, code: 'unknown_room', message: 'Unknown room.' };
    const session = await this.openSession(room, byUid).catch(() => null);
    if (!session) return { ok: false, code: 'no_session', message: 'This room’s chat is closed. The owner can start a new session.' };
    this.replaying = true;
    void (async () => {
      try {
        for (const line of lines) {
          const member = this.members.get(line.uid);
          if (!member) continue;
          await new Promise<void>((done) => {
            this.enqueue(
              async (ctx) => {
                const at = this.nextAt();
                const msg: ChatMessage = { id: messageId(at), kind: 'human', from: member.uid, fromName: member.name, look: member.look, text: clampCodePoints(line.text, LIMITS.chatText), at, mentions: [], room, session: session.id };
                try {
                  if (!(await withTimeout(this.store.insertMessage(OFFICE_ID, msg), timing.storeMs)) || ctx.cancelled) return;
                } catch (e) {
                  log.error('saving a replayed line failed', { err: String(e) });
                  return;
                }
                this.pushSessionRing(session.id, msg);
                this.broadcastChat(msg);
              },
              { onBusy: () => done(), onTimeout: () => done() },
            );
            setTimeout(done, gapMs);
          });
        }
      } finally {
        this.replaying = false;
      }
    })();
    return { ok: true, session: session.id };
  }

  /* ───────────── desks and map ───────────── */

  /** Desks are not claimed: every member has the one in their own zone (`relayout`). The message stays for older clients. */
  private onClaim(client: Client) {
    client.send({ t: 'error', code: 'desk_assigned', message: 'Everyone has the desk in their own zone.' });
  }

  /** The map is laid out from the team (see `relayout`), so a hand edit would be undone by the next person to join. */
  private onEdit(client: Client) {
    client.send({ t: 'error', code: 'forbidden', message: 'The office is laid out from your team, so it can’t be edited by hand.' });
  }
}
