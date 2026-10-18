/**
 * Validating what a client may put into the board. The team server runs exactly this before it writes anything (the
 * board is shared, so one bad payload would sit in everyone's copy), and the studio's experiments live in the tests
 * beside this file. Unknown fields are dropped, never stored.
 */
import { sanitizeText } from '../workspace/text.ts';
import { BOARD_LIMITS, ISSUE_PRIORITIES, ISSUE_STATUSES } from './types.ts';
import { PR_STATES } from './types.ts';
import type { IssueLink, IssuePriority, IssueStatus, PullRequestInfo } from './types.ts';

const ID_RE = /^[A-Za-z0-9_~:.-]{1,160}$/;

export const isIssueStatus = (v: unknown): v is IssueStatus => typeof v === 'string' && (ISSUE_STATUSES as readonly string[]).includes(v);
export const isIssuePriority = (v: unknown): v is IssuePriority => typeof v === 'string' && (ISSUE_PRIORITIES as readonly string[]).includes(v);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** One line: every run of whitespace (a newline pasted into a title) becomes a space. */
export const cleanLine = (s: string, max: number): string => sanitizeText(s.replace(/\s+/g, ' '), max);

/** Body text keeps its newlines and tabs; only unwanted characters are removed. */
export const cleanBody = (s: string, max: number): string => sanitizeText(s, max);

const cleanId = (v: unknown): string | null | undefined => {
  if (v === null) return null;
  if (typeof v !== 'string') return undefined;
  const id = v.trim();
  return id === '' ? null : ID_RE.test(id) && id.length <= BOARD_LIMITS.id ? id : undefined;
};

/** What `POST /board/issues` accepts. Everything but the title has a sensible default. */
export interface IssueInput {
  title: string;
  body?: string;
  status?: IssueStatus;
  priority?: IssuePriority;
  assignee?: string | null;
  labels?: string[];
  points?: number;
  docs?: string[];
  links?: IssueLink[];
  images?: string[];
}

export function parseIssueInput(v: unknown): IssueInput | null {
  if (!isObj(v) || typeof v.title !== 'string') return null;
  const title = cleanLine(v.title, BOARD_LIMITS.title);
  if (!title) return null;
  const out: IssueInput = { title };
  if (v.body !== undefined) {
    if (typeof v.body !== 'string') return null;
    const body = cleanBody(v.body, BOARD_LIMITS.body);
    if (body) out.body = body;
  }
  if (v.status !== undefined) {
    // `backlog` was a status before the reshape; an older client's create reads as to do.
    const status = v.status === 'backlog' ? 'todo' : v.status;
    if (!isIssueStatus(status)) return null;
    if (status !== 'todo') out.status = status;
  }
  if (v.priority !== undefined) {
    if (!isIssuePriority(v.priority)) return null;
    if (v.priority !== 'medium') out.priority = v.priority;
  }
  if (v.assignee !== undefined) {
    const assignee = cleanId(v.assignee);
    if (assignee === undefined) return null;
    if (assignee !== null) out.assignee = assignee;
  }
  if (v.labels !== undefined) {
    const labels = parseLabels(v.labels);
    if (labels === undefined) return null;
    if (labels.length) out.labels = labels;
  }
  if (v.points !== undefined) {
    const points = parsePoints(v.points);
    if (points === undefined) return null;
    if (points !== 0) out.points = points;
  }
  if (v.docs !== undefined) {
    const docs = parseDocs(v.docs);
    if (docs === undefined) return null;
    if (docs.length) out.docs = docs;
  }
  if (v.links !== undefined) {
    const links = parseLinks(v.links);
    if (links === undefined) return null;
    if (links.length) out.links = links;
  }
  if (v.images !== undefined) {
    const images = parseIds(v.images, BOARD_LIMITS.images);
    if (images === undefined) return null;
    if (images.length) out.images = images;
  }
  return out;
}

/** What `PATCH /board/issues/:id` accepts. Every field is optional; at least one must be there. */
export type IssuePatch = Partial<{
  title: string;
  body: string;
  status: IssueStatus;
  priority: IssuePriority;
  assignee: string | null;
  labels: string[];
  points: number;
  order: number;
  docs: string[];
  thread: string | null;
  branch: string | null;
  pr: string | null;
  prInfo: PullRequestInfo | null;
  links: IssueLink[];
  images: string[];
}>;

/**
 * What a client says it last saw (`ifUpdatedAt`): the change is refused when the issue was changed since, so an edit made on an old
 * copy never silently replaces somebody else's. Read from the request body next to the patch, not part of it.
 */
export function readIfUpdatedAt(v: unknown): number | undefined {
  if (!isObj(v) || v.ifUpdatedAt === undefined) return undefined;
  return typeof v.ifUpdatedAt === 'number' && Number.isFinite(v.ifUpdatedAt) && v.ifUpdatedAt >= 0 ? v.ifUpdatedAt : undefined;
}

