import type { Appearance, ChatMessage, SessionInfo, WorkThread, WorkspaceMap, WorkspaceRole } from './shared/workspace/types.ts';
import type { HistoryCursor } from './shared/workspace/protocol.ts';
import type { Config } from './config.ts';
import { log } from './log.ts';

export type { SessionInfo };

export interface WorkspaceDoc {
  id: string;
  name: string;
  createdAt: number;
}

export interface MemberDoc {
  uid: string;
  role: WorkspaceRole;
  name: string;
  look: Appearance;
  desk: string | null;
  joinedAt: number;
  lastSeen: number;
}

/** A saved message. A deleted one also remembers who deleted it (an admin's delete is final; the person who asked an agent can undo their own). */
export type StoredMessage = ChatMessage & { deletedBy?: string };

export interface MessagePage {
  /** Oldest first. */
  messages: StoredMessage[];
  /** There are older messages than the first one returned. */
  hasMore: boolean;
}

/** Messages are ordered by when they were saved, then by id (compared by code unit, like JavaScript and `COLLATE "C"`). */
export const compareMessages = (a: Pick<ChatMessage, 'at' | 'id'>, b: Pick<ChatMessage, 'at' | 'id'>) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** This server holds exactly one project, so there is one office (`wid`), `main`. */
export const OFFICE_ID = 'main';

export interface Store {
  getWorkspace(id: string): Promise<WorkspaceDoc | null>;
  putWorkspace(doc: WorkspaceDoc): Promise<void>;
  listMembers(wid: string): Promise<MemberDoc[]>;
  putMember(wid: string, m: MemberDoc): Promise<void>;
  deleteMember(wid: string, uid: string): Promise<void>;
  /** Writes only `lastSeen`, so leaving never overwrites a role or desk changed meanwhile. */
  touchMember(wid: string, uid: string, lastSeen: number): Promise<void>;
  loadMap(wid: string): Promise<WorkspaceMap | null>;
  saveMap(wid: string, map: WorkspaceMap): Promise<void>;
  listSessions(wid: string): Promise<SessionInfo[]>;
  putSession(wid: string, s: SessionInfo): Promise<void>;
  deleteSession(wid: string, id: string): Promise<void>;
  /** Worktree tabs (their chat is saved as messages of the tab's own session). */
  listThreads(wid: string): Promise<WorkThread[]>;
  putThread(wid: string, t: WorkThread): Promise<void>;
  /** The newest `limit` messages older than `before` (or the newest of all), oldest first. */
  listMessages(wid: string, opts: { session?: string | null; before?: HistoryCursor; limit: number }): Promise<MessagePage>;
  getMessage(wid: string, id: string): Promise<StoredMessage | null>;
  /** Saves a message, replacing one with the same id. */
  appendMessage(wid: string, msg: ChatMessage): Promise<void>;
  /** Saves a message only if nothing (not even a deleted message) has that id. Resolves to whether it was saved. */
  insertMessage(wid: string, msg: ChatMessage): Promise<boolean>;
  /**
   * Saves a message unless one with that id exists. A deleted one is replaced only when `reviveBy` is the person who deleted it.
   * Resolves to whether it was saved.
   */
  insertMessageOnce(wid: string, msg: ChatMessage, opts?: { reviveBy?: string }): Promise<boolean>;
  /** Blanks a message's text and marks it deleted, by `by` (the row stays, so paging and "already answered" still work). */
  markMessageDeleted(wid: string, id: string, by?: string): Promise<StoredMessage | null>;
  /** Forgets everything: the hosted demo's nightly reset starts from an empty store and seeds it again. */
  clearAll(): Promise<void>;
  close(): Promise<void>;
}

const clone = <T>(v: T): T => structuredClone(v);

/** The row a deleted message leaves behind. */
export const tombstone = (m: ChatMessage, by?: string): StoredMessage => ({ ...m, text: '', mentions: [], deleted: true, ...(by ? { deletedBy: by } : {}) });

/** Non-persistent store for development and tests. */
export class MemoryStore implements Store {
  private ws = new Map<string, WorkspaceDoc>();
  private members = new Map<string, Map<string, MemberDoc>>();
  private maps = new Map<string, WorkspaceMap>();
  private msgs = new Map<string, ChatMessage[]>();
  private sessions = new Map<string, Map<string, SessionInfo>>();
  private threads = new Map<string, Map<string, WorkThread>>();

  /** `maxMessages`: how many messages to keep per workspace (the oldest go first). */
  constructor(private maxMessages = 5000) {}

