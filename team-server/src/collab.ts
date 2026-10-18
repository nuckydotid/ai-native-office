import { randomBytes } from 'node:crypto';
import { parseIssueInput, parseIssuePatch, readIfUpdatedAt } from './shared/board/protocol.ts';
import { BOARD_LIMITS } from './shared/board/types.ts';
import type { Issue, IssueEvent } from './shared/board/types.ts';
import { statusForStage } from './shared/pipeline/types.ts';
import type { PipelineStage } from './shared/pipeline/types.ts';
import { parsePageInput, parsePagePatch, readIfUpdatedAt as readPageIfUpdatedAt } from './shared/pages/protocol.ts';
import { PAGES_LIMITS } from './shared/pages/types.ts';
import type { Page } from './shared/pages/types.ts';
import type { AssetRow, CollabStore } from './collab-store.ts';

/** A refusal the routes turn into a status and a sentence. */
export class CollabError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 403 | 404 | 409 = 400,
  ) {
    super(message);
  }
}

const notFound = (what: string) => new CollabError('not_found', `That ${what} is not on this project.`, 404);

/**
 * The rules of the board and the docs: what a payload may become, what a team may do to someone else's work, and how
 * the page tree stays a tree. The store only writes rows; everything a person can get wrong is decided here, on the
 * server, where every window sees the same answer.
 */
export class Collab {
  /** Told after every change (what changed and which ids), so the people who are connected can read it again. Never throws. */
  onChange?: (kind: 'board' | 'pages', ids: string[]) => void;
  /** Whether a worktree tab is still open (an issue that one is working on is not deleted from under it). Set by the server. */
  isThreadLive?: (id: string) => Promise<boolean>;
  /** Whether tickets made now join the delivery pipeline (their stage decides their status). Set from the configuration. */
  pipelineTickets = false;
  /** Numbering of tickets saved before they had numbers: one at a time, so two readers never number the same ones twice. */
  private numbering: Promise<void> | null = null;

  constructor(
    private store: CollabStore,
    private now: () => number = Date.now,
  ) {}

  private changed(kind: 'board' | 'pages', ids: string[]) {
    try {
      this.onChange?.(kind, ids);
    } catch {
      // A listener that fails must not fail the change that was already saved.
    }
  }

  private newId(prefix: string) {
    return `${prefix}-${this.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  }

  /* ───────────── the board ───────────── */

  /** A ticket as it should be read: the fields added since it was saved have their defaults (`backlog` is the todo column). */
  private normal(i: Issue): Issue {
    return {
      ...i,
      status: (i.status as string) === 'backlog' ? 'todo' : i.status,
      key: i.key ?? 0,
      docs: i.docs ?? [],
      thread: i.thread ?? null,
      branch: i.branch ?? null,
      pr: i.pr ?? null,
      prInfo: i.prInfo ?? null,
      links: i.links ?? [],
      images: i.images ?? [],
      threads: i.threads ?? (i.thread ? [i.thread] : []),
      activity: i.activity ?? [],
    };
  }

  /** Gives every ticket without a number the next one, oldest first (a board saved before numbers existed). */
  private async number(projectId: string): Promise<Issue[]> {
    const issues = (await this.store.listIssues(projectId)).map((i) => this.normal(i));
    if (issues.every((i) => i.key > 0)) return issues;
    // One numbering at a time: a second reader waits for the first and then finds nothing left to number.
    while (this.numbering) await this.numbering.catch(() => {});
    const run = (async () => {
      const fresh = (await this.store.listIssues(projectId)).map((i) => this.normal(i));
      let top = Math.max(0, ...fresh.map((i) => i.key));
      for (const i of fresh.filter((x) => x.key === 0).sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))) {
        top += 1;
        await this.store.putIssue(projectId, { ...i, key: top });
      }
    })();
    this.numbering = run;
    try {
      await run;
    } finally {
      this.numbering = null;
    }
    return (await this.store.listIssues(projectId)).map((i) => this.normal(i));
  }

  async board(projectId: string): Promise<{ issues: Issue[] }> {
    return { issues: await this.number(projectId) };
  }

  /** The two rules of the columns: In Progress needs someone on it, In Review needs a pull request. */
  private checkColumns(issue: Pick<Issue, 'status' | 'assignee' | 'pr'>) {
    if (issue.status === 'in_progress' && !issue.assignee) throw new CollabError('needs_assignee', 'Put this ticket on someone before moving it to In Progress.');
    if (issue.status === 'review' && !issue.pr) throw new CollabError('needs_pr', 'A ticket is in review only with a pull request. Open one first.');
  }

  /** Only the page ids that exist (a link to a doc that was deleted is never stored). */
  private async existingDocs(projectId: string, ids: readonly string[]): Promise<string[]> {
    const found: string[] = [];
    for (const id of ids) if (await this.store.getPage(projectId, id)) found.push(id);
    return found;
  }

  /** Only the pictures that this project keeps. */
  private async existingAssets(projectId: string, ids: readonly string[]): Promise<string[]> {
    const found: string[] = [];
    for (const id of ids) if (await this.store.getAsset(projectId, id)) found.push(id);
    return found;
  }

  /** What changed in a patch, as lines for the ticket's history. */
  private events(before: Issue, patch: Partial<Issue>, uid: string, at: number): IssueEvent[] {
    const out: IssueEvent[] = [];
    const say = (kind: IssueEvent['kind'], text: string) => out.push({ at, by: uid, kind, text });
    if (patch.status && patch.status !== before.status) say('status', `Moved from ${before.status.replace('_', ' ')} to ${patch.status.replace('_', ' ')}.`);
    if (patch.thread !== undefined && patch.thread !== before.thread) say('work', patch.thread ? 'A worktree tab started on this ticket.' : 'The worktree tab was closed.');
    if (patch.branch !== undefined && patch.branch !== before.branch && patch.branch) say('work', `Working on branch ${patch.branch}.`);
    if (patch.pr !== undefined && patch.pr !== before.pr && patch.pr) say('pr', 'A pull request was opened.');
    if (patch.prInfo && patch.prInfo.state !== before.prInfo?.state) say('pr', `Pull request #${patch.prInfo.number} is ${patch.prInfo.state}.`);
    if (patch.assignee !== undefined && patch.assignee !== before.assignee) say('edit', patch.assignee ? 'Assigned.' : 'Unassigned.');
    return out;
  }

