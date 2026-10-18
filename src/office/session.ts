import { dist } from '../shared/workspace/grid.ts';
import { deskSeat } from '../shared/workspace/props.ts';
import type { AgentStatus, ClientMsg, HistoryCursor, ServerMsg, WelcomeMsg } from '../shared/workspace/protocol.ts';
import type { ChatMessage, EmoteKind, PresenceStatus, WorkspacePage } from '../shared/workspace/types.ts';
import { useSync } from '../sync/store.ts';
import { zoneAt } from '../shared/workspace/layout.ts';
import { CHAT_CAP, PAGE_SIZE, compareMessages, cursorOf, kindOf } from './core/chatlog.ts';
import { ClientWorld } from './core/world.ts';
import { Emitter, type ConnStatus, type RoomConnection } from './net/room.ts';
import { useOffice } from './store.ts';

/** What a failed "Load earlier" says, for the short codes the server answers with. */
const PAGE_PROBLEMS: Record<string, string> = {
  unavailable: 'The chat history didn’t answer. Try again in a moment.',
};

/** How many pages of older messages are checked after rejoining. */
const CHECK_PAGES = 6;

const SIT_RANGE = 1.6;
const MOVE_EVERY_MS = 66;

/** What the panel needs from the agent runner (Stop, Run again). */
export interface RunControls {
  rerun(message: ChatMessage, handle: string): boolean;
  stopRun(replyTo: string, handle: string): void;
  /** Whether a run can be stopped from this window. A run the server does is the server's: Stop is not offered for it. */
  canStop?(replyTo: string, handle: string): boolean;
}

export interface SessionOptions {
  room: RoomConnection;
  /** How long a message waits to be confirmed as saved before the person is told. */
  sendTimeoutMs?: number;
  /** How long "Load earlier" waits for a page. */
  pageTimeoutMs?: number;
}

/** How a message the person sent turned out. `cid` is the id the client gave it. */
export type SendResult = { ok: true; cid: string } | { ok: false; cid: string; message: string };

