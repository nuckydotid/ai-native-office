import { buildOfficeMap, deskIdOf } from '../../shared/workspace/layout.ts';
import { agentFailureId, agentReplyId, extractMentions } from '../../shared/workspace/chat.ts';
import { makePlayer } from '../../shared/workspace/entities.ts';
import { buildGrid, canStand, dist, nearestFree, type Grid } from '../../shared/workspace/grid.ts';
import { deskSeat } from '../../shared/workspace/props.ts';
import { LIMITS, PROTOCOL_VERSION, cleanAgentText, parseClientMsg, rawRefs } from '../../shared/workspace/protocol.ts';
import type { AgentRef, AgentStatus, ClientMsg, ServerMsg } from '../../shared/workspace/protocol.ts';
import type { Appearance, ChatMessage, PlayerState, SessionInfo, WorkspaceMap } from '../../shared/workspace/types.ts';
import { compareMessages } from '../core/chatlog.ts';
import { Emitter, type ConnStatus, type RoomConnection } from './room.ts';

export interface LocalRoomOptions {
  uid: string;
  name: string;
  look: Appearance;
  map?: WorkspaceMap;
  now?: () => number;
  /** A short random string for message ids. */
  rand?: () => string;
}

const NOTE = 'This is a practice office on your Mac: nobody else is here and nothing you write is saved. Mention an agent with @ (for example @john) to try asking one.';
/** What a welcome shows: the latest messages. Older ones come from `history.get`, as with the team server. */
const TAIL = 30;

interface Run {
  runId: string;
  reqId: string;
  replyTo: string;
  agent: AgentRef;
  /** One at a time, like the server's queue for a person: the first is thinking and the rest wait. */
  state: 'queued' | 'thinking';
  room?: string;
  session?: string;
}

/**
 * An office that lives inside the app: the same map and desks as the team server, for one person, with a Room chat that
 * works the way the server's does (saved ids, paging, tombstones, agents that answer when mentioned) but only in memory.
 * Every message goes through the same validation as the server's, so what works here works there.
 */
export class LocalRoom implements RoomConnection {
  readonly kind = 'local' as const;
  private messages = new Emitter<ServerMsg>();
  private statuses = new Emitter<ConnStatus>();
  private map: WorkspaceMap;
  private grid: Grid;
  private players = new Map<string, PlayerState>();
  private desks = new Map<string, { x: number; y: number }>();
  private deskOwners = new Map<string, string>();
  private rows: ChatMessage[] = [];
  private sessions = new Map<string, SessionInfo>();
  private runs = new Map<string, Run>();
  private live = false;
  private starter: ReturnType<typeof setTimeout> | null = null;
  private lastAt = 0;
  private seq = 0;
  private readonly now: () => number;
  private readonly rand: () => string;

  constructor(private opts: LocalRoomOptions) {
    this.map = structuredClone(opts.map ?? buildOfficeMap([{ uid: opts.uid, name: opts.name, joinedAt: 0 }]));
    this.grid = buildGrid(this.map);
    for (const p of this.map.props) if (p.kind === 'desk') this.desks.set(p.id, p);
    this.now = opts.now ?? Date.now;
    this.rand = opts.rand ?? (() => Math.random().toString(36).slice(2, 8));
  }

  onMessage(listener: (msg: ServerMsg) => void) {
    return this.messages.on(listener);
  }

  onStatus(listener: (status: ConnStatus) => void) {
    return this.statuses.on(listener);
  }

  open() {
    if (this.live || this.starter) return;
    this.statuses.emit({ state: 'connecting' });
    // Like a server, the welcome arrives after the call returns, never from inside it.
    this.starter = setTimeout(() => {
      this.starter = null;
      this.live = true;
      this.enter();
      this.statuses.emit({ state: 'online' });
    }, 0);
  }

  close() {
    if (this.starter) clearTimeout(this.starter);
    this.starter = null;
    this.live = false;
    this.statuses.emit({ state: 'closed' });
  }