  /** Where a new card goes in a column: after the last one, with room to insert between two. */
  private async endOf(projectId: string, status: Issue['status']): Promise<number> {
    const issues = await this.store.listIssues(projectId);
    return Math.max(0, ...issues.filter((i) => i.status === status).map((i) => i.order)) + 1024;
  }

  async createIssue(projectId: string, uid: string, body: unknown): Promise<Issue> {
    const input = parseIssueInput(body);
    if (!input) throw new CollabError('bad_issue', 'An issue needs a title, and nothing longer than the board allows.');
    const issues = await this.number(projectId);
    if (issues.length >= BOARD_LIMITS.issues) throw new CollabError('board_full', `This board already has ${BOARD_LIMITS.issues} issues. Finish some before adding more.`);
    const at = this.now();
    // A pipeline ticket starts in Plan: its stage decides its status, and nothing but the pipeline moves it.
    const status = this.pipelineTickets ? 'todo' : (input.status ?? 'todo');
    if (!this.pipelineTickets) this.checkColumns({ status, assignee: input.assignee ?? null, pr: null });
    const issue: Issue = {
      id: this.newId('i'),
      key: Math.max(0, ...issues.map((i) => i.key)) + 1,
      title: input.title,
      body: input.body ?? '',
      status,
      priority: input.priority ?? 'medium',
      assignee: input.assignee ?? null,
      labels: input.labels ?? [],
      points: input.points ?? 0,
      order: await this.endOf(projectId, status),
      docs: await this.existingDocs(projectId, input.docs ?? []),
      thread: null,
      branch: null,
      pr: null,
      prInfo: null,
      links: input.links ?? [],
      images: await this.existingAssets(projectId, input.images ?? []),
      threads: [],
      activity: [{ at, by: uid, kind: 'created', text: 'Created the ticket.' }],
      ...(this.pipelineTickets ? { pipeline: { stage: 'plan' as const, mainRev: 'main@0' } } : {}),
      createdBy: uid,
      createdAt: at,
      updatedBy: uid,
      updatedAt: at,
    };
    await this.store.putIssue(projectId, issue);
    this.changed('board', [issue.id]);
    return issue;
  }

  async issue(projectId: string, id: string): Promise<Issue> {
    const issue = await this.store.getIssue(projectId, id);
    if (!issue) throw notFound('issue');
    return this.normal(issue);
  }

