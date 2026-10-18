import type { Issue } from './shared/board/types.ts';
import type { Page } from './shared/pages/types.ts';
import type { Artifact, AuditEvent } from './shared/pipeline/types.ts';
import { log } from './log.ts';
import { PostgresStore } from './store.ts';
import type { SqlClient, Store } from './store.ts';

/**
 * The board (issues) and the docs (pages): rows the team server owns. Kept out of `Store`, which holds the office's
 * chat and map, so collaboration can grow without putting those at risk. A Postgres
 * collab store shares the office store's connection (`PostgresStore.sql`): one pool per server, as before.
 */
/** A picture kept for a ticket (base64 text, so any database holds it the same way). */
export interface AssetRow {
  id: string;
  mime: string;
  size: number;
  createdBy: string;
  createdAt: number;
  data: string;
}

export interface CollabStore {
  getAsset(projectId: string, id: string): Promise<AssetRow | null>;
  putAsset(projectId: string, asset: AssetRow): Promise<void>;
  deleteAsset(projectId: string, id: string): Promise<void>;
  /** How many pictures a project keeps and how many bytes (for its limits). */
  assetUsage(projectId: string): Promise<{ count: number; bytes: number }>;
  listIssues(projectId: string): Promise<Issue[]>;
  getIssue(projectId: string, id: string): Promise<Issue | null>;
  putIssue(projectId: string, issue: Issue): Promise<void>;
  deleteIssue(projectId: string, id: string): Promise<void>;
  listPages(projectId: string): Promise<Page[]>;
  getPage(projectId: string, id: string): Promise<Page | null>;
  putPage(projectId: string, page: Page): Promise<void>;
  deletePage(projectId: string, id: string): Promise<void>;
  /** The delivery pipeline's artifacts (immutable apart from their state) and its audit trail. */
  listArtifacts(projectId: string, ticket?: string): Promise<Artifact[]>;
  getArtifact(projectId: string, id: string): Promise<Artifact | null>;
  putArtifact(projectId: string, artifact: Artifact): Promise<void>;
  appendAudit(projectId: string, event: AuditEvent, keep: number): Promise<void>;
  /** Newest last. */
  listAudit(projectId: string, limit: number): Promise<AuditEvent[]>;
  /** Forgets everything (the hosted demo's nightly reset). */
  clearAll(): Promise<void>;
}

const clone = <T>(v: T): T => structuredClone(v);

/** Issues in board order: by column order, ties by id (byte-wise, the same order JavaScript uses). */
export const sortIssues = (issues: Issue[]): Issue[] =>
  [...issues].sort((a, b) => a.status.localeCompare(b.status) || a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/** Pages in tree order: siblings by order, ties by id. */
export const sortPages = (pages: Page[]): Page[] =>
  [...pages].sort((a, b) => (a.parent ?? '').localeCompare(b.parent ?? '') || a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/** Non-persistent store for development and tests. */
export class MemoryCollabStore implements CollabStore {
  private issues = new Map<string, Map<string, Issue>>();
  private pages = new Map<string, Map<string, Page>>();
  private assets = new Map<string, Map<string, AssetRow>>();
  private artifacts = new Map<string, Map<string, Artifact>>();
  private audit = new Map<string, AuditEvent[]>();

  private group<T>(all: Map<string, Map<string, T>>, projectId: string) {
    let g = all.get(projectId);
    if (!g) all.set(projectId, (g = new Map()));
    return g;
  }

  async clearAll() {
    this.issues.clear();
    this.pages.clear();
    this.assets.clear();
    this.artifacts.clear();
    this.audit.clear();
  }

  async listArtifacts(projectId: string, ticket?: string) {
    return [...(this.artifacts.get(projectId)?.values() ?? [])].filter((a) => !ticket || a.ticket === ticket).sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1)).map(clone);
  }
  async getArtifact(projectId: string, id: string) {
    const a = this.artifacts.get(projectId)?.get(id);
    return a ? clone(a) : null;
  }
  async putArtifact(projectId: string, artifact: Artifact) {
    this.group(this.artifacts, projectId).set(artifact.id, clone(artifact));
  }
  async appendAudit(projectId: string, event: AuditEvent, keep: number) {
    const list = this.audit.get(projectId) ?? [];
    list.push(clone(event));
    this.audit.set(projectId, list.slice(-keep));
  }
  async listAudit(projectId: string, limit: number) {
    return (this.audit.get(projectId) ?? []).slice(-limit).map(clone);
  }

  async getAsset(projectId: string, id: string) {
    const a = this.assets.get(projectId)?.get(id);
    return a ? clone(a) : null;
  }
  async putAsset(projectId: string, asset: AssetRow) {
    this.group(this.assets, projectId).set(asset.id, clone(asset));
  }
  async deleteAsset(projectId: string, id: string) {
    this.assets.get(projectId)?.delete(id);
  }
  async assetUsage(projectId: string) {
    const all = [...(this.assets.get(projectId)?.values() ?? [])];
    return { count: all.length, bytes: all.reduce((n, a) => n + a.size, 0) };
  }

  async listIssues(projectId: string) {
    return sortIssues([...this.group(this.issues, projectId).values()].map(clone));
  }
  async getIssue(projectId: string, id: string) {
    const issue = this.issues.get(projectId)?.get(id);
    return issue ? clone(issue) : null;
  }
  async putIssue(projectId: string, issue: Issue) {
    this.group(this.issues, projectId).set(issue.id, clone(issue));
  }
  async deleteIssue(projectId: string, id: string) {
    this.issues.get(projectId)?.delete(id);
  }

  async listPages(projectId: string) {
    return sortPages([...this.group(this.pages, projectId).values()].map(clone));
  }
  async getPage(projectId: string, id: string) {
    const page = this.pages.get(projectId)?.get(id);
    return page ? clone(page) : null;
  }
  async putPage(projectId: string, page: Page) {
    this.group(this.pages, projectId).set(page.id, clone(page));
  }
  async deletePage(projectId: string, id: string) {
    this.pages.get(projectId)?.delete(id);
  }
}

