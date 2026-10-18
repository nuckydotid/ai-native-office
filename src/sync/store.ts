import { create } from 'zustand';

/**
 * "Something changed on the team server": a counter for the Board, one for the Docs and one for the delivery pipeline (artifacts, jobs,
 * rollouts), bumped when the server says so (it tells
 * everyone who is in the office). The pages read them again when their counter moves. It lives here, not in the Office, so the
 * Board and Docs never have to import `src/office`.
 */
interface SyncState {
  board: number;
  pages: number;
  pipeline: number;
  /** The ids that changed last (a page may patch just those; the whole list is also fine). */
  lastIds: { board: string[]; pages: string[]; pipeline: string[] };
  bump(kind: 'board' | 'pages' | 'pipeline', ids?: string[]): void;
}

export const useSync = create<SyncState>((set) => ({
  board: 0,
  pages: 0,
  pipeline: 0,
  lastIds: { board: [], pages: [], pipeline: [] },
  bump: (kind, ids = []) => set((s) => ({ [kind]: s[kind] + 1, lastIds: { ...s.lastIds, [kind]: ids } }) as Partial<SyncState>),
}));