export function parseIssuePatch(v: unknown): IssuePatch | null {
  if (!isObj(v)) return null;
  const out: IssuePatch = {};
  if (v.title !== undefined) {
    if (typeof v.title !== 'string') return null;
    const title = cleanLine(v.title, BOARD_LIMITS.title);
    if (!title) return null;
    out.title = title;
  }
  if (v.body !== undefined) {
    if (typeof v.body !== 'string') return null;
    out.body = cleanBody(v.body, BOARD_LIMITS.body);
  }
  if (v.status !== undefined) {
    const status = v.status === 'backlog' ? 'todo' : v.status;
    if (!isIssueStatus(status)) return null;
    out.status = status;
  }
  if (v.priority !== undefined) {
    if (!isIssuePriority(v.priority)) return null;
    out.priority = v.priority;
  }
  if (v.assignee !== undefined) {
    const assignee = cleanId(v.assignee);
    if (assignee === undefined) return null;
    out.assignee = assignee;
  }
  if (v.labels !== undefined) {
    const labels = parseLabels(v.labels);
    if (labels === undefined) return null;
    out.labels = labels;
  }
  if (v.points !== undefined) {
    const points = parsePoints(v.points);
    if (points === undefined) return null;
    out.points = points;
  }
  if (v.order !== undefined) {
    if (typeof v.order !== 'number' || !Number.isFinite(v.order) || v.order < 0 || v.order > BOARD_LIMITS.order) return null;
    out.order = Math.round(v.order);
  }
  if (v.docs !== undefined) {
    const docs = parseDocs(v.docs);
    if (docs === undefined) return null;
    out.docs = docs;
  }
  if (v.thread !== undefined) {
    const thread = cleanId(v.thread);
    if (thread === undefined) return null;
    out.thread = thread;
  }
  if (v.branch !== undefined) {
    if (v.branch === null || v.branch === '') out.branch = null;
    else if (typeof v.branch === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(v.branch) && !v.branch.includes('..')) out.branch = v.branch;
    else return null;
  }
  if (v.pr !== undefined) {
    if (v.pr === null || v.pr === '') out.pr = null;
    else if (typeof v.pr === 'string' && v.pr.length <= BOARD_LIMITS.pr && /^https:\/\/[^\s]+$/.test(v.pr)) out.pr = v.pr;
    else return null;
  }
  if (v.prInfo !== undefined) {
    if (v.prInfo === null) out.prInfo = null;
    else {
      const info = parsePrInfo(v.prInfo);
      if (!info) return null;
      out.prInfo = info;
    }
  }
  if (v.links !== undefined) {
    const links = parseLinks(v.links);
    if (links === undefined) return null;
    out.links = links;
  }
  if (v.images !== undefined) {
    const images = parseIds(v.images, BOARD_LIMITS.images);
    if (images === undefined) return null;
    out.images = images;
  }
  return Object.keys(out).length ? out : null;
}

function parsePrInfo(v: unknown): PullRequestInfo | null {
  if (!isObj(v)) return null;
  const { number, title, state, updatedAt } = v;
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 0 || number > 1e9) return null;
  if (typeof title !== 'string' || typeof state !== 'string' || !(PR_STATES as readonly string[]).includes(state)) return null;
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt) || updatedAt < 0) return null;
  return { number, title: cleanLine(title, BOARD_LIMITS.title), state: state as PullRequestInfo['state'], updatedAt: Math.round(updatedAt) };
}

/** Up to 10 `https` links, each with a short title (the address when there is none). */
export function parseLinks(v: unknown): IssueLink[] | undefined {
  if (!Array.isArray(v) || v.length > BOARD_LIMITS.links) return undefined;
  const out: IssueLink[] = [];
  for (const item of v) {
    if (!isObj(item) || typeof item.url !== 'string') return undefined;
    const url = item.url.trim();
    if (url.length > BOARD_LIMITS.linkUrl || !/^https:\/\/[^\s<>"']+$/.test(url)) return undefined;
    if (out.some((l) => l.url === url)) continue;
    const title = typeof item.title === 'string' ? cleanLine(item.title, BOARD_LIMITS.linkTitle) : '';
    out.push({ url, title: title || url.replace(/^https:\/\//, '').slice(0, BOARD_LIMITS.linkTitle) });
  }
  return out;
}

function parseIds(v: unknown, max: number): string[] | undefined {
  if (!Array.isArray(v) || v.length > max) return undefined;
  const out: string[] = [];
  for (const item of v) {
    const id = cleanId(item);
    if (typeof id !== 'string') return undefined;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** Up to 10 page ids, deduplicated. */
function parseDocs(v: unknown): string[] | undefined {
  if (!Array.isArray(v) || v.length > BOARD_LIMITS.docs) return undefined;
  const out: string[] = [];
  for (const item of v) {
    const id = cleanId(item);
    if (typeof id !== 'string') return undefined;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** Up to 8 short labels, cleaned and deduplicated (case-insensitively, first spelling wins). */
function parseLabels(v: unknown): string[] | undefined {
  if (!Array.isArray(v) || v.length > BOARD_LIMITS.labels) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== 'string') return undefined;
    const label = cleanLine(item, BOARD_LIMITS.label);
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out;
}

const parsePoints = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= BOARD_LIMITS.pointsMax ? v : undefined);
