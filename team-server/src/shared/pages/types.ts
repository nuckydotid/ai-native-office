// Copied from Worktrees Studio (src/shared/pages) by `npm run sync-core`. Do not edit here.
/**
 * Pages: the team's written knowledge for one project (pillar D), a tree of Markdown documents stored by the team
 * server and edited in the studio's Docs page. A Google Docs/Drive bridge comes later, and only with `drive.file`.
 */

export interface Page {
  id: string;
  /** Parent page id, or null for a top-level page. */
  parent: string | null;
  title: string;
  /** Markdown; the editor and the reader are the same field. */
  body: string;
  /** Sort key among siblings: lower comes first, ties break by id. */
  order: number;
  createdBy: string;
  createdAt: number;
  updatedBy: string;
  updatedAt: number;
}

export const PAGES_LIMITS = {
  title: 200,
  body: 60_000,
  /** Per project. */
  pages: 1000,
  /** How deep the tree may go, so a page always has a visible place. */
  depth: 6,
  /** Sort keys stay well inside a double. */
  order: 1e15,
} as const;