interface Waiting {
  resolve: (result: SendResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

let sends = 0;
/** An id for one send, unique enough among one person's messages and safe in the protocol (letters, digits, dashes). */
const newCid = () => `c${Date.now().toString(36)}-${(sends++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/**
 * One visit to the office: the connection, the world it keeps up to date, and what the person does in it. The picture
 * reads `world` every frame; the side panel reads the store.
 */
export class OfficeSession {
  readonly world = new ClientWorld();
  /** Things people say, for the speech bubbles over their heads. */
  readonly bubbles = new Emitter<{ from: string; text: string }>();
  /** What happens in the room, for the parts that react to it (the agent runner). The screens read the store instead. */
  readonly events = {
    chat: new Emitter<ChatMessage>(),
    status: new Emitter<AgentStatus>(),
    welcome: new Emitter<WelcomeMsg>(),
    error: new Emitter<Extract<ServerMsg, { t: 'error' }>>(),
    conn: new Emitter<ConnStatus>(),
  };
  private unsubscribe: (() => void)[] = [];
  private sent = { x: NaN, y: NaN, dir: '', moving: false, at: 0 };
  private lastZone: string | null = null;
  private currentRoomId = 'lobby';
  /** The page the person is on: where they stand and are seen. */
  private pageId: WorkspacePage = 'progress';
  /** A walk the engine should run, to the room of this page. Taken by the engine on its next step. */
  private walkTo: WorkspacePage | null = null;
  /** Whether the person is walking to a page's room: the room follows the page until they arrive. */
  private walking = false;
  private candidateRoom: { id: string; name: string } | null = null;
  private candidateSince = 0;
  private historyRequests = new Map<string, { resolve: (msgs: ChatMessage[]) => void }>();
  /** Set by whoever creates the session, once the runner exists. */
  runner: RunControls | null = null;
  private waiting = new Map<string, Waiting>();
  private page: { reqId: string; from: HistoryCursor | undefined; timer: ReturnType<typeof setTimeout>; room?: string; session?: string } | null = null;
  private pages = 0;
  /** After rejoining, the older messages the person kept are checked against the server (a message may have been removed while they were away). */
  private checking: { reqId: string; floor: HistoryCursor; left: number; at: HistoryCursor; timer: ReturnType<typeof setTimeout> } | null = null;
  /** The ids of the messages this window sent, so only they can start an agent here. */
  private mine = new Set<string>();

  constructor(private opts: SessionOptions) {}

  get room() {
    return this.opts.room;
  }

  /** Whether this window sent the message with this client id. */
  sentHere(cid: string | undefined): boolean {
    return cid !== undefined && this.mine.has(cid);
  }

  start() {
    const { room } = this.opts;
    useOffice.getState().begin();
    this.unsubscribe.push(
      room.onStatus((status) => {
        useOffice.getState().setStatus(status);
        this.events.conn.emit(status);
        if (status.state === 'online') return;
        // A message that was in flight when the connection went may or may not have been saved: say so, don't guess.
        this.failAll('Couldn’t confirm that it was sent. If it shows up in the chat, it was.');
        this.endPage();
        this.endCheck();
      }),
      room.onMessage((msg) => this.onMessage(msg)),
    );
    room.open();
  }

  stop() {
    for (const off of this.unsubscribe.splice(0)) off();
    this.failAll('Left the office.');
    this.endPage();
    this.endCheck();
    this.opts.room.close();
    useOffice.getState().end();
  }

  private onMessage(msg: ServerMsg) {
    const change = this.world.apply(msg, performance.now());
    const store = useOffice.getState();
    switch (msg.t) {
      case 'welcome': {
        // A page asked for on the connection before this one never arrives.
        this.endPage();
        this.endCheck();
        const restarts = store.restarts;
        const spawnRoom = msg.room ?? 'lobby';
        this.currentRoomId = spawnRoom;
        this.candidateRoom = null;
        const spawnZone = this.world.map?.zones.find((z) => z.id === spawnRoom);
        if (spawnZone) {
          this.lastZone = spawnZone.name;
          store.setZone(spawnZone.name);
        }
        this.opts.room.send({ t: 'page.set', page: this.pageId });
        store.welcome({
          you: msg.you, officeName: msg.workspace.name, role: msg.role, people: [...this.world.players.values()],
          history: msg.history, historyHasMore: msg.historyHasMore ?? false, thinking: msg.thinking ?? [],
          room: spawnRoom, sessions: msg.sessions, protocol: msg.protocol,
        });
        // The page was opened before the office answered (the app opens on a stage page): its room is where the person belongs, not the spawn.
        if (this.pageId !== 'progress') this.enterPageRoom(this.pageId);
        this.checkKept(msg.history[0], restarts);
        this.events.welcome.emit(msg);
        break;
      }
      case 'chat':
        // A message in a worktree tab belongs to the tab, not to the room's conversation.
        if (msg.msg.thread) {
          if (msg.msg.cid) this.settle(msg.msg.cid, { ok: true, cid: msg.msg.cid });
          break;
        }
        store.addChat(msg.msg);
        if (msg.msg.cid) this.settle(msg.msg.cid, { ok: true, cid: msg.msg.cid });
        if (kindOf(msg.msg) === 'human' && !msg.msg.deleted) this.bubbles.emit({ from: msg.msg.from, text: msg.msg.text });
        this.events.chat.emit(msg.msg);
        break;
      case 'chat.deleted':
        store.deleteChat(msg.id);
        break;
      case 'history.page': {
        const req = this.historyRequests.get(msg.reqId);
        if (req) {
          this.historyRequests.delete(msg.reqId);
          req.resolve(msg.messages);
          break;
        }
        this.pageArrived(msg);
        this.checkArrived(msg);
        break;
      }
      case 'session.update':
        store.updateSession(msg.session);
        break;
      case 'session.removed':
        store.removeSession(msg.id, msg.room);
        break;
      case 'sync':
        useSync.getState().bump(msg.kind, msg.ids);
        break;
      case 'card':
        // A card in a worktree tab's chat is not shown; a card in a room (a proposal) is part of the room's own message.
        if (!msg.thread) store.updateCard(msg.id, msg.ui);
        break;
      case 'agent.status':
        store.setAgentStatus(msg.status);
        this.events.status.emit(msg.status);
        break;
      case 'role':
        store.setRole(msg.role);
        break;
      case 'error':
        if (msg.cid) this.settle(msg.cid, { ok: false, cid: msg.cid, message: msg.message });
        else if (msg.reqId && msg.reqId === this.page?.reqId) {
          this.endPage();
          store.setNotice(msg.message);
        } else if (msg.reqId && msg.reqId === this.checking?.reqId) this.giveUpChecking();
        else if (msg.reqId) this.events.error.emit(msg);
        else store.setNotice(msg.message);
        break;
      default:
        if (change === 'roster') store.setPeople([...this.world.players.values()]);
    }
  }

  /* ───────────── movement ───────────── */

  /** The picture calls this each frame after moving the person's own figure; the server hears about it ~15 times a second. */
  reportMove(now: number) {
    const me = this.world.me;
    if (!me) return;
    const last = this.sent;
    if (me.x === last.x && me.y === last.y && me.dir === last.dir && me.moving === last.moving) return;
    const stopping = last.moving && !me.moving;
    if (!stopping && now - last.at < MOVE_EVERY_MS) return;
    const msg: ClientMsg = { t: 'move', x: +me.x.toFixed(3), y: +me.y.toFixed(3), dir: me.dir, moving: me.moving };
    if (this.opts.room.send(msg)) this.sent = { x: me.x, y: me.y, dir: me.dir, moving: me.moving, at: now };
  }

  /** The room the person stands in. Cheap enough for every frame. On Plan and Review the room is the page, and it stays the
   * page while the person is walking to it (passing the lobby must not flip the chat). */
  look() {
    if (this.pageId !== 'progress' || this.walking) return;
    const me = this.world.me;
    const map = this.world.map;
    if (!me || !map) return;
    const zone = zoneAt(map, me.x, me.y);
    // Doorway / wall / outside zone: keep previous room, reset candidate
    if (!zone) {
      this.candidateRoom = null;
      return;
    }
    // Same room: reset candidate
    if (zone.id === this.currentRoomId) {
      this.candidateRoom = null;
      if (zone.name !== this.lastZone) {
        this.lastZone = zone.name;
        useOffice.getState().setZone(zone.name);
      }
      return;
    }
    // Candidate room switch: hold for ~250ms
    const now = performance.now();
    if (!this.candidateRoom || this.candidateRoom.id !== zone.id) {
      this.candidateRoom = { id: zone.id, name: zone.name };
      this.candidateSince = now;
      return;
    }
    if (now - this.candidateSince >= 250) {
      this.switchRoom(zone.id, zone.name);
    }
  }

  /** The person opened a page: they are seen there, and their character walks to that page's room. */
  setPage(page: WorkspacePage) {
    if (this.pageId === page) return;
    this.pageId = page;
    this.world.page = page;
    this.opts.room.send({ t: 'page.set', page });
    this.enterPageRoom(page);
  }

  /** The character walks to the page's room (the engine runs the walk when it has the map); the chat follows the page right away. */
  private enterPageRoom(page: WorkspacePage) {
    this.walkTo = page;
    this.walking = true;
    if (page === 'progress') this.switchRoom('lobby');
    else this.switchRoom(page, page === 'plan' ? 'Plan Room' : 'Review Room');
  }

  /** The engine asks, once per step, whether the person should walk somewhere: the page whose room to head to. */
  takeWalkRequest(): WorkspacePage | null {
    const page = this.walkTo;
    this.walkTo = null;
    return page;
  }

  /** The walk is over (arrived, blocked, or the person took the wheel): the room follows the feet again. */
  walkEnded() {
    this.walking = false;
  }

  switchRoom(roomId: string, zoneName?: string) {
    this.currentRoomId = roomId;
    this.candidateRoom = null;
    if (zoneName) {
      this.lastZone = zoneName;
      useOffice.getState().setZone(zoneName);
    }
    this.endPage();
    this.endCheck();
    const store = useOffice.getState();
    store.openRoom(roomId);
    if (!store.views[roomId]?.loaded) {
      this.loadInitialHistory(roomId);
    }
  }

  loadInitialHistory(roomId: string, session?: string) {
    this.endPage();
    const reqId = `h${Date.now().toString(36)}-${(this.pages++).toString(36)}`;
    const timer = setTimeout(() => {
      if (this.page?.reqId !== reqId) return;
      this.endPage();
    }, this.opts.pageTimeoutMs ?? 10_000);
    this.page = { reqId, from: undefined, timer, room: roomId, session };
    const store = useOffice.getState();
    store.setLoadingEarlier(true);
    if (!this.opts.room.send({ t: 'history.get', reqId, room: roomId, session, limit: PAGE_SIZE })) {
      this.endPage();
    }
  }

  viewArchivedSession(sessionId: string | null) {
    const store = useOffice.getState();
    store.viewSession(sessionId);
    if (sessionId) {
      this.loadInitialHistory(store.roomId, sessionId);
    }
  }

  /** E: stand up if sitting, or sit at the nearest desk in reach (every zone is open to everyone). */
  interact() {
    const me = this.world.me;
    const map = this.world.map;
    if (!me || !map) return;
    if (me.sitting) return this.sit(null);
    for (const desk of map.props) {
      if (desk.kind !== 'desk') continue;
      const seat = deskSeat(desk);
      if (dist(me, { x: seat.x + 0.5, y: seat.y + 0.5 }) <= SIT_RANGE) return this.sit(desk.id);
    }
  }

  sit(deskId: string | null) {
    const me = this.world.me;
    const map = this.world.map;
    if (!me || !map) return;
    if (deskId === null) {
      if (!me.sitting) return;
      me.sitting = null;
      this.opts.room.send({ t: 'sit', deskId: null });
      return;
    }
    const desk = map.props.find((p) => p.id === deskId);
    if (!desk) return;
    const seat = deskSeat(desk);
    if (dist(me, { x: seat.x + 0.5, y: seat.y + 0.5 }) > 3) return;
    // The server doesn't answer a sit that worked, so the person's own figure takes the seat right away.
    Object.assign(me, { x: seat.x + 0.5, y: seat.y + 0.5, dir: 'up', moving: false, sitting: deskId });
    this.opts.room.send({ t: 'sit', deskId });
  }

  emote(emote: EmoteKind) {
    const me = this.world.me;
    if (me) me.emote = { kind: emote, at: Date.now() };
    this.opts.room.send({ t: 'emote', emote });
  }

  setStatus(status: PresenceStatus) {
    const me = this.world.me;
    if (me) me.status = status;
    this.opts.room.send({ t: 'status', status });
    useOffice.getState().setPeople([...this.world.players.values()]);
  }

  /* ───────────── the Room chat ───────────── */

  /**
   * Sends a message to the Room. Resolves when the server has saved it (its own copy comes back with this send's id), or
   * when it said no, or when it is too late to wait. Nothing is shown as sent before that.
   */
  sendChat(text: string, retryCid?: string): Promise<SendResult> {
    const clean = text.trim();
    // A send that is being tried again keeps its id, so the server can tell that it already saved it and not save it twice.
    const cid = retryCid && /^[A-Za-z0-9_-]{1,64}$/.test(retryCid) ? retryCid : newCid();
    this.settle(cid, { ok: false, cid, message: 'Sent again.' });
    if (!clean) return Promise.resolve({ ok: false, cid, message: 'There is nothing to send.' });
    const room = useOffice.getState().roomId;
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settle(cid, { ok: false, cid, message: 'The team server didn’t confirm that it was saved. If it shows up in the chat, it was.' }), this.opts.sendTimeoutMs ?? 10_000);
      this.waiting.set(cid, { resolve, timer });
      this.mine.add(cid);
      if (this.mine.size > 500) this.mine.delete(this.mine.values().next().value as string);
      if (!this.opts.room.send({ t: 'chat', text: clean, cid, room })) this.settle(cid, { ok: false, cid, message: 'You’re not connected to the office right now.' });
    });
  }

  private settle(cid: string, result: SendResult) {
    const w = this.waiting.get(cid);
    if (!w) return;
    clearTimeout(w.timer);
    this.waiting.delete(cid);
    w.resolve(result);
  }

  private failAll(message: string) {
    for (const cid of [...this.waiting.keys()]) this.settle(cid, { ok: false, cid, message });
  }

  /** Asks for the page of messages before the oldest one on screen. */
  loadEarlier() {
    const store = useOffice.getState();
    if (this.page || !store.historyHasMore || store.chat.length === 0) return;
    if (store.chat.length >= CHAT_CAP) return void store.setNotice('That is as far back as this window goes. Everything is still saved in the team database.');
    const reqId = `h${Date.now().toString(36)}-${(this.pages++).toString(36)}`;
    const timer = setTimeout(() => {
      if (this.page?.reqId !== reqId) return;
      this.endPage();
      useOffice.getState().setNotice('The team server is slow to answer. Try loading earlier messages again in a moment.');
    }, this.opts.pageTimeoutMs ?? 10_000);
    const from = cursorOf(store.chat);
    const room = store.roomId;
    const session = store.viewingSessionId ?? undefined;
    this.page = { reqId, from, timer, room, session };
    store.setLoadingEarlier(true);
    if (!this.opts.room.send({ t: 'history.get', reqId, room, session, before: from, limit: PAGE_SIZE })) {
      this.endPage();
      store.setNotice('You’re not connected to the office right now.');
    }
  }

  private pageArrived(msg: Extract<ServerMsg, { t: 'history.page' }>) {
    if (msg.reqId !== this.page?.reqId) return;
    const store = useOffice.getState();
    if (msg.error) {
      this.endPage();
      // The server says why with a short code; the person gets a sentence.
      return void store.setNotice(PAGE_PROBLEMS[msg.error] ?? PAGE_PROBLEMS.unavailable);
    }
    const from = this.page.from;
    clearTimeout(this.page.timer);
    this.page = null;
    store.addPage(msg.messages, msg.hasMore, from, msg.room, msg.session);
  }

  /** A person accepts or dismisses what an agent proposed in a room; the server creates what was chosen, as them. */
  decideProposal(messageId: string, decision: 'proceeded' | 'dismissed', chosen: string[]) {
    if (!this.opts.room.send({ t: 'card.decide', message: messageId, decision, chosen })) useOffice.getState().setNotice('You’re not connected to the office right now.');
  }

  /* ───────────── sessions ───────────── */

  newSession(room: string) {
    const reqId = `sn${Date.now().toString(36)}-${(this.pages++).toString(36)}`;
    if (!this.opts.room.send({ t: 'session.new', reqId, room })) {
      useOffice.getState().setNotice('You’re not connected to the office right now.');
    }
  }

  archiveSession(room: string) {
    const reqId = `sa${Date.now().toString(36)}-${(this.pages++).toString(36)}`;
    if (!this.opts.room.send({ t: 'session.archive', reqId, room })) {
      useOffice.getState().setNotice('You’re not connected to the office right now.');
    }
  }

  deleteSession(sessionId: string) {
    const reqId = `sd${Date.now().toString(36)}-${(this.pages++).toString(36)}`;
    if (!this.opts.room.send({ t: 'session.delete', reqId, session: sessionId })) {
      useOffice.getState().setNotice('You’re not connected to the office right now.');
    }
  }

  fetchHistory(room: string, session?: string, before?: HistoryCursor, limit = 40): Promise<ChatMessage[]> {
    const reqId = `fh${Date.now().toString(36)}-${(this.pages++).toString(36)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.historyRequests.delete(reqId);
        resolve([]);
      }, 5000);
      this.historyRequests.set(reqId, {
        resolve: (msgs) => {
          clearTimeout(timer);
          resolve(msgs);
        },
      });
      if (!this.opts.room.send({ t: 'history.get', reqId, room, session, before, limit })) {
        clearTimeout(timer);
        this.historyRequests.delete(reqId);
        resolve([]);
      }
    });
  }

  /* ───────────── checking what was kept ───────────── */

  /**
   * After rejoining with older messages kept (the welcome only brings the latest ones), asks the server about them: one of them
   * may have been removed while the person was away, and a removed message must not stay readable. A few pages are checked;
   * anything older than that is let go (it comes back with "Load earlier", and then as the server has it).
   */
  private checkKept(tailFirst: ChatMessage | undefined, restartsBefore: number) {
    const store = useOffice.getState();
    if (!tailFirst || store.restarts !== restartsBefore) return;
    const older = store.chat.filter((m) => compareMessages(m, tailFirst) < 0);
    if (older.length === 0) return;
    this.askChecked({ at: tailFirst.at, id: tailFirst.id }, { at: older[0].at, id: older[0].id }, CHECK_PAGES);
  }

  private askChecked(at: HistoryCursor, floor: HistoryCursor, left: number) {
    const reqId = `v${Date.now().toString(36)}-${(this.pages++).toString(36)}`;
    const timer = setTimeout(() => this.giveUpChecking(), this.opts.pageTimeoutMs ?? 10_000);
    this.checking = { reqId, floor, left, at, timer };
    // The kept messages are the ones just before `at`, so asking for as many as are held reaches the oldest of them.
    const held = useOffice.getState().chat.filter((m) => compareMessages(m, at) < 0).length;
    const limit = Math.min(PAGE_SIZE, Math.max(1, held));
    if (!this.opts.room.send({ t: 'history.get', reqId, before: at, limit })) this.giveUpChecking();
  }

  private checkArrived(msg: Extract<ServerMsg, { t: 'history.page' }>) {
    const check = this.checking;
    if (!check || msg.reqId !== check.reqId) return;
    clearTimeout(check.timer);
    this.checking = null;
    if (msg.error) {
      this.checking = check;
      return this.giveUpChecking();
    }
    const store = useOffice.getState();
    store.mergeChecked(msg.messages);
    const oldest = msg.messages[0];
    if (!oldest || !msg.hasMore || compareMessages(oldest, check.floor) <= 0) return;
    const oldestAt = { at: oldest.at, id: oldest.id };
    if (check.left <= 1) return void store.dropOlderThan(oldestAt);
    this.askChecked(oldestAt, check.floor, check.left - 1);
  }

  /** The rest of the kept messages can't be checked: they are let go rather than left as they were. */
  private giveUpChecking() {
    const check = this.checking;
    if (!check) return;
    clearTimeout(check.timer);
    this.checking = null;
    useOffice.getState().dropOlderThan(check.at);
  }

  private endCheck() {
    if (this.checking) clearTimeout(this.checking.timer);
    this.checking = null;
  }

  private endPage() {
    if (this.page) clearTimeout(this.page.timer);
    this.page = null;
    useOffice.getState().setLoadingEarlier(false);
  }

  /** Removes a message for everyone (the server decides whether this person may). */
  deleteMessage(id: string) {
    if (!this.opts.room.send({ t: 'chat.delete', id })) useOffice.getState().setNotice('You’re not connected to the office right now.');
  }
}