  async getWorkspace(id: string) {
    const d = this.ws.get(id);
    return d ? clone(d) : null;
  }
  async putWorkspace(doc: WorkspaceDoc) {
    // Like the database store: renaming the workspace keeps when it was created.
    this.ws.set(doc.id, clone({ ...doc, createdAt: this.ws.get(doc.id)?.createdAt ?? doc.createdAt }));
  }
  async listMembers(wid: string) {
    return [...(this.members.get(wid)?.values() ?? [])].map(clone);
  }
  async putMember(wid: string, m: MemberDoc) {
    let g = this.members.get(wid);
    if (!g) this.members.set(wid, (g = new Map()));
    g.set(m.uid, clone(m));
  }
  async deleteMember(wid: string, uid: string) {
    this.members.get(wid)?.delete(uid);
  }
  async touchMember(wid: string, uid: string, lastSeen: number) {
    const m = this.members.get(wid)?.get(uid);
    if (m) m.lastSeen = lastSeen;
  }
  async loadMap(wid: string) {
    const m = this.maps.get(wid);
    return m ? clone(m) : null;
  }
  async saveMap(wid: string, map: WorkspaceMap) {
    this.maps.set(wid, clone(map));
  }
  async listSessions(wid: string) {
    const list = [...(this.sessions.get(wid)?.values() ?? [])].map(clone);
    list.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return list;
  }
  async listThreads(wid: string) {
    const list = [...(this.threads.get(wid)?.values() ?? [])].map(clone);
    list.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return list;
  }
  async putThread(wid: string, t: WorkThread) {
    let g = this.threads.get(wid);
    if (!g) this.threads.set(wid, (g = new Map()));
    g.set(t.id, clone(t));
  }
  async putSession(wid: string, s: SessionInfo) {
    let g = this.sessions.get(wid);
    if (!g) this.sessions.set(wid, (g = new Map()));
    g.set(s.id, clone(s));
  }
  async deleteSession(wid: string, id: string) {
    this.sessions.get(wid)?.delete(id);
    const msgs = this.msgs.get(wid);
    if (msgs) {
      if (id === 'legacy') {
        this.msgs.set(wid, msgs.filter((m) => m.session !== undefined && m.session !== null && m.session !== 'legacy'));
      } else {
        this.msgs.set(wid, msgs.filter((m) => m.session !== id));
      }
    }
  }

  private list(wid: string) {
    let l = this.msgs.get(wid);
    if (!l) this.msgs.set(wid, (l = []));
    return l;
  }
  async listMessages(wid: string, { session, before, limit }: { session?: string | null; before?: HistoryCursor; limit: number }) {
    let all = this.list(wid);
    if (session === null || session === 'legacy') {
      all = all.filter((m) => m.session === undefined || m.session === null || m.session === 'legacy');
    } else if (typeof session === 'string') {
      all = all.filter((m) => m.session === session);
    }
    const older = before ? all.filter((m) => compareMessages(m, before) < 0) : all;
    const page = older.slice(Math.max(0, older.length - limit));
    return { messages: page.map(clone), hasMore: older.length > page.length };
  }
  async getMessage(wid: string, id: string): Promise<StoredMessage | null> {
    const m = this.list(wid).find((x) => x.id === id);
    return m ? clone(m) : null;
  }
  private put(wid: string, msg: ChatMessage) {
    const l = this.list(wid);
    const i = l.findIndex((x) => x.id === msg.id);
    if (i >= 0) l.splice(i, 1);
    l.push(clone(msg));
    l.sort(compareMessages);
    if (l.length > this.maxMessages) l.splice(0, l.length - this.maxMessages);
  }
  async appendMessage(wid: string, msg: ChatMessage) {
    this.put(wid, msg);
  }
  async insertMessage(wid: string, msg: ChatMessage) {
    if (this.list(wid).some((x) => x.id === msg.id)) return false;
    this.put(wid, msg);
    return true;
  }
  async insertMessageOnce(wid: string, msg: ChatMessage, opts?: { reviveBy?: string }) {
    const existing = this.list(wid).find((x) => x.id === msg.id) as StoredMessage | undefined;
    if (existing && !(existing.deleted && opts?.reviveBy !== undefined && existing.deletedBy === opts.reviveBy)) return false;
    this.put(wid, msg);
    return true;
  }
  async markMessageDeleted(wid: string, id: string, by?: string) {
    const l = this.list(wid);
    const i = l.findIndex((x) => x.id === id);
    if (i < 0) return null;
    l[i] = tombstone(l[i], by);
    return clone(l[i]) as StoredMessage;
  }
  async clearAll() {
    for (const m of [this.ws, this.members, this.maps, this.msgs, this.sessions, this.threads] as Map<string, unknown>[]) m.clear();
  }
  async close() {}
}