  private enter() {
    const spawn = this.map.spawns[0];
    // The one person here has the desk in their own zone, like a member of a team has.
    const desk = this.desks.has(deskIdOf(this.opts.uid)) ? deskIdOf(this.opts.uid) : null;
    this.players.set(this.opts.uid, makePlayer({ id: this.opts.uid, name: this.opts.name, x: spawn.x, y: spawn.y, look: this.opts.look, desk }));
    if (desk) this.deskOwners.set(desk, this.opts.uid);
    if (!this.sessions.has('sess-local-lobby')) {
      const lobbySession: SessionInfo = {
        id: 'sess-local-lobby',
        room: 'lobby',
        state: 'active',
        createdAt: this.stamp(),
        createdBy: this.opts.uid,
      };
      this.sessions.set(lobbySession.id, lobbySession);
    }
    const lobbySession = this.sessions.get('sess-local-lobby')!;
    if (this.rows.length === 0) {
      this.rows.push({
        id: 'note-1',
        kind: 'system',
        from: 'system',
        fromName: 'Office',
        text: NOTE,
        at: this.stamp(),
        room: 'lobby',
        session: lobbySession.id,
      });
    }
    const lobbyRows = this.rows.filter((r) => r.session === lobbySession.id);
    const tail = lobbyRows.slice(-TAIL);
    this.messages.emit({
      t: 'welcome',
      you: this.opts.uid,
      role: 'owner',
      workspace: { id: 'practice', name: 'Practice office' },
      map: structuredClone(this.map),
      players: structuredClone([...this.players.values()]),
      deskOwners: Object.fromEntries(this.deskOwners),
      history: structuredClone(tail),
      historyHasMore: lobbyRows.length > tail.length,
      thinking: [...this.runs.values()].map((r) => this.statusOf(r)),
      room: 'lobby',
      sessions: structuredClone([...this.sessions.values()]),
      protocol: PROTOCOL_VERSION,
      serverTime: this.now(),
    });
  }

  /** Strictly increasing, like the server's, so two messages never tie. */
  private stamp(): number {
    this.lastAt = Math.max(this.now(), this.lastAt + 1);
    return this.lastAt;
  }

  /** Answers arrive after `send` returns, as they do over a network. */
  private later(fn: () => void) {
    queueMicrotask(() => {
      if (this.live) fn();
    });
  }

  send(raw: ClientMsg): boolean {
    const me = this.players.get(this.opts.uid);
    if (!me || !this.live) return false;
    const text = JSON.stringify(raw);
    const msg = parseClientMsg(text);
    if (!msg) {
      const refs = rawRefs(text);
      this.later(() => this.messages.emit({ t: 'error', code: 'bad_request', message: 'That message couldn’t be sent.', ...refs }));
      return true;
    }
    switch (msg.t) {
      case 'move':
        // Like the server: sitting still at the seat is not a reason to stand up.
        if (me.sitting && !msg.moving && dist(me, msg) < 0.05) break;
        if (!canStand(this.grid, msg.x, msg.y)) {
          this.messages.emit({ t: 'correct', x: me.x, y: me.y });
          break;
        }
        Object.assign(me, { x: msg.x, y: msg.y, dir: msg.dir, moving: msg.moving, sitting: null });
        break;
      case 'sit':
        this.sit(me, msg.deskId);
        break;
      case 'page.set':
        me.page = msg.page;
        break;
      case 'chat':
        this.later(() => this.say(me, msg.text, msg.cid, msg.room));
        break;
      case 'history.get':
        this.later(() => this.page(msg.reqId, msg.room, msg.session, msg.before, msg.limit));
        break;
      case 'session.new':
        this.later(() => this.newSession(msg.room, msg.reqId));
        break;
      case 'session.archive':
        this.later(() => this.archiveSession(msg.room, msg.reqId));
        break;
      case 'session.delete':
        this.later(() => this.deleteSession(msg.session, msg.reqId));
        break;
      case 'chat.delete':
        this.later(() => this.remove(msg.id));
        break;
      case 'agent.start':
        this.later(() => this.startRun(me, msg.reqId, msg.replyTo, msg.agent, msg.mode));
        break;
      case 'agent.reply':
        this.later(() => this.finishRun(me, msg.reqId, msg.text));
        break;
      case 'agent.fail':
        this.later(() => this.endRun(msg.reqId, 'failed'));
        break;
      case 'ping':
        this.messages.emit({ t: 'pong', at: msg.at, serverTime: this.now() });
        break;
      default:
        // Emotes, status and the rest only matter to other people, and nobody else is here.
        break;
    }
    return true;
  }

  /* ───────────── the Room chat ───────────── */

  private getActiveSession(room: string): SessionInfo | undefined {
    return [...this.sessions.values()].find((s) => s.room === room && s.state === 'active');
  }

  private hasArchivedSession(room: string): boolean {
    return [...this.sessions.values()].some((s) => s.room === room && s.state === 'archived' && !s.legacy);
  }

