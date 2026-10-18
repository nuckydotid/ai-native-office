import type { Page } from '../shared/pages/types.ts';

/** A page as the tree shows it: the page, and how deep it sits under a top-level page (0 = top level). */
export interface PageRow {
  page: Page;
  depth: number;
}

const byOrder = (a: Page, b: Page) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The tree as one list, parents before their children (what a sidebar shows). A page whose parent is missing from the
 * list appears at the top level rather than disappearing, and a cycle (only a broken store could make one) ends the
 * walk instead of hanging it.
 */
export function flattenPages(pages: Page[]): PageRow[] {
  const byParent = new Map<string | null, Page[]>();
  const known = new Set(pages.map((p) => p.id));
  for (const page of pages) {
    const parent = page.parent && known.has(page.parent) ? page.parent : null;
    byParent.set(parent, [...(byParent.get(parent) ?? []), page]);
  }
  for (const list of byParent.values()) list.sort(byOrder);

  const rows: PageRow[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const page of byParent.get(parent) ?? []) {
      if (seen.has(page.id)) continue;
      seen.add(page.id);
      rows.push({ page, depth });
      walk(page.id, depth + 1);
    }
  };
  walk(null, 0);
  // A cycle has no root to reach it (only a broken store could make one): show what is left instead of hiding it.
  for (const page of [...pages].sort(byOrder)) {
    if (seen.has(page.id)) continue;
    seen.add(page.id);
    rows.push({ page, depth: 0 });
    walk(page.id, 1);
  }
  return rows;
}

/** The pages directly under `id`, in order. */
export const childPages = (pages: Page[], id: string | null): Page[] => pages.filter((p) => p.parent === id).sort(byOrder);

/** True when `maybeParent` is `id` itself or below it: the move a page tree must refuse. */
export function isDescendant(pages: Page[], id: string, maybeParent: string): boolean {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const seen = new Set<string>();
  let current: string | null = maybeParent;
  while (current) {
    if (current === id) return true;
    if (seen.has(current)) return false;
    seen.add(current);
    current = byId.get(current)?.parent ?? null;
  }
  return false;
}

/** The copy of a page that the words being edited were started from. */
export interface DraftBase {
  id: string;
  title: string;
  body: string;
  at: number;
}

export interface Draft {
  title: string;
  body: string;
}

/**
 * What to do with the edit field when the stored page changes (or another page is opened). Words that were not saved are never thrown
 * away because someone else changed the page: they stay, and `theirs` says so. A page that is opened, one whose words were not touched,
 * and one whose words are exactly what is stored now (the person's own save) simply take the stored copy.
 */
export function reconcileDraft(prev: DraftBase | null, stored: DraftBase | null, draft: Draft | null): { base: DraftBase | null; draft: Draft | null; theirs: boolean; keptTab: boolean } {
  const samePage = !!prev && !!stored && prev.id === stored.id;
  const untouched = samePage && !!draft && draft.title === prev.title && draft.body === prev.body;
  const saved = samePage && !!draft && !!stored && draft.title === stored.title && draft.body === stored.body;
  if (!samePage || untouched || saved) {
    return { base: stored, draft: stored ? { title: stored.title, body: stored.body } : null, theirs: false, keptTab: samePage };
  }
  return { base: prev, draft, theirs: !!stored && prev.at !== stored.at, keptTab: true };
}