const PRUNE_EVERY_MS = 3600 * 1000;

/** The slice of a Postgres client the store needs: `pg`'s pool, PGlite (tests) or anything shaped like them. */
export interface SqlClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query(text: string, params?: any[]): Promise<{ rows: any[] }>;
}

/** What must exist for the server to work. */
const TABLES = [
  `CREATE TABLE IF NOT EXISTS tm_workspace (id text PRIMARY KEY, name text NOT NULL, created_at bigint NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS tm_member (workspace_id text NOT NULL, uid text NOT NULL, data jsonb NOT NULL, PRIMARY KEY (workspace_id, uid))`,
  // The map is one JSON document: large, always loaded whole, never queried by field.
  `CREATE TABLE IF NOT EXISTS tm_doc (workspace_id text NOT NULL, kind text NOT NULL, data jsonb NOT NULL, updated_at bigint NOT NULL, PRIMARY KEY (workspace_id, kind))`,
  `CREATE TABLE IF NOT EXISTS tm_message (id text PRIMARY KEY, workspace_id text NOT NULL, at bigint NOT NULL, data jsonb NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS tm_session (workspace_id text NOT NULL, id text NOT NULL, room_id text NOT NULL, state text NOT NULL, created_at bigint NOT NULL, archived_at bigint, created_by text NOT NULL, PRIMARY KEY (workspace_id, id))`,
  `CREATE TABLE IF NOT EXISTS tm_thread (workspace_id text NOT NULL, id text NOT NULL, state text NOT NULL, updated_at bigint NOT NULL, data jsonb NOT NULL, PRIMARY KEY (workspace_id, id))`,
];

/** Faster paging. A table that is already large can take longer to index than a query may run: that is logged, and the server still starts. */
const INDEXES = [
  `CREATE INDEX IF NOT EXISTS tm_message_room_at ON tm_message (workspace_id, at DESC)`,
  // Paging orders by (at, id) with the byte-wise "C" collation, the same order JavaScript uses.
  `CREATE INDEX IF NOT EXISTS tm_message_room_at_id ON tm_message (workspace_id, at DESC, id COLLATE "C" DESC)`,
  `CREATE INDEX IF NOT EXISTS tm_message_session ON tm_message (workspace_id, (data->>'session'), at DESC, id COLLATE "C" DESC)`,
];

const json = (v: unknown) => JSON.stringify(v);

/** Postgres persistence: the `team` database of the project's Cloud SQL instance. Tables are created on first use. */
export class PostgresStore implements Store {
  private ready: Promise<void>;
  private lastPrune = 0;

  /** `retentionMs`: delete chat older than this; 0 (the default) keeps all of it. */
  constructor(
    private db: SqlClient,
    private closeDb: () => Promise<void> = async () => {},
    private now: () => number = Date.now,
    private retentionMs = 0,
  ) {
    this.ready = this.init();
    // A failure is reported to whoever uses the store (or `whenReady`), not as an unhandled rejection.
    this.ready.catch(() => {});
  }

  /** Connects to Postgres with `pg` (the Cloud Run Cloud SQL socket URL works as is). */
  static connect(url: string, retentionMs = 0): PostgresStore {
    // Timeouts so a stalled Cloud SQL connection fails (and is reported) instead of hanging chat for everyone.
    const pool = import('pg').then(({ default: pg }) => {
      const p = new pg.Pool({ connectionString: url, max: 4, connectionTimeoutMillis: 5000, statement_timeout: 5000, query_timeout: 6000 });
      // A connection that Cloud SQL closes while it is idle (maintenance, a failover) is reported on the pool. Without a listener
      // that is an uncaught error and ends the process; the pool simply opens another connection when one is needed.
      p.on('error', (e) => log.error('database connection error', { err: String(e) }));
      return p;
    });
    return new PostgresStore(
      { query: async (text, params) => (await pool).query(text, params) },
      async () => (await pool).end(),
      Date.now,
      retentionMs,
    );
  }

  /** Resolves once the tables exist; rejects if the database cannot be reached. */
  whenReady(): Promise<void> {
    return this.ready;
  }

  /** The one SQL client this store runs on, so another store (board, pages) can share the connection instead of opening a second pool. */
  get sql(): SqlClient {
    return this.db;
  }