const TABLES = [
  `CREATE TABLE IF NOT EXISTS tm_asset (project_id text NOT NULL, id text NOT NULL, mime text NOT NULL, size integer NOT NULL, created_by text NOT NULL, created_at bigint NOT NULL, data text NOT NULL, PRIMARY KEY (project_id, id))`,
  `CREATE TABLE IF NOT EXISTS tm_issue (project_id text NOT NULL, id text NOT NULL, status text NOT NULL, assignee text, sprint_id text, updated_at bigint NOT NULL, data jsonb NOT NULL, PRIMARY KEY (project_id, id))`,
  `CREATE TABLE IF NOT EXISTS tm_sprint (project_id text NOT NULL, id text NOT NULL, state text NOT NULL, updated_at bigint NOT NULL, data jsonb NOT NULL, PRIMARY KEY (project_id, id))`,
  `CREATE TABLE IF NOT EXISTS tm_page (project_id text NOT NULL, id text NOT NULL, parent_id text, updated_at bigint NOT NULL, data jsonb NOT NULL, PRIMARY KEY (project_id, id))`,
  `CREATE TABLE IF NOT EXISTS tm_artifact (project_id text NOT NULL, id text NOT NULL, ticket text NOT NULL, kind text NOT NULL, state text NOT NULL, created_at bigint NOT NULL, data jsonb NOT NULL, PRIMARY KEY (project_id, id))`,
  `CREATE TABLE IF NOT EXISTS tm_audit (project_id text NOT NULL, id text NOT NULL, at bigint NOT NULL, data jsonb NOT NULL, PRIMARY KEY (project_id, id))`,
];

/** Faster filtering later (by status, by assignee, by sprint, by parent). A failure is logged; the server still starts. */
const INDEXES = [
  `CREATE INDEX IF NOT EXISTS tm_issue_board ON tm_issue (project_id, status, assignee)`,
  `CREATE INDEX IF NOT EXISTS tm_issue_sprint ON tm_issue (project_id, sprint_id)`,
  `CREATE INDEX IF NOT EXISTS tm_page_parent ON tm_page (project_id, parent_id)`,
  `CREATE INDEX IF NOT EXISTS tm_artifact_ticket ON tm_artifact (project_id, ticket, kind)`,
  `CREATE INDEX IF NOT EXISTS tm_audit_at ON tm_audit (project_id, at)`,
];

const json = (v: unknown) => JSON.stringify(v);

/**
 * Postgres persistence for the board and the pages. Hot fields (status, assignee, sprint, parent, time) are columns so
 * they can be queried and indexed; the whole object stays in `data`, which is what every read returns, so a column can
 * never drift from the row.
 */
export class PostgresCollabStore implements CollabStore {
  private ready: Promise<void>;

  constructor(private db: SqlClient) {
    this.ready = this.init();
    // A failure is reported to whoever asks (every query waits for `ready`), not as an unhandled rejection.
    this.ready.catch(() => {});
  }

  /** Resolves once the tables exist; rejects if the database cannot be reached. */
  whenReady(): Promise<void> {
    return this.ready;
  }

  private async init() {
    for (const statement of TABLES) await this.db.query(statement);
    for (const statement of INDEXES) await this.db.query(statement).catch((e) => log.error('creating a collaboration index failed', { err: String(e) }));
  }

  private async q(text: string, params?: unknown[]) {
    await this.ready;
    return (await this.db.query(text, params)).rows;
  }

  async clearAll() {
    await this.q('TRUNCATE tm_asset, tm_issue, tm_page, tm_artifact, tm_audit');
  }

