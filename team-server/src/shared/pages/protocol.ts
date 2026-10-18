// Copied from Worktrees Studio (src/shared/pages) by `npm run sync-core`. Do not edit here.
/**
 * Validating what a client may put into a page. The team server runs exactly this before it writes (the docs are
 * shared), and the studio imports it for its own screens. The server also refuses a parent that would make a cycle
 * or a tree deeper than `PAGES_LIMITS.depth`, which needs the other pages, so it lives in the server, not here.
 */
import { sanitizeText } from '../workspace/text.ts';
import { PAGES_LIMITS } from './types.ts';

const ID_RE = /^[A-Za-z0-9_~:.-]{1,160}$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A page's title as it is stored: one line, every run of whitespace collapsed, never empty after cleaning. */
export const cleanTitle = (s: string): string => sanitizeText(s.replace(/\s+/g, ' '), PAGES_LIMITS.title);

/** Body text keeps its newlines and tabs (the body is Markdown). */
export const cleanPageBody = (s: string): string => sanitizeText(s, PAGES_LIMITS.body);

const cleanId = (v: unknown): string | null | undefined => {
  if (v === null) return null;
  if (typeof v !== 'string') return undefined;
  const id = v.trim();
  return id === '' ? null : ID_RE.test(id) ? id : undefined;
};

/** What `POST /pages` accepts. */
export interface PageInput {
  title: string;
  body?: string;
  parent?: string | null;
}

export function parsePageInput(v: unknown): PageInput | null {
  if (!isObj(v) || typeof v.title !== 'string') return null;
  const title = cleanTitle(v.title);
  if (!title) return null;
  const out: PageInput = { title };
  if (v.body !== undefined) {
    if (typeof v.body !== 'string') return null;
    const body = cleanPageBody(v.body);
    if (body) out.body = body;
  }
  if (v.parent !== undefined) {
    const parent = cleanId(v.parent);
    if (parent === undefined) return null;
    if (parent !== null) out.parent = parent;
  }
  return out;
}

/** What the client says it last saw (`ifUpdatedAt`): the change is refused when the page was changed since. Read next to the patch. */
export function readIfUpdatedAt(v: unknown): number | undefined {
  if (!isObj(v) || v.ifUpdatedAt === undefined) return undefined;
  return typeof v.ifUpdatedAt === 'number' && Number.isFinite(v.ifUpdatedAt) && v.ifUpdatedAt >= 0 ? v.ifUpdatedAt : undefined;
}

/** What `PATCH /pages/:id` accepts. Every field is optional; at least one must be there. */
export type PagePatch = Partial<{ title: string; body: string; parent: string | null; order: number }>;

export function parsePagePatch(v: unknown): PagePatch | null {
  if (!isObj(v)) return null;
  const out: PagePatch = {};
  if (v.title !== undefined) {
    if (typeof v.title !== 'string') return null;
    const title = cleanTitle(v.title);
    if (!title) return null;
    out.title = title;
  }
  if (v.body !== undefined) {
    if (typeof v.body !== 'string') return null;
    out.body = cleanPageBody(v.body);
  }
  if (v.parent !== undefined) {
    const parent = cleanId(v.parent);
    if (parent === undefined) return null;
    out.parent = parent;
  }
  if (v.order !== undefined) {
    if (typeof v.order !== 'number' || !Number.isFinite(v.order) || v.order < 0 || v.order > PAGES_LIMITS.order) return null;
    out.order = Math.round(v.order);
  }
  return Object.keys(out).length ? out : null;
}