  private async init() {
    for (const statement of TABLES) await this.db.query(statement);
    for (const statement of INDEXES) await this.db.query(statement).catch((e) => log.error('creating an index failed', { err: String(e) }));
    await this.prune();
  }

  /** Never throws: a failed prune must not stop the server from starting or fail a save that already succeeded. */
  private async prune() {
    this.lastPrune = this.now();
    if (this.retentionMs <= 0) return;
    try {
      await this.db.query('DELETE FROM tm_message WHERE at < $1', [Math.floor(this.now() - this.retentionMs)]);
    } catch (e) {
      log.error('removing old chat failed', { err: String(e) });
    }
  }

  private async q(text: string, params?: unknown[]) {
    await this.ready;
    return (await this.db.query(text, params)).rows;
  }

  async getWorkspace(id: string) {
    const [row] = await this.q('SELECT id, name, created_at FROM tm_workspace WHERE id = $1', [id]);
    return row ? ({ id: row.id, name: row.name, createdAt: Number(row.created_at) } as WorkspaceDoc) : null;
  }
  async putWorkspace(doc: WorkspaceDoc) {
    await this.q('INSERT INTO tm_workspace (id, name, created_at) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name', [doc.id, doc.name, doc.createdAt]);
  }
  async listMembers(wid: string) {
    return (await this.q('SELECT data FROM tm_member WHERE workspace_id = $1', [wid])).map((r) => r.data as MemberDoc);
  }
  async putMember(wid: string, m: MemberDoc) {
    await this.q('INSERT INTO tm_member (workspace_id, uid, data) VALUES ($1, $2, $3::jsonb) ON CONFLICT (workspace_id, uid) DO UPDATE SET data = EXCLUDED.data', [wid, m.uid, json(m)]);
  }
  async deleteMember(wid: string, uid: string) {
    await this.q('DELETE FROM tm_member WHERE workspace_id = $1 AND uid = $2', [wid, uid]);
  }
  async touchMember(wid: string, uid: string, lastSeen: number) {
    await this.q(`UPDATE tm_member SET data = jsonb_set(data, '{lastSeen}', $3::jsonb) WHERE workspace_id = $1 AND uid = $2`, [wid, uid, JSON.stringify(lastSeen)]);
  }

  private async loadDoc<T>(wid: string, kind: string): Promise<T | null> {
    const [row] = await this.q('SELECT data FROM tm_doc WHERE workspace_id = $1 AND kind = $2', [wid, kind]);
    return row ? (row.data as T) : null;
  }
  private async saveDoc(wid: string, kind: string, doc: unknown) {
    await this.q(
      'INSERT INTO tm_doc (workspace_id, kind, data, updated_at) VALUES ($1, $2, $3::jsonb, $4) ON CONFLICT (workspace_id, kind) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at',
      [wid, kind, json(doc), this.now()],
    );
  }

  loadMap(wid: string) {
    return this.loadDoc<WorkspaceMap>(wid, 'map');
  }
  saveMap(wid: string, map: WorkspaceMap) {
    return this.saveDoc(wid, 'map', map);
  }

  async listSessions(wid: string): Promise<SessionInfo[]> {
    const rows = await this.q(
      'SELECT id, room_id, state, created_at, archived_at, created_by FROM tm_session WHERE workspace_id = $1 ORDER BY created_at ASC, id ASC',
      [wid],
    );
    return rows.map((r) => ({
      id: r.id,
      room: r.room_id,
      state: r.state as SessionInfo['state'],
      createdAt: Number(r.created_at),
      ...(r.archived_at !== null && r.archived_at !== undefined ? { archivedAt: Number(r.archived_at) } : {}),
      createdBy: r.created_by,
      ...(r.id === 'legacy' ? { legacy: true } : {}),
    }));
  }
  async putSession(wid: string, s: SessionInfo): Promise<void> {
    await this.q(
      `INSERT INTO tm_session (workspace_id, id, room_id, state, created_at, archived_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (workspace_id, id) DO UPDATE SET
         room_id = EXCLUDED.room_id,
         state = EXCLUDED.state,
         archived_at = EXCLUDED.archived_at`,
      [wid, s.id, s.room, s.state, s.createdAt, s.archivedAt ?? null, s.createdBy],
    );
  }
  async listThreads(wid: string): Promise<WorkThread[]> {
    const rows = await this.q('SELECT data FROM tm_thread WHERE workspace_id = $1 ORDER BY updated_at ASC, id ASC', [wid]);
    return rows.map((r) => r.data as WorkThread);
  }
  async putThread(wid: string, t: WorkThread): Promise<void> {
    await this.q(
      `INSERT INTO tm_thread (workspace_id, id, state, updated_at, data) VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (workspace_id, id) DO UPDATE SET state = EXCLUDED.state, updated_at = EXCLUDED.updated_at, data = EXCLUDED.data`,
      [wid, t.id, t.state, t.updatedAt, json(t)],
    );
  }
  async deleteSession(wid: string, id: string): Promise<void> {
    await this.q('DELETE FROM tm_session WHERE workspace_id = $1 AND id = $2', [wid, id]);
    if (id === 'legacy') {
      await this.q(`DELETE FROM tm_message WHERE workspace_id = $1 AND (data->>'session' IS NULL OR data->>'session' = 'legacy')`, [wid]);
    } else {
      await this.q(`DELETE FROM tm_message WHERE workspace_id = $1 AND data->>'session' = $2`, [wid, id]);
    }
  }