  async updateIssue(projectId: string, uid: string, id: string, body: unknown): Promise<Issue> {
    const patch = parseIssuePatch(body);
    if (!patch) throw new CollabError('bad_issue', 'Nothing to change, or a value the board does not allow.');
    const issue = await this.issue(projectId, id);
    const seen = readIfUpdatedAt(body);
    if (seen !== undefined && seen !== issue.updatedAt) throw new CollabError('stale', 'Someone changed this ticket while you were editing it. Look at it again, then make your change.', 409);
    // A pipeline ticket's stage decides its status; the column rules (an assignee, a pull request) are not its rules.
    if (issue.pipeline && patch.status && patch.status !== issue.status) throw new CollabError('pipeline_stage', 'This ticket moves through the pipeline: use Approve & advance on its stage.', 409);
    if (patch.docs) patch.docs = await this.existingDocs(projectId, patch.docs);
    if (patch.images) patch.images = await this.existingAssets(projectId, patch.images);
    // Moving to another column puts the card at the end of that column, unless the client said where it goes.
    if (patch.status && patch.status !== issue.status && patch.order === undefined) patch.order = await this.endOf(projectId, patch.status);
    const at = Math.max(this.now(), issue.updatedAt + 1);
    const next: Issue = { ...issue, ...patch, updatedBy: uid, updatedAt: at };
    if (!issue.pipeline) this.checkColumns(next);
    // Every tab that worked on a ticket stays on it: its chat is the ticket's history.
    if (patch.thread && !(issue.threads ?? []).includes(patch.thread)) next.threads = [...(issue.threads ?? []), patch.thread].slice(-BOARD_LIMITS.threads);
    const events = this.events(issue, patch, uid, at);
    if (events.length) next.activity = [...(issue.activity ?? []), ...events].slice(-BOARD_LIMITS.activity);
    await this.store.putIssue(projectId, next);
    this.changed('board', [id]);
    return next;
  }

  /** The one writer of a pipeline ticket's stage (and, through it, its status). The pipeline service checks the gate before it calls this. */
  async setStage(projectId: string, uid: string, id: string, stage: PipelineStage, mainRev?: string): Promise<Issue> {
    const issue = await this.issue(projectId, id);
    if (!issue.pipeline) throw new CollabError('not_pipeline', 'This ticket is not in the delivery pipeline.', 409);
    const at = Math.max(this.now(), issue.updatedAt + 1);
    const status = statusForStage(stage);
    const from = issue.pipeline.stage;
    const next: Issue = {
      ...issue,
      status,
      order: status !== issue.status ? await this.endOf(projectId, status) : issue.order,
      pipeline: { stage, mainRev: mainRev ?? issue.pipeline.mainRev },
      updatedBy: uid,
      updatedAt: at,
      activity: [...(issue.activity ?? []), { at, by: uid, kind: 'status' as const, text: `Moved from ${from} to ${stage}.` }].slice(-BOARD_LIMITS.activity),
    };
    await this.store.putIssue(projectId, next);
    this.changed('board', [id]);
    return next;
  }

  async deleteIssue(projectId: string, uid: string, id: string, canModerate: boolean): Promise<void> {
    const issue = await this.issue(projectId, id);
    if (issue.createdBy !== uid && !canModerate) throw new CollabError('forbidden', 'Only the person who wrote this issue, a founder or an admin can delete it.', 403);
    if (issue.thread && (await this.isThreadLive?.(issue.thread))) {
      throw new CollabError('in_use', 'A worktree is working on this ticket. Close its tab first, then delete the ticket.', 409);
    }
    await this.store.deleteIssue(projectId, id);
    this.changed('board', [id]);
  }

  /* ───────────── pictures ───────────── */