  async getAsset(projectId: string, id: string) {
    const [r] = await this.q('SELECT id, mime, size, created_by, created_at, data FROM tm_asset WHERE project_id = $1 AND id = $2', [projectId, id]);
    return r ? { id: r.id as string, mime: r.mime as string, size: Number(r.size), createdBy: r.created_by as string, createdAt: Number(r.created_at), data: r.data as string } : null;
  }
  async putAsset(projectId: string, a: AssetRow) {
    await this.q(
      `INSERT INTO tm_asset (project_id, id, mime, size, created_by, created_at, data) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (project_id, id) DO NOTHING`,
      [projectId, a.id, a.mime, a.size, a.createdBy, a.createdAt, a.data],
    );
  }
  async deleteAsset(projectId: string, id: string) {
    await this.q('DELETE FROM tm_asset WHERE project_id = $1 AND id = $2', [projectId, id]);
  }
  async assetUsage(projectId: string) {
    const [r] = await this.q('SELECT count(*)::int AS n, coalesce(sum(size), 0)::bigint AS bytes FROM tm_asset WHERE project_id = $1', [projectId]);
    return { count: Number(r?.n ?? 0), bytes: Number(r?.bytes ?? 0) };
  }

  async listIssues(projectId: string) {
    return sortIssues((await this.q('SELECT data FROM tm_issue WHERE project_id = $1', [projectId])).map((r) => r.data as Issue));
  }
  async getIssue(projectId: string, id: string) {
    const [row] = await this.q('SELECT data FROM tm_issue WHERE project_id = $1 AND id = $2', [projectId, id]);
    return row ? (row.data as Issue) : null;
  }
  async putIssue(projectId: string, issue: Issue) {
    await this.q(
      `INSERT INTO tm_issue (project_id, id, status, assignee, updated_at, data)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (project_id, id) DO UPDATE SET
         status = EXCLUDED.status, assignee = EXCLUDED.assignee,
         updated_at = EXCLUDED.updated_at, data = EXCLUDED.data`,
      [projectId, issue.id, issue.status, issue.assignee, issue.updatedAt, json(issue)],
    );
  }
  async deleteIssue(projectId: string, id: string) {
    await this.q('DELETE FROM tm_issue WHERE project_id = $1 AND id = $2', [projectId, id]);
  }

  async listPages(projectId: string) {
    return sortPages((await this.q('SELECT data FROM tm_page WHERE project_id = $1', [projectId])).map((r) => r.data as Page));
  }
  async getPage(projectId: string, id: string) {
    const [row] = await this.q('SELECT data FROM tm_page WHERE project_id = $1 AND id = $2', [projectId, id]);
    return row ? (row.data as Page) : null;
  }
  async putPage(projectId: string, page: Page) {
    await this.q(
      `INSERT INTO tm_page (project_id, id, parent_id, updated_at, data) VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (project_id, id) DO UPDATE SET parent_id = EXCLUDED.parent_id, updated_at = EXCLUDED.updated_at, data = EXCLUDED.data`,
      [projectId, page.id, page.parent, page.updatedAt, json(page)],
    );
  }
  async deletePage(projectId: string, id: string) {
    await this.q('DELETE FROM tm_page WHERE project_id = $1 AND id = $2', [projectId, id]);
  }

  async listArtifacts(projectId: string, ticket?: string) {
    const rows = ticket
      ? await this.q('SELECT data FROM tm_artifact WHERE project_id = $1 AND ticket = $2 ORDER BY created_at, id', [projectId, ticket])
      : await this.q('SELECT data FROM tm_artifact WHERE project_id = $1 ORDER BY created_at, id', [projectId]);
    return rows.map((r) => r.data as Artifact);
  }
  async getArtifact(projectId: string, id: string) {
    const [row] = await this.q('SELECT data FROM tm_artifact WHERE project_id = $1 AND id = $2', [projectId, id]);
    return row ? (row.data as Artifact) : null;
  }
  async putArtifact(projectId: string, a: Artifact) {
    await this.q(
      `INSERT INTO tm_artifact (project_id, id, ticket, kind, state, created_at, data) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (project_id, id) DO UPDATE SET state = EXCLUDED.state, data = EXCLUDED.data`,
      [projectId, a.id, a.ticket, a.kind, a.state, a.createdAt, json(a)],
    );
  }
  async appendAudit(projectId: string, e: AuditEvent, keep: number) {
    await this.q('INSERT INTO tm_audit (project_id, id, at, data) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (project_id, id) DO NOTHING', [projectId, e.id, e.at, json(e)]);
    await this.q('DELETE FROM tm_audit WHERE project_id = $1 AND id IN (SELECT id FROM tm_audit WHERE project_id = $1 ORDER BY at DESC, id DESC OFFSET $2)', [projectId, keep]);
  }
  async listAudit(projectId: string, limit: number) {
    const rows = await this.q('SELECT data FROM (SELECT data, at, id FROM tm_audit WHERE project_id = $1 ORDER BY at DESC, id DESC LIMIT $2) t ORDER BY at, id', [projectId, limit]);
    return rows.map((r) => r.data as AuditEvent);
  }
}

/** The collab store that fits the office store: memory tests get memory, a Postgres server shares its connection. */
export function createCollabStore(store: Store): CollabStore {
  return store instanceof PostgresStore ? new PostgresCollabStore(store.sql) : new MemoryCollabStore();
}