  async listMessages(wid: string, { session, before, limit }: { session?: string | null; before?: HistoryCursor; limit: number }) {
    const conds = ['workspace_id = $1'];
    const params: unknown[] = [wid];

    if (session === null || session === 'legacy') {
      conds.push(`(data->>'session' IS NULL OR data->>'session' = 'legacy')`);
    } else if (typeof session === 'string') {
      params.push(session);
      conds.push(`data->>'session' = $${params.length}`);
    }

    if (before) {
      params.push(before.at, before.id);
      conds.push(`(at, id COLLATE "C") < ($${params.length - 1}::bigint, $${params.length}::text COLLATE "C")`);
    }

    params.push(limit + 1);
    const sql = `SELECT data FROM tm_message WHERE ${conds.join(' AND ')} ORDER BY at DESC, id COLLATE "C" DESC LIMIT $${params.length}`;
    const rows = await this.q(sql, params);
    return { messages: rows.slice(0, limit).map((r) => r.data as ChatMessage).reverse(), hasMore: rows.length > limit };
  }
  async getMessage(wid: string, id: string): Promise<StoredMessage | null> {
    const [row] = await this.q('SELECT data FROM tm_message WHERE workspace_id = $1 AND id = $2', [wid, id]);
    return row ? (row.data as StoredMessage) : null;
  }
  async appendMessage(wid: string, msg: ChatMessage) {
    await this.q('INSERT INTO tm_message (id, workspace_id, at, data) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, at = EXCLUDED.at', [msg.id, wid, msg.at, json(msg)]);
    // With a retention limit, old chat is removed as new chat arrives (at most once an hour), so no scheduled job is needed.
    if (this.retentionMs > 0 && this.now() - this.lastPrune > PRUNE_EVERY_MS) await this.prune();
  }
  async insertMessage(wid: string, msg: ChatMessage) {
    const rows = await this.q('INSERT INTO tm_message (id, workspace_id, at, data) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (id) DO NOTHING RETURNING id', [msg.id, wid, msg.at, json(msg)]);
    return rows.length > 0;
  }
  async insertMessageOnce(wid: string, msg: ChatMessage, opts?: { reviveBy?: string }) {
    const rows = await this.q(
      `INSERT INTO tm_message (id, workspace_id, at, data) VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, at = EXCLUDED.at
         WHERE tm_message.data->>'deleted' = 'true' AND $5::text IS NOT NULL AND tm_message.data->>'deletedBy' = $5::text
       RETURNING id`,
      [msg.id, wid, msg.at, json(msg), opts?.reviveBy ?? null],
    );
    return rows.length > 0;
  }
  async markMessageDeleted(wid: string, id: string, by?: string) {
    const current = await this.getMessage(wid, id);
    if (!current) return null;
    const gone = tombstone(current, by);
    await this.q('UPDATE tm_message SET data = $3::jsonb WHERE workspace_id = $1 AND id = $2', [wid, id, json(gone)]);
    return gone;
  }

  async clearAll() {
    await this.q('TRUNCATE tm_workspace, tm_member, tm_doc, tm_message, tm_session, tm_thread');
  }

  async close() {
    await this.ready.catch(() => {});
    await this.closeDb();
  }
}

export function createStore(cfg: Config): Store {
  return cfg.store === 'postgres' ? PostgresStore.connect(cfg.databaseUrl, cfg.chatRetentionDays * 24 * 3600 * 1000) : new MemoryStore();
}