  /** Keeps a picture a person attached to a ticket: a small image, checked by what its first bytes say it is. */
  async addAsset(projectId: string, uid: string, body: unknown): Promise<{ id: string; mime: string; size: number }> {
    const b = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    const mime = typeof b.mime === 'string' ? b.mime : '';
    const data = typeof b.data === 'string' ? b.data : '';
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime) || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
      throw new CollabError('bad_asset', 'Only PNG, JPEG, GIF and WebP pictures can be attached.');
    }
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length === 0 || bytes.length > BOARD_LIMITS.imageBytes) throw new CollabError('asset_too_big', `A picture can be up to ${BOARD_LIMITS.imageBytes / 1024 / 1024} MB.`);
    const head = bytes.subarray(0, 12);
    const ok =
      (mime === 'image/png' && head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) ||
      (mime === 'image/jpeg' && head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) ||
      (mime === 'image/gif' && head.subarray(0, 3).toString('latin1') === 'GIF') ||
      (mime === 'image/webp' && head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP');
    if (!ok) throw new CollabError('bad_asset', 'That file is not the kind of picture it says it is.');
    const usage = await this.store.assetUsage(projectId);
    if (usage.count >= BOARD_LIMITS.projectImages || usage.bytes + bytes.length > BOARD_LIMITS.projectImageBytes) {
      throw new CollabError('assets_full', 'This project has used all its room for pictures. Remove some from tickets first.');
    }
    const row: AssetRow = { id: this.newId('a'), mime, size: bytes.length, createdBy: uid, createdAt: this.now(), data };
    await this.store.putAsset(projectId, row);
    return { id: row.id, mime, size: row.size };
  }

  async asset(projectId: string, id: string): Promise<AssetRow> {
    const a = await this.store.getAsset(projectId, id);
    if (!a) throw notFound('picture');
    return a;
  }

  /* ───────────── the docs ───────────── */

  async pages(projectId: string): Promise<Page[]> {
    return this.store.listPages(projectId);
  }

  async page(projectId: string, id: string): Promise<Page> {
    const page = await this.store.getPage(projectId, id);
    if (!page) throw notFound('page');
    return page;
  }

  /** How many ancestors a page under `parent` would have (0 = top level). Throws on a cycle. */
  private async depthOf(projectId: string, parent: string | null, moving?: string): Promise<number> {
    let depth = 0;
    let current = parent;
    while (current) {
      if (current === moving) throw new CollabError('bad_parent', 'A page cannot be moved inside itself.');
      depth += 1;
      if (depth > PAGES_LIMITS.depth + 1) break;
      current = (await this.store.getPage(projectId, current))?.parent ?? null;
    }
    return depth;
  }

  async createPage(projectId: string, uid: string, body: unknown): Promise<Page> {
    const input = parsePageInput(body);
    if (!input) throw new CollabError('bad_page', 'A page needs a title.');
    const pages = await this.store.listPages(projectId);
    if (pages.length >= PAGES_LIMITS.pages) throw new CollabError('pages_full', `This project already has ${PAGES_LIMITS.pages} pages.`);
    const parent = input.parent ?? null;
    if (parent) {
      const found = await this.store.getPage(projectId, parent);
      if (!found) throw new CollabError('bad_parent', 'That parent page is not on this project.');
      if ((await this.depthOf(projectId, parent)) + 1 > PAGES_LIMITS.depth) throw new CollabError('bad_parent', `Pages go ${PAGES_LIMITS.depth} levels deep at most.`);
    }
    const at = this.now();
    const siblings = pages.filter((p) => p.parent === parent);
    const page: Page = {
      id: this.newId('p'),
      parent,
      title: input.title,
      body: input.body ?? '',
      order: Math.max(0, ...siblings.map((p) => p.order)) + 1024,
      createdBy: uid,
      createdAt: at,
      updatedBy: uid,
      updatedAt: at,
    };
    await this.store.putPage(projectId, page);
    this.changed('pages', [page.id]);
    return page;
  }

  async updatePage(projectId: string, uid: string, id: string, body: unknown): Promise<Page> {
    const patch = parsePagePatch(body);
    if (!patch) throw new CollabError('bad_page', 'Nothing to change, or a value the page does not allow.');
    const page = await this.page(projectId, id);
    const seen = readPageIfUpdatedAt(body);
    if (seen !== undefined && seen !== page.updatedAt) throw new CollabError('stale', 'Someone changed this page while you were editing it. Look at it again, then make your change.', 409);
    if (patch.parent !== undefined && patch.parent !== page.parent) {
      if (patch.parent) {
        if (!(await this.store.getPage(projectId, patch.parent))) throw new CollabError('bad_parent', 'That parent page is not on this project.');
        if ((await this.depthOf(projectId, patch.parent, id)) + 1 > PAGES_LIMITS.depth) throw new CollabError('bad_parent', 'A page cannot be moved inside itself, or deeper than the tree allows.');
      }
    }
    // Strictly later than before, even within the same millisecond: it is what a stale edit is recognised by.
    const next: Page = { ...page, ...patch, updatedBy: uid, updatedAt: Math.max(this.now(), page.updatedAt + 1) };
    await this.store.putPage(projectId, next);
    this.changed('pages', [id]);
    return next;
  }

  /** Deleting a page keeps its subpages: they move up to where it was. */
  async deletePage(projectId: string, uid: string, id: string, canModerate: boolean): Promise<Page[]> {
    const page = await this.page(projectId, id);
    if (page.createdBy !== uid && !canModerate) throw new CollabError('forbidden', 'Only the person who wrote this page, a founder or an admin can delete it.', 403);
    for (const child of (await this.store.listPages(projectId)).filter((p) => p.parent === id)) await this.store.putPage(projectId, { ...child, parent: page.parent });
    await this.store.deletePage(projectId, id);
    // A ticket that drew on the page no longer lists it.
    const touched: string[] = [];
    for (const issue of await this.store.listIssues(projectId)) {
      if ((issue.docs ?? []).includes(id)) {
        await this.store.putIssue(projectId, { ...issue, docs: issue.docs.filter((d) => d !== id) });
        touched.push(issue.id);
      }
    }
    if (touched.length) this.changed('board', touched);
    this.changed('pages', [id]);
    return this.store.listPages(projectId);
  }
}