  /** Keeps a message (a message saved again under the same id replaces the old one, as on the server) and sends it to the person. The client's own id goes on the copy that is sent back, but is never kept (history doesn't have it). */
  private add(msg: ChatMessage, cid?: string) {
    const i = this.rows.findIndex((m) => m.id === msg.id);
    if (i >= 0) this.rows.splice(i, 1);
    this.rows.push(msg);
    this.rows.sort(compareMessages);
    this.messages.emit({ t: 'chat', msg: { ...structuredClone(msg), ...(cid ? { cid } : {}) } });
  }

  private say(me: PlayerState, text: string, cid?: string, room: string = 'lobby') {
    let active = this.getActiveSession(room);
    if (!active) {
      if (this.hasArchivedSession(room)) {
        return void this.messages.emit({
          t: 'error',
          code: 'no_session',
          message: 'This room’s chat is closed. The owner can start a new session.',
          cid,
        });
      }
      active = {
        id: `sess-${this.rand()}`,
        room,
        state: 'active',
        createdAt: this.stamp(),
        createdBy: this.opts.uid,
      };
      this.sessions.set(active.id, active);
      this.messages.emit({ t: 'session.update', session: structuredClone(active) });
    }
    const at = this.stamp();
    this.add(
      {
        id: `${at.toString(36).padStart(9, '0')}-${this.rand()}${(this.seq++).toString(36)}`,
        kind: 'human',
        from: me.id,
        fromName: me.name,
        look: me.look,
        text,
        at,
        mentions: extractMentions(text),
        room,
        session: active.id,
      },
      cid,
    );
  }

  private page(
    reqId: string,
    room: string = 'lobby',
    session?: string,
    before?: { at: number; id: string },
    limit: number = LIMITS.historyPage,
  ) {
    let targetSessionId = session;
    if (!targetSessionId) {
      const active = this.getActiveSession(room);
      targetSessionId = active?.id;
    }
    const rows = targetSessionId ? this.rows.filter((m) => m.session === targetSessionId) : [];
    const older = before ? rows.filter((m) => compareMessages(m, before) < 0) : rows;
    const messages = older.slice(Math.max(0, older.length - limit));
    this.messages.emit({
      t: 'history.page',
      reqId,
      room,
      session: targetSessionId ?? '',
      messages: structuredClone(messages),
      hasMore: older.length > messages.length,
    });
  }

  private newSession(room: string, _reqId: string) {
    const active = this.getActiveSession(room);
    const now = this.stamp();
    if (active) {
      active.state = 'archived';
      active.archivedAt = now;
      this.messages.emit({ t: 'session.update', session: structuredClone(active) });
    }
    const nextSession: SessionInfo = {
      id: `sess-${this.rand()}`,
      room,
      state: 'active',
      createdAt: now,
      createdBy: this.opts.uid,
    };
    this.sessions.set(nextSession.id, nextSession);
    this.messages.emit({ t: 'session.update', session: structuredClone(nextSession) });
  }

  private archiveSession(room: string, reqId: string) {
    const active = this.getActiveSession(room);
    if (!active) {
      return void this.messages.emit({ t: 'error', code: 'not_found', message: 'No active session in this room.', reqId });
    }
    active.state = 'archived';
    active.archivedAt = this.stamp();
    this.messages.emit({ t: 'session.update', session: structuredClone(active) });
  }

  private deleteSession(sessionId: string, reqId: string) {
    const target = this.sessions.get(sessionId);
    if (!target) {
      return void this.messages.emit({ t: 'error', code: 'not_found', message: 'Session not found.', reqId });
    }
    const room = target.room;
    this.sessions.delete(sessionId);
    this.rows = this.rows.filter((m) => m.session !== sessionId);
    this.messages.emit({ t: 'session.removed', id: sessionId, room });
  }

  private remove(id: string) {
    const i = this.rows.findIndex((m) => m.id === id);
    if (i < 0 || this.rows[i].deleted) return;
    this.rows[i] = { ...this.rows[i], text: '', deleted: true, mentions: [] };
    this.messages.emit({ t: 'chat.deleted', id });
  }

  /* ───────────── agents ───────────── */

  private statusOf(run: Run, state: AgentStatus['state'] = run.state): AgentStatus {
    return {
      runId: run.runId,
      reqId: run.reqId,
      agent: run.agent,
      by: this.opts.uid,
      byName: this.opts.name,
      replyTo: run.replyTo,
      state,
      room: run.room,
      session: run.session,
    };
  }

  private startRun(me: PlayerState, reqId: string, replyTo: string, agent: AgentRef, mode: 'fresh' | 'resume' | 'rerun') {
    const existing = this.runs.get(reqId);
    if (existing) return void this.messages.emit({ t: 'agent.status', status: this.statusOf(existing) });
    const mention = this.rows.find((m) => m.id === replyTo);
    if (!mention || mention.deleted || mention.kind !== 'human' || mention.from !== me.id || !(mention.mentions ?? []).includes(agent.handle)) {
      return void this.messages.emit({ t: 'error', code: 'bad_request', message: 'That agent wasn’t mentioned in your message.', reqId });
    }
    // Each way of starting has an age it will not go past (a "Run again" may be a day old; a fresh question is seconds old).
    if (this.now() - mention.at > LIMITS.startMaxAgeMs[mode]) {
      return void this.messages.emit({ t: 'error', code: 'not_allowed', message: 'That question is too old to answer that way.', reqId });
    }
    const run: Run = {
      runId: `run-${reqId}`,
      reqId,
      replyTo,
      agent,
      state: 'thinking',
      room: mention.room,
      session: mention.session,
    };
    const answered = this.rows.find((m) => m.id === agentReplyId(replyTo, agent.handle));
    // Answered: done. Answered and then taken back: "Run again" (and only that) may ask again.
    if (answered && (!answered.deleted || mode !== 'rerun')) {
      return void this.messages.emit({ t: 'agent.status', status: this.statusOf(run, 'done') });
    }
    const failed = this.rows.find((m) => m.id === agentFailureId(replyTo, agent.handle));
    if (failed && !failed.deleted && mode !== 'rerun') {
      return void this.messages.emit({ t: 'agent.status', status: { ...this.statusOf(run, 'failed'), reason: 'earlier_failure' } });
    }
    run.state = this.runs.size === 0 ? 'thinking' : 'queued';
    this.runs.set(reqId, run);
    this.messages.emit({ t: 'agent.status', status: this.statusOf(run) });
  }

  private finishRun(me: PlayerState, reqId: string, raw: string) {
    const run = this.runs.get(reqId);
    if (!run) return void this.messages.emit({ t: 'error', code: 'bad_request', message: 'Nobody is waiting for that answer any more.', reqId });
    const text = cleanAgentText(raw);
    if (text === null) {
      // An answer that can't be posted ends the run with a note in the conversation, like the server's.
      this.endRun(reqId, 'failed');
      return this.note(run, `${run.agent.name}’s answer couldn’t be posted (it was empty or too long).`);
    }
    this.add({
      id: agentReplyId(run.replyTo, run.agent.handle),
      kind: 'agent',
      from: `agent:${run.agent.handle}`,
      fromName: run.agent.name,
      look: run.agent.look,
      text,
      at: this.stamp(),
      mentions: [],
      replyTo: run.replyTo,
      runId: run.runId,
      via: me.id,
      viaName: me.name,
      room: run.room,
      session: run.session,
    });
    this.endRun(reqId, 'done');
  }

  private note(run: Run, text: string) {
    this.add({
      id: agentFailureId(run.replyTo, run.agent.handle),
      kind: 'system',
      from: 'system',
      fromName: 'Office',
      text,
      at: this.stamp(),
      mentions: [],
      replyTo: run.replyTo,
      via: this.opts.uid,
      viaName: this.opts.name,
      room: run.room,
      session: run.session,
    });
  }

  private endRun(reqId: string, state: 'done' | 'failed') {
    const run = this.runs.get(reqId);
    if (!run) return;
    this.runs.delete(reqId);
    this.messages.emit({ t: 'agent.status', status: this.statusOf(run, state) });
    // The next one waiting takes its turn.
    const next = [...this.runs.values()].find((r) => r.state === 'queued');
    if (next) {
      next.state = 'thinking';
      this.messages.emit({ t: 'agent.status', status: this.statusOf(next) });
    }
  }

  /* ───────────── the office ───────────── */

  private sit(me: PlayerState, deskId: string | null) {
    if (deskId === null) {
      if (!me.sitting) return;
      const free = nearestFree(this.grid, me.x, me.y + 1, 3);
      me.sitting = null;
      if (free) Object.assign(me, { x: free.x, y: free.y });
      this.messages.emit({ t: 'correct', x: me.x, y: me.y });
      return;
    }
    const desk = this.desks.get(deskId);
    if (!desk) return;
    const seat = deskSeat(desk);
    if (dist(me, { x: seat.x + 0.5, y: seat.y + 0.5 }) > 3) {
      this.messages.emit({ t: 'correct', x: me.x, y: me.y });
      return;
    }
    Object.assign(me, { x: seat.x + 0.5, y: seat.y + 0.5, dir: 'up', moving: false, sitting: deskId });
  }
}
